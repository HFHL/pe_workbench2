#!/usr/bin/env node
/**
 * analysis-state.json 结构校验器。
 *
 * 只检查结构一致性：方法身份、驱动引用、归因闭合、可比性、证据类型、
 * 同日反向修正的稳定性。不判断假设本身对不对。
 *
 * 用法：
 *   node scripts/validate_state.mjs [analysis-state.json]
 *   node scripts/validate_state.mjs --quiet state.json
 *
 * 退出码：0 = 无 error（可有 warning）；1 = 有 error 或读不到文件。
 */

import fs from "node:fs";
import path from "node:path";

const COLORS = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (COLORS ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s) => (COLORS ? `\x1b[31m${s}\x1b[0m` : s);
const yellow = (s) => (COLORS ? `\x1b[33m${s}\x1b[0m` : s);
const green = (s) => (COLORS ? `\x1b[32m${s}\x1b[0m` : s);

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const target = args.find((arg) => !arg.startsWith("--")) || "analysis-state.json";
const file = path.resolve(process.cwd(), target);

const THESIS_STATUS = new Set(["active", "weakened", "invalidated", "confirmed", "retired"]);
const FALSIFIER_STATUS = new Set(["armed", "warning", "triggered", "unknown", "retired"]);
const FREQUENCY = new Set(["daily", "weekly", "monthly", "quarterly", "semi_annual", "event"]);
const SENSITIVITY_METHOD = new Set(["model_input", "price_condition", "scenario"]);
const SCENARIO = new Set(["bear", "base", "bull", "reverse"]);
const ASSUMPTION_KIND = new Set(["model_input", "model_forecast", "research_forecast", "actual"]);
const CHECK_RESULT = new Set(["pass", "difference", "plug", "unverified"]);
const CHECK_REASON = new Set(["tool_failure", "source_missing", "not_disclosed", "not_attempted"]);
const STAGE = new Set(["draft", "reviewed", "tracked"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);
const SCHEMA = new Set(["2.0", "2.1"]);
const EVIDENCE_KIND = new Set([
  "model_input",
  "formula",
  "cached",
  "actual",
  "market",
  "consensus",
  "external_forecast",
  "inference",
]);
const VALUATION_OUTPUT = new Set(["target_price", "equity_value", "enterprise_value", "per_share_value"]);
const DRIVER_ROLE = new Set([
  "base_metric",
  "multiple",
  "margin",
  "fx",
  "share_count",
  "net_cash",
  "discount_rate",
  "terminal_growth",
  "other",
]);
const MULTIPLE_BASIS = new Set(["ARR", "EPS", "EBITDA", "SALES", "BOOK", "OTHER"]);
const VALUATION_STATUS = new Set(["current", "superseded"]);
const CHANGE_KIND = new Set([
  "method_switch",
  "assumption_update",
  "correction",
  "evidence_update",
  "scope",
  "editorial",
]);
const COMPARABILITY = new Set(["comparable", "not_comparable"]);
const COMBINATION = new Set(["multiplicative", "additive", "none"]);
const GAP_KIND = new Set(["data", "tool", "method", "scope"]);
const GAP_STATUS = new Set(["open", "resolved", "accepted"]);
const METHOD_KEY = /^[a-z][a-z0-9_]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const errors = [];
const warnings = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDate(value) {
  return typeof value === "string" && DATE.test(value) && !Number.isNaN(Date.parse(value));
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasText(value) {
  return (typeof value === "string" && value.trim().length > 0) || typeof value === "number";
}

function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function eqNum(a, b) {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

function near(a, b, tolerance = 0.005) {
  return Math.abs(a - b) <= tolerance;
}

let state;
try {
  state = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  console.error(red(`✗ 无法读取 ${target}: ${error.message}`));
  process.exit(1);
}

if (!isObject(state)) {
  console.error(red("✗ 顶层必须是对象"));
  process.exit(1);
}

const modern = state.schema_version === "2.1";

/* ---------- 顶层 ---------- */

if (!SCHEMA.has(state.schema_version)) err('schema_version 必须是 "2.1"（历史文件可为 "2.0"）');
if (state.schema_version === "2.0") {
  warn("schema 2.0 只做旧版结构检查：无法验证估值方法、驱动、归因与可比性；下次实质更新请升级 2.1");
}
if (!Number.isInteger(state.revision) || state.revision < 1) err("revision 必须是 ≥1 的整数");
if (!STAGE.has(state.stage)) err(`stage 必须是 ${[...STAGE].join(" / ")}`);
if (!nonEmpty(state.framework_id)) err("framework_id 不能为空");

const subject = state.subject;
if (!isObject(subject)) {
  err("subject 必须是对象");
} else {
  for (const key of ["company", "currency", "units"]) {
    if (!nonEmpty(subject[key])) err(`subject.${key} 不能为空`);
  }
  if (subject.data_cutoff !== null && !isDate(subject.data_cutoff)) {
    err("subject.data_cutoff 必须是 YYYY-MM-DD 或 null");
  }
  for (const key of ["model_as_of", "valuation_date", "market_price_date", "actuals_through", "forecast_start"]) {
    if (subject[key] !== null && subject[key] !== undefined && !isDate(subject[key])) {
      err(`subject.${key} 必须是 YYYY-MM-DD 或 null`);
    }
  }
}

const model = state.model;
if (!isObject(model)) {
  err("model 必须是对象");
} else {
  const understanding = model.understanding;
  if (!isObject(understanding)) {
    err("model.understanding 必须是对象");
  } else {
    for (const key of ["revenue", "costs_profit", "cash_flow", "valuation"]) {
      if (typeof understanding[key] !== "string") err(`model.understanding.${key} 必须是字符串（可为空）`);
    }
  }
  if (!Array.isArray(model.checks)) {
    err("model.checks 必须是数组");
  } else {
    const ids = new Set();
    model.checks.forEach((check, index) => {
      const at = `model.checks[${index}]`;
      if (!isObject(check)) return err(`${at} 必须是对象`);
      if (!nonEmpty(check.id)) err(`${at}.id 不能为空`);
      else if (ids.has(check.id)) err(`${at}.id 重复: ${check.id}`);
      else ids.add(check.id);
      if (!nonEmpty(check.item)) err(`${at}.item 不能为空`);
      if (!CHECK_RESULT.has(check.result)) err(`${at}.result 必须是 ${[...CHECK_RESULT].join(" / ")}`);
    });
  }
}

const ARRAYS = [
  "sources",
  "evidence",
  "assumptions",
  "theses",
  "sensitivities",
  "valuations",
  "falsifiers",
  "gaps",
  "changes",
];
for (const key of ARRAYS) {
  if (!Array.isArray(state[key])) err(`${key} 必须是数组`);
}

/* ---------- ID 与索引 ---------- */

const ids = new Map(); // id -> collection
const index = {};
for (const key of ARRAYS) {
  index[key] = new Map();
}

for (const key of ARRAYS) {
  const rows = Array.isArray(state[key]) ? state[key] : [];
  rows.forEach((row, i) => {
    if (!isObject(row)) return err(`${key}[${i}] 必须是对象`);
    if (!nonEmpty(row.id)) return err(`${key}[${i}].id 不能为空`);
    if (ids.has(row.id)) return err(`ID 重复：${row.id}（${ids.get(row.id)} 与 ${key}）`);
    ids.set(row.id, key);
    index[key].set(row.id, row);
  });
}

function checkRefs(value, targetKey, at) {
  if (value === undefined) return;
  if (!Array.isArray(value)) return err(`${at} 必须是数组`);
  for (const id of value) {
    if (!index[targetKey]?.has(id)) err(`${at} 引用了不存在的 ${targetKey} ID：${id}`);
  }
}

function driverOf(valuation, assumptionId) {
  return (valuation?.drivers || []).find((driver) => driver.assumption_id === assumptionId);
}

function evidenceKinds(idsList) {
  return (idsList || []).map((id) => index.evidence.get(id)?.kind).filter(Boolean);
}

/* ---------- sources / evidence / assumptions ---------- */

for (const [i, source] of (state.sources || []).entries()) {
  if (!nonEmpty(source.name)) err(`sources[${i}].name 不能为空`);
  if (!nonEmpty(source.locator)) err(`sources[${i}].locator 不能为空`);
}

for (const [i, evidence] of (state.evidence || []).entries()) {
  const at = `evidence[${i}]（${evidence.id || "?"}）`;
  if (!nonEmpty(evidence.statement)) err(`${at}.statement 不能为空`);
  if (!Array.isArray(evidence.source_ids) || evidence.source_ids.length === 0) {
    err(`${at}.source_ids 至少 1 个`);
  }
  checkRefs(evidence.source_ids, "sources", `${at}.source_ids`);
  if (!nonEmpty(evidence.kind)) err(`${at}.kind 不能为空`);
  else if (modern && !EVIDENCE_KIND.has(evidence.kind)) {
    err(`${at}.kind 必须是 ${[...EVIDENCE_KIND].join(" / ")}`);
  }
  if (!nonEmpty(evidence.locator)) err(`${at}.locator 不能为空`);
}

for (const [i, assumption] of (state.assumptions || []).entries()) {
  const at = `assumptions[${i}]（${assumption.id || "?"}）`;
  if (!nonEmpty(assumption.statement)) err(`${at}.statement 不能为空`);
  if (assumption.kind !== undefined && !ASSUMPTION_KIND.has(assumption.kind)) {
    err(`${at}.kind 必须是 ${[...ASSUMPTION_KIND].join(" / ")}`);
  }
  checkRefs(assumption.evidence_ids, "evidence", `${at}.evidence_ids`);
}

/* ---------- theses ---------- */

for (const [i, thesis] of (state.theses || []).entries()) {
  const at = `theses[${i}]（${thesis.id || "?"}）`;
  for (const key of ["statement", "mechanism", "horizon", "alternatives", "confidence_reason"]) {
    if (!nonEmpty(thesis[key])) err(`${at}.${key} 不能为空`);
  }
  if (!THESIS_STATUS.has(thesis.status)) err(`${at}.status 必须是 ${[...THESIS_STATUS].join(" / ")}`);
  if (!CONFIDENCE.has(thesis.confidence)) err(`${at}.confidence 必须是 ${[...CONFIDENCE].join(" / ")}`);
  if (!Array.isArray(thesis.assumption_ids) || thesis.assumption_ids.length === 0) {
    err(`${at}.assumption_ids 至少 1 个`);
  }
  checkRefs(thesis.assumption_ids, "assumptions", `${at}.assumption_ids`);
  checkRefs(thesis.support_ids, "evidence", `${at}.support_ids`);
  checkRefs(thesis.counter_ids, "evidence", `${at}.counter_ids`);
  if (!Array.isArray(thesis.support_ids) || thesis.support_ids.length === 0) {
    err(`${at}.support_ids 至少 1 个`);
  }
  if (!Array.isArray(thesis.counter_ids) || thesis.counter_ids.length === 0) {
    warn(`${at}.counter_ids 为空：没有反面证据的观点容易被写成叙事`);
  }
}

/* ---------- falsifiers ---------- */

for (const [i, falsifier] of (state.falsifiers || []).entries()) {
  const at = `falsifiers[${i}]（${falsifier.id || "?"}）`;
  for (const key of ["statement", "metric", "operator", "threshold", "source", "warning", "action"]) {
    if (!nonEmpty(falsifier[key])) err(`${at}.${key} 不能为空`);
  }
  if (!FALSIFIER_STATUS.has(falsifier.status)) {
    err(`${at}.status 必须是 ${[...FALSIFIER_STATUS].join(" / ")}`);
  }
  if (!FREQUENCY.has(falsifier.frequency)) {
    err(`${at}.frequency 必须是 ${[...FREQUENCY].join(" / ")}`);
  }
  if (!nonEmpty(falsifier.thesis_id) || !index.theses.has(falsifier.thesis_id)) {
    err(`${at}.thesis_id 必须引用存在的观点：${falsifier.thesis_id || "（空）"}`);
  }
  if (falsifier.last_checked_at && !isDate(falsifier.last_checked_at)) {
    err(`${at}.last_checked_at 必须是 YYYY-MM-DD`);
  }
  if (falsifier.status === "armed" && !nonEmpty(falsifier.observed)) {
    warn(`${at}.observed 为空：跟踪基线不完整`);
  }
}

/* ---------- 观点与失效条件的配对 ---------- */

if (Array.isArray(state.theses) && Array.isArray(state.falsifiers)) {
  const byThesis = new Map();
  for (const falsifier of state.falsifiers) {
    const list = byThesis.get(falsifier.thesis_id) || [];
    list.push(falsifier);
    byThesis.set(falsifier.thesis_id, list);
  }
  for (const thesis of state.theses) {
    if (!["active", "weakened"].includes(thesis.status)) continue;
    const links = (byThesis.get(thesis.id) || []).filter((f) => ["armed", "triggered"].includes(f.status));
    if (links.length === 0) {
      err(`观点 ${thesis.id}（${thesis.status}）没有 armed/triggered 的失效条件：跟踪时无法判断是否该改判`);
    }
  }
}

/* ---------- sensitivities ---------- */

for (const [i, sensitivity] of (state.sensitivities || []).entries()) {
  const at = `sensitivities[${i}]（${sensitivity.id || "?"}）`;
  if (!SENSITIVITY_METHOD.has(sensitivity.method)) {
    err(`${at}.method 必须是 ${[...SENSITIVITY_METHOD].join(" / ")}`);
  }
  if (!Array.isArray(sensitivity.assumption_ids) || sensitivity.assumption_ids.length === 0) {
    err(`${at}.assumption_ids 至少 1 个`);
  }
  checkRefs(sensitivity.assumption_ids, "assumptions", `${at}.assumption_ids`);
  for (const key of ["baseline", "perturbation", "result"]) {
    if (!nonEmpty(sensitivity[key])) err(`${at}.${key} 不能为空`);
  }
  checkRefs(sensitivity.evidence_ids, "evidence", `${at}.evidence_ids`);
  for (const id of sensitivity.affects || []) {
    if (!ids.has(id) || !["valuations", "theses"].includes(ids.get(id))) {
      err(`${at}.affects 引用了不存在的估值/观点 ID：${id}`);
    }
  }
}

/* ---------- valuations ---------- */

for (const [i, valuation] of (state.valuations || []).entries()) {
  const at = `valuations[${i}]（${valuation.id || "?"}）`;
  if (!SCENARIO.has(valuation.scenario)) err(`${at}.scenario 必须是 ${[...SCENARIO].join(" / ")}`);
  for (const key of ["method", "unit", "formula"]) {
    if (!nonEmpty(valuation[key])) err(`${at}.${key} 不能为空`);
  }
  if (valuation.as_of !== null && valuation.as_of !== undefined && !isDate(valuation.as_of)) {
    err(`${at}.as_of 必须是 YYYY-MM-DD`);
  }
  if (valuation.value !== null && typeof valuation.value !== "number") {
    err(`${at}.value 必须是数字或 null`);
  }
  if (valuation.value === null && !nonEmpty(valuation.limitations)) {
    err(`${at}.value 为 null 时必须写 limitations`);
  }
  checkRefs(valuation.assumption_ids, "assumptions", `${at}.assumption_ids`);
  checkRefs(valuation.thesis_ids, "theses", `${at}.thesis_ids`);
  checkRefs(valuation.evidence_ids, "evidence", `${at}.evidence_ids`);

  if (!modern) continue;

  if (!nonEmpty(valuation.method_key)) err(`${at}.method_key 不能为空（稳定机器键，如 dcf / arr_multiple）`);
  else if (!METHOD_KEY.test(valuation.method_key)) {
    err(`${at}.method_key 只能用小写字母、数字、下划线，且以字母开头：${valuation.method_key}`);
  }
  if (!VALUATION_OUTPUT.has(valuation.output)) {
    err(`${at}.output 必须是 ${[...VALUATION_OUTPUT].join(" / ")}`);
  }
  if (!VALUATION_STATUS.has(valuation.status)) {
    err(`${at}.status 必须是 ${[...VALUATION_STATUS].join(" / ")}`);
  }
  if (valuation.status === "superseded") {
    if (!nonEmpty(valuation.superseded_by)) err(`${at}.status=superseded 时必须写 superseded_by`);
    else if (!index.valuations.has(valuation.superseded_by)) {
      err(`${at}.superseded_by 引用了不存在的估值：${valuation.superseded_by}`);
    } else if (valuation.superseded_by === valuation.id) {
      err(`${at}.superseded_by 不能指向自己`);
    }
  } else if (valuation.superseded_by !== null && valuation.superseded_by !== undefined) {
    err(`${at}.superseded_by 只在 status=superseded 时填写`);
  }

  if (!Array.isArray(valuation.drivers)) {
    err(`${at}.drivers 必须是数组`);
  } else {
    if (valuation.value !== null && valuation.drivers.length === 0) {
      err(`${at}.drivers 至少 1 个：公式里的每个数都要有 A`);
    }
    const seenDrivers = new Set();
    let hasMultiple = false;
    valuation.drivers.forEach((driver, j) => {
      const driverAt = `${at}.drivers[${j}]`;
      if (!isObject(driver)) return err(`${driverAt} 必须是对象`);
      if (!nonEmpty(driver.assumption_id)) err(`${driverAt}.assumption_id 不能为空`);
      else if (!index.assumptions.has(driver.assumption_id)) {
        err(`${driverAt}.assumption_id 引用了不存在的假设：${driver.assumption_id}`);
      } else if (seenDrivers.has(driver.assumption_id)) {
        err(`${driverAt}.assumption_id 重复：${driver.assumption_id}`);
      } else {
        seenDrivers.add(driver.assumption_id);
      }
      if (!DRIVER_ROLE.has(driver.role)) {
        err(`${driverAt}.role 必须是 ${[...DRIVER_ROLE].join(" / ")}`);
      }
      if (driver.role === "multiple") hasMultiple = true;
      if (!isNum(driver.value)) err(`${driverAt}.value 必须是数字`);
      if (!nonEmpty(driver.unit)) err(`${driverAt}.unit 不能为空`);
    });

    const assumptionIds = new Set(Array.isArray(valuation.assumption_ids) ? valuation.assumption_ids : []);
    for (const driver of valuation.drivers) {
      if (nonEmpty(driver.assumption_id) && !assumptionIds.has(driver.assumption_id)) {
        err(`${at}.assumption_ids 必须包含驱动 ${driver.assumption_id}（drivers 是公式直接操作数）`);
      }
    }

    if (hasMultiple) {
      if (!MULTIPLE_BASIS.has(valuation.multiple_basis)) {
        err(`${at}.multiple_basis 必须是 ${[...MULTIPLE_BASIS].join(" / ")}（有 multiple 驱动时必须写清乘的是什么）`);
      }
      if (!nonEmpty(valuation.multiple_period)) {
        err(`${at}.multiple_period 不能为空（如 2026E；倍数必须写清期间）`);
      }
    }
  }
}

/* ---------- market / gaps / changes / tracking / review ---------- */

if (!isObject(state.market)) {
  err("market 必须是对象");
} else {
  const { price, price_date: priceDate } = state.market;
  if (price !== null && typeof price !== "number") err("market.price 必须是数字或 null");
  if (priceDate !== null && priceDate !== undefined && !isDate(priceDate)) {
    err("market.price_date 必须是 YYYY-MM-DD 或 null");
  }
  checkRefs(state.market.consensus_source_ids, "sources", "market.consensus_source_ids");
  if (price !== null && state.subject?.market_price_date && priceDate && priceDate !== state.subject.market_price_date) {
    warn("market.price_date 与 subject.market_price_date 不一致");
  }
}

for (const [i, gap] of (state.gaps || []).entries()) {
  const at = `gaps[${i}]（${gap.id || "?"}）`;
  for (const key of ["question", "impact"]) {
    if (!nonEmpty(gap[key])) err(`${at}.${key} 不能为空`);
  }
  if (modern) {
    if (gap.kind !== undefined && !GAP_KIND.has(gap.kind)) {
      err(`${at}.kind 必须是 ${[...GAP_KIND].join(" / ")}`);
    }
    if (gap.status !== undefined && !GAP_STATUS.has(gap.status)) {
      err(`${at}.status 必须是 ${[...GAP_STATUS].join(" / ")}`);
    }
    if (gap.status === "resolved" && !nonEmpty(gap.resolution)) {
      err(`${at}.status=resolved 时必须写 resolution`);
    }
    if (gap.kind === "tool") {
      if (!GAP_STATUS.has(gap.status)) {
        err(`${at}.kind=tool 时必须写 status（open / resolved / accepted）`);
      }
      const text = `${gap.question || ""} ${gap.impact || ""}`;
      if (/未披露|未公开|not disclosed/i.test(text)) {
        err(`${at} 是工具类缺口，但写成“未披露”；这是读取失败，不是来源缺失`);
      }
    }
  }
}

const VALUATION_CHANGE_KIND = new Set(["method_switch", "assumption_update", "correction"]);

for (const [i, change] of (state.changes || []).entries()) {
  const at = `changes[${i}]（${change.id || "?"}）`;
  for (const key of ["before", "after", "reason"]) {
    if (!nonEmpty(change[key])) err(`${at}.${key} 不能为空`);
  }
  if (!isDate(change.at)) err(`${at}.at 必须是 YYYY-MM-DD`);
  if (!Number.isInteger(change.revision) || change.revision < 2) {
    err(`${at}.revision 必须是 ≥2 的整数`);
  } else if (change.revision > state.revision) {
    err(`${at}.revision 不能大于状态文件的 revision（${state.revision}）`);
  }
  if (!Array.isArray(change.affected_ids) || change.affected_ids.length === 0) {
    err(`${at}.affected_ids 至少 1 个`);
  }
  for (const id of change.affected_ids || []) {
    if (!ids.has(id)) err(`${at}.affected_ids 引用了不存在的 ID：${id}`);
  }
  checkRefs(change.evidence_ids, "evidence", `${at}.evidence_ids`);

  if (!modern) continue;

  // 升级 2.1 时允许保留旧的 change 写法（不重写历史）；当前 revision 的 change 必须完整。
  if (change.kind === undefined) {
    if (change.revision === state.revision) {
      err(`${at} 是当前 revision 的 change，必须写 kind 与 from/to；旧 change 才允许保留 2.0 写法`);
    } else {
      warn(`${at} 是历史 change（revision ${change.revision} < ${state.revision}），缺 2.1 的 kind/from-to；不重写历史，跳过方法/归因检查`);
    }
    continue;
  }

  if (!CHANGE_KIND.has(change.kind)) {
    err(`${at}.kind 必须是 ${[...CHANGE_KIND].join(" / ")}`);
  }
  const fromV = change.from_valuation_id ? index.valuations.get(change.from_valuation_id) : null;
  const toV = change.to_valuation_id ? index.valuations.get(change.to_valuation_id) : null;
  if (change.from_valuation_id && !fromV) {
    err(`${at}.from_valuation_id 引用了不存在的估值：${change.from_valuation_id}`);
  }
  if (change.to_valuation_id && !toV) {
    err(`${at}.to_valuation_id 引用了不存在的估值：${change.to_valuation_id}`);
  }

  const affectedValuations = (change.affected_ids || []).filter((id) => index.valuations.has(id));
  if (VALUATION_CHANGE_KIND.has(change.kind) && (!fromV || !toV)) {
    err(`${at}.kind=${change.kind} 必须写 from_valuation_id 与 to_valuation_id`);
  } else if (affectedValuations.length > 0 && !fromV && !toV) {
    warn(`${at}.affected_ids 包含估值但未说明 from/to，无法核对方法与归因`);
  }

  if (!fromV || !toV) continue;

  for (const id of [fromV.id, toV.id]) {
    if (!(change.affected_ids || []).includes(id)) {
      err(`${at}.affected_ids 必须包含 ${id}`);
    }
  }

  if (!COMPARABILITY.has(change.comparability)) {
    err(`${at}.comparability 必须是 ${[...COMPARABILITY].join(" / ")}`);
  }

  if (isNum(fromV.value) && isNum(toV.value) && (!isNum(change.value_before) || !isNum(change.value_after))) {
    err(`${at} 必须在 value_before / value_after 写数值（${fromV.id}=${fromV.value}，${toV.id}=${toV.value}）`);
  }
  // 历史 change 的 value_after 不应拿“当前 V.value”来比：V 可能已被后续同方法更新。
  // 只校验被保留的 superseded 快照；current V 的闭合放到 changes 链末尾统一校验。
  if (fromV.status === "superseded" && isNum(fromV.value) && isNum(change.value_before) && !eqNum(change.value_before, fromV.value)) {
    err(`${at}.value_before 与已保留的 ${fromV.id}.value 不一致（${change.value_before} vs ${fromV.value}）`);
  }
  if (toV.status === "superseded" && isNum(toV.value) && isNum(change.value_after) && !eqNum(change.value_after, toV.value)) {
    err(`${at}.value_after 与已保留的 ${toV.id}.value 不一致（${change.value_after} vs ${toV.value}）`);
  }

  const sameMethod = fromV.method_key === toV.method_key;

  if (sameMethod) {
    if (change.kind === "method_switch") {
      err(
        `${at}.kind=method_switch 但 from/to 的 method_key 相同（${fromV.method_key}）；` +
          `若确实换了方法，旧 V 必须保留原 method_key 并新建 V`,
      );
    }
    if (change.comparability !== "comparable") {
      err(`${at}.comparability 必须是 comparable（同一 method_key 才能比较）`);
    }
    if (fromV.id !== toV.id) {
      if (fromV.status !== "superseded" || fromV.superseded_by !== toV.id) {
        err(`${at} 更换了估值快照但旧 V 未标 superseded / superseded_by=${toV.id}`);
      }
      if (toV.status !== "current") err(`${at}.to_valuation_id 必须是 status=current`);
    }
    const valueChanged =
      isNum(change.value_before) && isNum(change.value_after) && !eqNum(change.value_before, change.value_after);
    if (["evidence_update", "scope", "editorial"].includes(change.kind) && valueChanged) {
      err(`${at}.kind=${change.kind} 不应改变估值；改值请用 assumption_update 或 correction`);
    }
    if (valueChanged || ["assumption_update", "correction"].includes(change.kind)) {
      checkAttribution(change, fromV, toV, at);
    }
  } else {
    if (change.kind !== "method_switch") {
      err(`${at} 的 method_key 从 ${fromV.method_key} 变为 ${toV.method_key}，kind 必须是 method_switch`);
    }
    if (change.comparability !== "not_comparable") {
      err(`${at} 方法不同（${fromV.method_key} → ${toV.method_key}），comparability 必须是 not_comparable`);
    }
    if (!nonEmpty(change.comparability_reason)) {
      err(`${at}.comparability_reason 不能为空：说明为什么两种估值不可比`);
    }
    if (fromV.id === toV.id) {
      err(`${at} 方法切换不能覆盖同一个 V（${toV.id}）；请新建 V，并保留旧 V 的原 method_key/value`);
    }
    if (fromV.status !== "superseded" || fromV.superseded_by !== toV.id) {
      err(`${at} 方法切换必须把 ${fromV.id} 标为 superseded，且 superseded_by=${toV.id}（报告仍可把它作为对照引用）`);
    }
    if (toV.status !== "current") err(`${at}.to_valuation_id 必须是 status=current`);
    if (Array.isArray(change.attribution) && change.attribution.length > 0) {
      err(`${at} 是方法切换：不同模型之间没有可加/可乘的目标价归因，请改用 bridge`);
    }
    if (!Array.isArray(change.bridge) || change.bridge.length < 2) {
      err(`${at}.bridge 至少 2 项（方法、基准指标、倍数口径等），不能只写“不可比”`);
    } else {
      change.bridge.forEach((item, j) => {
        const itemAt = `${at}.bridge[${j}]`;
        if (!isObject(item)) return err(`${itemAt} 必须是对象`);
        for (const key of ["factor", "from", "to"]) {
          if (!hasText(item[key])) err(`${itemAt}.${key} 不能为空`);
        }
      });
    }
  }

  if (["method_switch", "assumption_update", "correction"].includes(change.kind)) {
    const kinds = evidenceKinds(change.evidence_ids);
    if (kinds.length === 0) {
      err(`${at} 改了估值但没有引用任何证据`);
    } else if (!kinds.some((kind) => kind !== "inference")) {
      err(`${at} 至少要有 1 条非 inference 证据；“人工判断”不能单独作为改估值的依据`);
    } else if (kinds.every((kind) => kind === "inference" || kind === "market")) {
      warn(`${at} 只引用市场/推断证据，警惕用现价反推目标价`);
    }
  }
}

/* ---------- 估值变化链：历史 change 之间要连续，current V 要接上最后一版 ---------- */

if (modern) {
  const byToValuation = new Map();
  (state.changes || []).forEach((change, order) => {
    if (!change.to_valuation_id) return;
    const valuation = index.valuations.get(change.to_valuation_id);
    if (!valuation) return;
    const list = byToValuation.get(change.to_valuation_id) || [];
    list.push({ change, order });
    byToValuation.set(change.to_valuation_id, list);
  });

  for (const [valuationId, list] of byToValuation) {
    list.sort((a, b) => {
      const byDate = String(a.change.at).localeCompare(String(b.change.at));
      if (byDate !== 0) return byDate;
      const byRevision = (a.change.revision || 0) - (b.change.revision || 0);
      if (byRevision !== 0) return byRevision;
      return a.order - b.order;
    });
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1].change;
      const cur = list[i].change;
      if (isNum(prev.value_after) && isNum(cur.value_before) && !eqNum(prev.value_after, cur.value_before)) {
        err(
          `${cur.id}.value_before=${cur.value_before} 与前一版 ${prev.id}.value_after=${prev.value_after} 不连续（${valuationId}）`,
        );
      }
    }
    const last = list[list.length - 1].change;
    const valuation = index.valuations.get(valuationId);
    if (isNum(valuation.value) && isNum(last.value_after) && !eqNum(valuation.value, last.value_after)) {
      err(`${valuationId}.value=${valuation.value} 与最后一次变化 ${last.id}.value_after=${last.value_after} 不一致`);
    }
  }
}

function checkAttribution(change, fromV, toV, at) {
  const list = change.attribution;
  if (!Array.isArray(list) || list.length === 0) {
    err(`${at} 可比估值变化必须写 attribution（覆盖所有变化驱动）`);
    return;
  }
  if (!COMBINATION.has(change.combination) || change.combination === "none") {
    err(`${at}.combination 必须是 multiplicative 或 additive（有 attribution 时）`);
  }
  if (!isNum(change.residual)) {
    err(`${at}.residual 必须是数字（未解释比例，可为 0）`);
    return;
  }
  if (!isNum(change.value_before) || !isNum(change.value_after) || change.value_before === 0) {
    err(`${at} 归因需要可计算的 value_before / value_after`);
    return;
  }

  // 历史 change 的 to 值可能已被后续同方法更新覆盖；只拿“当前 V 的最后一版”对 drivers 做核对。
  const isLatestForCurrent =
    toV.status === "current" &&
    isNum(change.value_after) &&
    isNum(toV.value) &&
    eqNum(change.value_after, toV.value);

  const seen = new Set();
  list.forEach((item, j) => {
    const itemAt = `${at}.attribution[${j}]`;
    if (!isObject(item)) return err(`${itemAt} 必须是对象`);
    const aid = item.assumption_id;
    if (!nonEmpty(aid) || !index.assumptions.has(aid)) {
      return err(`${itemAt}.assumption_id 引用了不存在的假设：${aid || "（空）"}`);
    }
    if (seen.has(aid)) err(`${itemAt}.assumption_id 重复：${aid}`);
    seen.add(aid);
    if (item.from !== null && !isNum(item.from)) err(`${itemAt}.from 必须是数字或 null`);
    if (item.to !== null && !isNum(item.to)) err(`${itemAt}.to 必须是数字或 null`);
    if (!isNum(item.contribution)) err(`${itemAt}.contribution 必须是数字（占起始值的比例）`);

    const toDriver = driverOf(toV, aid);
    if (!toDriver) {
      err(`${itemAt} 的 ${aid} 不是 ${toV.id} 的公式驱动；只在 assumption_ids 里的间接假设不能作为估值归因`);
    } else if (isLatestForCurrent && isNum(item.to) && isNum(toDriver.value) && !eqNum(item.to, toDriver.value)) {
      err(`${itemAt}.to=${item.to} 与 ${toV.id}.drivers 中 ${aid}=${toDriver.value} 不一致`);
    }

    if (fromV.id !== toV.id) {
      const fromDriver = driverOf(fromV, aid);
      if (!fromDriver) {
        err(`${itemAt} 的 ${aid} 不在 ${fromV.id} 的 drivers 中；跨快照归因必须两边都是驱动`);
      } else if (isNum(item.from) && isNum(fromDriver.value) && !eqNum(item.from, fromDriver.value)) {
        err(`${itemAt}.from=${item.from} 与 ${fromV.id}.drivers 中 ${aid}=${fromDriver.value} 不一致`);
      }
    }
  });

  const total = change.value_after / change.value_before - 1;
  let explained = 0;
  if (change.combination === "multiplicative") {
    explained = list.reduce((product, item) => product * (1 + (isNum(item.contribution) ? item.contribution : 0)), 1) - 1;
  } else if (change.combination === "additive") {
    explained = list.reduce((sum, item) => sum + (isNum(item.contribution) ? item.contribution : 0), 0);
  } else {
    return;
  }

  const unexplained = total - explained;
  if (!near(unexplained, change.residual, 0.005)) {
    err(
      `${at}.residual=${change.residual} 与闭合结果不一致：总变化 ${(total * 100).toFixed(1)}%，` +
        `归因解释 ${(explained * 100).toFixed(1)}%，残差应为 ${(unexplained * 100).toFixed(1)}%`,
    );
  }
  const gap = Math.abs(unexplained);
  if (gap > 0.15) {
    err(`${at} 归因不完整：${(gap * 100).toFixed(1)}% 未解释（>15%）；补齐驱动，不能只写“其他”`);
  } else if (gap > 0.05) {
    if (nonEmpty(change.residual_reason)) {
      warn(`${at} 仍有 ${(gap * 100).toFixed(1)}% 未解释（已写 residual_reason）`);
    } else {
      err(`${at} 有 ${(gap * 100).toFixed(1)}% 未解释（>5%）；补驱动或写 residual_reason`);
    }
  }
}

/* ---------- model.checks 的 2.1 语义 ---------- */

if (modern && Array.isArray(state.model?.checks)) {
  for (const [i, check] of state.model.checks.entries()) {
    const at = `model.checks[${i}]（${check.id || "?"}）`;
    if (check.reason !== undefined && !CHECK_REASON.has(check.reason)) {
      err(`${at}.reason 必须是 ${[...CHECK_REASON].join(" / ")}`);
    }
    if (check.result !== "unverified") continue;
    if (!CHECK_REASON.has(check.reason)) {
      err(`${at}.result=unverified 时必须写 reason（tool_failure / source_missing / not_disclosed / not_attempted）`);
    }
    if (!nonEmpty(check.locator)) err(`${at}.locator 不能为空：写明实际检查的 sheet/单元格/页码`);
    if (!nonEmpty(check.attempted)) err(`${at}.attempted 不能为空：写明试过什么读取路径`);
    if (check.reason === "tool_failure") {
      if (!Array.isArray(check.gap_ids) || check.gap_ids.length === 0) {
        err(`${at} 是工具失败：必须用 gap_ids 挂到 kind=tool 的缺口，不能当成“未披露”`);
      } else {
        for (const gapId of check.gap_ids) {
          const gap = index.gaps.get(gapId);
          if (!gap) err(`${at}.gap_ids 引用了不存在的缺口：${gapId}`);
          else if (gap.kind !== "tool") err(`${at}.gap_ids 的 ${gapId} 必须是 kind=tool`);
        }
      }
      const text = `${check.item || ""} ${check.note || ""}`;
      if (/未披露|未公开|not disclosed/i.test(text)) {
        err(`${at} 记的是 tool_failure，但文字写成“未披露”；工具失败不是来源事实`);
      }
    }
    if (check.reason === "not_disclosed") {
      const text = `${check.item || ""} ${check.note || ""}`;
      if (/无法解析|解析失败|读取失败|ZeroDivision|timeout|超时/i.test(text)) {
        err(`${at} 文字显示是读取/解析失败，不能记成 not_disclosed`);
      }
    }
  }
}

/* ---------- 同日反向修正 ---------- */

const pricedChanges = [];
for (const [i, change] of (state.changes || []).entries()) {
  if (!change.from_valuation_id || !change.to_valuation_id) continue;
  if (!isNum(change.value_before) || !isNum(change.value_after)) continue;
  const delta = change.value_after - change.value_before;
  if (delta === 0) continue;
  pricedChanges.push({ change, index: i, delta });
}
pricedChanges.sort((a, b) => {
  const byDate = String(a.change.at).localeCompare(String(b.change.at));
  if (byDate !== 0) return byDate;
  const byRevision = (a.change.revision || 0) - (b.change.revision || 0);
  if (byRevision !== 0) return byRevision;
  return a.index - b.index;
});
for (let i = 1; i < pricedChanges.length; i += 1) {
  const prev = pricedChanges[i - 1];
  const cur = pricedChanges[i];
  if (prev.change.at !== cur.change.at) continue;
  const chained =
    prev.change.to_valuation_id === cur.change.from_valuation_id ||
    prev.change.to_valuation_id === cur.change.to_valuation_id ||
    prev.change.from_valuation_id === cur.change.from_valuation_id;
  if (!chained) continue;
  if (Math.sign(prev.delta) === Math.sign(cur.delta)) continue;

  if (!nonEmpty(cur.change.stability_note)) {
    err(`${cur.change.id} 与 ${prev.change.id} 在同一天反向修正，必须写 stability_note（为什么推翻上一版）`);
  }
  const kinds = evidenceKinds(cur.change.evidence_ids);
  if (!kinds.some((kind) => kind !== "inference")) {
    err(`${cur.change.id} 同日反向修正缺少新增非推断证据；“人工判断”不能单独支撑反向改估值`);
  } else {
    warn(`${cur.change.id} 同日反向修正：已列新增证据，仍需确认不是把假设调到贴近现价`);
  }
}

/* ---------- revision 与 changes ---------- */

if (state.revision > 1 && (!Array.isArray(state.changes) || state.changes.length === 0)) {
  warn("revision > 1 但没有 changes 记录");
}
if (state.revision === 1 && Array.isArray(state.changes) && state.changes.length > 0) {
  warn("首次版本（revision=1）不应有版本变化记录");
}
if (state.revision > 1 && Array.isArray(state.changes) && state.changes.length > 0) {
  const revisions = new Set(state.changes.map((change) => change.revision));
  if (!revisions.has(state.revision)) {
    warn(`最新 revision ${state.revision} 没有对应的 changes 条目`);
  }
}

/* ---------- tracking / review ---------- */

if (!isObject(state.tracking)) {
  err("tracking 必须是对象");
} else {
  if (state.tracking.last_run_at && !isDate(state.tracking.last_run_at)) {
    err("tracking.last_run_at 必须是 YYYY-MM-DD");
  }
  if (state.tracking.data_cutoff && !isDate(state.tracking.data_cutoff)) {
    err("tracking.data_cutoff 必须是 YYYY-MM-DD");
  }
  for (const [id, status] of Object.entries(state.tracking.thesis_status || {})) {
    if (!index.theses.has(id)) err(`tracking.thesis_status 引用了不存在的观点：${id}`);
    else if (!THESIS_STATUS.has(status)) err(`tracking.thesis_status.${id} 状态非法：${status}`);
  }
  checkRefs(state.tracking.triggered_falsifier_ids, "falsifiers", "tracking.triggered_falsifier_ids");
}

if (!isObject(state.review)) {
  err("review 必须是对象");
} else {
  if (!nonEmpty(state.review.status)) err("review.status 不能为空");
  if (state.review.mode && !["self", "independent"].includes(state.review.mode)) {
    err("review.mode 必须是 self 或 independent");
  }
}

/* ---------- 阶段规则 ---------- */

if (state.stage === "reviewed" || state.stage === "tracked") {
  if (!Array.isArray(state.theses) || state.theses.length === 0) {
    err("stage 为 reviewed/tracked 时至少要有 1 条观点");
  } else {
    for (const thesis of state.theses) {
      if (["active", "weakened"].includes(thesis.status) && (thesis.counter_ids || []).length === 0) {
        err(`stage 为 reviewed/tracked 时，观点 ${thesis.id} 必须有反面证据`);
      }
    }
  }
  if (!Array.isArray(state.falsifiers) || state.falsifiers.length === 0) {
    err("stage 为 reviewed/tracked 时至少要有 1 条失效条件");
  }
  if (!nonEmpty(state.subject?.data_cutoff)) {
    err("stage 为 reviewed/tracked 时必须写 subject.data_cutoff");
  }
}

/* ---------- 输出 ---------- */

const label = path.basename(file);
if (!quiet) {
  console.log(dim(`校验 ${label} · ${state.subject?.company || "（未命名）"} · revision ${state.revision} · ${state.stage} · schema ${state.schema_version}`));
}

for (const warning of warnings) console.log(yellow(`  warn  ${warning}`));
for (const error of errors) console.log(red(`  error ${error}`));

if (errors.length === 0) {
  console.log(green(`✓ 通过：0 error，${warnings.length} warning`));
  process.exit(0);
}
console.log(red(`✗ 未通过：${errors.length} error，${warnings.length} warning`));
process.exit(1);
