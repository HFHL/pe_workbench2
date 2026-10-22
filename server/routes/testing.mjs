/**
 * Test-only fixture routes. Disabled unless WORKBENCH_TEST=1.
 *
 * The browser suite needs a real workbook, a real prepared working model and a
 * real pending proposal without calling a model provider. Everything here uses
 * the same approval service and file paths as production; only the seeding is
 * synthetic.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { normalizeTrackingResult } from "../../lib/tracking.mjs";

export async function handleTesting({ req, res, url, app, ctx }) {
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/testing/")) return false;
  if (!app.config.testMode) {
    app.http.json(res, 404, { error: "not found" });
    return true;
  }

  if (pathname === "/api/testing/approvals" && req.method === "POST") {
    const body = await app.http.readJson(req).catch(() => ({}));
    const scenario = String(body.scenario || "approve");
    try {
      const seeded = await seedApproval({ ctx, app, scenario });
      app.http.json(res, 201, seeded);
    } catch (error) {
      app.http.json(res, 500, { error: error.message });
    }
    return true;
  }

  if (pathname === "/api/testing/dashboard" && req.method === "POST") {
    const body = await app.http.readJson(req).catch(() => ({}));
    try {
      const seeded = await seedDashboard({ ctx, app, scenario: String(body.scenario || "full") });
      app.http.json(res, 201, seeded);
    } catch (error) {
      app.http.json(res, 500, { error: error.message });
    }
    return true;
  }

  if (pathname === "/api/testing/reset" && req.method === "POST") {
    const rows = ctx.store.db.prepare(
      `select id from trackings where workspace_id = ? and target_id in (
         select id from materials where workspace_id = ? and path like 'exports/test-approval/%'
       )`,
    ).all(ctx.id, ctx.id);
    for (const row of rows) ctx.store.deleteTracking(row.id);
    ctx.store.db.prepare(`delete from approval_requests where workspace_id = ?`).run(ctx.id);
    const root = path.join(ctx.root, "exports", "test-approval");
    await fsp.rm(root, { recursive: true, force: true });
    app.http.json(res, 200, { ok: true });
    return true;
  }

  app.http.json(res, 404, { error: "not found" });
  return true;
}

async function seedApproval({ ctx, app, scenario }) {
  const stamp = Date.now().toString(36);
  const dirRel = `exports/test-approval/${stamp}`;
  const dirAbs = path.join(ctx.root, dirRel);
  await fsp.mkdir(path.join(dirAbs, "model"), { recursive: true });

  const sourceRel = `${dirRel}/source.xlsx`;
  const sourceAbs = path.join(ctx.root, sourceRel);
  execFileSync("python3", [
    path.join(app.config.root, "scripts", "fixtures", "make-workbook-fixture.py"),
    sourceAbs,
    "100",
  ], { stdio: "ignore" });
  ctx.store.indexFile(sourceRel, { source: "agent", status: "draft" });

  const targetRel = `${dirRel}/report.md`;
  await fsp.writeFile(path.join(ctx.root, targetRel), "# Test report\n\nBaseline\n", "utf8");
  const target = ctx.store.indexFile(targetRel, { source: "agent", status: "draft" });

  const stateRel = `${dirRel}/analysis-state.json`;
  const state = {
    subject: { model_file: sourceRel },
    model: {
      files: [{ absolute_path: sourceRel }],
      write_enabled: false,
      bindings: [],
      outputs: [],
    },
  };
  await fsp.writeFile(path.join(ctx.root, stateRel), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  ctx.store.indexFile(stateRel, { source: "agent", status: "draft" });

  const prepared = await app.prepareWorkingModel({
    ctx,
    tracking: { relPath: targetRel },
    state,
    stateRel,
  });
  const enabled = JSON.parse(await fsp.readFile(path.join(ctx.root, stateRel), "utf8"));
  enabled.model.write_enabled = true;
  enabled.model.bindings = [{ metric: "Revenue", sheet: "Model", cell: "B2", verified: true }];
  enabled.model.outputs = [{ label: "Gross profit", sheet: "Model", cell: "B4" }];
  await fsp.writeFile(path.join(ctx.root, stateRel), `${JSON.stringify(enabled, null, 2)}\n`, "utf8");
  ctx.store.indexFile(stateRel, { source: "agent", status: "draft" });

  const tracking = ctx.store.createTracking({
    targetId: target.id,
    templateId: "model",
    freq: "weekly",
    weekday: 1,
    time: "09:00",
  });
  const run = ctx.store.startTrackingRun(tracking.id, {
    trigger: "manual",
    baseVersion: target.versions[0].v,
  });
  run.trigger = "manual";

  const result = normalizeTrackingResult({
    status: "needs_review",
    headline: "Revenue update needs approval",
    conclusion: "Revenue changed from 100 to 120.",
    summary: "The actual revenue is 120. Gross profit should be recalculated.",
    confidence: "中",
    modelChanges: [{ metric: "Revenue", sheet: "Model", cell: "B2", value: 120, note: "actual revenue" }],
    modelOutputs: [{ label: "Gross profit", sheet: "Model", cell: "B4" }],
    sources: [{ label: "Actuals.xlsx", date: "2026-10-20" }],
  }, {
    trackingId: tracking.id,
    targetId: target.id,
    targetPath: targetRel,
    templateId: "model",
    baseVersion: target.versions[0].v,
    resultVersion: null,
    nowLabel: "2026-10-20 09:00",
    duration: "1m",
    fallbackConclusion: "done",
    fallbackSummary: "",
    status: "needs_review",
    runId: run.id,
    trigger: "manual",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  });

  const proposed = await ctx.approvals.propose({
    ctx,
    tracking: ctx.store.getTracking(tracking.id),
    trackingRunId: run.id,
    threadId: `test-thread-${stamp}`,
    result,
    state: enabled,
    stateRel,
  });
  if (!proposed.ok) throw new Error(proposed.reason);
  result.writeback.approval = {
    id: proposed.approval.id,
    status: proposed.approval.status,
    createdAt: proposed.approval.createdAt,
  };
  ctx.store.finishTrackingRun(tracking.id, run.id, {
    status: "needs_review",
    message: "等待模型写回审批",
    result,
  });

  if (scenario === "conflict") {
    // Simulate a newer version written after the proposal was generated.
    ctx.store.indexFile(prepared.workingFile, { forceVersion: true, source: "agent" });
  }

  app.bus.broadcastGlobal({
    type: "approval.created",
    approval: ctx.approvals.get(proposed.approval.id),
  }, ctx.id);
  app.bus.broadcastGlobal({ type: "tracking.updated", tracking: ctx.store.getTracking(tracking.id) }, ctx.id);
  return {
    approval: ctx.approvals.get(proposed.approval.id),
    trackingId: tracking.id,
    runId: run.id,
    workingFile: prepared.workingFile,
    scenario,
  };
}


/* ---------- investment dashboard fixture ---------- */

function dashboardState({
  company = "长鑫科技",
  targetPrice = 92,
  includeSensitivities = true,
  includeTheses = true,
  sourceLabel = "TrendForce DRAM 月报",
  falsifierSource = { text: "TrendForce 月报", url: "https://example.com/dram" },
} = {}) {
  return {
    schema_version: "2.0",
    framework_id: "IF-DASH-E2E",
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
    theses: includeTheses ? [{
      id: "T1",
      statement: "AI 服务器需求推动 DRAM 周期上行，2027 年 ASP 与毛利率同时改善。",
      mechanism: "需求 → 价格 → 毛利 → EPS",
      horizon: "12–24 个月",
      assumption_ids: [],
      support_ids: [],
      counter_ids: [],
      alternatives: "暂无",
      unknowns: "库存",
      confidence: "medium",
      confidence_reason: "方向一致，库存上升。",
      status: "active",
    }] : [],
    valuations: includeSensitivities ? [
      { id: "V1", scenario: "bear", method: "PE", as_of: "2026-09-01", value: 65, unit: "元/股" },
      { id: "V2", scenario: "base", method: "PE", as_of: "2026-09-01", value: targetPrice, unit: "元/股" },
      { id: "V3", scenario: "bull", method: "PE", as_of: "2026-09-01", value: 120, unit: "元/股" },
    ] : [],
    market: { price: 78, price_date: "2026-10-18", consensus: "3 家", consensus_source_ids: [], implied: "", limitations: "" },
    falsifiers: [
      {
        id: "F1", thesis_id: "T1", statement: "渠道库存超过 12 周且继续上升。",
        metric: "渠道 DRAM 库存周数", operator: ">", threshold: "12 周", observed: "9.2 周",
        source: "TrendForce 渠道库存（月度）", frequency: "monthly", warning: "10 周",
        action: "检查需求是否转弱；若同时价格转跌，T1 降为 invalidated", status: "armed",
        last_checked_at: "2026-10-18", last_observed: "9.2 周",
      },
      {
        id: "F2", thesis_id: "T1", statement: "DRAM 合约价连续两个季度环比下跌。",
        metric: "DDR5 8Gb 合约价季度环比", operator: "crosses_below", threshold: "-5% × 2 季",
        observed: "+4%", source: falsifierSource, frequency: "quarterly", warning: "-3%",
        action: "重算 V2", status: "warning", last_checked_at: "2026-10-18", last_observed: "+4%",
      },
    ],
    sensitivities: includeSensitivities ? [
      {
        id: "S1", assumption_ids: ["A1"], method: "model_input", baseline: "2027 ASP 同比 +35%",
        perturbation: "±10%", result: "ASP +10% → 2027E EPS +21%，base 目标价 +18 元",
        affects: ["V2"], evidence_ids: [], fixed_conditions: "产能、毛利率、税率、目标 PE 不变",
        limitations: "只测单价单变量",
      },
    ] : [],
    gaps: [{ id: "G1", question: "ASP 假设依据是什么？", impact: "影响 T1 置信度", evidence_needed: "访谈" }],
    changes: [],
    tracking: { last_run_id: null, last_run_at: null, data_cutoff: "2026-10-18", thesis_status: { T1: "active" }, triggered_falsifier_ids: [] },
    review: { status: "reviewed", mode: "self", notes: [] },
  };
}

function dashboardResult({ trackingId, targetId, targetPath, runId, baseVersion, resultVersion, status, headline, from, to, sourceLabel = "TrendForce DRAM 月报", monitorChecks = [] }) {
  const now = new Date();
  return normalizeTrackingResult({
    status,
    headline,
    conclusion: `${headline}。`,
    summary: "Dashboard 测试用结构化结果；所有数字来自状态文件或本次运行。",
    confidence: "中",
    deltas: from && to ? [{ label: "目标价", from, to, note: "目标价调整", tone: "up" }] : [],
    theses: [{ id: "T1", statement: "AI 服务器需求推动 DRAM 周期上行。", status: "active", change: "维持", note: "证据未变" }],
    invalidations: [],
    monitorChecks,
    modelChanges: [],
    modelOutputs: [],
    reasons: status === "updated" ? [{
      tag: "新实际值", title: "渠道库存超过阈值", detail: "最新月报显示库存 13 周。",
      source: sourceLabel, impact: "F1 触发，T1 需要复核",
    }] : [],
    sources: [{ label: sourceLabel, date: "2026-10-18" }],
    notUsed: ["旧版渠道样本"],
    writeback: {
      mode: "原位更新 · 已备份", stats: "1 处",
      note: "系统写入跟踪记录后产生的新版本。",
      changes: [{ where: "报告结论段", from: from || "—", to: to || "—", note: "目标价" }],
    },
  }, {
    trackingId, targetId, targetPath, templateId: "framework", baseVersion, resultVersion,
    nowLabel: "2026-10-20 09:00", duration: "1m 02s", fallbackConclusion: headline,
    fallbackSummary: "", status, runId, trigger: "manual",
    startedAt: now.toISOString(), endedAt: new Date(now.getTime() + 500).toISOString(),
    backupPath: "exports/test-dashboard/backups/report.md",
  });
}

async function seedDashboard({ ctx, app, scenario }) {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dirRel = `exports/test-dashboard/${stamp}-${scenario}`;
  const dirAbs = path.join(ctx.root, dirRel);
  await fsp.mkdir(dirAbs, { recursive: true });

  const reportRel = `${dirRel}/report.md`;
  await fsp.writeFile(path.join(ctx.root, reportRel), "# 投资框架 v1\n", "utf8");
  const report = ctx.store.indexFile(reportRel, { source: "agent" });
  const stateRel = `${dirRel}/analysis-state.json`;

  if (scenario === "empty") {
    const tracking = ctx.store.createTracking({
      targetId: report.id, templateId: "framework", freq: "weekly", weekday: 1, time: "09:00",
    });
    app.bus.broadcastGlobal({ type: "tracking.updated", tracking: ctx.store.getTracking(tracking.id) }, ctx.id);
    return { scenario, trackingId: tracking.id, runId: null };
  }

  if (scenario === "partial") {
    const tracking = ctx.store.createTracking({
      targetId: report.id, templateId: "framework", freq: "weekly", weekday: 1, time: "09:00",
    });
    const run = ctx.store.startTrackingRun(tracking.id, { trigger: "manual", baseVersion: 1 });
    const result = dashboardResult({
      trackingId: tracking.id, targetId: report.id, targetPath: reportRel, runId: run.id,
      baseVersion: 1, resultVersion: null, status: "baseline", headline: "首次基线，状态文件缺失",
    });
    ctx.store.finishTrackingRun(tracking.id, run.id, { status: "baseline", message: "首次基线", result });
    app.bus.broadcastGlobal({ type: "tracking.updated", tracking: ctx.store.getTracking(tracking.id) }, ctx.id);
    return { scenario, trackingId: tracking.id, runId: run.id };
  }

  const xss = scenario === "xss";
  const noSens = scenario === "nosens";
  const company = xss
    ? '<script>window.__dashXss=1</script><img src=x onerror="window.__dashXss=2">超长公司名'.repeat(12)
    : "长鑫科技股份有限公司（超长名称用于换行与截断验证）";
  const state = dashboardState({
    company,
    targetPrice: 92,
    includeSensitivities: !noSens,
    sourceLabel: xss ? '<script>window.__dashXss=5</script>来源' : "TrendForce DRAM 月报",
    falsifierSource: xss
      ? { text: '<img src=x onerror="window.__dashXss=6">', url: "javascript:window.__dashXss=7" }
      : { text: "TrendForce 月报", url: "https://example.com/dram" },
  });
  await fsp.writeFile(path.join(ctx.root, stateRel), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  ctx.store.indexFile(stateRel, { source: "agent", visibility: "internal" });

  const modelRel = `${dirRel}/model.xlsx`;
  execFileSync("python3", [
    path.join(app.config.root, "scripts", "fixtures", "make-workbook-fixture.py"),
    path.join(ctx.root, modelRel), "100",
  ], { stdio: "ignore" });
  const model = ctx.store.indexFile(modelRel, { source: "agent", status: "draft" });

  const tracking = ctx.store.createTracking({
    targetId: report.id, templateId: "framework", freq: "weekly", weekday: 1, time: "09:00",
  });

  const run1 = ctx.store.startTrackingRun(tracking.id, { trigger: "manual", baseVersion: 1 });
  await fsp.writeFile(path.join(ctx.root, reportRel), "# 投资框架 v2\n", "utf8");
  ctx.store.indexFile(reportRel, { source: "agent", runId: run1.id });
  state.valuations = state.valuations.map((item) => item.id === "V2" ? { ...item, value: 95 } : item);
  await fsp.writeFile(path.join(ctx.root, stateRel), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  ctx.store.indexFile(stateRel, { source: "agent", visibility: "internal", runId: run1.id });
  const result1 = dashboardResult({
    trackingId: tracking.id, targetId: report.id, targetPath: reportRel, runId: run1.id,
    baseVersion: 1, resultVersion: 2, status: "updated", headline: "目标价由 92 上调至 95",
    from: "92 元/股", to: "95 元/股",
  });
  ctx.store.finishTrackingRun(tracking.id, run1.id, {
    status: "updated", message: "更新到 v2", resultVersion: 2, result: result1,
    decisionClass: "C3", confidence: "medium",
  });

  const run2 = ctx.store.startTrackingRun(tracking.id, { trigger: "manual", baseVersion: 2 });
  await fsp.writeFile(path.join(ctx.root, reportRel), "# 投资框架 v3\n", "utf8");
  ctx.store.indexFile(reportRel, { source: "agent", runId: run2.id });
  state.valuations = state.valuations.map((item) => item.id === "V2" ? { ...item, value: 97 } : item);
  await fsp.writeFile(path.join(ctx.root, stateRel), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  ctx.store.indexFile(stateRel, { source: "agent", visibility: "internal", runId: run2.id });
  const result2 = dashboardResult({
    trackingId: tracking.id, targetId: report.id, targetPath: reportRel, runId: run2.id,
    baseVersion: 2, resultVersion: 3, status: "updated", headline: "目标价由 95 上调至 97",
    from: "95 元/股", to: "97 元/股",
    sourceLabel: xss ? '<script>window.__dashXss=8</script>来源' : "TrendForce DRAM 月报",
    monitorChecks: [{ id: "F1", falsifier_id: "F1", observed: "13 周", status: "triggered", note: "库存越过阈值" }],
  });
  result2.writeback.model = {
    file: modelRel,
    version: 1,
    changes: [],
    outputs: [{ label: "目标价", sheet: "Model", cell: "B4", before: 95, after: 97 }],
  };
  ctx.store.finishTrackingRun(tracking.id, run2.id, {
    status: "updated", message: "更新到 v3", resultVersion: 3, result: result2,
    decisionClass: "C3", confidence: "medium",
  });

  if (!noSens && !xss) {
    const statuses = [
      "triggered", "warning",
      ...Array.from({ length: 17 }, () => "armed"),
      "unknown", "unknown", "unknown", "retired",
    ];
    const items = statuses.map((status, index) => ({
      id: `MON${String(index + 1).padStart(2, "0")}`,
      falsifier_id: `F${index + 1}`,
      thesis_id: "T1",
      metric: index === 0 ? "渠道 DRAM 库存周数" : `监测指标 ${index + 1}`,
      operator: ">",
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
  }

  app.bus.broadcastGlobal({ type: "tracking.updated", tracking: ctx.store.getTracking(tracking.id) }, ctx.id);
  return {
    scenario,
    trackingId: tracking.id,
    runId: run2.id,
    runIds: [run1.id, run2.id],
    modelId: model.id,
    reportId: report.id,
  };
}
