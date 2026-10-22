/**
 * Model trace: an append-only, ordered history of a valuation model.
 *
 * One row answers three questions:
 *   - what changed (title / summary / changes)
 *   - why it changed (reason)
 *   - which files changed (files)
 *
 * The first version seeds from the old judgment card (if one exists) so the
 * historical stages are not lost. New projects start from the model/report file
 * baseline. After that, the trace only grows: human judgments and confirmed
 * adjustments append new entries instead of rewriting history.
 */

import fs from "node:fs";
import path from "node:path";

const REPORT_NAME = "投资框架报告.md";
const STATE_NAME = "analysis-state.json";
const VERDICTS = new Set(["high", "fair", "low"]);
const VERDICT_LABEL = { high: "偏高", fair: "合理", low: "偏低" };
const VERDICT_DIRECTION = { high: "下调", low: "上调" };

function walkFiles(dir, predicate, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, predicate, out);
    else if (predicate(full, entry.name)) out.push(full);
  }
  return out;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function latestState(store, root) {
  if (root) {
    const files = walkFiles(path.join(root, "exports"), (_full, name) => name === STATE_NAME)
      .map((file) => {
        try {
          return { file, mtime: fs.statSync(file).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    for (const item of files) {
      const parsed = readJsonFile(item.file);
      if (parsed) return parsed;
    }
  }
  const material = store.findMaterialByName(STATE_NAME, { includeDeleted: true });
  const version = material ? store.getLatestMaterialVersion(material.id) : null;
  const text = version ? store.readMaterialVersionText(material.id, version.v) : null;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function stageAt(stage) {
  const text = String(stage?.committedAt || stage?.date || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!match) return nowIso();
  const [, year, month, day, hour, minute] = match;
  return new Date(`${year}-${month}-${day}T${hour || "09"}:${minute || "00"}:00+08:00`).toISOString();
}

function stageKind(stage, index) {
  if (index === 0) return "generated";
  const intent = String(stage?.intent || "");
  if (intent === "revise") return "revised";
  if (intent === "branch") return "branch";
  if (intent === "checkpoint") return "checkpoint";
  return "updated";
}

function cleanReason(value) {
  return String(value || "")
    .replace(/^\s*为什么变[：:]\s*/, "")
    .trim();
}

function normalizeVerdict(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (VERDICTS.has(raw)) return raw;
  if (raw === "偏高" || raw === "高") return "high";
  if (raw === "合理" || raw === "中性" || raw === "合适") return "fair";
  if (raw === "偏低" || raw === "低") return "low";
  return null;
}

function isValuationChange(entry) {
  if (!entry) return false;
  if (entry.kind === "generated") return true;
  if (entry.kind === "proposed") return true;
  if (entry.kind !== "revised") return false;
  const text = `${entry.title || ""} ${entry.reason || ""} ${(entry.changes || []).join(" ")}`;
  if (/目标价[^。\n]{0,40}(未变|不变)/.test(text)) return false;
  if (/目标价/.test(text)) return true;
  if (/[0-9]+\s*(→|->)\s*[0-9]+/.test(text)) return true;
  return false;
}

function baseName(rel) {
  return String(rel || "").split("/").pop() || String(rel || "");
}

function isReportFile(rel) {
  return baseName(rel) === REPORT_NAME;
}

function isStateFile(rel) {
  return baseName(rel) === STATE_NAME;
}

function isModelFile(rel) {
  return /\.(xlsx|xlsm)$/i.test(rel);
}

function isProposalFile(rel) {
  if (!String(rel || "").startsWith("exports/")) return false;
  if (isReportFile(rel) || isStateFile(rel) || isModelFile(rel)) return false;
  if (!/\.(md|tsv|csv|json)$/i.test(rel)) return false;
  return /估值|归母|模型|框架|调整方案|少数股东|投资判断/.test(baseName(rel));
}

function cleanText(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\r/g, "")
    .trim();
}

function extractTargetChange(text) {
  const patterns = [
    /目标价(?:区间)?[^。\n]{0,80}?(\d+(?:\.\d+)?(?:\s*[–-]\s*\d+(?:\.\d+)?)?)\s*元?[^。\n]{0,30}?(?:下移|下调|上移|上调|调整|变|至|→|到)\s*[^。\n]{0,12}?(\d+(?:\.\d+)?(?:\s*[–-]\s*\d+(?:\.\d+)?)?)/,
    /(\d+(?:\.\d+)?(?:\s*[–-]\s*\d+(?:\.\d+)?))\s*元?\s*(?:→|->|下移|下调|上移|上调)\s*(\d+(?:\.\d+)?(?:\s*[–-]\s*\d+(?:\.\d+)?))/,
  ];
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match) {
      return {
        from: match[1].replace(/\s+/g, ""),
        to: match[2].replace(/\s+/g, ""),
      };
    }
  }
  return null;
}

function runMethodLabel(text, files = []) {
  const joined = `${text || ""} ${files.join(" ")}`;
  if (/归母|少数股东|Mi\s*系数/i.test(joined)) return "归母口径";
  return "";
}

function buildRunSummary({ targetChange, method, text, files }) {
  if (targetChange) {
    return `目标价 ${targetChange.from} → ${targetChange.to}${method ? ` · ${method}` : ""}`;
  }
  const first = cleanText(text).split(/[。\n]/).map((line) => line.trim()).find(Boolean) || "";
  return (first || files.map(baseName).join(" · ")).slice(0, 120);
}

function buildRunReason(text, files) {
  const cleaned = cleanText(text);
  if (!cleaned) return `本次运行修改了：${files.map(baseName).join("、")}`;
  const sentences = cleaned.split(/(?<=[。！？\n])/).map((line) => line.trim()).filter(Boolean);
  const picked = sentences.filter((line) => /目标价|归母|少数股东|估值|EPS|Mi|毛利率|净利/.test(line)).slice(0, 4);
  const reason = (picked.length ? picked : sentences.slice(0, 3)).join(" ");
  return reason.slice(0, 600);
}

function buildRunTitle({ kind, targetChange, method, files }) {
  const prefix = method || "模型";
  if (targetChange) {
    const suffix = kind === "proposed" ? "调整提案" : "更新";
    return `${prefix}${suffix}：目标价 ${targetChange.from} → ${targetChange.to}`;
  }
  if (kind === "proposed") {
    const name = files.map(baseName).find((item) => /调整|方案|归母|估值/.test(item));
    return name ? `模型调整提案：${name.replace(/\.(md|tsv|csv|json)$/i, "")}` : "模型调整提案";
  }
  return files.some(isReportFile) ? "模型更新：投资框架报告" : "模型更新";
}

function materialRef(material, extra = {}) {
  const latest = Array.isArray(material?.versions) ? material.versions[0] : null;
  return {
    materialId: material.id,
    name: material.name,
    path: material.relPath || material.path || null,
    version: latest?.v ?? null,
    kind: material.kind || null,
    label: extra.label || material.name,
    effect: extra.effect || "",
  };
}

function materialRefFromRow(row, version, extra = {}) {
  return {
    materialId: row.deleted_at ? null : row.id,
    name: row.name,
    path: row.path || null,
    version: version?.v ?? null,
    kind: row.kind || null,
    label: extra.label || row.name,
    effect: extra.effect || "",
  };
}

function dedupeFiles(files) {
  const seen = new Set();
  const out = [];
  for (const file of files.filter(Boolean)) {
    const key = file.materialId || file.path || file.name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

function buildMaterialIndex(store) {
  const materials = store.listMaterials();
  const byId = new Map();
  const byPath = new Map();
  const byName = new Map();
  for (const material of materials) {
    byId.set(material.id, material);
    if (material.relPath) byPath.set(material.relPath, material);
    byName.set(material.name, material);
  }
  const modelMaterial = materials.find((material) => /\.(xlsx|xlsm)$/i.test(material.name)) || null;
  return { materials, byId, byPath, byName, modelMaterial };
}

function resolveDriverFile(driver, ctx) {
  const kind = String(driver?.kind || "");
  const ref = String(driver?.ref || "");
  let material = null;

  if (kind === "file") {
    const evidence = (ctx.card.evidence || []).find((item) => item.id === ref);
    if (evidence?.materialId) material = ctx.byId.get(evidence.materialId) || null;
  } else if (kind === "model") {
    if (ctx.card.model?.materialId) material = ctx.byId.get(ctx.card.model.materialId) || null;
    if (!material) material = ctx.modelMaterial;
  } else if (kind === "report") {
    const path = ctx.card.provenance?.reportFile;
    if (path) material = ctx.byPath.get(path) || null;
    if (!material) material = ctx.byName.get(REPORT_NAME) || null;
  } else if (kind === "state") {
    const path = ctx.card.provenance?.stateFile;
    if (path) material = ctx.byPath.get(path) || null;
    if (!material) material = ctx.byName.get(STATE_NAME) || null;
  }

  if (!material) return null;
  return materialRef(material, { label: driver.label, effect: driver.effect });
}

function fallbackFiles(ctx) {
  const files = [];
  const model = ctx.modelMaterial
    || (ctx.card.model?.materialId ? ctx.byId.get(ctx.card.model.materialId) : null);
  if (model) files.push(materialRef(model, { label: "估值模型" }));

  const reportPath = ctx.card.provenance?.reportFile;
  const report = (reportPath && ctx.byPath.get(reportPath)) || ctx.byName.get(REPORT_NAME);
  if (report) files.push(materialRef(report, { label: "投资框架报告" }));

  const statePath = ctx.card.provenance?.stateFile;
  const state = (statePath && ctx.byPath.get(statePath)) || ctx.byName.get(STATE_NAME);
  if (state) files.push(materialRef(state, { label: "analysis-state" }));

  return dedupeFiles(files);
}

function adjustmentFiles(store, focusFiles = [], root = null) {
  const index = buildMaterialIndex(store);
  const exists = (file) => {
    if (!file) return false;
    if (!root || !file.path) return true;
    return fs.existsSync(path.join(root, file.path));
  };
  const pickByName = (name, label) => {
    const live = index.byName.get(name);
    if (live) return materialRef(live, { label });
    const row = store.findMaterialByName(name, { includeDeleted: true });
    if (!row) return null;
    return materialRefFromRow(row, store.getLatestMaterialVersion(row.id), { label });
  };

  const working = pickByName("工作模型.xlsx", "工作模型")
    || (() => {
      const material = index.materials.find((item) => /\/model\/[^/]+\.(xlsx|xlsm)$/i.test(item.relPath || ""));
      return material ? materialRef(material, { label: "工作模型" }) : null;
    })();
  const report = pickByName(REPORT_NAME, "投资框架报告");
  const state = pickByName(STATE_NAME, "analysis-state");
  const picked = [working, report, state].filter(Boolean).filter(exists);
  if (picked.length) return dedupeFiles(picked);

  const outputs = focusFiles.filter((file) => file.kind === "output").filter(exists);
  if (outputs.length) return dedupeFiles(outputs);
  return dedupeFiles(focusFiles.filter((file) => /\.(xlsx|xlsm|md|json)$/i.test(file.name || "")).filter(exists));
}

function seedFromCard(store, projectId, card) {
  const index = buildMaterialIndex(store);
  const ctx = { ...index, card };
  const stages = (Array.isArray(card.stages) ? card.stages : [])
    .filter(Boolean)
    .sort((a, b) => Date.parse(stageAt(a)) - Date.parse(stageAt(b)));
  if (!stages.length) return seedFromFiles(store, projectId, index);

  stages.forEach((stage, stageIndex) => {
    const drivers = Array.isArray(stage.change?.drivers) ? stage.change.drivers : [];
    let files = dedupeFiles(drivers.map((driver) => resolveDriverFile(driver, ctx)));
    if (!files.length) files = fallbackFiles(ctx);
    const title = String(stage.change?.headline || stage.label || `第 ${stageIndex + 1} 次变化`).trim();
    store.appendTraceEntry({
      workspaceId: projectId,
      at: stageAt(stage),
      kind: stageKind(stage, stageIndex),
      title,
      summary: String(stage.summary || "").trim(),
      reason: cleanReason(stage.change?.why || stage.summary),
      files,
      changes: Array.isArray(stage.diffTags) ? stage.diffTags : [],
      source: { type: "card_stage", stageId: stage.id || null, intent: stage.intent || "continue" },
    });
  });
  return true;
}

function seedFromFiles(store, projectId, index) {
  const model = index.modelMaterial;
  const report = index.byName.get(REPORT_NAME) || null;
  const state = index.byName.get(STATE_NAME) || null;
  if (!model && !report) return false;

  const files = dedupeFiles([
    model ? materialRef(model, { label: "估值模型" }) : null,
    report ? materialRef(report, { label: "投资框架报告" }) : null,
    state ? materialRef(state, { label: "analysis-state" }) : null,
  ]);
  const versions = [];
  for (const material of [model, report].filter(Boolean)) {
    const oldest = Array.isArray(material.versions) ? material.versions[material.versions.length - 1] : null;
    if (oldest?.createdAt) versions.push(oldest.createdAt);
  }
  const at = versions.length ? new Date(Math.min(...versions.map((value) => Date.parse(value)))).toISOString() : nowIso();
  const first = model || report;
  const title = model ? "生成估值模型" : "生成投资框架报告";
  store.appendTraceEntry({
    workspaceId: projectId,
    at,
    kind: "generated",
    title,
    summary: first?.name || "",
    reason: "首次生成/上传，作为追踪起点。后续每次变化都会追加在这里。",
    files,
    changes: ["建立模型基线"],
    source: { type: "file", materialId: first?.id || null, version: files[0]?.version ?? null },
  });
  return true;
}

function buildAdjustPrompt({ verdict, note, files, subject }) {
  const label = VERDICT_LABEL[verdict] || "偏高";
  const direction = VERDICT_DIRECTION[verdict] || "调整";
  const paths = files.map((file) => file.path).filter(Boolean);
  const targets = paths.length
    ? paths.map((item) => `- \`${item}\``).join("\n")
    : "- 当前项目的估值模型、投资框架报告与 analysis-state.json";
  const noteLine = note ? `\n人工备注：${note}` : "";
  return `人工判断：${subject || "本项目"}的最新一次估值${label}。请复核并调整估值模型与投资框架。
${noteLine}

要求：
1. 找出导致估值${label}的关键假设（收入、毛利率、ASP、产能、折现率等），用可核验的数据修正。
2. 重算目标价，并按“${direction}”方向更新；说明目标价从多少到多少。
3. 同步更新投资框架报告与 analysis-state.json，保持数字和判断一致。
4. 说明改了哪些假设、哪些单元格、哪些文件；不要只解释，要实际修改文件。
5. 不要修改 inputs/ 或 uploads/ 中的原始资料，不要覆盖原始模型。

目标文件：
${targets}`;
}

function buildAdoptionPrompt({ entry, note, files, subject }) {
  const paths = files.map((file) => file.path).filter(Boolean);
  const targets = paths.length
    ? paths.map((item) => `- \`${item}\``).join("\n")
    : "- 当前项目的投资框架报告、估值模型与 analysis-state.json";
  const noteLine = note ? `\n人工备注：${note}` : "";
  return `人工已采纳这次估值调整提案：${entry?.title || subject || "本项目"}。请把提案正式写入主投资框架报告、估值模型和 analysis-state.json。
${noteLine}

提案摘要：${entry?.summary || entry?.title || ""}
提案原因：${entry?.reason || ""}

要求：
1. 按提案中的目标价区间、关键假设（如归母系数 Mi）和情景，更新主报告与模型；不要重新发明一套结论。
2. 同步更新 analysis-state.json，保持目标价、EPS、净利率和判断一致。
3. 说明改了哪些假设、哪些单元格、哪些文件，以及目标价从多少到多少。
4. 不要修改 inputs/ 或 uploads/ 中的原始资料，不要覆盖原始模型。
5. 不要只解释，要实际修改文件。

目标文件：
${targets}`;
}

export function createTraceService({ store, projectId, projectName = "", root = null }) {
  function ensure() {
    const existing = store.listTraceEntries(projectId);
    if (existing.length) return existing;
    const card = store.getJudgmentCard(projectId);
    if (card && Array.isArray(card.stages) && card.stages.length) {
      seedFromCard(store, projectId, card);
    } else {
      seedFromFiles(store, projectId, buildMaterialIndex(store));
    }
    return store.listTraceEntries(projectId);
  }

  function buildView() {
    const entries = ensure();
    const card = store.getJudgmentCard(projectId);
    const judgments = store.listTraceJudgments(projectId);
    const byEntry = new Map();
    for (const judgment of judgments) {
      if (!byEntry.has(judgment.entryId)) byEntry.set(judgment.entryId, judgment);
    }
    const decorated = entries.map((entry) => ({
      ...entry,
      judgment: byEntry.get(entry.id) || null,
    }));
    const lastChange = [...decorated].reverse().find((entry) => isValuationChange(entry)) || null;
    const pending = judgments.find((judgment) => judgment.status === "pending_confirmation") || null;
    const modelMaterial = buildMaterialIndex(store).modelMaterial;
    const state = latestState(store, root);
    const stateTarget = (state?.valuations || []).find((valuation) => valuation.id === "V1")?.value;
    const target = Number.isFinite(Number(stateTarget))
      ? Number(stateTarget)
      : (card?.conclusion?.target ?? null);
    const previousTarget = card?.conclusion?.previousTarget ?? null;
    const delta = previousTarget && target
      ? `${((target / previousTarget - 1) * 100).toFixed(1)}%`
      : (card?.conclusion?.delta || "");
    const subject = state?.subject?.company || card?.subject || projectName || "本项目";

    return {
      projectId,
      subject,
      question: card?.question || "估值模型的变更记录",
      model: modelMaterial ? materialRef(modelMaterial) : null,
      current: card?.conclusion || target != null
        ? {
            target,
            previousTarget,
            delta,
            rating: card?.conclusion?.rating || "",
            confidence: card?.conclusion?.confidence || "",
            asOf: decorated[decorated.length - 1]?.at || null,
          }
        : null,
      entries: decorated,
      focus: lastChange && !lastChange.judgment ? lastChange : null,
      pendingJudgment: pending
        ? {
            ...pending,
            entry: decorated.find((entry) => entry.id === pending.entryId) || null,
          }
        : null,
      summary: {
        total: decorated.length,
        firstAt: decorated[0]?.at || null,
        lastAt: decorated[decorated.length - 1]?.at || null,
      },
    };
  }

  function recordRun({
    sessionId = null,
    runId = null,
    trackingRunId = null,
    changedFiles = [],
    text = "",
    at = null,
  } = {}) {
    const files = [...new Set((Array.isArray(changedFiles) ? changedFiles : []).filter(Boolean))];
    if (!files.length) return null;

    const existing = store.listTraceEntries(projectId);
    if (runId && existing.some((entry) => entry.source?.runId === runId && entry.source?.sessionId === sessionId)) {
      return null;
    }
    const signature = files.slice().sort().join("|");
    const duplicate = existing.some((entry) => {
      if (entry.source?.type !== "agent_run") return false;
      const previous = Array.isArray(entry.source.changedFiles)
        ? entry.source.changedFiles.slice().sort().join("|")
        : "";
      return previous === signature && Math.abs(Date.now() - Date.parse(entry.at)) < 10 * 60 * 1000;
    });
    if (duplicate) return null;

    const reportChanged = files.some(isReportFile);
    const modelChanged = files.some(isModelFile);
    const stateChanged = files.some(isStateFile);
    const proposalFiles = files.filter(isProposalFile);
    const targetChange = extractTargetChange(text);
    const valuationSignal = /目标价|估值|EPS|归母|少数股东|Mi\s*系数/.test(text || "");
    const stateApplied = stateChanged
      && (targetChange || /目标价[^。\n]{0,40}(→|下修|上修|下调|上调|调整|至)/.test(text || ""));
    const applied = reportChanged || modelChanged || stateApplied;
    if (!applied && !proposalFiles.length) return null;
    if (!applied && !valuationSignal) return null;

    const kind = applied ? "revised" : "proposed";
    const method = runMethodLabel(text, files);
    const changes = [];
    if (targetChange) changes.push(`目标价 ${targetChange.from} → ${targetChange.to}`);
    if (method) changes.push(method);
    if (reportChanged) changes.push("更新投资框架报告");
    if (modelChanged) changes.push("更新估值模型");

    const index = buildMaterialIndex(store);
    const refs = dedupeFiles(files.map((rel) => {
      const material = index.byPath.get(rel) || index.byName.get(baseName(rel));
      if (material) return materialRef(material, { label: baseName(rel) });
      return {
        materialId: null,
        name: baseName(rel),
        path: rel,
        version: null,
        kind: null,
        label: baseName(rel),
        effect: "",
      };
    }));

    return store.appendTraceEntry({
      workspaceId: projectId,
      at: at || nowIso(),
      kind,
      title: buildRunTitle({ kind, targetChange, method, files }),
      summary: buildRunSummary({ targetChange, method, text, files }),
      reason: buildRunReason(text, files),
      files: refs,
      changes,
      source: {
        type: "agent_run",
        sessionId,
        runId,
        trackingRunId,
        changedFiles: files,
      },
    });
  }

  function judge({ entryId, verdict, note = "", adopt = false } = {}) {
    ensure();
    const entry = store.getTraceEntry(entryId, projectId);
    if (!entry) return { ok: false, status: 404, error: "找不到这条变化" };
    if (!isValuationChange(entry)) {
      return { ok: false, status: 409, error: "这条变化没有改估值，不需要判断" };
    }
    const normalized = normalizeVerdict(verdict);
    if (!normalized) return { ok: false, status: 400, error: "请选择偏高、合理或偏低" };
    const existing = store.listTraceJudgments(projectId).find((item) => item.entryId === entryId);
    if (existing) return { ok: false, status: 409, error: "这条变化已经判断过" };

    const isProposal = entry.kind === "proposed";
    const adopted = normalized === "fair" && isProposal && adopt === true;
    const status = normalized === "fair"
      ? (adopted ? "adopted" : "recorded")
      : "pending_confirmation";
    let judgement = store.appendTraceJudgment({
      workspaceId: projectId,
      entryId,
      verdict: normalized,
      note: String(note || "").trim().slice(0, 200),
      status,
    });
    const label = VERDICT_LABEL[normalized];
    let adoption = null;
    if (adopted) {
      const card = store.getJudgmentCard(projectId);
      const files = adjustmentFiles(store, Array.isArray(entry.files) ? entry.files : [], root);
      const prompt = buildAdoptionPrompt({
        entry,
        note: judgement.note,
        files,
        subject: card?.subject || projectName,
      });
      judgement = store.updateTraceJudgment(judgement.id, { prompt }, projectId);
      adoption = { prompt, entryId: entry.id };
    }
    const message = adopted
      ? "已采纳提案，正在让 Workbench 写入主报告和模型…"
      : normalized === "fair"
        ? (isProposal ? "已记录：认可提案，暂不写入" : "已记录：估值合理，不调整模型")
        : `已记录：估值${label}；请再确认一次是否调整`;
    return {
      ok: true,
      ...buildView(),
      message,
      judgment: judgement,
      ...(adoption ? { adoption } : {}),
    };
  }

  function confirm({ judgmentId, action = "" } = {}) {
    const judgement = store.getTraceJudgment(judgmentId, projectId);
    if (!judgement) return { ok: false, status: 404, error: "找不到这次判断" };
    if (judgement.status !== "pending_confirmation") {
      return { ok: false, status: 409, error: "这次判断已经处理过" };
    }
    const normalizedAction = String(action || "").trim().toLowerCase();
    const label = VERDICT_LABEL[judgement.verdict] || "偏高";

    if (normalizedAction === "cancel" || normalizedAction === "cancel_adjust") {
      store.updateTraceJudgment(judgement.id, { status: "cancelled" }, projectId);
      return {
        ok: true,
        ...buildView(),
        message: `已保留你的判断：估值${label}；这次不调整模型`,
      };
    }
    if (normalizedAction !== "adjust" && normalizedAction !== "confirm") {
      return { ok: false, status: 400, error: "请选择确认调整或先不改" };
    }

    const focus = store.getTraceEntry(judgement.entryId, projectId);
    const files = adjustmentFiles(store, Array.isArray(focus?.files) ? focus.files : [], root);
    const entry = store.appendTraceEntry({
      workspaceId: projectId,
      at: nowIso(),
      kind: "adjustment",
      title: `已确认调整：估值${label}`,
      summary: `人工判断${label}，按“${VERDICT_DIRECTION[judgement.verdict]}”方向调整`,
      reason: judgement.note ? `你的判断：${label}。${judgement.note}` : `你的判断：${label}。`,
      files,
      changes: [`人工判断：估值${label}`],
      source: { type: "judgment", judgmentId: judgement.id, entryId: judgement.entryId },
    });
    const card = store.getJudgmentCard(projectId);
    const prompt = buildAdjustPrompt({
      verdict: judgement.verdict,
      note: judgement.note,
      files,
      subject: card?.subject || projectName,
    });
    const updated = store.updateTraceJudgment(judgement.id, {
      status: "confirmed",
      prompt,
      adjustmentEntryId: entry.id,
    }, projectId);

    return {
      ok: true,
      ...buildView(),
      message: `已确认调整：估值${label}`,
      judgment: updated,
      adjustment: { entryId: entry.id, prompt },
    };
  }

  return {
    view: buildView,
    recordRun,
    judge,
    confirm,
    reset() {
      store.resetTrace(projectId);
      return buildView();
    },
  };
}
