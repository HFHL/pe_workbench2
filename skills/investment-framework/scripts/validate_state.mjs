#!/usr/bin/env node
/**
 * analysis-state.json 结构校验器（不检查金融语义）。
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
const STAGE = new Set(["draft", "reviewed", "tracked"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);
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

/* ---------- 顶层 ---------- */

if (state.schema_version !== "2.0") err("schema_version 必须是字符串 \"2.0\"");
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

const ALL_COLLECTIONS = new Set(ARRAYS);

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
}

for (const [i, change] of (state.changes || []).entries()) {
  const at = `changes[${i}]（${change.id || "?"}）`;
  for (const key of ["before", "after", "reason"]) {
    if (!nonEmpty(change[key])) err(`${at}.${key} 不能为空`);
  }
  if (!isDate(change.at)) err(`${at}.at 必须是 YYYY-MM-DD`);
  if (!Number.isInteger(change.revision) || change.revision < 2) {
    err(`${at}.revision 必须是 ≥2 的整数`);
  }
  if (!Array.isArray(change.affected_ids) || change.affected_ids.length === 0) {
    err(`${at}.affected_ids 至少 1 个`);
  }
  for (const id of change.affected_ids || []) {
    if (!ids.has(id)) err(`${at}.affected_ids 引用了不存在的 ID：${id}`);
  }
  checkRefs(change.evidence_ids, "evidence", `${at}.evidence_ids`);
}

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

if (state.revision > 1 && (!Array.isArray(state.changes) || state.changes.length === 0)) {
  warn("revision > 1 但没有 changes 记录");
}
if (state.revision === 1 && Array.isArray(state.changes) && state.changes.length > 0) {
  warn("首次版本（revision=1）不应有版本变化记录");
}

/* ---------- 输出 ---------- */

const label = path.basename(file);
if (!quiet) {
  console.log(dim(`校验 ${label} · ${state.subject?.company || "（未命名）"} · revision ${state.revision} · ${state.stage}`));
}

for (const warning of warnings) console.log(yellow(`  warn  ${warning}`));
for (const error of errors) console.log(red(`  error ${error}`));

if (errors.length === 0) {
  console.log(green(`✓ 通过：0 error，${warnings.length} warning`));
  process.exit(0);
}
console.log(red(`✗ 未通过：${errors.length} error，${warnings.length} warning`));
process.exit(1);
