/**
 * Monitoring domain: the machine-readable contract between a framework's
 * falsifiers, the background scheduler and the notification layer.
 *
 * The framework's `analysis-state.json` stays the source of truth. A monitor
 * item is a projection of one falsifier plus the operational fields that the
 * scheduler needs (cadence, source tier, autonomy, next check).
 *
 * Keep this module free of I/O and of the Pi agent: server, UI and tests must
 * share exactly the same rules.
 */

export const MONITOR_STATUS = ["armed", "warning", "triggered", "unknown", "retired"];
export const MONITOR_FREQUENCY = ["daily", "weekly", "monthly", "quarterly", "event"];
export const MONITOR_AUTONOMY = ["observe", "propose", "auto_notify", "auto_silent"];
export const CHANGE_CLASS = ["C0", "C1", "C2", "C3", "C4"];
export const SOURCE_TIER = [1, 2, 3, 4];

const DAY = 24 * 60 * 60 * 1000;

const STATUS_LABEL = {
  armed: "监控中",
  warning: "接近阈值",
  triggered: "已触发",
  unknown: "缺数据",
  retired: "已归档",
};

const ACTION_LABEL = {
  observe: "仅记录",
  notify: "提醒",
  apply: "自动应用",
  propose: "待确认",
};

function cleanString(value, fallback = "") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function isDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY);
}

function isoDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function computeNextCheck(frequency, from = new Date()) {
  const base = from instanceof Date ? from : new Date(from);
  if (Number.isNaN(base.getTime())) return null;
  switch (frequency) {
    case "daily": return isoDay(addDays(base, 1));
    case "weekly": return isoDay(addDays(base, 7));
    case "monthly": {
      const next = new Date(base);
      next.setMonth(next.getMonth() + 1);
      return isoDay(next);
    }
    case "quarterly": {
      const next = new Date(base);
      next.setMonth(next.getMonth() + 3);
      return isoDay(next);
    }
    default: return null;
  }
}

export function normalizeSource(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const tier = Number(value.tier);
    return {
      kind: cleanString(value.kind, "unspecified"),
      primary: cleanString(value.primary || value.adapter, "westock_query"),
      fallback: cleanString(value.fallback, "anysearch_search"),
      query: cleanString(value.query),
      tier: SOURCE_TIER.includes(tier) ? tier : 2,
      text: cleanString(value.text),
    };
  }
  return {
    kind: "unspecified",
    primary: "westock_query",
    fallback: "anysearch_search",
    query: "",
    tier: 2,
    text: cleanString(value),
  };
}

export function normalizeMonitorItem(input = {}, { index = 0, trackingId = "" } = {}) {
  const source = normalizeSource(input.source);
  const status = MONITOR_STATUS.includes(input.status) ? input.status : "armed";
  const frequency = MONITOR_FREQUENCY.includes(input.frequency) ? input.frequency : "monthly";
  const autonomy = MONITOR_AUTONOMY.includes(input.autonomy) ? input.autonomy : "auto_notify";
  return {
    id: cleanString(input.id, `MON${index + 1}`),
    tracking_id: cleanString(input.tracking_id, trackingId),
    falsifier_id: cleanString(input.falsifier_id || input.falsifierId),
    thesis_id: cleanString(input.thesis_id || input.thesisId),
    metric: cleanString(input.metric || input.statement || input.name),
    operator: cleanString(input.operator),
    warning: cleanString(input.warning),
    threshold: cleanString(input.threshold || input.statement),
    unit: cleanString(input.unit),
    frequency,
    source,
    action: cleanString(input.action),
    rationale: cleanString(input.rationale || input.basis),
    status,
    last_observed: cleanString(input.last_observed ?? input.lastObserved ?? input.observed),
    last_checked_at: isDate(input.last_checked_at || input.lastCheckedAt) ? (input.last_checked_at || input.lastCheckedAt) : "",
    next_check_at: isDate(input.next_check_at || input.nextCheckAt) ? (input.next_check_at || input.nextCheckAt) : computeNextCheck(frequency),
    autonomy,
  };
}

export function validateMonitorItem(item) {
  const errors = [];
  if (!item?.id) errors.push("缺少监测项 ID");
  if (!item?.thesis_id) errors.push(`${item?.id || "监测项"} 缺少关联观点 thesis_id`);
  if (!item?.metric) errors.push(`${item?.id || "监测项"} 缺少指标 metric`);
  if (!item?.threshold) errors.push(`${item?.id || "监测项"} 缺少失效阈值 threshold`);
  if (!item?.action) errors.push(`${item?.id || "监测项"} 缺少触发动作 action`);
  if (!MONITOR_FREQUENCY.includes(item?.frequency)) errors.push(`${item?.id || "监测项"} 频率非法`);
  if (!MONITOR_STATUS.includes(item?.status)) errors.push(`${item?.id || "监测项"} 状态非法`);
  if (!MONITOR_AUTONOMY.includes(item?.autonomy)) errors.push(`${item?.id || "监测项"} 自治级别非法`);
  if (!item?.source?.text && !item?.source?.primary) errors.push(`${item?.id || "监测项"} 缺少来源`);
  if (item?.next_check_at && !isDate(item.next_check_at)) errors.push(`${item?.id || "监测项"} 下次检查日期非法`);
  return errors;
}

/**
 * Build a proposed monitoring plan from analysis-state.json. This is a pure
 * projection: it never mutates the state and never invents observations.
 */
export function deriveMonitorPlan(state, {
  trackingId = "",
  targetPath = "",
  now = new Date(),
} = {}) {
  const warnings = [];
  const falsifiers = Array.isArray(state?.falsifiers) ? state.falsifiers : [];
  const thesisIds = new Set((Array.isArray(state?.theses) ? state.theses : []).map((thesis) => cleanString(thesis?.id)));
  const company = cleanString(state?.subject?.company);
  const seen = new Set();
  const items = [];

  for (const [index, falsifier] of falsifiers.entries()) {
    const thesisId = cleanString(falsifier?.thesis_id);
    if (thesisId && thesisIds.size && !thesisIds.has(thesisId)) {
      warnings.push(`F${falsifier?.id || index + 1} 关联的观点 ${thesisId} 不存在于状态文件`);
    }
    const item = normalizeMonitorItem({
      id: falsifier?.monitor_id || `MON${index + 1}`,
      tracking_id: trackingId,
      falsifier_id: falsifier?.id,
      thesis_id: thesisId,
      metric: falsifier?.metric || falsifier?.statement,
      operator: falsifier?.operator,
      warning: falsifier?.warning,
      threshold: [falsifier?.operator, falsifier?.threshold].filter(Boolean).join(" "),
      frequency: falsifier?.frequency,
      source: {
        text: falsifier?.source,
        query: falsifier?.source_query || [company, falsifier?.metric].filter(Boolean).join(" "),
        tier: falsifier?.source_tier || 2,
      },
      action: falsifier?.action,
      rationale: falsifier?.threshold,
      status: falsifier?.status,
      last_observed: falsifier?.last_observed ?? falsifier?.observed,
      last_checked_at: falsifier?.last_checked_at,
      next_check_at: falsifier?.next_check_at || computeNextCheck(falsifier?.frequency, now),
      autonomy: falsifier?.autonomy || "auto_notify",
    }, { index, trackingId });

    if (seen.has(item.id)) {
      warnings.push(`监测项 ID 重复：${item.id}`);
      continue;
    }
    seen.add(item.id);
    const errors = validateMonitorItem(item);
    if (errors.length) warnings.push(...errors);
    items.push(item);
  }

  return {
    schema: "pe.monitoring.plan/v1",
    trackingId,
    targetPath,
    generatedAt: now.toISOString(),
    items,
    warnings,
  };
}

export function validateMonitorPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object") return ["监测方案不是对象"];
  if (!Array.isArray(plan.items)) return ["监测方案缺少 items 数组"];
  const ids = new Set();
  for (const item of plan.items) {
    const itemErrors = validateMonitorItem(item);
    errors.push(...itemErrors);
    if (item?.id) {
      if (ids.has(item.id)) errors.push(`监测项 ID 重复：${item.id}`);
      ids.add(item.id);
    }
  }
  return errors;
}

/**
 * Confidence is computed by the host from observable signals, not from the
 * agent's self-report.
 *
 * signals: { sourceTier, directness, corroboration, freshness, mapping }
 */
export function computeConfidence(signals = {}) {
  const reasons = [];
  let score = 0;

  const tier = Number(signals.sourceTier);
  if (tier === 1) { score += 2; reasons.push("一手来源（公告/财报/监管）"); }
  else if (tier === 2) { score += 1; reasons.push("二手权威来源"); }
  else if (tier === 3) { score -= 1; reasons.push("高频资讯/聚合来源，仅作线索"); }
  else if (tier === 4) { score -= 2; reasons.push("论坛/传闻，不足以自动应用"); }

  if (signals.directness === "direct") { score += 2; reasons.push("指标直接披露"); }
  else if (signals.directness === "derived") { score += 1; reasons.push("可由披露项推算"); }
  else { reasons.push("间接/代理指标"); }

  if (Number(signals.corroboration) >= 2) { score += 1; reasons.push("多个独立来源一致"); }
  else if (Number(signals.corroboration) === 1) { reasons.push("单一来源"); }
  else { score -= 1; reasons.push("无独立来源"); }

  if (signals.freshness === "fresh") { score += 1; reasons.push("在频率窗口内"); }
  else { score -= 1; reasons.push("数据偏旧或期间不明"); }

  if (signals.mapping === "confirmed") { score += 1; reasons.push("映射已确认"); }
  else if (signals.mapping === "pending") { reasons.push("映射待确认"); }
  else { score -= 2; reasons.push("映射未确认"); }

  const level = score >= 5 ? "high" : score >= 2 ? "medium" : "low";
  return { level, score, reasons };
}

/**
 * Decide what to do with a proposed change.
 *
 * C4 (threshold/method/structure changes) is always propose.
 * Low confidence never auto-applies.
 */
export function decideAction({
  changeClass = "C0",
  confidence = "medium",
  autonomy = "auto_notify",
} = {}) {
  const klass = CHANGE_CLASS.includes(changeClass) ? changeClass : "C0";
  const level = ["high", "medium", "low"].includes(confidence) ? confidence : "medium";
  const mode = MONITOR_AUTONOMY.includes(autonomy) ? autonomy : "auto_notify";

  if (klass === "C4") {
    return { action: "propose", notify: true, checkpoint: false, reason: "结构/方法/阈值变更需要确认" };
  }
  if (mode === "observe") {
    return { action: "observe", notify: false, checkpoint: false, reason: "观察模式" };
  }
  if (mode === "propose" || level === "low") {
    return { action: "propose", notify: true, checkpoint: false, reason: level === "low" ? "置信度不足" : "配置为待确认" };
  }
  if (klass === "C0") {
    return { action: "observe", notify: false, checkpoint: false, reason: "无实质变化" };
  }
  if (klass === "C1") {
    return { action: "notify", notify: mode !== "auto_silent", checkpoint: false, reason: "预警，仅提醒" };
  }
  return {
    action: "apply",
    notify: mode !== "auto_silent",
    checkpoint: true,
    reason: klass === "C3" ? "估值/目标价变化" : "失效条件触发",
  };
}

export function shouldCheckpoint(changeClass, { manual = false, periodic = false } = {}) {
  if (manual || periodic) return true;
  return changeClass === "C2" || changeClass === "C3";
}

export function statusForObservation({ warning = false, triggered = false } = {}) {
  if (triggered) return "triggered";
  if (warning) return "warning";
  return "armed";
}

export function monitorStatusLabel(status) {
  return STATUS_LABEL[status] || status || "";
}

export function actionLabel(action) {
  return ACTION_LABEL[action] || action || "";
}

/**
 * A monitor item is stale when its next check is in the past or it has not
 * been observed recently. Used by the scheduler and the UI.
 */
export function isMonitorDue(item, now = new Date()) {
  if (!item || item.status === "retired" || item.frequency === "event") return false;
  if (!item.next_check_at) return true;
  return new Date(`${item.next_check_at}T00:00:00`).getTime() <= now.getTime();
}
