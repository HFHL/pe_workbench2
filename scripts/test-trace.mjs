/**
 * Model trace service test.
 *
 * Uses a throwaway SQLite store and a small synthetic judgment card. The card
 * is only the historical seed; after that the trace grows by itself.
 */

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openStore } from "../store.mjs";
import { createTraceService } from "../lib/trace/service.mjs";

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pe-trace-"));
try {
  const store = await openStore({
    root: dir,
    workspace: path.join(dir, "project"),
    projectId: "p-test",
    projectName: "Test",
    seed: false,
  });

  store.saveJudgmentCard({
    id: "CARD-TEST",
    subject: "测试存储",
    question: "测试问题",
    conclusion: { target: 92, previousTarget: 129, delta: "-28.7%", rating: "增持", confidence: "中" },
    model: { materialId: null },
    provenance: { reportFile: null, stateFile: null },
    evidence: [],
    stages: [
      {
        id: "ST0",
        label: "基准",
        date: "2026-09-04",
        committedAt: "2026-09-04 18:00",
        intent: "continue",
        summary: "建立基准",
        diffTags: ["目标价 129"],
        change: {
          headline: "基准：目标价 ¥129",
          why: "为什么变：首次生成。",
          drivers: [{ kind: "user", label: "首次生成", ref: "ST0", effect: "建立基准" }],
        },
      },
      {
        id: "ST1",
        label: "修订",
        date: "2026-10-19",
        committedAt: "2026-10-19 09:17",
        intent: "revise",
        summary: "下修",
        diffTags: ["目标价 129→92"],
        change: {
          headline: "目标价 ¥129 → ¥92（-28.7%）",
          why: "为什么变：毛利率假设被削弱。\n目标价：下修。",
          drivers: [{ kind: "user", label: "人工判断", ref: "ST1", effect: "下修" }],
        },
      },
      {
        id: "ST2",
        label: "证据核验",
        date: "2026-10-22",
        committedAt: "2026-10-22 22:46",
        intent: "revise",
        summary: "核验证据，目标价未变",
        diffTags: ["证据核验"],
        change: {
          headline: "判断变更：证据核验；目标价未变",
          why: "为什么变：核验了关键证据。\n目标价：未变。",
          drivers: [{ kind: "user", label: "签核", ref: "ST2", effect: "记录" }],
        },
      },
    ],
  }, "p-test");

  const trace = createTraceService({ store, projectId: "p-test", projectName: "Test" });
  const initial = trace.view();
  assert.equal(initial.entries.length, 3);
  assert.equal(initial.entries[0].kind, "generated");
  assert.equal(initial.entries[1].kind, "revised");
  assert.equal(initial.entries[1].title.includes("129"), true);
  assert.equal(initial.focus.id, initial.entries[1].id, "focus is the latest valuation change, not the evidence checkpoint");
  assert.equal(initial.current.target, 92);
  assert.equal(initial.pendingJudgment, null);

  const invalid = trace.judge({ entryId: initial.focus.id, verdict: "maybe" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.status, 400);

  const high = trace.judge({ entryId: initial.focus.id, verdict: "high", note: "毛利率太乐观" });
  assert.equal(high.ok, true);
  assert.equal(high.pendingJudgment.verdict, "high");
  assert.equal(high.pendingJudgment.status, "pending_confirmation");
  assert.equal(high.focus, null);

  const duplicate = trace.judge({ entryId: initial.focus.id, verdict: "fair" });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.status, 409);

  const cancelled = trace.confirm({ judgmentId: high.pendingJudgment.id, action: "cancel" });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.pendingJudgment, null);
  assert.equal(cancelled.entries.find((entry) => entry.id === initial.focus.id).judgment.status, "cancelled");
  assert.equal(cancelled.entries.some((entry) => entry.kind === "adjustment"), false);

  trace.reset();
  const clean = trace.view();
  assert.equal(clean.focus.id, clean.entries[1].id);
  const low = trace.judge({ entryId: clean.focus.id, verdict: "low", note: "产能爬坡更快" });
  assert.equal(low.pendingJudgment.verdict, "low");
  const adjusted = trace.confirm({ judgmentId: low.pendingJudgment.id, action: "adjust" });
  assert.equal(adjusted.ok, true);
  assert.equal(adjusted.entries.at(-1).kind, "adjustment");
  assert.equal(adjusted.entries.at(-1).title.includes("偏低"), true);
  assert.equal(adjusted.adjustment.prompt.includes("上调"), true);
  assert.equal(adjusted.adjustment.prompt.includes("产能爬坡更快"), true);
  assert.equal(adjusted.entries.find((entry) => entry.id === clean.focus.id).judgment.status, "confirmed");

  const again = trace.confirm({ judgmentId: low.pendingJudgment.id, action: "adjust" });
  assert.equal(again.ok, false);
  assert.equal(again.status, 409);

  const run = trace.recordRun({
    sessionId: "s-run",
    runId: "run-proposal-1",
    changedFiles: [
      "exports/investment-model/高盛-长鑫-Model-20260904/归母净利润与少数股东权益专题分析.md",
      "exports/investment-model/高盛-长鑫-Model-20260904/估值模型调整方案_归母权益口径.md",
      "exports/investment-model/高盛-长鑫-Model-20260904/估值模型_修正版_归母口径.tsv",
    ],
    text: "现有模型全部用合并口径。目标价区间从 88–100 元整体下移到 60–85 元。引入归母系数 Mi。",
    at: "2026-10-23T00:30:00.000Z",
  });
  assert.equal(run.kind, "proposed");
  assert.equal(run.title.includes("60–85"), true);
  assert.equal(run.files.length, 3);
  const duplicateRun = trace.recordRun({
    sessionId: "s-run",
    runId: "run-proposal-1",
    changedFiles: run.source.changedFiles,
    text: "重复结算",
  });
  assert.equal(duplicateRun, null);
  const runView = trace.view();
  assert.equal(runView.focus.id, run.id);
  assert.equal(runView.focus.kind, "proposed");

  const adopted = trace.judge({ entryId: run.id, verdict: "fair", adopt: true, note: "接受 65% Mi" });
  assert.equal(adopted.judgment.status, "adopted");
  assert.equal(adopted.adoption.prompt.includes("写入"), true);
  assert.equal(adopted.focus, null);
  const reJudge = trace.judge({ entryId: run.id, verdict: "high" });
  assert.equal(reJudge.status, 409);

  const appliedRun = trace.recordRun({
    sessionId: "s-applied",
    runId: "run-applied-1",
    changedFiles: ["exports/investment-model/高盛-长鑫-Model-20260904/投资框架报告.md"],
    text: "已把目标价 60–85 写入投资框架报告。",
    at: "2026-10-23T01:00:00.000Z",
  });
  assert.equal(appliedRun.kind, "revised");
  assert.equal(trace.view().focus.id, appliedRun.id);

  const fairTrace = createTraceService({ store, projectId: "p-fair", projectName: "Fair" });
  const fairView = fairTrace.view();
  assert.equal(fairView.entries.length, 0, "a project without a card or model starts empty");

  // The judgment card has to name the number: analysis-state valuations, the
  // scenario band and the market price all reach the view.
  const stateRoot = path.join(dir, "state-project");
  const stateDir = path.join(stateRoot, "exports", "investment-model", "model");
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.writeFile(path.join(stateDir, "analysis-state.json"), JSON.stringify({
    subject: { company: "长鑫科技", valuation_date: "2026-09-04" },
    market: { price: 42.85, currency: "RMB", price_date: "2026-10-23" },
    valuations: [
      { id: "V1", scenario: "base", value: 129, unit: "元/股", as_of: "2026-09-04" },
      { id: "V2", scenario: "bull", value: 187, unit: "元/股" },
      { id: "V3", scenario: "bear", value: 78, unit: "元/股" },
    ],
  }), "utf8");
  const stateTrace = createTraceService({ store, projectId: "p-state", projectName: "State", root: stateRoot });
  const stateView = stateTrace.view();
  assert.equal(stateView.current.target, 129);
  assert.equal(stateView.current.unit, "元/股");
  assert.equal(stateView.current.valuationDate, "2026-09-04");
  assert.deepEqual(stateView.current.scenarios.map((item) => item.value), [78, 129, 187]);
  assert.equal(stateView.current.market.price, 42.85);
  assert.equal(stateView.current.market.asOf, "2026-10-23");
  assert.equal(stateView.current.upsidePct, 201.1);

  console.log("trace: ok");
} finally {
  await fsp.rm(dir, { recursive: true, force: true });
}
