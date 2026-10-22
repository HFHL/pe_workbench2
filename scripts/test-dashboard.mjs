#!/usr/bin/env node
/**
 * pe.investment-dashboard v1: schema, component catalog and API integration.
 *
 * The integration fixture uses a real SQLite store and the real HTTP stack. It
 * never calls a model provider and never writes through the dashboard service.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../server/config.mjs";
import { createWorkbench } from "../server/create-app.mjs";
import { normalizeTrackingResult } from "../lib/tracking.mjs";
import { INVESTMENT_DASHBOARD } from "../lib/dashboard/contract.mjs";
import { DASHBOARD_SECTIONS } from "../lib/dashboard/catalog.mjs";
import { currencyFromUnit } from "../server/dashboard/service.mjs";
import { registerDashboardComponents } from "../ui/dashboard/components/index.js";
import {
  renderDashboardSection,
  renderDashboardSections,
  validateDashboardDto,
} from "../ui/dashboard/registry.js";

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  fail ${name}`);
    console.error(`       ${error.stack || error.message}`);
    failed += 1;
  }
}

const silent = { log() {}, warn() {}, error() {} };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pe-dashboard-test-"));
const local = { base: "", app: null, ctx: null, full: null, partial: null, noRun: null };

await run("currency parser ignores English unit words", () => {
  assert.equal(currencyFromUnit("per share"), null);
  assert.equal(currencyFromUnit("Per Share"), null);
  assert.equal(currencyFromUnit("share"), null);
  assert.equal(currencyFromUnit("CNY per share"), "CNY");
  assert.equal(currencyFromUnit("usd/share"), "USD");
});

function makeState({
  company = "长鑫科技",
  currentPrice = 78,
  targetPrice = 92,
  thesisStatus = "active",
  falsifierStatus = "armed",
  includeSensitivities = true,
} = {}) {
  return {
    schema_version: "2.0",
    framework_id: "IF-DASH-TEST",
    revision: 3,
    stage: "tracked",
    subject: {
      company,
      security: "688000.SS",
      currency: "CNY",
      units: "元/股",
      model_as_of: "2026-09-01",
      valuation_date: "2026-09-01",
      market_price_date: "2026-10-18",
      data_cutoff: "2026-10-18",
    },
    model: { understanding: {}, checks: [] },
    sources: [],
    evidence: [],
    assumptions: [],
    theses: [{
      id: "T1",
      statement: "AI 服务器需求推动 DRAM 周期上行。",
      mechanism: "需求 → 价格 → 毛利",
      horizon: "12–24 个月",
      assumption_ids: [],
      support_ids: [],
      counter_ids: [],
      alternatives: "暂无",
      unknowns: "库存",
      confidence: "medium",
      confidence_reason: "价格方向一致，库存上升。",
      status: thesisStatus,
    }],
    valuations: includeSensitivities ? [
      { id: "V1", scenario: "bear", method: "PE", as_of: "2026-09-01", value: 65, unit: "元/股" },
      { id: "V2", scenario: "base", method: "PE", as_of: "2026-09-01", value: targetPrice, unit: "元/股" },
      { id: "V3", scenario: "bull", method: "PE", as_of: "2026-09-01", value: 120, unit: "元/股" },
    ] : [],
    market: { price: currentPrice, price_date: "2026-10-18", consensus: "3 家", consensus_source_ids: [], implied: "", limitations: "" },
    falsifiers: [
      {
        id: "F1", thesis_id: "T1", statement: "库存超过 12 周", metric: "渠道库存周数",
        operator: ">", threshold: "12 周", observed: "9.2 周", source: "TrendForce 月报",
        frequency: "monthly", warning: "10 周", action: "复核并下调 A1", status: falsifierStatus,
        last_checked_at: "2026-10-18", last_observed: "9.2 周",
      },
      {
        id: "F2", thesis_id: "T1", statement: "合约价连续两季下跌", metric: "DDR5 合约价 QoQ",
        operator: "crosses_below", threshold: "-5% × 2", observed: "+4%", source: "TrendForce",
        frequency: "quarterly", warning: "-3%", action: "重算 V2", status: "warning",
        last_checked_at: "2026-10-18", last_observed: "+4%",
      },
    ],
    sensitivities: includeSensitivities ? [
      {
        id: "S1", assumption_ids: ["A1"], method: "model_input", baseline: "ASP +35%",
        perturbation: "±10%", result: "EPS +21% / -17%", affects: ["V2"],
        evidence_ids: [], fixed_conditions: "其他不变", limitations: "单变量",
      },
    ] : [],
    gaps: [{ id: "G1", question: "ASP 假设依据是什么？", impact: "影响 T1 置信度", evidence_needed: "访谈" }],
    changes: [],
    tracking: { last_run_id: null, last_run_at: null, data_cutoff: "2026-10-18", thesis_status: { T1: thesisStatus }, triggered_falsifier_ids: [] },
    review: { status: "reviewed", mode: "self", notes: [] },
  };
}

function makeResult({ trackingId, targetId, targetPath, runId, baseVersion, resultVersion, status, headline, from, to }) {
  const now = new Date();
  return normalizeTrackingResult({
    status,
    headline,
    conclusion: `${headline}。`,
    summary: "本次运行的摘要，全部来自结构化结果。",
    confidence: "中",
    deltas: from && to ? [{ label: "目标价", from, to, note: "目标价调整", tone: "up" }] : [],
    theses: [{ id: "T1", statement: "AI 服务器需求推动 DRAM 周期上行。", status: "active", change: "维持", note: "证据未变" }],
    invalidations: [],
    monitorChecks: status === "updated"
      ? [{ id: "F1", falsifier_id: "F1", observed: "13 周", status: "triggered", note: "库存越过阈值" }]
      : [],
    modelChanges: [],
    modelOutputs: [],
    reasons: status === "updated"
      ? [{ tag: "新实际值", title: "渠道库存超过阈值", detail: "最新月报显示库存 13 周。", source: "TrendForce 2026-10", impact: "F1 触发，T1 需要复核" }]
      : [],
    sources: [{ label: "TrendForce DRAM 月报", date: "2026-10-18" }],
    notUsed: ["旧版渠道样本"],
    writeback: {
      mode: "原位更新 · 已备份",
      stats: "1 处",
      note: "系统写入跟踪记录后产生的新版本。",
      changes: [{ where: "报告结论段", from: from || "—", to: to || "—", note: "目标价" }],
    },
  }, {
    trackingId,
    targetId,
    targetPath,
    templateId: "framework",
    baseVersion,
    resultVersion,
    nowLabel: "2026-10-20 09:00",
    duration: "1m 02s",
    fallbackConclusion: headline,
    fallbackSummary: "",
    status,
    runId,
    trigger: "manual",
    startedAt: now.toISOString(),
    endedAt: new Date(now.getTime() + 500).toISOString(),
    backupPath: "exports/dash/backups/report.md",
  });
}

async function seed() {
  const { ctx, app } = local;
  const dir = path.join(ctx.root, "exports", "dash");
  fs.mkdirSync(dir, { recursive: true });

  const reportRel = "exports/dash/report.md";
  const stateRel = "exports/dash/analysis-state.json";
  fs.writeFileSync(path.join(ctx.root, reportRel), "# 投资框架 v1\n");
  const report = ctx.store.indexFile(reportRel, { source: "agent" });
  fs.writeFileSync(path.join(ctx.root, stateRel), `${JSON.stringify(makeState({ targetPrice: 92 }), null, 2)}\n`);
  ctx.store.indexFile(stateRel, { source: "agent", visibility: "internal" });

  const tracking = ctx.store.createTracking({
    targetId: report.id,
    templateId: "framework",
    freq: "weekly",
    weekday: 1,
    time: "09:00",
  });
  const run1 = ctx.store.startTrackingRun(tracking.id, { trigger: "manual", baseVersion: 1 });
  fs.writeFileSync(path.join(ctx.root, reportRel), "# 投资框架 v2\n");
  ctx.store.indexFile(reportRel, { source: "agent", runId: run1.id });
  fs.writeFileSync(path.join(ctx.root, stateRel), `${JSON.stringify(makeState({ targetPrice: 95 }), null, 2)}\n`);
  ctx.store.indexFile(stateRel, { source: "agent", visibility: "internal", runId: run1.id });
  const result1 = makeResult({
    trackingId: tracking.id, targetId: report.id, targetPath: reportRel, runId: run1.id,
    baseVersion: 1, resultVersion: 2, status: "updated", headline: "目标价由 92 上调至 95", from: "92 元/股", to: "95 元/股",
  });
  ctx.store.finishTrackingRun(tracking.id, run1.id, {
    status: "updated", message: "更新到 v2", resultVersion: 2, result: result1,
    decisionClass: "C3", confidence: "medium",
  });

  const run2 = ctx.store.startTrackingRun(tracking.id, { trigger: "manual", baseVersion: 2 });
  fs.writeFileSync(path.join(ctx.root, reportRel), "# 投资框架 v3\n");
  ctx.store.indexFile(reportRel, { source: "agent", runId: run2.id });
  fs.writeFileSync(path.join(ctx.root, stateRel), `${JSON.stringify(makeState({ targetPrice: 97, company: "长鑫科技股份有限公司（超长名称用于换行与截断验证）" }), null, 2)}\n`);
  ctx.store.indexFile(stateRel, { source: "agent", visibility: "internal", runId: run2.id });
  const result2 = makeResult({
    trackingId: tracking.id, targetId: report.id, targetPath: reportRel, runId: run2.id,
    baseVersion: 2, resultVersion: 3, status: "updated", headline: "目标价由 95 上调至 97", from: "95 元/股", to: "97 元/股",
  });
  // The run's declared model output is authoritative for targetPrice. The
  // workbook file is intentionally not indexed here, so the source ref must
  // also demonstrate the broken-link state.
  result2.writeback.model = {
    file: "exports/dash/model-not-indexed.xlsx",
    version: 1,
    changes: [],
    outputs: [{ label: "目标价", sheet: "Model", cell: "B4", before: 95, after: 97 }],
  };
  ctx.store.finishTrackingRun(tracking.id, run2.id, {
    status: "updated", message: "更新到 v3", resultVersion: 3, result: result2,
    decisionClass: "C3", confidence: "medium",
  });

  const statuses = ["triggered", "warning", ...Array.from({ length: 17 }, () => "armed"), "unknown", "unknown", "unknown", "retired"];
  const items = statuses.map((status, index) => ({
    id: `MON${String(index + 1).padStart(2, "0")}`,
    falsifier_id: index < 2 ? `F${index + 1}` : `F${index + 1}`,
    thesis_id: "T1",
    metric: index === 0 ? "渠道库存周数" : `监测指标 ${index + 1}`,
    operator: index === 0 ? ">" : ">=",
    warning: "10 周",
    threshold: "12 周",
    observed: index === 0 ? "13 周" : `${index} 周`,
    status,
    source: { text: `来源 ${index + 1}`, url: index === 0 ? "https://example.com/dram" : "" },
    action: "复核并记录",
    last_checked_at: "2026-10-18",
    next_check_at: `2026-10-${String(20 + (index % 8)).padStart(2, "0")}`,
  }));
  ctx.store.replaceMonitorItems(tracking.id, items);

  // A historical run's DTO must stay byte-identical when a newer run is added.
  fs.mkdirSync(path.join(ctx.root, "exports", "dash-stable"), { recursive: true });
  const stableRel = "exports/dash-stable/report.md";
  const stableStateRel = "exports/dash-stable/analysis-state.json";
  fs.writeFileSync(path.join(ctx.root, stableRel), "# Stable v1\n");
  const stableReport = ctx.store.indexFile(stableRel, { source: "agent" });
  fs.writeFileSync(path.join(ctx.root, stableStateRel), `${JSON.stringify(makeState({ targetPrice: 90 }), null, 2)}\n`);
  ctx.store.indexFile(stableStateRel, { source: "agent", visibility: "internal" });
  const stable = ctx.store.createTracking({
    targetId: stableReport.id, templateId: "framework", freq: "weekly", weekday: 1, time: "09:00",
  });
  const stableRun = ctx.store.startTrackingRun(stable.id, { trigger: "manual", baseVersion: 1 });
  fs.writeFileSync(path.join(ctx.root, stableRel), "# Stable v2\n");
  ctx.store.indexFile(stableRel, { source: "agent", runId: stableRun.id });
  fs.writeFileSync(path.join(ctx.root, stableStateRel), `${JSON.stringify(makeState({ targetPrice: 91 }), null, 2)}\n`);
  ctx.store.indexFile(stableStateRel, { source: "agent", visibility: "internal", runId: stableRun.id });
  const stableResult = makeResult({
    trackingId: stable.id, targetId: stableReport.id, targetPath: stableRel, runId: stableRun.id,
    baseVersion: 1, resultVersion: 2, status: "updated", headline: "目标价 90 → 91",
    from: "90 元/股", to: "91 元/股",
  });
  ctx.store.finishTrackingRun(stable.id, stableRun.id, {
    status: "updated", message: "stable v2", resultVersion: 2, result: stableResult,
  });

  // Non-per-share valuation units must never produce an upside percentage,
  // even when the run declares a numeric target output.
  fs.mkdirSync(path.join(ctx.root, "exports", "dash-unit"), { recursive: true });
  const unitRel = "exports/dash-unit/report.md";
  const unitStateRel = "exports/dash-unit/analysis-state.json";
  fs.writeFileSync(path.join(ctx.root, unitRel), "# Unit report\n");
  const unitReport = ctx.store.indexFile(unitRel, { source: "agent" });
  const unitState = makeState({ targetPrice: 9700 });
  unitState.subject.units = "百万元";
  unitState.valuations = unitState.valuations.map((item) => ({ ...item, unit: "百万元" }));
  fs.writeFileSync(path.join(ctx.root, unitStateRel), `${JSON.stringify(unitState, null, 2)}\n`);
  ctx.store.indexFile(unitStateRel, { source: "agent", visibility: "internal" });
  const unitTracking = ctx.store.createTracking({
    targetId: unitReport.id, templateId: "framework", freq: "weekly", weekday: 1, time: "09:00",
  });
  const unitRun = ctx.store.startTrackingRun(unitTracking.id, { trigger: "manual", baseVersion: 1 });
  fs.writeFileSync(path.join(ctx.root, unitRel), "# Unit report v2\n");
  ctx.store.indexFile(unitRel, { source: "agent", runId: unitRun.id });
  ctx.store.indexFile(unitStateRel, { source: "agent", visibility: "internal", runId: unitRun.id });
  const unitResult = makeResult({
    trackingId: unitTracking.id, targetId: unitReport.id, targetPath: unitRel, runId: unitRun.id,
    baseVersion: 1, resultVersion: 2, status: "updated", headline: "总价值单位的目标价",
    from: "9,200 百万元", to: "9,700 百万元",
  });
  unitResult.writeback.model = {
    file: "exports/dash-unit/model-not-indexed.xlsx",
    version: 1,
    changes: [],
    outputs: [{ label: "目标价", sheet: "Model", cell: "B4", before: 9200, after: 9700 }],
  };
  ctx.store.finishTrackingRun(unitTracking.id, unitRun.id, {
    status: "updated", message: "单位测试", resultVersion: 2, result: unitResult,
  });

  // Audit-only version: an updated run with no business deltas must not be
  // described as a changed investment judgment.
  fs.mkdirSync(path.join(ctx.root, "exports", "dash-audit"), { recursive: true });
  const auditRel = "exports/dash-audit/report.md";
  fs.writeFileSync(path.join(ctx.root, auditRel), "# Audit v1\n");
  const auditReport = ctx.store.indexFile(auditRel, { source: "agent" });
  const audit = ctx.store.createTracking({
    targetId: auditReport.id, templateId: "framework", freq: "weekly", weekday: 1, time: "09:00",
  });
  const auditRun = ctx.store.startTrackingRun(audit.id, { trigger: "manual", baseVersion: 1 });
  fs.writeFileSync(path.join(ctx.root, auditRel), "# Audit v2\n");
  ctx.store.indexFile(auditRel, { source: "agent", runId: auditRun.id });
  const auditResult = makeResult({
    trackingId: audit.id, targetId: auditReport.id, targetPath: auditRel, runId: auditRun.id,
    baseVersion: 1, resultVersion: 2, status: "updated", headline: "只追加了跟踪记录",
  });
  // A standing confirmed thesis with change="维持" is not a new judgment.
  auditResult.theses = [{ id: "T1", statement: "已确认的观点", status: "confirmed", change: "维持", note: "" }];
  ctx.store.finishTrackingRun(audit.id, auditRun.id, {
    status: "updated", message: "审计版本 v2", resultVersion: 2, result: auditResult,
    decisionClass: "C0", confidence: "medium",
  });

  fs.mkdirSync(path.join(ctx.root, "exports", "dash-nochange"), { recursive: true });
  const noChangeRel = "exports/dash-nochange/report.md";
  fs.writeFileSync(path.join(ctx.root, noChangeRel), "# No change v1\n");
  const noChangeReport = ctx.store.indexFile(noChangeRel, { source: "agent" });
  const noChange = ctx.store.createTracking({
    targetId: noChangeReport.id, templateId: "framework", freq: "weekly", weekday: 1, time: "09:00",
  });
  const noChangeRun = ctx.store.startTrackingRun(noChange.id, { trigger: "manual", baseVersion: 1 });
  const noChangeResult = makeResult({
    trackingId: noChange.id, targetId: noChangeReport.id, targetPath: noChangeRel, runId: noChangeRun.id,
    baseVersion: 1, resultVersion: null, status: "no_change", headline: "本期无重大变化",
  });
  ctx.store.finishTrackingRun(noChange.id, noChangeRun.id, {
    status: "no_change", message: "无重大变化", resultVersion: null, result: noChangeResult,
    decisionClass: "C0", confidence: "medium",
  });

  fs.mkdirSync(path.join(ctx.root, "exports", "dash-partial"), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, "exports", "dash-partial", "partial.md"), "# 部分数据\n");
  const partialReport = ctx.store.indexFile("exports/dash-partial/partial.md", { source: "agent" });
  const partial = ctx.store.createTracking({
    targetId: partialReport.id, templateId: "framework", freq: "weekly", weekday: 1, time: "09:00",
  });
  const partialRun = ctx.store.startTrackingRun(partial.id, { trigger: "manual", baseVersion: 1 });
  const partialResult = makeResult({
    trackingId: partial.id, targetId: partialReport.id, targetPath: "exports/dash-partial/partial.md",
    runId: partialRun.id, baseVersion: 1, resultVersion: null, status: "baseline", headline: "首次基线",
  });
  ctx.store.finishTrackingRun(partial.id, partialRun.id, {
    status: "baseline", message: "首次基线", resultVersion: null, result: partialResult,
    decisionClass: "C0", confidence: "low",
  });

  fs.mkdirSync(path.join(ctx.root, "exports", "dash-empty"), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, "exports", "dash-empty", "empty.md"), "# 没有运行\n");
  const emptyReport = ctx.store.indexFile("exports/dash-empty/empty.md", { source: "agent" });
  const noRun = ctx.store.createTracking({
    targetId: emptyReport.id, templateId: "framework", freq: "weekly", weekday: 1, time: "09:00",
  });

  local.full = { tracking, run1, run2, report, result1, result2 };
  local.unit = { tracking: unitTracking, run: unitRun, report: unitReport };

  // Explicitly mismatched currencies must not be divided as if comparable.
  fs.mkdirSync(path.join(ctx.root, "exports", "dash-currency"), { recursive: true });
  const currencyRel = "exports/dash-currency/report.md";
  const currencyStateRel = "exports/dash-currency/analysis-state.json";
  fs.writeFileSync(path.join(ctx.root, currencyRel), "# Currency report\n");
  const currencyReport = ctx.store.indexFile(currencyRel, { source: "agent" });
  const currencyState = makeState({ targetPrice: 97 });
  currencyState.subject.units = "usd/share";
  currencyState.valuations = currencyState.valuations.map((item) => ({ ...item, unit: "usd/share" }));
  fs.writeFileSync(path.join(ctx.root, currencyStateRel), `${JSON.stringify(currencyState, null, 2)}\n`);
  ctx.store.indexFile(currencyStateRel, { source: "agent", visibility: "internal" });
  const currencyTracking = ctx.store.createTracking({
    targetId: currencyReport.id, templateId: "framework", freq: "weekly", weekday: 1, time: "09:00",
  });
  const currencyRun = ctx.store.startTrackingRun(currencyTracking.id, { trigger: "manual", baseVersion: 1 });
  fs.writeFileSync(path.join(ctx.root, currencyRel), "# Currency report v2\n");
  ctx.store.indexFile(currencyRel, { source: "agent", runId: currencyRun.id });
  ctx.store.indexFile(currencyStateRel, { source: "agent", visibility: "internal", runId: currencyRun.id });
  const currencyResult = makeResult({
    trackingId: currencyTracking.id, targetId: currencyReport.id, targetPath: currencyRel,
    runId: currencyRun.id, baseVersion: 1, resultVersion: 2, status: "updated", headline: "跨币种估值测试",
  });
  ctx.store.finishTrackingRun(currencyTracking.id, currencyRun.id, {
    status: "updated", message: "币种测试", resultVersion: 2, result: currencyResult,
  });
  local.currency = { tracking: currencyTracking, run: currencyRun, report: currencyReport };
  local.stable = { tracking: stable, run: stableRun, report: stableReport };
  local.audit = { tracking: audit, run: auditRun, report: auditReport };
  local.noChange = { tracking: noChange, run: noChangeRun, report: noChangeReport };
  local.partial = { tracking: partial, run: partialRun, report: partialReport };
  local.noRun = { tracking: noRun, report: emptyReport };
}

async function getJson(pathname) {
  const res = await fetch(local.base + pathname);
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

function section(dto, type) {
  return dto.sections.find((item) => item.type === type).data;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function main() {
  const config = await loadConfig({
    env: {
      ...process.env,
      WORKBENCH_STORAGE_ROOT: tmp,
      WORKBENCH_PROJECTS_DIR: path.join(tmp, "projects"),
      PORT: "0",
      PI_FAKE_AGENT: "1",
      WORKBENCH_TEST: "1",
      TRACKING_SCHEDULER: "0",
      MONITOR_SCHEDULER: "0",
      SOURCE_SCHEDULER: "0",
      WORKBOOK_QUERY: "0",
      PDF_READ: "0",
      WESTOCK_QUERY: "0",
      ANYSEARCH_QUERY: "0",
      ASR: "0",
    },
  });
  local.app = await createWorkbench({ config, logger: silent });
  const { port } = await local.app.listen(0, "127.0.0.1");
  local.base = `http://127.0.0.1:${port}`;
  local.ctx = local.app.projectManager.get("product-eng");
  await seed();
  registerDashboardComponents();

  console.log("\ndashboard API");
  let latestDto = null;
  await run("latest dashboard is schema-valid and fixed to four sections", async () => {
    const { res, json } = await getJson(`/api/trackings/${local.full.tracking.id}/dashboard`);
    assert.equal(res.status, 200);
    assert.equal(INVESTMENT_DASHBOARD.validate(json).ok, true, JSON.stringify(INVESTMENT_DASHBOARD.validate(json).errors));
    assert.deepEqual(json.sections.map((item) => item.type), DASHBOARD_SECTIONS.map((item) => item.type));
    assert.equal(json.schema.name, "pe.investment-dashboard");
    assert.equal(json.source.runId, local.full.run2.id);
    latestDto = json;
  });

  await run("dashboard responses are deterministic for the same run", async () => {
    const a = await getJson(`/api/trackings/${local.full.tracking.id}/dashboard`);
    const b = await getJson(`/api/trackings/${local.full.tracking.id}/dashboard`);
    assert.deepEqual(a.json, b.json);
    const c = await getJson(`/api/trackings/${local.full.tracking.id}/runs/${local.full.run2.id}/dashboard`);
    assert.deepEqual(c.json.sections, a.json.sections);
  });

  await run("historical run uses its own state snapshot, not the latest values", async () => {
    const { res, json } = await getJson(`/api/trackings/${local.full.tracking.id}/runs/${local.full.run1.id}/dashboard`);
    assert.equal(res.status, 200);
    assert.equal(json.source.runId, local.full.run1.id);
    assert.equal(section(json, "valuation-summary").targetPrice, 95);
    const latest = await getJson(`/api/trackings/${local.full.tracking.id}/dashboard`);
    assert.equal(section(latest.json, "valuation-summary").targetPrice, 97);
    assert.notEqual(section(json, "valuation-summary").sourceRefs.find((ref) => ref.kind === "state").version,
      section(latest.json, "valuation-summary").sourceRefs.find((ref) => ref.kind === "state").version);
    // Historical checks must not read the mutable latest monitor ledger.
    const checks = section(json, "falsification-panel").checks;
    assert.ok(checks.every((check) => !check.id.startsWith("MON")), checks.map((check) => check.id));
    assert.ok(checks.every((check) => !check.sourceRefs.some((ref) => String(ref.locator || "").startsWith("monitor_items["))));
    assert.equal(json.dataState, "complete");
  });

  await run("audit-only versions are not described as business changes", async () => {
    const { res, json } = await getJson(`/api/trackings/${local.audit.tracking.id}/dashboard`);
    assert.equal(res.status, 200);
    const change = section(json, "version-change");
    assert.equal(change.status, "updated");
    assert.equal(change.changeKind, "audit-only");
    assert.equal(change.conclusionChanged, false);
    assert.match(change.auditNote, /审计版本/);
  });

  await run("no_change is explicit and distinct from updated", async () => {
    const { res, json } = await getJson(`/api/trackings/${local.noChange.tracking.id}/dashboard`);
    assert.equal(res.status, 200);
    const change = section(json, "version-change");
    assert.equal(change.status, "no_change");
    assert.equal(change.changeKind, "none");
    assert.equal(change.conclusionChanged, false);
    assert.match(change.auditNote, /无重大变化/);
  });

  await run("versions and source refs match material history", async () => {
    const { json } = await getJson(`/api/trackings/${local.full.tracking.id}/runs/${local.full.run1.id}/dashboard`);
    const change = section(json, "version-change");
    assert.equal(change.fromVersion, "v1");
    assert.equal(change.toVersion, "v2");
    assert.equal(change.fromDate, local.ctx.store.getMaterial(local.full.report.id).versions.find((v) => v.v === 1).createdAt);
    assert.equal(change.toDate, local.ctx.store.getMaterial(local.full.report.id).versions.find((v) => v.v === 2).createdAt);
    assert.equal(json.source.materialId, local.full.report.id);
    assert.equal(json.source.materialVersion, 2);
    const ref = change.sourceRefs.find((item) => item.kind === "material" && item.version === 2);
    assert.equal(ref.status, "ok");
    assert.equal(ref.materialId, local.full.report.id);
  });

  await run("valuation computes upside only from numeric same-unit prices", async () => {
    const valuation = section(latestDto, "valuation-summary");
    assert.equal(valuation.currentPrice, 78);
    assert.equal(valuation.targetPrice, 97);
    assert.equal(valuation.upsidePercent, 24.36);
    assert.equal(valuation.currency, "CNY");
    assert.equal(validationUnit(valuation.priceUnit), true);
  });

  await run("a fixed historical run stays identical when newer runs are added", async () => {
    const run2 = local.ctx.store.startTrackingRun(local.stable.tracking.id, { trigger: "manual", baseVersion: 2 });
    fs.writeFileSync(path.join(local.ctx.root, "exports/dash-stable/report.md"), "# Stable v3\n");
    local.ctx.store.indexFile("exports/dash-stable/report.md", { source: "agent", runId: run2.id });
    fs.writeFileSync(path.join(local.ctx.root, "exports/dash-stable/analysis-state.json"), `${JSON.stringify(makeState({ targetPrice: 92 }), null, 2)}\n`);
    local.ctx.store.indexFile("exports/dash-stable/analysis-state.json", { source: "agent", visibility: "internal", runId: run2.id });
    const result2 = makeResult({
      trackingId: local.stable.tracking.id, targetId: local.stable.report.id, targetPath: "exports/dash-stable/report.md",
      runId: run2.id, baseVersion: 2, resultVersion: 3, status: "updated", headline: "目标价 91 → 92",
      from: "91 元/股", to: "92 元/股",
    });
    local.ctx.store.finishTrackingRun(local.stable.tracking.id, run2.id, {
      status: "updated", message: "stable v3", resultVersion: 3, result: result2,
    });

    const before = await getJson(`/api/trackings/${local.stable.tracking.id}/runs/${local.stable.run.id}/dashboard`);
    assert.equal(before.res.status, 200);

    const run3 = local.ctx.store.startTrackingRun(local.stable.tracking.id, { trigger: "manual", baseVersion: 3 });
    fs.writeFileSync(path.join(local.ctx.root, "exports/dash-stable/report.md"), "# Stable v4\n");
    local.ctx.store.indexFile("exports/dash-stable/report.md", { source: "agent", runId: run3.id });
    fs.writeFileSync(path.join(local.ctx.root, "exports/dash-stable/analysis-state.json"), `${JSON.stringify(makeState({ targetPrice: 93 }), null, 2)}\n`);
    local.ctx.store.indexFile("exports/dash-stable/analysis-state.json", { source: "agent", visibility: "internal", runId: run3.id });
    const result3 = makeResult({
      trackingId: local.stable.tracking.id, targetId: local.stable.report.id, targetPath: "exports/dash-stable/report.md",
      runId: run3.id, baseVersion: 3, resultVersion: 4, status: "updated", headline: "目标价 92 → 93",
      from: "92 元/股", to: "93 元/股",
    });
    local.ctx.store.finishTrackingRun(local.stable.tracking.id, run3.id, {
      status: "updated", message: "stable v4", resultVersion: 4, result: result3,
    });

    const after = await getJson(`/api/trackings/${local.stable.tracking.id}/runs/${local.stable.run.id}/dashboard`);
    assert.deepEqual(after.json, before.json);
    const latest = await getJson(`/api/trackings/${local.stable.tracking.id}/dashboard`);
    assert.equal(section(latest.json, "valuation-summary").targetPrice, 93);
  });

  await run("non-per-share units never produce an upside percentage", async () => {
    const { res, json } = await getJson(`/api/trackings/${local.unit.tracking.id}/dashboard`);
    assert.equal(res.status, 200);
    const valuation = section(json, "valuation-summary");
    assert.equal(valuation.valueUnit, "百万元");
    assert.equal(valuation.currentPrice, 78);
    assert.equal(valuation.targetPrice, 9700);
    assert.equal(valuation.priceUnit, null);
    assert.equal(valuation.upsidePercent, null);
    assert.ok(valuation.unknowns.some((item) => /非每股|每股口径/.test(item)), valuation.unknowns);
  });

  await run("mismatched explicit currencies never produce an upside percentage", async () => {
    const { res, json } = await getJson(`/api/trackings/${local.currency.tracking.id}/dashboard`);
    assert.equal(res.status, 200);
    const valuation = section(json, "valuation-summary");
    assert.equal(valuation.currency, "CNY");
    assert.equal(valuation.priceUnit, "usd/share");
    assert.equal(valuation.currentPrice, 78);
    assert.equal(valuation.targetPrice, 97);
    assert.equal(valuation.upsidePercent, null);
    assert.ok(valuation.unknowns.some((item) => /USD.*CNY.*不一致/.test(item)), valuation.unknowns);
  });

  await run("target price matches the run output and keeps its cell locator", async () => {
    const valuation = section(latestDto, "valuation-summary");
    assert.equal(valuation.targetPrice, 97);
    const workbook = valuation.sourceRefs.find((ref) => ref.kind === "workbook");
    assert.ok(workbook, JSON.stringify(valuation.sourceRefs));
    assert.equal(workbook.locator, "Model!B4");
    assert.equal(workbook.status, "broken");
  });

  await run("20+ monitor checks keep unknown visible and triggered first", async () => {
    const panel = section(latestDto, "falsification-panel");
    assert.ok(panel.checks.length >= 20, panel.checks.length);
    assert.equal(panel.checks[0].status, "triggered");
    const unknown = panel.checks.filter((check) => check.status === "unknown");
    assert.ok(unknown.length >= 3);
    assert.equal(unknown[0].statusLabel, "缺数据");
    assert.match(unknown[0].statusMeaning, /不能视为正常/);
    assert.ok(panel.counts.triggered >= 1);
  });

  await run("sensitivity matrix comes only from existing valuations", async () => {
    const sens = section(latestDto, "sensitivity-matrix");
    assert.equal(sens.available, true);
    assert.equal(sens.cells.length, 3);
    assert.equal(sens.baseCase.value, 97);
    assert.equal(sens.baseCase.row, "base");
    assert.ok(sens.tests.some((test) => test.id === "S1"));
  });

  await run("missing state and no sensitivities produce true empty states", async () => {
    const { res, json } = await getJson(`/api/trackings/${local.partial.tracking.id}/dashboard`);
    assert.equal(res.status, 200);
    assert.equal(INVESTMENT_DASHBOARD.validate(json).ok, true);
    const valuation = section(json, "valuation-summary");
    assert.equal(valuation.currentPrice, null);
    assert.equal(valuation.targetPrice, null);
    assert.equal(valuation.upsidePercent, null);
    assert.notEqual(valuation.currentPrice, 0);
    assert.ok(valuation.sourceRefs.some((ref) => ref.status === "missing"));
    const sens = section(json, "sensitivity-matrix");
    assert.equal(sens.available, false);
    assert.deepEqual(sens.cells, []);
    assert.match(sens.emptyReason, /尚无敏感性数据/);
  });

  await run("tracking without runs returns an explicit empty dashboard", async () => {
    const { res, json } = await getJson(`/api/trackings/${local.noRun.tracking.id}/dashboard`);
    assert.equal(res.status, 200);
    assert.equal(json.dataState, "empty");
    assert.equal(json.source.runId, null);
    assert.ok(json.warnings.some((item) => /尚无运行记录/.test(item)));
    const change = section(json, "version-change");
    assert.equal(change.status, "unavailable");
    assert.equal(change.changeKind, "unavailable");
    assert.match(change.auditNote, /不判定为业务变化/);
    assert.equal(INVESTMENT_DASHBOARD.validate(json).ok, true);
  });

  await run("dashboard endpoint rejects non-GET methods", async () => {
    const res = await fetch(`${local.base}/api/trackings/${local.full.tracking.id}/dashboard`, { method: "POST" });
    assert.equal(res.status, 405);
  });

  await run("unknown run and unknown tracking return 404", async () => {
    const run = await getJson(`/api/trackings/${local.full.tracking.id}/runs/run_missing/dashboard`);
    assert.equal(run.res.status, 404);
    const tracking = await getJson(`/api/trackings/track_missing/dashboard`);
    assert.equal(tracking.res.status, 404);
  });

  await run("materialVersion mismatch is reported instead of mixing data", async () => {
    const { res, json } = await getJson(`/api/trackings/${local.full.tracking.id}/dashboard?materialVersion=99`);
    assert.equal(res.status, 200);
    assert.ok(json.warnings.some((item) => /materialVersion=99/.test(item)));
    assert.equal(section(json, "version-change").toVersion, "v3");
  });

  console.log("\ndashboard schema");
  await run("valid four-section payload passes", () => {
    assert.equal(INVESTMENT_DASHBOARD.validate(latestDto).ok, true);
  });
  await run("missing critical field is rejected", () => {
    const bad = clone(latestDto);
    delete bad.sections[0].data.company;
    assert.equal(INVESTMENT_DASHBOARD.validate(bad).ok, false);
  });
  await run("unknown section type is rejected", () => {
    const bad = clone(latestDto);
    bad.sections[0].type = "raw-html";
    assert.equal(INVESTMENT_DASHBOARD.validate(bad).ok, false);
  });
  await run("unknown section version is rejected", () => {
    const bad = clone(latestDto);
    bad.sections[2].version = 2;
    assert.equal(INVESTMENT_DASHBOARD.validate(bad).ok, false);
  });
  await run("formatted-string numbers, bad dates and bad currency are rejected", () => {
    const numberBad = clone(latestDto);
    numberBad.sections[0].data.currentPrice = "78";
    assert.equal(INVESTMENT_DASHBOARD.validate(numberBad).ok, false);
    const dateBad = clone(latestDto);
    dateBad.sections[0].data.asOf = "2026/10/20";
    assert.equal(INVESTMENT_DASHBOARD.validate(dateBad).ok, false);
    const currencyBad = clone(latestDto);
    currencyBad.sections[0].data.currency = "cny";
    assert.equal(INVESTMENT_DASHBOARD.validate(currencyBad).ok, false);
  });
  await run("duplicated or reordered sections are rejected", () => {
    const duplicate = clone(latestDto);
    duplicate.sections = [duplicate.sections[0], duplicate.sections[0], duplicate.sections[2], duplicate.sections[3]];
    assert.equal(INVESTMENT_DASHBOARD.validate(duplicate).ok, false);
    const reordered = clone(latestDto);
    [reordered.sections[0], reordered.sections[1]] = [reordered.sections[1], reordered.sections[0]];
    assert.equal(INVESTMENT_DASHBOARD.validate(reordered).ok, false);
  });
  await run("impossible calendar dates are rejected", () => {
    const feb = clone(latestDto);
    feb.sections[0].data.asOf = "2026-02-31";
    assert.equal(INVESTMENT_DASHBOARD.validate(feb).ok, false);
    const month = clone(latestDto);
    month.sections[0].data.asOf = "2026-13-01";
    assert.equal(INVESTMENT_DASHBOARD.validate(month).ok, false);
    const leap = clone(latestDto);
    leap.sections[0].data.asOf = "2026-02-29";
    assert.equal(INVESTMENT_DASHBOARD.validate(leap).ok, false);
    const realLeap = clone(latestDto);
    realLeap.sections[0].data.asOf = "2024-02-29";
    assert.equal(INVESTMENT_DASHBOARD.validate(realLeap).ok, true);
  });
  await run("partial/empty section data remains valid", () => {
    const dto = clone(latestDto);
    const partial = section(dto, "sensitivity-matrix");
    partial.available = false;
    partial.cells = [];
    partial.baseCase = null;
    partial.rowAxis.values = [];
    partial.columnAxis.values = [];
    partial.tests = [];
    partial.valueUnit = "";
    partial.units = [];
    partial.summary = "";
    assert.equal(INVESTMENT_DASHBOARD.validate(dto).ok, true);
  });

  console.log("\ndashboard component catalog");
  await run("renders all four fixed components", () => {
    const html = renderDashboardSections(latestDto);
    assert.match(html, /当前估值结论|长鑫科技/);
    assert.match(html, /版本变化/);
    assert.match(html, /情景估值矩阵/);
    assert.match(html, /推翻条件/);
    assert.match(html, /基准/);
  });
  await run("unknown component or version renders an error placeholder", () => {
    const unknownType = renderDashboardSection({ type: "raw-html", version: 1, data: {} });
    assert.match(unknownType, /未知组件/);
    const unknownVersion = renderDashboardSection({ type: "valuation-summary", version: 9, data: {} });
    assert.match(unknownVersion, /未知组件/);
  });
  await run("empty sensitivity and falsification render explicit empty states", () => {
    const partial = renderDashboardSections((() => {
      const dto = clone(latestDto);
      dto.sections[2].data.available = false;
      dto.sections[2].data.cells = [];
      dto.sections[2].data.baseCase = null;
      dto.sections[2].data.tests = [];
      dto.sections[2].data.rowAxis.values = [];
      dto.sections[2].data.columnAxis.values = [];
      dto.sections[3].data.checks = [];
      dto.sections[3].data.theses = [];
      dto.sections[3].data.counts = { triggered: 0, warning: 0, unknown: 0, armed: 0, retired: 0 };
      return dto;
    })());
    assert.match(partial, /尚无敏感性数据/);
    assert.match(partial, /尚未配置失效条件/);
  });
  await run("payload text and event attributes never become executable HTML", () => {
    const dto = clone(latestDto);
    dto.sections[0].data.company = '<script>window.__dashXss=1</script><img src=x onerror="window.__dashXss=2">';
    dto.sections[1].data.reasons[0].detail = '<svg onload="window.__dashXss=3"></svg>';
    dto.sections[3].data.checks[0].observed = '"><iframe srcdoc="<script>1</script>">';
    dto.sections[3].data.checks[0].sourceRefs[0].url = "javascript:window.__dashXss=4";
    const html = renderDashboardSections(dto);
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /<img /);
    assert.doesNotMatch(html, /<svg onload/);
    assert.doesNotMatch(html, /<iframe/);
    assert.doesNotMatch(html, /href="javascript:/);
    assert.match(html, /&lt;script&gt;/);
  });
  await run("unavailable/failed versions do not claim a business conclusion", () => {
    const dto = clone(latestDto);
    const version = dto.sections[1].data;
    version.status = "unavailable";
    version.statusLabel = "无结果";
    version.changeKind = "unavailable";
    version.conclusionChanged = false;
    version.auditNote = "该次运行没有可用的结构化结果，不判定为业务变化。";
    const html = renderDashboardSection(dto.sections[1]);
    assert.match(html, /无结果，未产生可比较结论/);
    assert.doesNotMatch(html, /结论无业务变化/);
    const failed = clone(dto);
    failed.sections[1].data.status = "failed";
    failed.sections[1].data.statusLabel = "运行失败";
    failed.sections[1].data.changeKind = "failed";
    const failedHTML = renderDashboardSection(failed.sections[1]);
    assert.match(failedHTML, /运行失败，未产生可比较结论/);
    assert.doesNotMatch(failedHTML, /结论无业务变化/);
  });

  await run("malicious count values are rejected by the component validator", () => {
    const dto = clone(latestDto);
    dto.sections[3].data.counts.triggered = '<img src=x onerror="window.__dashXss=1">';
    const html = renderDashboardSection(dto.sections[3]);
    assert.match(html, /数据不完整/);
    assert.doesNotMatch(html, /<img /);
  });

  await run("very long reasons remain text and never break the renderer", () => {
    const dto = clone(latestDto);
    dto.sections[1].data.reasons[0].detail = "长".repeat(20000);
    dto.sections[1].data.reasons[0].source = "来".repeat(20000);
    const html = renderDashboardSection(dto.sections[1]);
    assert.ok(html.length > 20000);
    assert.doesNotMatch(html, /<script/);
  });

  await run("broken, missing and unverified source refs are labelled distinctly", () => {
    const dto = clone(latestDto);
    dto.sections[0].data.sourceRefs[0].status = "missing";
    assert.match(renderDashboardSection(dto.sections[0]), /缺失/);
    dto.sections[0].data.sourceRefs[0].status = "broken";
    assert.match(renderDashboardSection(dto.sections[0]), /断链/);
    dto.sections[0].data.sourceRefs[0].status = "unverified";
    assert.match(renderDashboardSection(dto.sections[0]), /未验证/);
  });

  await local.app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

function validationUnit(unit) {
  return unit === "元/股";
}

main().catch((error) => {
  console.error(error);
  try { local.app?.close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
