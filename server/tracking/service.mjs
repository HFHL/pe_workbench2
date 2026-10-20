/**
 * Tracking / monitoring / source-polling domain service.
 *
 * Owns tracking runs, result normalization, monitor-item sync and source
 * polling. It has no HTTP code and no module-level timers. Schedulers call
 * runTracking/tick; tests can call them directly.
 */

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  buildTrackingPrompt,
  fallbackTrackingResult,
  normalizeTrackingResult,
  templateFor,
} from "../../lib/tracking.mjs";
import { computeNextCheck, decideAction } from "../../lib/monitoring.mjs";
import { notifyDesktop } from "../../lib/desktop-notify.mjs";
import { lastAssistantText } from "../agent/snapshot.mjs";
import { TRACKING_RESULT } from "../../lib/contracts/tracking-result.mjs";

export function createTrackingService({
  config,
  bus,
  projectManager,
  sessions,
  broadcastMaterial,
  broadcastTracking,
  logger = console,
}) {
  if (!config || !bus || !projectManager || !sessions) {
    throw new Error("createTrackingService requires config, bus, projectManager and sessions");
  }
  const createEntry = (args) => sessions.createEntry(args);
  const broadcastGlobal = (payload, projectId) => bus.broadcastGlobal(payload, projectId);
  const SKILLS_DIR = config.skillsDir;
  const nowIso = () => new Date().toISOString();

const activeTrackingRuns = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fullNowLabel(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatRunDuration(startedAt, endedAt = new Date()) {
  const seconds = Math.max(1, Math.round((new Date(endedAt) - new Date(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function backupStamp(date = new Date()) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}-${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;
}

async function backupTrackingTarget(ctx, target, runId) {
  const targetAbs = path.join(ctx.root, target.relPath);
  const dir = path.posix.dirname(target.relPath);
  const base = path.posix.basename(target.relPath);
  const rel = path.posix.join(dir, "backups", `${backupStamp()}-${runId.slice(0, 8)}`, base);
  const absolute = path.join(ctx.root, rel);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.copyFile(targetAbs, absolute);
  return rel;
}

async function readTrackingResult(file) {
  try {
    const raw = await fsp.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function settleTrackingRun({
  ctx,
  trackingId,
  runId,
  entry,
  run,
  targetId,
  baseVersion,
  resultAbs,
  backupRel,
  error,
  monitorMode = false,
  monitorItems = [],
  stateRel = "",
  stateMaterialId = null,
  stateBaseVersion = null,
}) {
  const store = ctx.store;
  let pendingApproval = null;
  try {
    // Give the write tool's indexing callback a beat to finish.
    await sleep(320);
    const row = store.getTrackingRow(trackingId);
    const target = store.getMaterial(targetId);
    const latestVersion = target?.versions?.[0]?.v ?? baseVersion;
    const versionIncreased = latestVersion > baseVersion;
    const rawResult = error ? null : await readTrackingResult(resultAbs);
    const finalText = entry ? lastAssistantText(entry.session) : "";
    const failed = Boolean(error) || Boolean(
      entry?.session.messages?.some(
        (message) => message.role === "assistant" && message.stopReason === "error",
      ),
    );

    let status;
    if (failed) status = "failed";
    else if (rawResult?.status === "needs_review") status = "needs_review";
    else if (rawResult?.status === "no_change") status = versionIncreased ? "updated" : "no_change";
    else if (monitorMode) status = versionIncreased ? "updated" : "no_change";
    else if (rawResult?.status === "updated" || versionIncreased) status = "updated";
    else status = "no_change";

    const template = templateFor(row?.template_id);
    if (!failed && template.writeMode === "propose_only" && !versionIncreased) {
      status = "needs_review";
    }

    const endedAt = new Date();
    const context = {
      trackingId,
      targetId,
      targetPath: target?.relPath || "",
      templateId: row?.template_id || "generic",
      baseVersion,
      resultVersion: versionIncreased ? latestVersion : null,
      nowLabel: fullNowLabel(endedAt),
      duration: formatRunDuration(run.startedAt, endedAt),
      fallbackConclusion: finalText ? finalText.split(/\n/)[0].slice(0, 180) : "跟踪运行完成",
      fallbackSummary: finalText.slice(0, 2400),
      status,
      backupPath: backupRel,
      monitorMode,
      runId,
      trigger: run?.trigger || "manual",
      startedAt: run?.startedAt || "",
      endedAt: endedAt.toISOString(),
    };

    if (failed) {
      if (monitorMode && monitorItems.length) {
        await syncMonitorItemsFromState(ctx, trackingId, {
          checkedIds: monitorItems.map((item) => item.id),
          now: endedAt,
        });
      }
      let notification = null;
      if (monitorMode) {
        try {
          notification = store.createNotification({
            trackingId,
            runId,
            severity: "action",
            title: "监测检查失败",
            body: String(error?.message || "运行失败").slice(0, 800),
            changes: [],
            actions: [{ action: "open", label: "查看运行" }],
          });
          broadcastGlobal({ type: "notification.created", notification }, ctx.id);
          notifyDesktop({ title: notification.title, body: notification.body, subtitle: ctx.name || "PE Workbench" });
        } catch (notifyError) {
          console.warn(`[monitor] failure notification failed: ${notifyError.message}`);
        }
      }
      const dto = store.finishTrackingRun(trackingId, runId, {
        status: "failed",
        message: error?.message || "运行失败",
        sessionId: entry?.id || null,
        notificationId: notification?.id || null,
      });
      broadcastTracking(dto, ctx.id);
      return;
    }

    let result = rawResult
      ? normalizeTrackingResult(rawResult, context)
      : fallbackTrackingResult(context);
    result.status = status;
    result.target.result_version = versionIncreased ? latestVersion : null;
    result.writeback.version = versionIncreased ? `v${latestVersion}` : "未产生新版本";
    if (backupRel) {
      result.writeback.backup = backupRel;
      const note = String(result.writeback.note || "");
      if (!note.includes(backupRel) && !note.includes("backups/")) {
        result.writeback.note = `${note} 宿主已把原文件备份到 ${backupRel}。`.trim();
      }
    }
    if (status === "no_change" && versionIncreased) {
      result.writeback.note = `${result.writeback.note} 本次同时在目标文件写入了跟踪记录，因此产生了审计版本 v${latestVersion}。`;
    }
    if (monitorMode && !versionIncreased) {
      result.writeback.note = "监测模式：本次只更新状态文件里的观察值，报告未改动，没有产生新版本。";
    }

    if (monitorMode && !result.monitorChecks.length && result.invalidations.length) {
      result.monitorChecks = result.invalidations.map((item) => ({
        id: item.id,
        falsifier_id: item.id,
        observed: item.observed,
        status: item.triggered ? "triggered" : "unknown",
        note: item.condition,
      }));
    }

    const triggeredCheck = (result.monitorChecks || []).some((check) => check.status === "triggered");
    const warningCheck = (result.monitorChecks || []).some((check) => check.status === "warning");
    const invalidatedThesis = (result.theses || []).some((thesis) => thesis.status === "invalidated");
    const targetDelta = (result.deltas || []).some((delta) => /目标价|TP|target/i.test(delta.label || ""));
    const changeClass = (result.modelChanges || []).length || targetDelta
      ? "C3"
      : (triggeredCheck || invalidatedThesis)
        ? "C2"
        : warningCheck || status === "updated"
          ? "C1"
          : "C0";
    const confidenceLabel = { "高": "high", "中": "medium", "低": "low" }[result.confidence] || "medium";
    const trackingDto = store.getTracking(trackingId);
    const decision = decideAction({
      changeClass,
      confidence: confidenceLabel,
      autonomy: trackingDto?.autonomyDefault || "auto_notify",
    });
    result.decision = {
      class: changeClass,
      confidence: confidenceLabel,
      action: decision.action,
      reason: decision.reason,
    };

    // Validate before creating anything durable. An invalid result must not
    // leave an orphaned, approvable proposal behind.
    {
      const preliminary = TRACKING_RESULT.validate(result);
      if (!preliminary.ok) {
        const detail = preliminary.errors.map((item) => `${item.path} ${item.message}`).join("; ");
        throw new Error(`跟踪结果不符合 pe.tracking-result@v1：${detail}`);
      }
      result = preliminary.value;
    }

    let modelWrite = null;
    let approval = null;
    // Hard rule: a tracking result with model changes is never written back
    // automatically, regardless of autonomy or confidence. It becomes a
    // durable proposal that a human must approve.
    if (result.modelChanges.length) {
      status = "needs_review";
      result.decision = {
        ...result.decision,
        action: "propose",
        reason: "模型写回必须经人工审批，autonomy 不会直接应用",
      };
      const tracking = store.getTracking(trackingId);
      const { state } = await readTrackingState(ctx, tracking);
      if (!state) {
        result.writeback.note = `${result.writeback.note} 状态文件不可读，无法生成审批提案。`.trim();
      } else {
        const proposed = await ctx.approvals.propose({
          ctx,
          tracking,
          trackingRunId: runId,
          threadId: entry?.id || "",
          result,
          state,
          stateRel,
        });
        if (proposed.ok) {
          approval = proposed.approval;
          pendingApproval = proposed.approval;
          result.writeback.approval = {
            id: approval.id,
            status: approval.status,
            createdAt: approval.createdAt,
          };
          result.writeback.note = `${result.writeback.note} 检测到 ${result.modelChanges.length} 个模型输入变更，已生成审批提案，等待人工确认；工作模型未修改。`.trim();
        } else {
          result.writeback.note = `${result.writeback.note} 无法生成审批提案：${proposed.reason}。工作模型未修改。`.trim();
        }
      }
    }

    let syncedItems = monitorItems;
    if (monitorMode) {
      try {
        syncedItems = await syncMonitorItemsFromState(ctx, trackingId, {
          checkedIds: monitorItems.map((item) => item.id),
          now: endedAt,
        });
      } catch (error) {
        console.warn(`[monitor] item sync failed: ${error.message}`);
      }
    }

    const contractCheck = TRACKING_RESULT.validate(result);
    if (!contractCheck.ok) {
      const detail = contractCheck.errors.map((item) => `${item.path} ${item.message}`).join("; ");
      if (approval) await ctx.approvals.cancel(approval.id, `tracking result invalid: ${detail}`);
      throw new Error(`跟踪结果不符合 pe.tracking-result@v1：${detail}`);
    }
    result = contractCheck.value;

    const message = status === "updated"
      ? (modelWrite?.ok ? `模型更新 · ${result.writeback.version}` : `更新到 v${latestVersion}`)
      : status === "no_change"
        ? (monitorMode
            ? (versionIncreased ? `监测完成 · 审计版本 v${latestVersion}` : `监测完成 · ${monitorItems.length} 项无重大变化`)
            : (versionIncreased ? `无重大变化 · 审计版本 v${latestVersion}` : "无重大变化"))
        : (approval ? "等待模型写回审批" : "等待人工确认");
    const notification = monitorMode
      ? await maybeCreateMonitorNotification({
          ctx,
          trackingId,
          runId,
          result,
          items: syncedItems,
        })
      : null;
    const dto = store.finishTrackingRun(trackingId, runId, {
      status,
      message,
      resultVersion: versionIncreased ? latestVersion : null,
      result,
      sessionId: entry?.id || null,
      notificationId: notification?.id || null,
      decisionClass: result.decision?.class || null,
      confidence: result.decision?.confidence || null,
    });
    broadcastTracking(dto, ctx.id);
    if (target) broadcastMaterial(target, ctx.id);

    try {
      if (versionIncreased) {
        store.recordRunChange({
          runId,
          objectType: "material",
          objectId: targetId,
          before: { version: baseVersion },
          after: { version: latestVersion },
        });
      }
      if (stateRel) {
        const stateMaterial = store.findMaterialByPath(stateRel);
        const stateLatest = stateMaterial?.versions?.[0]?.v ?? null;
        if (stateMaterial?.id && stateLatest && stateLatest !== stateBaseVersion) {
          store.recordRunChange({
            runId,
            objectType: "material",
            objectId: stateMaterial.id,
            before: stateBaseVersion ? { version: stateBaseVersion } : null,
            after: { version: stateLatest },
          });
        }
      }
      if (modelWrite?.ok && modelWrite.material?.id) {
        const modelVersion = modelWrite.material.versions?.[0]?.v ?? null;
        store.recordRunChange({
          runId,
          objectType: "model",
          objectId: modelWrite.material.id,
          before: modelVersion ? { version: Math.max(1, modelVersion - 1), backup: modelWrite.backupRel } : null,
          after: { version: modelVersion, file: modelWrite.workingFile },
        });
      }
    } catch (error) {
      console.warn(`[tracking] failed to record run changes: ${error.message}`);
    }
  } catch (failure) {
    console.error(`[tracking] settle failed: ${failure.message}`);
    if (pendingApproval) {
      try {
        await ctx.approvals.cancel(pendingApproval.id, `tracking settle failed: ${failure.message}`);
      } catch {
        /* approval cancellation is best effort */
      }
    }
    const dto = store.finishTrackingRun(trackingId, runId, {
      status: "failed",
      message: failure.message || "结果处理失败",
      sessionId: entry?.id || null,
    });
    broadcastTracking(dto, ctx.id);
  } finally {
    activeTrackingRuns.delete(trackingId);
  }
}

function isoDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Project observations from analysis-state.json back onto monitor_items after
 * a run. The state file stays canonical; this only keeps the scheduler's
 * projection in sync.
 */
async function syncMonitorItemsFromState(ctx, trackingId, { checkedIds = [], now = new Date() } = {}) {
  const tracking = ctx.store.getTracking(trackingId);
  if (!tracking) return [];
  const items = ctx.store.listMonitorItems(trackingId);
  if (!items.length) return items;
  const { state } = await readTrackingState(ctx, tracking);
  const byFalsifier = new Map();
  const byMonitor = new Map();
  for (const falsifier of Array.isArray(state?.falsifiers) ? state.falsifiers : []) {
    if (falsifier?.id) byFalsifier.set(String(falsifier.id), falsifier);
    if (falsifier?.monitor_id) byMonitor.set(String(falsifier.monitor_id), falsifier);
  }

  const today = isoDay(now);
  for (const item of items) {
    const checked = checkedIds.includes(item.id);
    const falsifier = byFalsifier.get(String(item.falsifierId)) || byMonitor.get(String(item.id));
    const patch = {};
    if (falsifier) {
      if (falsifier.last_observed != null) patch.lastObserved = String(falsifier.last_observed);
      if (falsifier.last_checked_at) patch.lastCheckedAt = String(falsifier.last_checked_at);
      if (falsifier.status) patch.status = String(falsifier.status);
      if (falsifier.next_check_at) patch.nextCheckAt = String(falsifier.next_check_at);
    } else if (checked) {
      patch.status = "unknown";
      patch.lastObserved = item.lastObserved || "unknown";
    }
    if (checked) {
      patch.lastCheckedAt = patch.lastCheckedAt || today;
      if (!falsifier?.next_check_at) {
        const next = computeNextCheck(item.frequency, now);
        if (next) patch.nextCheckAt = next;
      }
    }
    if (Object.keys(patch).length) {
      ctx.store.updateMonitorItem(item.id, patch, trackingId);
    }
  }
  return ctx.store.listMonitorItems(trackingId);
}

async function maybeCreateMonitorNotification({ ctx, trackingId, runId, result, items }) {
  try {
    const checks = Array.isArray(result?.monitorChecks) ? result.monitorChecks : [];
    const triggered = checks.filter((check) => check.status === "triggered");
    const warnings = checks.filter((check) => check.status === "warning");
    const invalidated = Array.isArray(result?.invalidations)
      ? result.invalidations.filter((item) => item.triggered)
      : [];
    const needsReview = result?.status === "needs_review";
    const updated = result?.status === "updated";
    const allUnknown = checks.length > 0 && checks.every((check) => check.status === "unknown");
    if (!triggered.length && !warnings.length && !invalidated.length && !needsReview && !updated && !allUnknown) {
      return null;
    }

    const byId = new Map(items.map((item) => [item.id, item]));
    const first = triggered[0] || warnings[0];
    const metric = first ? (byId.get(first.id)?.metric || "") : "";
    let title;
    if (triggered.length) title = `${triggered[0].id} 触发：${metric}`;
    else if (warnings.length) title = `${warnings[0].id} 接近阈值：${metric}`;
    else if (allUnknown) title = `监测项缺数据：${checks.length} 项`;
    else if (needsReview) title = `跟踪需要确认：${result.conclusion}`;
    else title = `跟踪已更新：${result.conclusion}`;

    const severity = result?.decision?.action === "propose" || triggered.length || invalidated.length || needsReview
      ? "action"
      : "attention";
    const body = [result.conclusion, result.summary].filter(Boolean).join(" — ").slice(0, 800);
    const changes = [
      ...triggered.map((check) => ({
        object: "monitor",
        id: check.id,
        before: byId.get(check.id)?.lastObserved || "",
        after: check.observed || "",
        status: check.status,
      })),
      ...warnings.map((check) => ({
        object: "monitor",
        id: check.id,
        before: byId.get(check.id)?.lastObserved || "",
        after: check.observed || "",
        status: check.status,
      })),
      ...(Array.isArray(result.theses) ? result.theses : [])
        .filter((thesis) => thesis.change && thesis.change !== "维持")
        .map((thesis) => ({
          object: "thesis",
          id: thesis.id,
          before: "",
          after: thesis.status,
          note: thesis.change,
        })),
    ];

    const safeTitle = title.slice(0, 120);
    const recent = ctx.store.listNotifications({ trackingId, limit: 1 })[0];
    if (recent && recent.title === safeTitle) {
      const age = Date.now() - new Date(recent.createdAt).getTime();
      if (Number.isFinite(age) && age < 30 * 60 * 1000) return recent;
    }
    const notification = ctx.store.createNotification({
      trackingId,
      runId,
      severity,
      title: safeTitle,
      body,
      changes,
      actions: [
        { action: "open", label: "查看差异" },
        { action: "undo", label: "撤销" },
        { action: "edit", label: "调整阈值" },
      ],
    });
    broadcastGlobal({ type: "notification.created", notification }, ctx.id);
    notifyDesktop({ title, body, subtitle: ctx.name || "PE Workbench" });
    return notification;
  } catch (error) {
    console.warn(`[monitor] notification failed: ${error.message}`);
    return null;
  }
}

function monitorKeywords(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[\s\/、,，;；:：()（）\[\]【】]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function triageSourceEvent({ event, state, items }) {
  const text = `${event.title || ""} ${event.snippet || ""} ${event.content || ""}`.toLowerCase();
  const company = String(state?.subject?.company || "").toLowerCase();
  const security = String(state?.subject?.security || "").toLowerCase();
  let score = 0;
  const matches = [];
  const itemIds = [];
  if (company && text.includes(company)) {
    score += 2;
    matches.push(company);
  }
  if (security && text.includes(security)) {
    score += 2;
    matches.push(security);
  }
  for (const item of items) {
    const tokens = [
      ...monitorKeywords(item.metric),
      ...monitorKeywords(item.source?.query),
    ];
    const hit = tokens.find((token) => text.includes(token));
    if (hit) {
      score += 1;
      itemIds.push(item.id);
      matches.push(`${item.id}:${hit}`);
    }
  }
  return {
    status: score >= 2 ? "relevant" : "ignored",
    relevance: JSON.stringify({ score, matches: [...new Set(matches)].slice(0, 12), itemIds }),
    itemIds: [...new Set(itemIds)],
  };
}

function parseAnySearchResults(text) {
  const raw = String(text || "");
  const chunks = raw.split(/\n(?=##\s+\d+\.\s)/).filter((chunk) => /^##\s+\d+\.\s/.test(chunk.trim()));
  return chunks.map((chunk) => {
    const title = chunk.match(/^##\s+\d+\.\s*(.+)$/m)?.[1]?.trim() || "";
    const url = chunk.match(/^来源：\s*(\S+)/m)?.[1]?.trim() || "";
    const snippet = chunk.match(/^摘要：\s*(.+)$/m)?.[1]?.trim() || "";
    return { title, url, snippet, content: chunk.replace(/^##\s+\d+\.\s*.+$/m, "").trim() };
  }).filter((item) => item.title || item.url);
}

function westockSymbol(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^(sh|sz|bj|hk|us|t|ks|kq|fu|fx|pt)/i.test(raw)) return raw.toLowerCase();
  const match = raw.match(/^(\d{6})\.(SS|SH|SZ|BJ)$/i);
  if (!match) return raw;
  const suffix = match[2].toUpperCase();
  const prefix = suffix === "SZ" || suffix === "BJ" ? suffix.toLowerCase() : "sh";
  return `${prefix}${match[1]}`;
}

async function syncSourceBindings(ctx, trackingId) {
  const tracking = ctx.store.getTracking(trackingId);
  if (!tracking) return [];
  const { state } = await readTrackingState(ctx, tracking);
  const items = ctx.store.listMonitorItems(trackingId);
  if (!items.length) {
    ctx.store.replaceSourceBindings(trackingId, []);
    return [];
  }
  const company = state?.subject?.company || "";
  const security = state?.subject?.security || "";
  const query = [company, security, "公告 财报 新闻 行业"].filter(Boolean).join(" ").trim();
  if (!query) return [];
  const bindings = [{
    adapter: "anysearch",
    query,
    sourceTier: 3,
    intervalMinutes: 360,
    nextPollAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  }];
  const westock = westockSymbol(security);
  if (westock) {
    bindings.push({
      adapter: "westock",
      query: westock,
      sourceTier: 1,
      intervalMinutes: 720,
      nextPollAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
  }
  return ctx.store.replaceSourceBindings(trackingId, bindings);
}

function parseMarkdownTable(text) {
  const lines = String(text || "").split("\n").filter((line) => line.trim().startsWith("|"));
  if (lines.length < 3) return [];
  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const header = cells(lines[0]);
  return lines.slice(2).map((line) => {
    const values = cells(line);
    const row = {};
    header.forEach((key, index) => { row[key] = values[index] || ""; });
    return row;
  }).filter((row) => row.title || row.summary);
}

async function pollWestockBinding(ctx, binding) {
  const tool = ctx.tools.find((item) => item.name === "westock_query");
  if (!tool) return { events: 0, skipped: true };
  const security = westockSymbol(binding.query);
  const created = [];
  for (const [kind, args, tier] of [
    ["news", ["news", security], 3],
    ["notice", ["notice", "list", security], 1],
  ]) {
    const result = await tool.execute("source-scheduler", { args });
    if (result?.isError) continue;
    const text = (result?.content || []).find((part) => part.type === "text")?.text || "";
    const rows = parseMarkdownTable(text).slice(0, 8);
    const tracking = ctx.store.getTracking(binding.trackingId);
    const { state } = tracking ? await readTrackingState(ctx, tracking) : { state: null };
    const items = ctx.store.listMonitorItems(binding.trackingId);
    for (const row of rows) {
      const candidate = {
        title: row.title || row.summary || "",
        url: row.url || "",
        snippet: row.summary || row.src || "",
        content: `${row.title || ""} ${row.summary || ""}`,
        publishedAt: row.time || null,
      };
      if (!candidate.title) continue;
      const triage = triageSourceEvent({ event: candidate, state, items });
      let domain = "";
      try { domain = new URL(candidate.url).hostname; } catch { domain = "westock"; }
      const event = ctx.store.createSourceEvent({
        trackingId: binding.trackingId,
        monitorItemId: triage.itemIds[0] || null,
        adapter: kind === "notice" ? "westock-notice" : "westock-news",
        sourceTier: tier,
        domain,
        url: candidate.url,
        title: candidate.title,
        publishedAt: candidate.publishedAt,
        payload: { snippet: candidate.snippet, id: row.id || "", kind },
        triageStatus: triage.status,
        relevance: triage.relevance,
      });
      if (!event.duplicate) created.push(event);
    }
  }
  return { events: created.length };
}

async function ingestUploadEvent(ctx, material, name) {
  const title = `上传资料：${name}`;
  for (const tracking of ctx.store.listTrackings()) {
    const items = ctx.store.listMonitorItems(tracking.id);
    if (!items.length) continue;
    const { state } = await readTrackingState(ctx, tracking);
    if (!state) continue;
    const company = String(state?.subject?.company || "").toLowerCase();
    const security = String(state?.subject?.security || "").toLowerCase();
    const haystack = `${name} ${material.relPath || ""}`.toLowerCase();
    const matches = (company && haystack.includes(company)) || (security && haystack.includes(security));
    if (!matches) continue;
    const triage = triageSourceEvent({
      event: { title, content: haystack, snippet: material.relPath },
      state,
      items,
    });
    const event = ctx.store.createSourceEvent({
      trackingId: tracking.id,
      monitorItemId: triage.itemIds[0] || null,
      adapter: "upload",
      sourceTier: 2,
      domain: "local",
      url: material.relPath || "",
      title,
      payload: { file: material.relPath, snippet: name },
      triageStatus: triage.status,
      relevance: triage.relevance,
    });
    if (!event.duplicate) {
      broadcastGlobal({ type: "event.created", event }, ctx.id);
    }
  }
}

async function pollSourceBinding(ctx, binding) {
  if (binding.adapter === "westock") return pollWestockBinding(ctx, binding);
  if (binding.adapter !== "anysearch") return { events: 0, skipped: true };
  const tool = ctx.tools.find((item) => item.name === "anysearch_search");
  if (!tool) return { events: 0, skipped: true };
  const result = await tool.execute("source-scheduler", {
    query: binding.query,
    maxResults: 6,
  });
  if (result?.isError) throw new Error(result.content?.[0]?.text || "搜索失败");
  const text = (result?.content || []).find((part) => part.type === "text")?.text || "";
  const parsed = parseAnySearchResults(text);
  const tracking = ctx.store.getTracking(binding.trackingId);
  const { state } = tracking ? await readTrackingState(ctx, tracking) : { state: null };
  const items = ctx.store.listMonitorItems(binding.trackingId);
  let created = 0;
  for (const candidate of parsed) {
    const triage = triageSourceEvent({ event: candidate, state, items });
    let domain = "";
    try {
      domain = new URL(candidate.url).hostname;
    } catch {
      domain = "";
    }
    const event = ctx.store.createSourceEvent({
      trackingId: binding.trackingId,
      monitorItemId: triage.itemIds[0] || null,
      adapter: binding.adapter,
      sourceTier: binding.sourceTier || 3,
      domain,
      url: candidate.url,
      title: candidate.title,
      payload: { snippet: candidate.snippet, content: candidate.content },
      triageStatus: triage.status,
      relevance: triage.relevance,
    });
    if (!event.duplicate) created += 1;
  }
  return { events: created, parsed: parsed.length };
}

function trackingWorkspaceFiles(ctx, target) {  const targetPath = target?.relPath || "";
  const files = [];
  for (const material of ctx.store.listMaterials()) {
    const relPath = material?.relPath;
    if (!relPath || relPath === targetPath) continue;
    if (relPath.startsWith(".tracking/") || relPath.includes("/backups/")) continue;
    const version = material.versions?.[0];
    files.push({
      path: relPath,
      name: material.name,
      kind: material.kind === "output" ? "output" : "input",
      version: version?.v ?? 1,
      size: version?.size ?? null,
      updatedAt: version?.createdAt || material.updatedAt || "",
    });
  }
  files.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "input" ? -1 : 1;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
  return files.slice(0, 80);
}

async function readTrackingState(ctx, tracking) {
  const targetPath = tracking?.relPath || tracking?.targetPath || "";
  if (!targetPath) return { relPath: "", state: null, error: "目标文件路径为空" };
  const dir = path.posix.dirname(targetPath);
  const relPath = path.posix.join(dir, "analysis-state.json");
  const absolute = path.join(ctx.root, relPath);
  try {
    const raw = await fsp.readFile(absolute, "utf8");
    return { relPath, state: JSON.parse(raw), error: null };
  } catch (error) {
    return {
      relPath,
      state: null,
      error: error.code === "ENOENT" ? `同目录没有 analysis-state.json（${relPath}）` : `无法读取状态文件：${error.message}`,
    };
  }
}

async function writeTrackingState(ctx, relPath, state, { note = "模型绑定", reason = "model metadata" } = {}) {
  const absolute = path.join(ctx.root, relPath);
  const temp = `${absolute}.tmp-${process.pid}`;
  await fsp.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fsp.rename(temp, absolute);
  return ctx.store.indexFile(relPath, {
    source: "agent",
    author: "Workbench",
    note,
    status: "draft",
    visibility: "internal",
    reason,
  });
}

async function runTracking(ctx, trackingId, {
  trigger = "manual",
  scheduledFor = null,
  monitorMode = false,
  monitorItemIds = [],
  events = [],
  eventIds = [],
} = {}) {
  const store = ctx.store;
  if (activeTrackingRuns.has(trackingId)) {
    throw Object.assign(new Error("tracking is running"), { status: 409 });
  }
  const row = store.getTrackingRow(trackingId);
  if (!row) throw Object.assign(new Error("tracking not found"), { status: 404 });
  const current = store.getTracking(trackingId);
  if (current?.running) throw Object.assign(new Error("tracking is running"), { status: 409 });
  const target = store.getMaterial(row.target_id);
  if (!target) throw Object.assign(new Error("target file not found"), { status: 400 });

  const stateInfo = await readTrackingState(ctx, current);
  const stateMaterial = stateInfo.relPath ? store.findMaterialByPath(stateInfo.relPath) : null;
  const stateBaseVersion = stateMaterial?.versions?.[0]?.v ?? null;

  const monitorItems = monitorMode
    ? store.listMonitorItems(trackingId).filter((item) => (
        item.status !== "retired"
        && (!monitorItemIds.length || monitorItemIds.includes(item.id))
      ))
    : [];
  if (monitorMode && !monitorItems.length) {
    throw Object.assign(new Error("没有到期的监测项"), { status: 409 });
  }

  const baseVersion = target.versions?.[0]?.v ?? 0;
  activeTrackingRuns.add(trackingId);
  let run;
  try {
    run = store.startTrackingRun(trackingId, {
      trigger,
      baseVersion,
      scheduledFor,
    });
    run.trigger = trigger;
  } catch (error) {
    activeTrackingRuns.delete(trackingId);
    throw error;
  }
  broadcastTracking(store.getTracking(trackingId), ctx.id);

  const resultRel = `.tracking/${trackingId}/${run.id}.json`;
  const resultAbs = path.join(ctx.root, resultRel);
  const template = templateFor(row.template_id);
  let backupRel = null;
  let entry;
  try {
    await fsp.mkdir(path.dirname(resultAbs), { recursive: true });
    if (template.writeMode === "in_place") {
      backupRel = await backupTrackingTarget(ctx, target, run.id);
    }
    entry = await createEntry({ id: crypto.randomUUID(), ctx });
  } catch (error) {
    activeTrackingRuns.delete(trackingId);
    store.clearTrackingLease(trackingId);
    const dto = store.finishTrackingRun(trackingId, run.id, {
      status: "failed",
      message: error?.message || "无法备份目标文件或创建跟踪会话",
    });
    broadcastTracking(dto, ctx.id);
    throw error;
  }

  entry.title = monitorMode ? `[跟踪] ${current?.targetName || target.name} · 监测` : `[跟踪] ${current?.targetName || target.name}`;
  entry.session.setSessionName(entry.title);
  entry.updatedAt = nowIso();
  entry.trackingRun = { runId: run.id, trackingId, monitorMode };
  if (eventIds.length) {
    ctx.store.markSourceEventsUsed(eventIds, run.id);
  }
  if (monitorMode) {
    entry.monitorRun = { runId: run.id, trackingId };
  }

  const prompt = buildTrackingPrompt({
    trackingId,
    runId: run.id,
    targetPath: target.relPath,
    targetName: target.name,
    templateId: row.template_id,
    baseVersion,
    resultRelPath: resultRel,
    backupRelPath: backupRel,
    trigger,
    workspaceFiles: trackingWorkspaceFiles(ctx, target),
    skillsDir: SKILLS_DIR,
    monitorItems,
    monitorMode,
    events,
  });

  let settled = false;
  let unsubscribe = null;
  let watchdog = null;
  const finish = (error = null) => {
    if (settled) return;
    settled = true;
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    try {
      unsubscribe?.();
    } catch {
      /* ignore */
    }
    void settleTrackingRun({
      ctx,
      trackingId,
      runId: run.id,
      entry,
      run,
      targetId: row.target_id,
      baseVersion,
      resultAbs,
      backupRel,
      error,
      monitorMode,
      monitorItems,
      stateRel: stateInfo.relPath,
      stateMaterialId: stateMaterial?.id || null,
      stateBaseVersion,
    });
  };

  const maxRuntimeMs = Number(process.env.TRACKING_MAX_RUNTIME_MS || 15 * 60 * 1000);
  watchdog = setTimeout(() => {
    try {
      entry.session.abort?.();
    } catch {
      /* ignore */
    }
    finish(new Error("跟踪运行超时，已停止等待"));
  }, Math.max(60_000, maxRuntimeMs));
  watchdog.unref?.();

  unsubscribe = entry.session.subscribe((event) => {
    if (event.type === "agent_settled") finish(null);
  });

  try {
    entry.session.prompt(prompt, {}).catch((error) => finish(error));
  } catch (error) {
    finish(error);
  }

  return {
    runId: run.id,
    sessionId: entry.id,
    tracking: store.getTracking(trackingId),
  };
}


  return {
    activeTrackingRuns,
    runTracking,
    settleTrackingRun,
    readTrackingState,
    writeTrackingState,
    syncSourceBindings,
    pollSourceBinding,
    ingestUploadEvent,
    backupTrackingTarget,
    triageSourceEvent,
    formatRunDuration,
    lastAssistantText,
  };
}

export default createTrackingService;
