/**
 * Watch finding contract: the only shape a watcher is allowed to surface.
 *
 * A finding must be actionable and traceable: a one-line headline, why it
 * matters (which sensitivity / falsifier), a quantified impact when possible,
 * and at least one clickable source. `material: false` is a valid, silent
 * result and never becomes a chat message.
 */

export const WATCH_FINDING_SCHEMA = "pe.watch.finding/v1";
export const WATCH_SEVERITY = ["critical", "warning", "info"];
export const WATCH_CONFIDENCE = ["high", "medium", "low"];
export const WATCH_AFFECTED_KIND = ["sensitivity", "falsifier", "valuation", "thesis", "data"];

function clean(value, fallback = "") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function clamp(value, limit) {
  const text = clean(value);
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeHttpUrl(value) {
  const raw = clean(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function safeRelPath(value) {
  const raw = clean(value).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!raw || raw.includes("\u0000") || raw.split("/").includes("..")) return "";
  return raw;
}

function normalizeEvidence(raw, index) {
  const item = raw && typeof raw === "object" ? raw : {};
  const url = safeHttpUrl(item.url);
  const filePath = safeRelPath(item.path || item.filePath);
  return {
    title: clamp(item.title || item.label || url || filePath || `来源 ${index + 1}`, 180),
    url,
    path: filePath,
    materialId: clean(item.materialId),
    source: clamp(item.source, 80),
    sourceTier: [1, 2, 3, 4].includes(Number(item.sourceTier)) ? Number(item.sourceTier) : 3,
    publishedAt: clean(item.publishedAt || item.published_at),
    quote: clamp(item.quote || item.snippet, 400),
  };
}

function normalizeAffected(raw) {
  const item = raw && typeof raw === "object" ? raw : {};
  const kind = WATCH_AFFECTED_KIND.includes(item.kind) ? item.kind : "data";
  return {
    kind,
    id: clamp(item.id, 40),
    note: clamp(item.note || item.noteText, 200),
  };
}

function normalizeImpact(raw) {
  if (!raw || typeof raw !== "object") return null;
  const label = clamp(raw.label, 40);
  const from = clamp(raw.from, 40);
  const to = clamp(raw.to, 40);
  const delta = clamp(raw.delta, 40);
  const direction = ["up", "down", "flat"].includes(raw.direction) ? raw.direction : "";
  if (!label && !from && !to) return null;
  return { label: label || "目标价", from, to, delta, direction };
}

export function normalizeFinding(input = {}, { watchId = "", checkId = "", now = new Date() } = {}) {
  const material = input.material === true || input.material === "true";
  const evidence = asArray(input.evidence).map(normalizeEvidence).filter((item) => item.url || item.path);
  return {
    schema: WATCH_FINDING_SCHEMA,
    watchId: clean(watchId || input.watchId),
    checkId: clean(checkId || input.checkId),
    material,
    severity: WATCH_SEVERITY.includes(input.severity) ? input.severity : (material ? "warning" : "info"),
    headline: clamp(input.headline || input.title, 160),
    summary: clamp(input.summary || input.body, 600),
    affected: asArray(input.affected).map(normalizeAffected).filter((item) => item.id || item.note),
    impact: normalizeImpact(input.impact),
    evidence,
    confidence: WATCH_CONFIDENCE.includes(input.confidence) ? input.confidence : "medium",
    materialReason: clamp(input.materialReason || input.material_reason, 600),
    suggestedAction: clamp(input.suggestedAction || input.suggested_action, 400),
    checked: asArray(input.checked).map((item) => clamp(item, 200)).filter(Boolean),
    reportVersion: Number.isFinite(Number(input.reportVersion)) ? Number(input.reportVersion) : null,
    nextWatch: clamp(input.nextWatch || input.next_watch, 300),
    createdAt: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
}

export function validateFinding(finding) {
  const errors = [];
  if (!finding || typeof finding !== "object") return ["finding 不是对象"];
  if (finding.schema !== WATCH_FINDING_SCHEMA) errors.push("finding schema 不匹配");
  if (typeof finding.material !== "boolean") errors.push("material 必须是布尔值");
  if (!WATCH_SEVERITY.includes(finding.severity)) errors.push("severity 非法");
  if (!WATCH_CONFIDENCE.includes(finding.confidence)) errors.push("confidence 非法");
  if (finding.material) {
    if (!finding.headline) errors.push("重大发现缺少 headline");
    if (!finding.summary) errors.push("重大发现缺少 summary");
    if (!finding.evidence.length) errors.push("重大发现至少需要一个可点击链接或本地文件来源");
    if (!finding.materialReason) errors.push("重大发现缺少 materialReason");
    if (!finding.affected.length) errors.push("重大发现至少要关联一个敏感性/失效条件/估值");
  }
  for (const item of asArray(finding.affected)) {
    if (!WATCH_AFFECTED_KIND.includes(item.kind)) errors.push(`affected.kind 非法：${item.kind}`);
  }
  for (const item of asArray(finding.evidence)) {
    if (item.url && !safeHttpUrl(item.url)) errors.push(`证据 URL 非法：${item.url}`);
    if (!item.url && item.path && !safeRelPath(item.path)) errors.push(`证据路径非法：${item.path}`);
  }
  return errors;
}

/**
 * Turn a finding into a chat message row. Only material findings are
 * surfaced; silence is represented by the absence of a message.
 */
export function findingToMessage(finding, { watchId = "", checkId = "" } = {}) {
  if (!finding?.material) return null;
  return {
    watchId: clean(watchId || finding.watchId),
    checkId: clean(checkId || finding.checkId),
    role: "watcher",
    kind: "finding",
    title: finding.headline,
    body: finding.summary,
    severity: finding.severity,
    citations: finding.evidence,
    related: {
      affected: finding.affected,
      impact: finding.impact,
      confidence: finding.confidence,
      materialReason: finding.materialReason,
      suggestedAction: finding.suggestedAction,
      reportVersion: finding.reportVersion,
      nextWatch: finding.nextWatch,
    },
    createdAt: finding.createdAt,
  };
}

/** Status-line text for a check that produced no finding. */
export function silentCheckText(finding) {
  const checked = asArray(finding?.checked).length;
  if (finding?.materialReason) return clamp(finding.materialReason, 120);
  if (checked) return `检查了 ${checked} 条候选，没有重大变化`;
  return "没有重大变化";
}
