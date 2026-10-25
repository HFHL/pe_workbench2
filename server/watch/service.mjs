/**
 * 「盯」service: a read-only valuation watcher.
 *
 * One watch per project. A cheap rule scan (westock notices/news + AnySearch)
 * produces candidate events; an LLM gate judges whether a candidate actually
 * hits a top sensitivity or a falsifier. Only material findings become chat
 * messages. Silence is the default.
 *
 * The watcher never writes the report, analysis-state.json or the model. Its
 * agent sessions are scoped to `.watch/` and the result JSON is the only file
 * they may create.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { buildWatchBrief, validateWatchBrief, westockSymbol } from "../../lib/watch/brief.mjs";
import {
  findingToMessage,
  normalizeFinding,
  silentCheckText,
  validateFinding,
} from "../../lib/watch/contract.mjs";
import {
  buildSourceTasks,
  candidateHash,
  candidatesFromAnySearch,
  candidatesFromWestock,
  parseAnySearchResults,
  parseMarkdownTable,
  rankCandidates,
} from "../../lib/watch/sources.mjs";
import { lastAssistantText, resultText, toolDetail } from "../agent/snapshot.mjs";

const WATCH_DIR = ".watch";
const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_DEEP_CHECK_TIME = "18:30";
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const ASK_TIMEOUT_MS = 3 * 60 * 1000;
const MIN_RETRY_GAP_MS = 5 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function excerpt(value, limit = 1200) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function isoDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + Math.max(1, Number(minutes) || 1) * 60 * 1000).toISOString();
}

/**
 * Next occurrence of a local `HH:MM` wall-clock time. Server-local time is the
 * same zone the market data uses (Asia/Shanghai on this install).
 */
export function computeNextDeepCheck(time = DEFAULT_DEEP_CHECK_TIME, from = new Date()) {
  const match = String(time || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return addMinutes(from, 24 * 60);
  const hour = Math.max(0, Math.min(23, Number(match[1])));
  const minute = Math.max(0, Math.min(59, Number(match[2])));
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

function materialVersion(material) {
  return material?.versions?.[0]?.v ?? null;
}

function materialCreatedAt(material) {
  return material?.versions?.[0]?.createdAt || material?.updatedAt || "";
}

function newestFirst(left, right) {
  return String(materialCreatedAt(right)).localeCompare(String(materialCreatedAt(left)));
}

async function readJsonFile(file) {
  try {
    const raw = await fsp.readFile(file, "utf8");
    const text = raw.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function scoreReport(material) {
  const name = String(material?.name || "");
  let score = 0;
  if (/投资框架/.test(name)) score += 4;
  if (/报告/.test(name)) score += 2;
  if (material?.kind === "output") score += 1;
  return score;
}

function scoreModel(material, company = "") {
  const name = String(material?.name || "");
  let score = 0;
  if (/model/i.test(name)) score += 4;
  if (/估值/.test(name)) score += 3;
  if (company && name.includes(company.slice(0, 2))) score += 1;
  if (material?.kind === "output") score += 1;
  return score;
}

function shortName(relPath, fallback = "") {
  const base = path.posix.basename(String(relPath || ""));
  return base || fallback;
}

export function createWatchService({
  config = {},
  bus,
  projectManager,
  sessions,
  logger = console,
} = {}) {
  if (!bus || !projectManager || !sessions) {
    throw new Error("createWatchService requires bus, projectManager and sessions");
  }
  const activeChecks = new Set();
  const chatQueues = new Map();
  const DEFAULT_INTERVAL = Math.max(5, Math.min(240, Number(config.watchIntervalMinutes) || DEFAULT_INTERVAL_MINUTES));
  const DEFAULT_DEEP = String(config.watchDeepCheckTime || DEFAULT_DEEP_CHECK_TIME);
  const broadcastGlobal = (payload, projectId) => bus.broadcastGlobal(payload, projectId);

  function reportWatch(watch, projectId) {
    broadcastGlobal({ type: "watch.updated", watch }, projectId);
  }

  function reportMessage(message, projectId) {
    broadcastGlobal({ type: "watch.message", message }, projectId);
  }

  /* ---------- target detection ---------- */

  function inspectTarget(ctx, reportPath = "") {
    const materials = ctx.store.listMaterials();
    const states = materials
      .filter((material) => /(?:^|\/)analysis-state\.json$/i.test(material.relPath || ""))
      .sort(newestFirst);
    if (!states.length) {
      return {
        found: false,
        error: "还没有找到 analysis-state.json。先完成一次投资框架分析，或把报告和状态文件放到 exports/ 下。",
      };
    }

    let stateMaterial = states[0];
    if (reportPath) {
      const dir = path.posix.dirname(reportPath);
      const match = states.find((material) => path.posix.dirname(material.relPath) === dir);
      if (match) stateMaterial = match;
    }
    const dir = path.posix.dirname(stateMaterial.relPath);
    const siblings = materials.filter((material) => path.posix.dirname(material.relPath) === dir);

    let state;
    try {
      state = JSON.parse(fs.readFileSync(path.join(ctx.root, stateMaterial.relPath), "utf8"));
    } catch (error) {
      return {
        found: false,
        error: `无法读取 ${stateMaterial.relPath}：${error.message}`,
      };
    }

    const reports = siblings
      .filter((material) => /\.md$/i.test(material.relPath))
      .sort((left, right) => scoreReport(right) - scoreReport(left) || newestFirst(left, right));
    let reportMaterial = null;
    if (reportPath) {
      reportMaterial = materials.find((material) => material.relPath === reportPath) || null;
    }
    reportMaterial = reportMaterial || reports[0] || null;

    const modelCandidates = [];
    const addModel = (relPath) => {
      const cleaned = String(relPath || "").replace(/^\.\//, "");
      if (!cleaned || !/\.(xlsx|xlsm)$/i.test(cleaned)) return;
      const material = materials.find((item) => item.relPath === cleaned);
      if (material && !modelCandidates.includes(material)) modelCandidates.push(material);
    };
    addModel(state?.subject?.model_file);
    addModel(state?.model?.working_file);
    for (const material of [...siblings, ...materials].filter((item) => /\.(xlsx|xlsm)$/i.test(item.relPath))) {
      addModel(material.relPath);
    }
    const company = String(state?.subject?.company || "").split("（")[0].trim();
    const modelMaterial = modelCandidates
      .sort((left, right) => scoreModel(right, company) - scoreModel(left, company) || newestFirst(left, right))[0] || null;

    let preview = null;
    try {
      preview = buildWatchBrief({
        state,
        reportPath: reportMaterial?.relPath || "",
        reportVersion: materialVersion(reportMaterial),
        statePath: stateMaterial.relPath,
        stateRevision: state?.revision ?? null,
        stateVersion: materialVersion(stateMaterial),
        modelPath: modelMaterial?.relPath || String(state?.model?.working_file || state?.subject?.model_file || ""),
        modelVersion: materialVersion(modelMaterial),
      });
    } catch {
      preview = null;
    }

    return {
      found: true,
      company: String(state?.subject?.company || state?.framework_id || dir),
      security: String(state?.subject?.security || ""),
      symbol: westockSymbol(state?.subject?.security),
      statePath: stateMaterial.relPath,
      stateRevision: state?.revision ?? null,
      stateVersion: materialVersion(stateMaterial),
      reportPath: reportMaterial?.relPath || "",
      reportName: reportMaterial?.name || shortName(reportMaterial?.relPath),
      reportVersion: materialVersion(reportMaterial),
      modelPath: modelMaterial?.relPath || String(state?.model?.working_file || state?.subject?.model_file || ""),
      modelName: modelMaterial?.name || shortName(modelMaterial?.relPath),
      modelVersion: materialVersion(modelMaterial),
      sensitivities: Array.isArray(state?.sensitivities) ? state.sensitivities.length : 0,
      falsifiers: Array.isArray(state?.falsifiers) ? state.falsifiers.length : 0,
      theses: Array.isArray(state?.theses) ? state.theses.length : 0,
      baseValue: preview?.valuation?.base?.value ?? null,
      focus: preview ? {
        base: preview.valuation?.base || null,
        bull: preview.valuation?.bull || null,
        bear: preview.valuation?.bear || null,
        sensitivities: preview.sensitivities || preview.topSensitivities || [],
        falsifiers: preview.falsifiers || [],
        boundaries: preview.invalidation?.boundaries || [],
      } : null,
      warnings: [...new Set([
        !preview?.valuation?.base ? "状态文件没有基准估值，暂时无法开始盯盘" : "",
        ...(preview?.warnings || []),
      ].filter(Boolean))],
      state,
    };
  }

  async function detectTarget(ctx) {
    const inspected = inspectTarget(ctx);
    if (!inspected.found) return inspected;
    const { state, ...rest } = inspected;
    return rest;
  }

  async function buildBrief(ctx, target) {
    const inspected = target?.state ? target : inspectTarget(ctx, target?.reportPath || "");
    if (!inspected.found) throw Object.assign(new Error(inspected.error), { status: 404 });
    const brief = buildWatchBrief({
      state: inspected.state,
      reportPath: inspected.reportPath,
      reportVersion: inspected.reportVersion,
      statePath: inspected.statePath,
      stateRevision: inspected.stateRevision,
      stateVersion: inspected.stateVersion,
      modelPath: inspected.modelPath,
      modelVersion: inspected.modelVersion,
    });
    const errors = validateWatchBrief(brief);
    if (errors.length) {
      throw Object.assign(new Error(`盯盘 brief 校验失败：${errors.join("；")}`), { status: 400 });
    }
    return { brief, inspected };
  }

  /* ---------- watch lifecycle ---------- */

  function overview(ctx) {
    const watch = ctx.store.getCurrentWatch();
    if (!watch) {
      const detected = inspectTarget(ctx);
      const { state, ...detection } = detected;
      return { watch: null, messages: [], checks: [], detection };
    }
    return {
      watch,
      messages: ctx.store.listWatchMessages({ watchId: watch.id, limit: 200 }),
      checks: ctx.store.listWatchChecks(watch.id, 8),
    };
  }

  function view(ctx, watchId) {
    const watch = ctx.store.getWatch(watchId);
    if (!watch) return null;
    return {
      watch,
      messages: ctx.store.listWatchMessages({ watchId, limit: 200 }),
      checks: ctx.store.listWatchChecks(watchId, 8),
    };
  }

  async function createWatch(ctx, {
    reportPath = "",
    intervalMinutes = DEFAULT_INTERVAL,
    deepCheckTime = DEFAULT_DEEP,
    name = "",
  } = {}) {
    const existing = ctx.store.getCurrentWatch();
    if (existing) {
      return { watch: existing, created: false };
    }
    const inspected = inspectTarget(ctx, reportPath);
    if (!inspected.found) throw Object.assign(new Error(inspected.error), { status: 404 });
    const { brief } = await buildBrief(ctx, inspected);
    const now = new Date();
    const interval = Math.max(5, Math.min(240, Number(intervalMinutes) || DEFAULT_INTERVAL));
    const deepTime = String(deepCheckTime || DEFAULT_DEEP);
    const companyShort = String(inspected.company || "").split(/[（(]/)[0].trim() || inspected.company;
    const watch = ctx.store.createWatch({
      name: name || `${companyShort} · 盯`,
      reportPath: brief.target.reportPath,
      statePath: brief.target.statePath,
      modelPath: brief.target.modelPath,
      brief,
      intervalMinutes: interval,
      deepCheckTime: deepTime,
      nextScanAt: addMinutes(now, 0.2),
      nextDeepAt: computeNextDeepCheck(deepTime, now),
    });
    const base = brief.valuation?.base;
    const focus = brief.topSensitivities.slice(0, 2)
      .map((item) => `${item.id} ${item.driver}`).join("、");
    ctx.store.createWatchMessage({
      watchId: watch.id,
      role: "watcher",
      kind: "system",
      title: `开始盯住 ${companyShort}`,
      body: [
        base ? `基准估值 ${base.value ?? "—"} ${base.unit || ""}。` : "",
        focus ? `最敏感的两个变量：${focus}。` : "",
        "我会在后台定期扫一遍公告、财报和新闻，并在每天收盘后做一次深度复核。",
        "只读：不会改报告、状态文件或模型。没有重大发现就不打扰你。",
      ].filter(Boolean).join(""),
      related: {
        reportPath: brief.target.reportPath,
        modelPath: brief.target.modelPath,
        warnings: brief.warnings,
      },
    });
    reportWatch(watch, ctx.id);
    return { watch, created: true };
  }

  async function updateWatch(ctx, watchId, patch = {}) {
    const watch = ctx.store.getWatch(watchId);
    if (!watch) return null;
    const next = { ...patch };
    if (patch.intervalMinutes !== undefined) {
      next.nextScanAt = addMinutes(new Date(), patch.intervalMinutes);
    }
    if (patch.deepCheckTime !== undefined) {
      next.nextDeepAt = computeNextDeepCheck(patch.deepCheckTime, new Date());
    }
    if (patch.enabled === true) {
      next.status = "watching";
      next.nextScanAt = addMinutes(new Date(), 0.2);
    } else if (patch.enabled === false) {
      next.status = "paused";
    }
    const updated = ctx.store.updateWatch(watchId, next);
    if (updated) reportWatch(updated, ctx.id);
    return updated;
  }

  async function deleteWatch(ctx, watchId) {
    const removed = ctx.store.deleteWatch(watchId);
    if (removed) {
      broadcastGlobal({ type: "watch.deleted", id: watchId }, ctx.id);
    }
    return removed;
  }

  async function refreshBrief(ctx, watchId) {
    const watch = ctx.store.getWatch(watchId);
    if (!watch) return null;
    const inspected = inspectTarget(ctx, watch.reportPath);
    if (!inspected.found) throw Object.assign(new Error(inspected.error), { status: 404 });
    const { brief } = await buildBrief(ctx, inspected);
    const updated = ctx.store.updateWatch(watchId, {
      brief,
      reportPath: brief.target.reportPath,
      statePath: brief.target.statePath,
      modelPath: brief.target.modelPath,
    });
    if (updated) reportWatch(updated, ctx.id);
    return updated;
  }

  /**
   * If the report/state/model changed, rebuild the brief so the next check
   * focuses on the latest numbers. Returns the brief actually used.
   */
  async function refreshBriefIfStale(ctx, watch) {
    const materials = ctx.store.listMaterials();
    const byPath = new Map(materials.map((material) => [material.relPath, material]));
    const reportVersion = materialVersion(byPath.get(watch.reportPath));
    const modelVersion = materialVersion(byPath.get(watch.modelPath));
    const stateMaterial = byPath.get(watch.statePath);
    const stateVersion = materialVersion(stateMaterial);
    const changed = (reportVersion && reportVersion !== watch.brief?.target?.reportVersion)
      || (stateVersion && stateVersion !== watch.brief?.target?.stateVersion)
      || (modelVersion && modelVersion !== watch.brief?.target?.modelVersion);
    if (!changed) return { brief: watch.brief, changed: false, stateMaterial };
    const inspected = inspectTarget(ctx, watch.reportPath);
    if (!inspected.found) return { brief: watch.brief, changed: false, stateMaterial };
    const { brief } = await buildBrief(ctx, inspected);
    ctx.store.updateWatch(watch.id, {
      brief,
      reportPath: brief.target.reportPath,
      statePath: brief.target.statePath,
      modelPath: brief.target.modelPath,
    });
    if (reportVersion !== watch.brief?.target?.reportVersion) {
      ctx.store.createWatchMessage({
        watchId: watch.id,
        role: "watcher",
        kind: "system",
        title: "关注点已更新",
        body: `报告版本从 v${watch.brief?.target?.reportVersion ?? "—"} 更新到 v${reportVersion ?? "—"}，下一次检查会按新的基准估值和敏感性执行。`,
        related: { reportPath: brief.target.reportPath },
      });
    }
    return { brief, changed: true, stateMaterial };
  }

  /* ---------- rule scan ---------- */

  function logRun(ctx, watchId, runId, runKind, seqRef, kind, payload) {
    try {
      ctx.store.appendWatchLog({
        watchId,
        runId,
        runKind,
        seq: seqRef.value++,
        kind,
        payload,
      });
    } catch (error) {
      logger.warn?.(`[watch] audit log failed: ${error.message}`);
    }
  }

  async function callTool(ctx, name, params) {
    const tool = (ctx.tools || []).find((item) => item.name === name);
    if (!tool) throw new Error(`工具不可用：${name}`);
    const result = await tool.execute(`watch-scan-${Date.now()}`, params);
    const text = (result?.content || []).find((part) => part.type === "text")?.text || "";
    if (result?.isError) throw new Error(text || `${name} 调用失败`);
    return text;
  }

  async function scan(ctx, watchId) {
    const watch = ctx.store.getWatch(watchId);
    if (!watch || !watch.enabled) return { skipped: true, reason: "disabled" };
    if (activeChecks.has(watchId)) return { skipped: true, reason: "busy" };
    const runId = crypto.randomUUID();
    const seq = { value: 0 };
    const startedAt = Date.now();
    const tasks = buildSourceTasks(watch.brief);
    logRun(ctx, watchId, runId, "scan", seq, "run_start", {
      trigger: "scan",
      intervalMinutes: watch.intervalMinutes,
      tasks: tasks.length,
    });
    if (!tasks.length) {
      ctx.store.updateWatch(watchId, {
        lastScanAt: nowIso(),
        nextScanAt: addMinutes(new Date(), watch.intervalMinutes),
        status: "degraded",
      });
      logRun(ctx, watchId, runId, "scan", seq, "run_end", {
        status: "degraded",
        reason: "no-source-tasks",
        durationMs: Date.now() - startedAt,
      });
      return { skipped: true, reason: "no-source-tasks", runId };
    }

    const candidates = [];
    const errors = [];
    for (const task of tasks) {
      const taskStarted = Date.now();
      try {
        let found = [];
        if (task.adapter === "anysearch") {
          const text = await callTool(ctx, "anysearch_search", { query: task.query, maxResults: 6 });
          found = candidatesFromAnySearch(parseAnySearchResults(text), { query: task.query });
        } else {
          const text = await callTool(ctx, "westock_query", { args: task.args });
          found = candidatesFromWestock(parseMarkdownTable(text), { kind: task.kind });
        }
        candidates.push(...found);
        logRun(ctx, watchId, runId, "scan", seq, "source", {
          adapter: task.adapter,
          kind: task.kind || "",
          query: task.query || (task.args || []).join(" "),
          ok: true,
          count: found.length,
          durationMs: Date.now() - taskStarted,
        });
      } catch (error) {
        errors.push(`${task.adapter}${task.kind ? `/${task.kind}` : ""}: ${error.message}`);
        logger.warn?.(`[watch] source ${task.adapter} failed: ${error.message}`);
        logRun(ctx, watchId, runId, "scan", seq, "source", {
          adapter: task.adapter,
          kind: task.kind || "",
          query: task.query || (task.args || []).join(" "),
          ok: false,
          count: 0,
          error: error.message,
          durationMs: Date.now() - taskStarted,
        });
      }
    }

    const ranked = rankCandidates(candidates, watch.brief).slice(0, 24);
    let added = 0;
    for (const candidate of ranked) {
      try {
        const result = ctx.store.createWatchEvent({
          watchId,
          adapter: candidate.adapter,
          kind: candidate.kind,
          sourceTier: candidate.sourceTier,
          domain: candidate.domain,
          url: candidate.url,
          title: candidate.title,
          publishedAt: candidate.publishedAt,
          snippet: candidate.snippet,
          contentHash: candidateHash(candidate),
          score: candidate.score,
          categories: candidate.categories,
        });
        if (!result.duplicate) {
          added += 1;
          logRun(ctx, watchId, runId, "scan", seq, "candidate", {
            eventId: result.event?.id || "",
            title: candidate.title,
            url: candidate.url || "",
            domain: candidate.domain || "",
            sourceTier: candidate.sourceTier,
            score: candidate.score,
            categories: candidate.categories,
            publishedAt: candidate.publishedAt || "",
            snippet: excerpt(candidate.snippet, 300),
          });
        }
      } catch (error) {
        errors.push(`store: ${error.message}`);
      }
    }

    const status = errors.length && !candidates.length ? "degraded" : "watching";
    const updated = ctx.store.updateWatch(watchId, {
      lastScanAt: nowIso(),
      nextScanAt: addMinutes(new Date(), watch.intervalMinutes),
      status,
    });
    if (updated) reportWatch(updated, ctx.id);
    logRun(ctx, watchId, runId, "scan", seq, "run_end", {
      status,
      added,
      candidates: ranked.length,
      errors,
      durationMs: Date.now() - startedAt,
    });
    ctx.store.pruneWatchLogs(watchId);
    return { added, candidates: ranked.length, errors, runId };
  }

  /* ---------- LLM check ---------- */

  function runAgent(entry, prompt, { timeoutMs = CHECK_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let unsubscribe = null;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try {
          unsubscribe?.();
        } catch {
          /* ignore */
        }
        if (error) reject(error);
        else resolve(lastAssistantText(entry.session));
      };
      timer = setTimeout(() => {
        try {
          entry.session.abort?.();
        } catch {
          /* ignore */
        }
        finish(new Error("盯盘运行超时，已停止等待"));
      }, Math.max(30_000, timeoutMs));
      timer.unref?.();
      unsubscribe = entry.session.subscribe((event) => {
        if (event.type === "agent_settled") finish(null);
      });
      try {
        entry.session.prompt(prompt, {}).catch((error) => finish(error));
      } catch (error) {
        finish(error);
      }
    });
  }

  function briefText(brief) {
    const base = brief.valuation?.base;
    const lines = [];
    lines.push(`- 公司 / 证券：${brief.target.company}${brief.target.security ? `（${brief.target.security}）` : ""}`);
    lines.push(`- 估值日：${brief.target.valuationDate || "—"}；信息截止：${brief.target.dataCutoff || "—"}；行情日：${brief.target.marketPriceDate || "—"}`);
    lines.push(`- 报告：${brief.target.reportPath || "—"}${brief.target.reportVersion ? `（v${brief.target.reportVersion}）` : ""}`);
    lines.push(`- 状态文件：${brief.target.statePath || "—"}（revision ${brief.target.revision ?? "—"}）`);
    lines.push(`- 模型：${brief.target.modelPath || "—"}${brief.target.modelVersion ? `（v${brief.target.modelVersion}）` : ""}`);
    lines.push("");
    lines.push("## 基准估值");
    if (base) {
      lines.push(`- 基准 ${base.id}/${base.scenario}：${base.value ?? "—"} ${base.unit || ""}`);
      if (base.formula) lines.push(`- 公式：${base.formula}`);
      if (brief.valuation.bull) lines.push(`- 上行 ${brief.valuation.bull.id}：${brief.valuation.bull.value ?? "—"} ${brief.valuation.bull.unit || ""}`);
      if (brief.valuation.bear) lines.push(`- 下行 ${brief.valuation.bear.id}：${brief.valuation.bear.value ?? "—"} ${brief.valuation.bear.unit || ""}`);
    } else {
      lines.push("- （状态文件没有估值）");
    }
    if (brief.valuation?.market?.price != null) {
      lines.push(`- 现价：${brief.valuation.market.price}（${brief.valuation.market.priceDate || "—"}）`);
    }
    lines.push("");
    lines.push("## 最敏感的变量（优先级从高到低，这是本次盯盘的重点）");
    if (brief.topSensitivities.length) {
      for (const item of brief.topSensitivities) {
        lines.push(`- ${item.id}（优先级 ${item.priority}，影响约 ±${item.impactPercent || "—"}%）：${item.driver}`);
        lines.push(`  基准：${item.baseline || "—"}`);
        lines.push(`  扰动：${item.perturbation || "—"}`);
        lines.push(`  结果：${item.result || "—"}`);
        if (item.affects?.length) lines.push(`  影响观点：${item.affects.join("、")}`);
      }
    } else {
      lines.push("- （没有敏感性分析）");
    }
    lines.push("");
    lines.push("## 失效条件");
    if (brief.falsifiers.length) {
      for (const item of brief.falsifiers) {
        lines.push(`- ${item.id}（${item.thesisId || "—"}，${item.status}）：${item.metric}`);
        lines.push(`  阈值：${item.threshold || "—"}${item.warning ? `；预警：${item.warning}` : ""}`);
        lines.push(`  来源/频率：${item.source || "—"} / ${item.frequency || "—"}${item.lastObserved ? `；上次观察：${item.lastObserved}` : ""}`);
      }
    } else {
      lines.push("- （没有失效条件）");
    }
    if (brief.invalidation.boundaries.length) {
      lines.push("");
      lines.push("## 估值失效边界");
      for (const item of brief.invalidation.boundaries) lines.push(`- ${item}`);
    }
    lines.push("");
    lines.push(`## 检索主题：${brief.queries.topics.join("、") || "—"}`);
    return lines.join("\n");
  }

  function eventsText(events) {
    if (!events.length) return "（本次没有规则扫描命中的候选；请自己用工具查最新披露/行情/新闻。）";
    return events.map((event) => {
      const tier = event.sourceTier || 3;
      const meta = [
        `tier ${tier}`,
        event.categories?.length ? event.categories.join("/") : "",
        event.publishedAt || "",
        event.domain || "",
      ].filter(Boolean).join(" · ");
      return `- ${event.title}\n  ${meta}${event.url ? `\n  ${event.url}` : ""}${event.snippet ? `\n  摘要：${event.snippet.slice(0, 500)}` : ""}`;
    }).join("\n");
  }

  function checkPrompt({ watch, brief, events, trigger, checkId, resultRelPath, deep }) {
    const now = new Date();
    return `# 「盯」· 只读估值巡检

你不是在重写报告，而是在判断：**新信息有没有让当前估值失效**。这是一次只读检查。

## 当前对象
${briefText(brief)}

## 本次任务
- 任务：${deep ? "每日深度复核（主动查最新披露、行情和新闻）" : `规则扫描后的重大性研判（trigger=${trigger}）`}
- 检查 ID：${checkId}
- 时间：${isoDay(now)} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}
- 报告/状态/模型都只读；不要修改它们。你唯一可以写的文件是下面的结果 JSON。

## 候选事件
${eventsText(events)}

## 工作顺序
1. 用 read 读报告和 \`${brief.target.statePath}\`，确认上面的 brief 与当前版本一致；不一致时以状态文件为准，并在结果里注明。
2. ${deep
    ? "主动取证：用 westock_query 查最新行情、公告、财报（例如 quote / notice list / finance）；用 anysearch_search 搜最近 24–48 小时的新闻；必要时用 web_fetch 打开原文。"
    : "逐条核对候选：用 web_fetch 打开原文；用 westock_query 查公告/财报/行情做交叉验证。不要只看标题。westock 子命令用 `notice list <symbol>`（公告）、`news <symbol>`（新闻）、`quote <symbol>`（行情）、`finance <symbol>`（财报），不要猜 announce/公告 这类子命令。westock 公告列表没有 URL 时，用 anysearch_search 搜公告标题，找到原文或可信转载链接。"}
3. **先做“新旧”判定**：候选发布日期是否晚于 \`${brief.target.dataCutoff || "信息截止日"}\`？报告、状态文件和已有证据里是否已经引用过同一来源、同一数字、同一结论？如果只是同一事实的重复报道/转载，或框架已经纳入过的卖方观点，**不算新信息**。
4. 判断它是否**直接改变 top 敏感性输入的取值/区间**，或**触发/接近某条失效条件**，或**推翻某条观点**。
5. 只有同时满足以下条件才 output \`material: true\`：
   - **是新信息**：晚于信息截止日，或框架尚未纳入的实质性变化；
   - 来源可核验（tier 1–2 优先；tier 3 需要两个**独立**来源或与公告互证；同一研报/通稿的多家转载只算一个来源）；
   - 与敏感性变量或失效条件有明确对应关系；
   - 能给出量化影响（目标价/估值 from → to 或 % 变化）；至少能说明方向与量级；
   - 至少一个可点击链接，且必须是原文页；券商首页、搜索页、https://www.sse.com.cn/ 这类占位链接不算。
   - **卖方重申目标价、且没有新增盈利/行业数据**，不算重大；只有新的财务披露、监管事件、产能/价格数据，或对 S/F 输入的实质改变才算。
6. 不满足就 \`material: false\`。**不要为了汇报而汇报**；没有重大变化是常态。

## 输出
把结果写到 \`${resultRelPath}\`（只写这一个文件，合法 JSON，不要 markdown 代码围栏）：
\`\`\`json
{
  "material": false,
  "severity": "info | warning | critical",
  "headline": "一句话结论（material=true 时必填，最多 40 字）",
  "summary": "最多 3 句 / 150 字：发生了什么、为什么影响估值、影响多少；详细依据放 checked",
  "affected": [
    { "kind": "sensitivity | falsifier | valuation | thesis | data", "id": "S2", "note": "为什么相关" }
  ],
  "impact": { "label": "目标价", "from": "62 元", "to": "55 元", "delta": "-11%", "direction": "down" },
  "evidence": [
    { "title": "来源标题", "url": "https://…", "source": "公司公告", "sourceTier": 1, "publishedAt": "2026-10-24", "quote": "关键原文" }
  ],
  "confidence": "high | medium | low",
  "materialReason": "为什么算/不算重大（material=false 时必填）",
  "suggestedAction": "建议人工做什么（只建议，不执行）",
  "checked": ["本次实际核对了什么"],
  "reportVersion": ${brief.target.reportVersion ?? "null"},
  "nextWatch": "下一次要特别留意什么"
}
\`\`\`

注意：
- \`material: true\` 时，\`evidence\` 必须至少有一条带 http(s) 链接；没有链接就判 \`material: false\`。
- 不要编造数字、日期、来源或链接；无法核验就写进 \`checked\` 或降为 \`material: false\`。
- 结果写完后再回复 1–2 句结论；不要重复整份 JSON。`;
  }

  async function runCheck(ctx, watchId, { trigger = "scan", force = false } = {}) {
    const watch = ctx.store.getWatch(watchId);
    if (!watch || !watch.enabled) return { skipped: true, reason: "disabled" };
    if (activeChecks.has(watchId)) return { skipped: true, reason: "busy" };
    const deep = trigger === "deep";
    const events = ctx.store.listWatchEvents({ watchId, status: "new", limit: 24 });
    if (!deep && !events.length) {
      ctx.store.updateWatch(watchId, { status: "quiet" });
      return { skipped: true, reason: "no-candidates" };
    }
    if (!force && !deep && watch.lastCheckAt) {
      const age = Date.now() - new Date(watch.lastCheckAt).getTime();
      if (Number.isFinite(age) && age < MIN_RETRY_GAP_MS) {
        return { skipped: true, reason: "recent" };
      }
    }

    activeChecks.add(watchId);
    const checkId = ctx.store.createWatchCheck({ watchId, trigger, candidates: events.length });
    const runKind = deep ? "deep" : trigger === "manual" ? "manual" : "gate";
    const seq = { value: 0 };
    const runStartedAt = Date.now();
    logRun(ctx, watchId, checkId, runKind, seq, "run_start", {
      trigger,
      deep,
      candidates: events.length,
      eventIds: events.map((event) => event.id),
      reportVersion: watch.brief?.target?.reportVersion ?? null,
    });
    const resultRel = path.posix.join(WATCH_DIR, watchId, `${checkId}.json`);
    const resultAbs = path.join(ctx.root, resultRel);
    let entry = null;
    let logUnsub = null;
    try {
      await fsp.mkdir(path.dirname(resultAbs), { recursive: true });
      const refreshed = await refreshBriefIfStale(ctx, watch);
      const brief = refreshed.brief;
      entry = await sessions.createEntry({ ctx, writeRoots: [`${WATCH_DIR}/`] });
      entry.title = `[盯] ${brief.target.company} · ${deep ? "深度复核" : "巡检"}`;
      entry.session.setSessionName(entry.title);
      logRun(ctx, watchId, checkId, runKind, seq, "session", {
        sessionId: entry.id,
        title: entry.title,
      });
      const toolStarts = new Map();
      logUnsub = entry.session.subscribe((event) => {
        if (event.type === "tool_execution_start") {
          const args = event.args || {};
          toolStarts.set(event.toolCallId, { at: Date.now(), args });
          logRun(ctx, watchId, checkId, runKind, seq, "tool_start", {
            toolCallId: event.toolCallId,
            tool: event.toolName,
            detail: excerpt(toolDetail(ctx, event.toolName, args), 400),
          });
        }
        if (event.type === "tool_execution_end") {
          const started = toolStarts.get(event.toolCallId) || { at: Date.now(), args: event.args || {} };
          toolStarts.delete(event.toolCallId);
          const result = resultText(event.result);
          const failed = Boolean(event.error) || /失败：|unknown command|isError/i.test(result.slice(0, 300));
          logRun(ctx, watchId, checkId, runKind, seq, "tool_end", {
            toolCallId: event.toolCallId,
            tool: event.toolName,
            detail: excerpt(toolDetail(ctx, event.toolName, started.args || {}), 400),
            status: failed ? "error" : "ok",
            durationMs: Math.max(0, Date.now() - started.at),
            result: excerpt(result, 1500),
            error: event.error?.message
              ? excerpt(event.error.message, 300)
              : failed ? excerpt(result.split("\n")[0], 300) : "",
          });
        }
      });
      ctx.store.updateWatch(watchId, { status: "checking" });
      reportWatch(ctx.store.getWatch(watchId), ctx.id);

      const prompt = checkPrompt({ watch, brief, events, trigger, checkId, resultRelPath: resultRel, deep });
      await runAgent(entry, prompt, { timeoutMs: Number(config.watchMaxRuntimeMs) || CHECK_TIMEOUT_MS });
      try {
        logUnsub?.();
        logUnsub = null;
      } catch {
        /* ignore */
      }
      logRun(ctx, watchId, checkId, runKind, seq, "assistant", {
        text: excerpt(lastAssistantText(entry.session), 1600),
      });
      // Give the write tool's indexing callback a beat to finish.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const raw = await readJsonFile(resultAbs);
      if (!raw) throw new Error("模型没有写结果 JSON，本次按无效检查处理");
      const finding = normalizeFinding(raw, { watchId, checkId });
      // The host owns the version stamp; never trust the model's copy.
      finding.reportVersion = brief.target.reportVersion ?? null;
      const errors = validateFinding(finding);
      if (errors.length) throw new Error(`盯盘结果不符合契约：${errors.join("；")}`);

      let message = null;
      if (finding.material) {
        const payload = findingToMessage(finding, { watchId, checkId });
        message = ctx.store.createWatchMessage(payload);
        reportMessage(message, ctx.id);
      }
      logRun(ctx, watchId, checkId, runKind, seq, "judgment", {
        material: finding.material,
        severity: finding.severity,
        headline: finding.headline,
        summary: finding.summary,
        confidence: finding.confidence,
        materialReason: finding.materialReason,
        suggestedAction: finding.suggestedAction,
        checked: finding.checked,
        affected: finding.affected,
        impact: finding.impact,
        evidence: finding.evidence,
        nextWatch: finding.nextWatch,
        reportVersion: finding.reportVersion,
      });
      if (events.length) ctx.store.markWatchEventsUsed(events.map((event) => event.id), checkId);
      ctx.store.finishWatchCheck(checkId, {
        status: finding.material ? "finding" : "silent",
        llmCalled: true,
        findingCount: finding.material ? 1 : 0,
        result: finding,
        sessionId: entry.id,
      });
      const patch = {
        lastCheckAt: nowIso(),
        status: finding.material ? "finding" : "quiet",
      };
      if (deep) {
        patch.lastDeepCheckAt = nowIso();
        patch.nextDeepAt = computeNextDeepCheck(watch.deepCheckTime, new Date());
      }
      const updated = ctx.store.updateWatch(watchId, patch);
      if (updated) reportWatch(updated, ctx.id);
      logRun(ctx, watchId, checkId, runKind, seq, "run_end", {
        status: finding.material ? "finding" : "silent",
        material: finding.material,
        messageId: message?.id || null,
        durationMs: Date.now() - runStartedAt,
      });
      ctx.store.pruneWatchLogs(watchId);
      return {
        checkId,
        material: finding.material,
        message,
        summary: finding.material ? finding.headline : silentCheckText(finding),
      };
    } catch (error) {
      logger.warn?.(`[watch] check failed (${ctx.id}/${watchId}): ${error.message}`);
      logRun(ctx, watchId, checkId, runKind, seq, "error", {
        message: error.message,
      });
      logRun(ctx, watchId, checkId, runKind, seq, "run_end", {
        status: "failed",
        material: null,
        error: error.message,
        durationMs: Date.now() - runStartedAt,
      });
      ctx.store.finishWatchCheck(checkId, {
        status: "failed",
        llmCalled: true,
        error: error.message,
        sessionId: entry?.id || null,
      });
      const patch = { lastCheckAt: nowIso(), status: "error" };
      if (deep) {
        patch.lastDeepCheckAt = nowIso();
        patch.nextDeepAt = computeNextDeepCheck(watch.deepCheckTime, new Date());
      }
      const updated = ctx.store.updateWatch(watchId, patch);
      if (updated) reportWatch(updated, ctx.id);
      ctx.store.pruneWatchLogs(watchId);
      return { checkId, error: error.message };
    } finally {
      try {
        logUnsub?.();
      } catch {
        /* ignore */
      }
      activeChecks.delete(watchId);
    }
  }

  /* ---------- chat ---------- */

  function recentFindingsText(ctx, watchId, limit = 6) {
    const messages = ctx.store.listWatchMessages({ watchId, limit: 120 })
      .filter((message) => ["finding", "answer", "system"].includes(message.kind))
      .slice(-limit);
    if (!messages.length) return "";
    return messages.map((message) => {
      const links = (message.citations || [])
        .map((item) => item.url || item.path)
        .filter(Boolean)
        .slice(0, 3);
      return `- [${message.kind}] ${message.title || message.body.slice(0, 80)}${links.length ? `（${links.join("、")}）` : ""}`;
    }).join("\n");
  }

  function localTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "—";
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function watchRuntimeText(watch) {
    const last = watch.lastCheck;
    const result = !last
      ? "还没有检查过"
      : last.status === "finding"
        ? "有重大发现"
        : last.status === "silent"
          ? "无新增重大变化（一切安好）"
          : last.status === "failed"
            ? `检查失败：${last.error || "未知错误"}`
            : "运行中";
    return [
      `- 盯盘状态：${watch.enabled ? "启用" : "已暂停"}（${watch.status || "idle"}）`,
      `- 最近一次检查：${localTime(watch.lastCheckAt)}；结果：${result}`,
      `- 下次规则扫描：${localTime(watch.nextScanAt)}；下次深度复核：${localTime(watch.nextDeepAt)}`,
    ].join("\n");
  }

  function chatPrompt({ ctx, watch, brief, question }) {
    const recent = recentFindingsText(ctx, watch.id, 6);
    return `# 「盯」· 对话

你是这个项目的估值盯盘助手。只读：不要修改报告、analysis-state.json 或模型；也不要写任何文件。用中文、简洁、Markdown 回答，不要使用表格。

## 你正在盯的对象
${briefText(brief)}

## 运行状态（回答“现在怎么样”时以这里为准，不要用信息截止日代替检查时间）
${watchRuntimeText(watch)}

## 最近的发现
${recent || "（暂时没有重大发现）"}

## 用户的问题
${question}

回答要求：
- 先直接回答，再给依据；引用来源时保留可点击链接。
- **控制在 6 行以内（约 200 字）**。最多 3 个要点；需要展开时先给结论，再问用户要不要展开。不要复述整份框架。
- 状态行的“一切安好”只代表**最近一次检查没有新增重大信息**，不代表所有失效条件都未触发。回答时要区分“本次新增发现”和“框架里已存在的状态（如某个 F 早已 triggered）”。
- 如果用户问“现在怎么样”，用一句话说明最近一次检查时间和结论，不要编造新数据。
- 如果用户问假设性问题，按 brief 里的敏感性区间推算，并说明这是推算不是新证据。
- 如果问题超出当前报告范围，明确说需要什么数据，不要猜。`;
  }


  async function answer(ctx, watchId, question) {
    let watch = ctx.store.getWatch(watchId);
    if (!watch) return;
    let entry = watch.sessionId ? await sessions.ensureEntry(watch.sessionId, ctx) : null;
    if (!entry) {
      entry = await sessions.createEntry({ ctx, writeRoots: [`${WATCH_DIR}/`] });
      entry.session.setSessionName(`[盯] ${watch.brief?.target?.company || watch.name}`);
      watch = ctx.store.updateWatch(watchId, { sessionId: entry.id }) || watch;
      reportWatch(watch, ctx.id);
    }
    try {
      const prompt = chatPrompt({ ctx, watch, brief: watch.brief, question });
      const text = await runAgent(entry, prompt, { timeoutMs: Number(config.watchAskTimeoutMs) || ASK_TIMEOUT_MS });
      const body = String(text || "").trim();
      if (body) {
        const message = ctx.store.createWatchMessage({
          watchId,
          role: "assistant",
          kind: "answer",
          title: "",
          body,
          related: { sessionId: entry.id },
        });
        reportMessage(message, ctx.id);
      }
    } catch (error) {
      logger.warn?.(`[watch] answer failed (${ctx.id}/${watchId}): ${error.message}`);
      const message = ctx.store.createWatchMessage({
        watchId,
        role: "assistant",
        kind: "error",
        title: "回答失败",
        body: error.message || "盯盘助手暂时不可用",
      });
      reportMessage(message, ctx.id);
    }
  }

  async function ask(ctx, watchId, text) {
    const watch = ctx.store.getWatch(watchId);
    if (!watch) throw Object.assign(new Error("watch not found"), { status: 404 });
    const question = String(text || "").trim();
    if (!question) throw Object.assign(new Error("问题不能为空"), { status: 400 });
    if (question.length > 2000) throw Object.assign(new Error("问题太长（最多 2000 字）"), { status: 400 });
    const message = ctx.store.createWatchMessage({
      watchId,
      role: "user",
      kind: "question",
      body: question,
    });
    reportMessage(message, ctx.id);
    const run = () => answer(ctx, watchId, question);
    const previous = chatQueues.get(watchId) || Promise.resolve();
    const queued = previous.then(run, run).catch((error) => {
      logger.warn?.(`[watch] queued answer failed: ${error.message}`);
    });
    chatQueues.set(watchId, queued.finally(() => {
      if (chatQueues.get(watchId) === queued) chatQueues.delete(watchId);
    }));
    return { message, queued: true };
  }

  function markRead(ctx, watchId) {
    const changed = ctx.store.markWatchMessagesRead(watchId);
    const watch = ctx.store.getWatch(watchId);
    if (watch) reportWatch(watch, ctx.id);
    return { changed, watch };
  }

  return {
    overview,
    view,
    detectTarget,
    createWatch,
    updateWatch,
    deleteWatch,
    refreshBrief,
    scan,
    runCheck,
    ask,
    markRead,
    get activeChecks() {
      return activeChecks;
    },
  };
}
