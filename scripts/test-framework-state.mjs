#!/usr/bin/env node
/**
 * 投资框架状态契约 + 跟踪结果归一化的自测。
 * 不依赖网络和模型，只验证结构规则。
 *
 *   node scripts/test-framework-state.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildTrackingPrompt, normalizeTrackingResult } from "../lib/tracking.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = path.join(ROOT, "skills/investment-framework");
const VALIDATOR = path.join(SKILL, "scripts/validate_state.mjs");
const EXAMPLE = path.join(SKILL, "assets/analysis-state.example.json");
const TEMPLATE = path.join(SKILL, "assets/analysis-state.template.json");

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function validate(file) {
  const result = spawnSync(process.execPath, [VALIDATOR, "--quiet", file], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pe-framework-test-"));
const example = JSON.parse(fs.readFileSync(EXAMPLE, "utf8"));

function writeTemp(name, mutate) {
  const state = structuredClone(example);
  mutate(state);
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  return file;
}

console.log("状态契约校验");
{
  const result = validate(EXAMPLE);
  check("示例状态通过校验", result.status === 0, result.output.trim());
}
{
  const result = validate(TEMPLATE);
  check(
    "空模板被拦下并提示 company",
    result.status === 1 && result.output.includes("subject.company"),
    result.output.trim(),
  );
}
{
  const file = writeTemp("warning-status.json", (state) => {
    state.falsifiers[0].status = "warning";
  });
  const result = validate(file);
  check("warning 状态可通过校验", result.status === 0, result.output.trim());
}
{
  const file = writeTemp("broken-ref.json", (state) => {
    state.evidence[0].source_ids = ["SRC404"];
  });
  const result = validate(file);
  check(
    "悬空来源引用被拦下",
    result.status === 1 && result.output.includes("SRC404"),
    result.output.trim(),
  );
}
{
  const file = writeTemp("no-falsifier.json", (state) => {
    state.falsifiers = state.falsifiers.filter((item) => item.thesis_id !== "T2");
    state.tracking.triggered_falsifier_ids = [];
  });
  const result = validate(file);
  check(
    "有效观点缺少失效条件被拦下",
    result.status === 1 && result.output.includes("没有 armed/triggered 的失效条件"),
    result.output.trim(),
  );
}
{
  const file = writeTemp("bad-revision.json", (state) => {
    state.revision = 2;
    state.changes = [];
  });
  const result = validate(file);
  check(
    "revision>1 无 changes 只警告不阻断",
    result.status === 0 && result.output.includes("revision > 1"),
    result.output.trim(),
  );
}

console.log("估值口径、方法切换与归因");

// 这些用例只验证结构规则；数值用于复现 1560/320/458 的方法切换链路，不构成投资判断。

function makeMethodSwitchState(state, overrides = {}) {
  state.revision = 4;
  const a1 = state.assumptions.find((item) => item.id === "A1");
  a1.value = 20;
  a1.statement = "2026E ARR 20 亿美元";
  a1.unit = "亿美元";
  const a2 = state.assumptions.find((item) => item.id === "A2");
  a2.value = 10;
  a2.statement = "目标倍数 10x";
  a2.unit = "x ARR";

  state.assumptions.push(
    {
      id: "A11", statement: "汇率 7.8 HKD/USD", value: 7.8, unit: "HKD/USD", period: "2026E",
      kind: "model_input", evidence_ids: ["E1"], status: "active",
    },
    {
      id: "A12", statement: "股数 4.876 亿股", value: 4.876, unit: "亿股", period: "2026E",
      kind: "model_input", evidence_ids: ["E1"], status: "active",
    },
  );

  const v1 = state.valuations.find((item) => item.id === "V1");
  v1.value = 1560;
  v1.method_key = "dcf";
  v1.method = "高盛 DCF";
  v1.output = "target_price";
  v1.drivers = [
    { assumption_id: "A4", role: "base_metric", value: 5.2, unit: "元/股" },
    { assumption_id: "A6", role: "discount_rate", value: 0.12, unit: "比例" },
  ];
  v1.assumption_ids = ["A1", "A2", "A3", "A4", "A6"];
  v1.status = "superseded";
  v1.superseded_by = "V4";
  delete v1.multiple_basis;
  delete v1.multiple_period;

  state.valuations.push({
    id: "V4",
    scenario: "base",
    method_key: "arr_multiple",
    method: "ARR 倍数法",
    output: "target_price",
    multiple_basis: "ARR",
    multiple_period: "2026E",
    as_of: "2026-10-26",
    value: 320,
    unit: "港元/股",
    drivers: [
      { assumption_id: "A1", role: "base_metric", value: 20, unit: "亿美元" },
      { assumption_id: "A2", role: "multiple", value: 10, unit: "x ARR" },
      { assumption_id: "A11", role: "fx", value: 7.8, unit: "HKD/USD" },
      { assumption_id: "A12", role: "share_count", value: 4.876, unit: "亿股" },
    ],
    assumption_ids: ["A1", "A2", "A11", "A12"],
    thesis_ids: ["T1"],
    evidence_ids: ["E1"],
    formula: "20 × 10 × 7.8 ÷ 4.876 ≈ 320 港元/股",
    limitations: "倍数法一阶近似",
    status: "current",
    superseded_by: null,
  });

  state.changes = [{
    id: "C1",
    at: "2026-10-26",
    revision: 4,
    kind: "method_switch",
    affected_ids: ["V1", "V4", "A1", "A2", "A11", "A12"],
    from_valuation_id: "V1",
    to_valuation_id: "V4",
    comparability: "not_comparable",
    comparability_reason: "DCF 与 ARR 倍数法的基准、倍数口径和公式都不同",
    bridge: [
      { factor: "方法", from: "DCF", to: "ARR 倍数法" },
      { factor: "基准指标", from: "DCF 现金流", to: "2026E ARR 20 亿美元" },
    ],
    value_before: 1560,
    value_after: 320,
    before: "DCF base 1560",
    after: "ARR 倍数法 base 320",
    reason: "DCF 表读取失败后改用 ARR 倍数法",
    evidence_ids: ["E1"],
    run_id: "test",
  }];
  Object.assign(state.changes[0], overrides);
}

function makeAttributionState(state, attribution, options = {}) {
  state.revision = options.revision ?? 4;
  const a1 = state.assumptions.find((item) => item.id === "A1");
  a1.value = 26;
  a1.statement = "2026E ARR 26 亿美元";
  a1.unit = "亿美元";
  const a2 = state.assumptions.find((item) => item.id === "A2");
  a2.value = 11;
  a2.statement = "目标倍数 11x";
  a2.unit = "x ARR";

  const v1 = state.valuations.find((item) => item.id === "V1");
  v1.value = options.valueAfter ?? 458;
  v1.method_key = "arr_multiple";
  v1.method = "ARR 倍数法";
  v1.output = "target_price";
  v1.multiple_basis = "ARR";
  v1.multiple_period = "2026E";
  v1.unit = "港元/股";
  v1.drivers = [
    { assumption_id: "A1", role: "base_metric", value: 26, unit: "亿美元" },
    { assumption_id: "A2", role: "multiple", value: 11, unit: "x ARR" },
  ];
  v1.assumption_ids = ["A1", "A2"];
  v1.status = "current";
  v1.superseded_by = null;
  v1.formula = "26 × 11 × 7.8 ÷ 4.876 ≈ 458 港元/股";

  state.changes = [{
    id: options.changeId ?? "C1",
    at: options.at ?? "2026-10-26",
    revision: options.revision ?? 4,
    kind: "assumption_update",
    affected_ids: ["V1", "A1", "A2"],
    from_valuation_id: "V1",
    to_valuation_id: "V1",
    comparability: "comparable",
    value_before: options.valueBefore ?? 320,
    value_after: options.valueAfter ?? 458,
    attribution,
    combination: options.combination ?? "multiplicative",
    residual: options.residual ?? 0.00125,
    before: "2026E ARR 20 亿美元、10x",
    after: "2026E ARR 26 亿美元、11x",
    reason: "ARR 与倍数调整",
    evidence_ids: options.evidenceIds ?? ["E1"],
    run_id: "test",
  }];
  if (options.stabilityNote) state.changes[0].stability_note = options.stabilityNote;
}

{
  const file = writeTemp("legacy-20.json", (state) => {
    state.schema_version = "2.0";
  });
  const result = validate(file);
  check(
    "schema 2.0 历史文件仍可通过并提示兼容",
    result.status === 0 && result.output.includes("schema 2.0"),
    result.output.trim(),
  );
}
{
  const file = writeTemp("historical-change-legacy.json", (state) => {
    state.revision = 4;
    state.changes = [{
      id: "C1",
      at: "2026-10-25",
      revision: 3,
      affected_ids: ["V1"],
      before: "旧口径",
      after: "新口径",
      reason: "历史变化，保留 2.0 写法",
      evidence_ids: ["E1"],
      run_id: "test",
    }];
  });
  const result = validate(file);
  check(
    "2.1 中历史 change 可保留旧写法（只警告）",
    result.status === 0 && result.output.includes("历史 change"),
    result.output.trim(),
  );
}
{
  const file = writeTemp("current-change-legacy.json", (state) => {
    state.revision = 4;
    state.changes = [{
      id: "C1",
      at: "2026-10-26",
      revision: 4,
      affected_ids: ["V1"],
      before: "旧口径",
      after: "新口径",
      reason: "当前 revision 但缺 2.1 字段",
      evidence_ids: ["E1"],
      run_id: "test",
    }];
  });
  const result = validate(file);
  check(
    "当前 revision 的 change 缺 kind/from-to 被拦下",
    result.status === 1 && result.output.includes("当前 revision 的 change"),
    result.output.trim(),
  );
}
{
  const file = writeTemp("method-switch.json", (state) => makeMethodSwitchState(state));
  const result = validate(file);
  check("方法切换：新 V + 旧 V superseded + bridge 通过", result.status === 0, result.output.trim());
}
{
  const file = writeTemp("method-switch-comparable.json", (state) => {
    makeMethodSwitchState(state, { comparability: "comparable" });
  });
  const result = validate(file);
  check(
    "方法切换被标成可比被拦下",
    result.status === 1 && result.output.includes("必须是 not_comparable"),
    result.output.trim(),
  );
}
{
  const file = writeTemp("method-switch-no-bridge.json", (state) => {
    makeMethodSwitchState(state, { bridge: [] });
  });
  const result = validate(file);
  check(
    "方法切换缺 bridge 被拦下",
    result.status === 1 && result.output.includes(".bridge 至少 2 项"),
    result.output.trim(),
  );
}
{
  const file = writeTemp("method-switch-same-v.json", (state) => {
    makeMethodSwitchState(state, { to_valuation_id: "V1" });
  });
  const result = validate(file);
  check(
    "方法切换指向同一个 V 被拦下",
    result.status === 1 && result.output.includes("新建 V"),
    result.output.trim(),
  );
}
{
  const file = writeTemp("attribution-ok.json", (state) => {
    makeAttributionState(state, [
      { assumption_id: "A1", from: 20, to: 26, contribution: 0.30 },
      { assumption_id: "A2", from: 10, to: 11, contribution: 0.10 },
    ]);
  });
  const result = validate(file);
  check("320→458 同时归因 ARR 与倍数通过", result.status === 0, result.output.trim());
}
{
  const file = writeTemp("attribution-missing-arr.json", (state) => {
    makeAttributionState(state, [
      { assumption_id: "A2", from: 10, to: 11, contribution: 0.10 },
    ]);
  });
  const result = validate(file);
  check(
    "320→458 只归因倍数被拦下（遗漏 ARR）",
    result.status === 1 && result.output.includes("归因不完整"),
    result.output.trim(),
  );
}
{
  const file = writeTemp("attribution-indirect.json", (state) => {
    makeAttributionState(state, [
      { assumption_id: "A1", from: 20, to: 26, contribution: 0.30 },
      { assumption_id: "A2", from: 10, to: 11, contribution: 0.10 },
      { assumption_id: "A3", from: 0.22, to: 0.24, contribution: 0.02 },
    ]);
  });
  const result = validate(file);
  check(
    "把不进入公式的 A3 列为归因被拦下",
    result.status === 1 && result.output.includes("不是 V1 的公式驱动"),
    result.output.trim(),
  );
}
{
  const file = writeTemp("attribution-inference.json", (state) => {
    makeAttributionState(state, [
      { assumption_id: "A1", from: 20, to: 26, contribution: 0.30 },
      { assumption_id: "A2", from: 10, to: 11, contribution: 0.10 },
    ], { evidenceIds: ["E7"] });
  });
  const result = validate(file);
  check(
    "估值变化只引 inference 被拦下",
    result.status === 1 && result.output.includes("非 inference"),
    result.output.trim(),
  );
}
{
  const file = writeTemp("attribution-no-multiple-basis.json", (state) => {
    makeAttributionState(state, [
      { assumption_id: "A1", from: 20, to: 26, contribution: 0.30 },
      { assumption_id: "A2", from: 10, to: 11, contribution: 0.10 },
    ]);
    delete state.valuations.find((item) => item.id === "V1").multiple_basis;
  });
  const result = validate(file);
  check(
    "有 multiple 驱动但缺 multiple_basis 被拦下",
    result.status === 1 && result.output.includes("multiple_basis"),
    result.output.trim(),
  );
}
{
  const file = writeTemp("same-day-reversal.json", (state) => {
    makeAttributionState(state, [
      { assumption_id: "A1", from: 20, to: 26, contribution: 0.30 },
      { assumption_id: "A2", from: 10, to: 11, contribution: 0.10 },
    ], { valueAfter: 458, revision: 4 });
    const a2 = state.assumptions.find((item) => item.id === "A2");
    a2.value = 10;
    const v1 = state.valuations.find((item) => item.id === "V1");
    v1.value = 400;
    v1.drivers.find((driver) => driver.assumption_id === "A2").value = 10;
    state.revision = 5;
    state.changes.push({
      id: "C2",
      at: "2026-10-26",
      revision: 5,
      kind: "assumption_update",
      affected_ids: ["V1", "A2"],
      from_valuation_id: "V1",
      to_valuation_id: "V1",
      comparability: "comparable",
      value_before: 458,
      value_after: 400,
      attribution: [{ assumption_id: "A2", from: 11, to: 10, contribution: 10 / 11 - 1 }],
      combination: "multiplicative",
      residual: 400 / 458 - 1 - (10 / 11 - 1),
      before: "458",
      after: "400",
      reason: "下调倍数",
      evidence_ids: ["E7"],
      run_id: "test",
    });
  });
  const result = validate(file);
  check(
    "同日反向修正缺 stability_note 被拦下",
    result.status === 1 && result.output.includes("stability_note"),
    result.output.trim(),
  );
  check(
    "同日反向修正只引推断证据被拦下",
    result.status === 1 && result.output.includes("缺少新增非推断证据"),
    result.output.trim(),
  );
}
{
  const file = writeTemp("method-switch-then-reverse.json", (state) => {
    makeMethodSwitchState(state);
    const a1 = state.assumptions.find((item) => item.id === "A1");
    a1.value = 26;
    const a2 = state.assumptions.find((item) => item.id === "A2");
    a2.value = 11;
    const v4 = state.valuations.find((item) => item.id === "V4");
    v4.value = 458;
    v4.drivers.find((driver) => driver.assumption_id === "A1").value = 26;
    v4.drivers.find((driver) => driver.assumption_id === "A2").value = 11;
    state.revision = 5;
    state.changes.push({
      id: "C2",
      at: "2026-10-26",
      revision: 5,
      kind: "assumption_update",
      affected_ids: ["V4", "A1", "A2"],
      from_valuation_id: "V4",
      to_valuation_id: "V4",
      comparability: "comparable",
      value_before: 320,
      value_after: 458,
      attribution: [
        { assumption_id: "A1", from: 20, to: 26, contribution: 0.30 },
        { assumption_id: "A2", from: 10, to: 11, contribution: 0.10 },
      ],
      combination: "multiplicative",
      residual: 0.00125,
      before: "320",
      after: "458",
      reason: "ARR 20→26、倍数 10→11",
      evidence_ids: ["E7"],
      run_id: "test",
    });
  });
  const result = validate(file);
  check(
    "智谱式方法切换 + 同日反向修正：缺 stability_note 被拦下",
    result.status === 1 && result.output.includes("stability_note"),
    result.output.trim(),
  );
  check(
    "智谱式方法切换 + 同日反向修正：只引推断证据被拦下",
    result.status === 1 && result.output.includes("缺少新增非推断证据"),
    result.output.trim(),
  );
}
{
  const file = writeTemp("tool-failure-undisclosed.json", (state) => {
    state.model.checks.push({
      id: "CHK3",
      item: "DCF 折现率/终值增长率未披露",
      result: "unverified",
      reason: "tool_failure",
      locator: "DCF!C48:C49",
      attempted: "workbook_query",
      gap_ids: ["G3"],
      note: "解析报错",
    });
    state.gaps.push({
      id: "G3",
      question: "DCF 参数读取失败",
      impact: "无法复核 DCF",
      evidence_needed: "修复读取",
      kind: "tool",
      status: "open",
    });
  });
  const result = validate(file);
  check(
    "tool_failure 写成未披露被拦下",
    result.status === 1 && result.output.includes("未披露"),
    result.output.trim(),
  );
}
{
  const file = writeTemp("tool-gap-undisclosed.json", (state) => {
    state.gaps.push({
      id: "G3",
      question: "DCF 折现率/终值增长率未披露",
      impact: "无法复核 DCF",
      evidence_needed: "修复读取",
      kind: "tool",
      status: "open",
    });
  });
  const result = validate(file);
  check(
    "工具类缺口写成未披露被拦下",
    result.status === 1 && result.output.includes("不是来源缺失"),
    result.output.trim(),
  );
}
{
  const file = writeTemp("tool-failure-ok.json", (state) => {
    state.model.checks.push({
      id: "CHK3",
      item: "DCF 参数读取失败，待修复",
      result: "unverified",
      reason: "tool_failure",
      locator: "DCF!C48:C49",
      attempted: "workbook_query",
      gap_ids: ["G3"],
      note: "解析报错",
    });
    state.gaps.push({
      id: "G3",
      question: "DCF 参数读取失败",
      impact: "无法复核 DCF",
      evidence_needed: "修复读取",
      kind: "tool",
      status: "open",
    });
  });
  const result = validate(file);
  check("tool_failure 挂 tool gap 可通过", result.status === 0, result.output.trim());
}

console.log("跟踪结果归一化");
{
  const context = {
    trackingId: "t1",
    targetId: "m1",
    targetPath: "exports/x/投资框架报告.md",
    templateId: "framework",
    baseVersion: 1,
    resultVersion: 2,
    nowLabel: "2026-10-20 09:00",
    duration: "12s",
    status: "updated",
  };
  const result = normalizeTrackingResult(
    {
      status: "updated",
      conclusion: "目标价 92 → 88",
      summary: "库存触发了 F2。",
      theses: [
        { id: "T1", statement: "周期上行", status: "active", change: "维持", note: "F1 未触发" },
        { id: "T2", statement: "份额提升", status: "weakened", change: "降级", note: "F3 预警" },
        { bad: true },
      ],
      invalidations: [
        { id: "F1", thesis_id: "T1", condition: "价格转跌", observed: "+4%", triggered: false },
        { id: "F2", thesis_id: "T1", condition: "库存 > 12 周", observed: "12.6 周", triggered: true, action: "下调 A1" },
      ],
    },
    context,
  );
  check("观点数组被保留并过滤脏数据", result.theses.length === 2, `got ${result.theses.length}`);
  check("观点状态被保留", result.theses[1].status === "weakened", JSON.stringify(result.theses[1]));
  check("失效条件数组被保留", result.invalidations.length === 2);
  check("触发的失效条件排在前面", result.invalidations[0].id === "F2", JSON.stringify(result.invalidations));
  check("triggered 归一化为布尔", result.invalidations[0].triggered === true);
}
{
  const context = {
    trackingId: "t2",
    targetId: "m2",
    targetPath: "exports/x/投资框架报告.md",
    templateId: "framework",
    baseVersion: 1,
    resultVersion: null,
    nowLabel: "2026-10-20 09:00",
    duration: "",
    status: "no_change",
  };
  const result = normalizeTrackingResult({ status: "no_change", conclusion: "无变化" }, context);
  check("缺省时观点/失效条件为空数组", Array.isArray(result.theses) && result.theses.length === 0 && result.invalidations.length === 0);
}
{
  const context = {
    trackingId: "t2b",
    targetId: "m2b",
    targetPath: "exports/x/投资框架报告.md",
    templateId: "framework",
    baseVersion: 1,
    resultVersion: null,
    nowLabel: "2026-10-20 09:00",
    duration: "",
    status: "no_change",
  };
  const result = normalizeTrackingResult({
    status: "no_change",
    conclusion: "MON1 未触发",
    monitorChecks: [
      { id: "MON1", falsifier_id: "F1", observed: "+3%", status: "warning", note: "较上期收窄" },
      { id: "MON2", falsifier_id: "F2", observed: "12.6 周", status: "triggered" },
      { id: "bad" },
    ],
  }, context);
  check("监测检查被保留并过滤脏数据", result.monitorChecks.length === 2, String(result.monitorChecks.length));
  check("监测状态 warning 被保留", result.monitorChecks[0].status === "warning");
  check("监测检查保留 falsifier 关联", result.monitorChecks[1].falsifier_id === "F2");
}

console.log("跟踪 prompt 契约");
{
  const base = {
    trackingId: "t3",
    runId: "r3",
    targetPath: "exports/x/投资框架报告.md",
    targetName: "投资框架报告.md",
    baseVersion: 1,
    resultRelPath: ".tracking/t3/r3.json",
    trigger: "manual",
    workspaceFiles: [],
    skillsDir: "/tmp/skills",
  };
  const frameworkPrompt = buildTrackingPrompt({ ...base, templateId: "framework" });
  check("框架模板要求加载 framework-update", frameworkPrompt.includes("framework-update"));
  check(
    "框架模板包含 theses / invalidations schema",
    frameworkPrompt.includes("\"theses\"") && frameworkPrompt.includes("\"invalidations\""),
  );
  check(
    "框架模板注入校验脚本绝对路径",
    frameworkPrompt.includes("/tmp/skills/investment-framework/scripts/validate_state.mjs"),
  );
  const genericPrompt = buildTrackingPrompt({ ...base, templateId: "generic" });
  check("通用模板不要求 framework-update", !genericPrompt.includes("framework-update"));
  check("通用模板保留 theses schema（可留空）", genericPrompt.includes("\"theses\""));

  const monitorPrompt = buildTrackingPrompt({
    ...base,
    templateId: "framework",
    monitorMode: true,
    monitorItems: [{
      id: "MON1",
      falsifierId: "F1",
      thesisId: "T1",
      metric: "DRAM 合约价季度环比",
      warning: "环比 ≤ -3%",
      threshold: "连续两季 ≤ -5%",
      frequency: "quarterly",
      source: { text: "TrendForce" },
    }],
  });
  check("监测模式注入监测项", monitorPrompt.includes("本次监测项") && monitorPrompt.includes("MON1"));
  check("监测模式禁止追加跟踪记录", monitorPrompt.includes("不要追加 `## 跟踪记录`") || monitorPrompt.includes("不要写 `## 跟踪记录`"));
  check("监测模式包含 monitorChecks schema", monitorPrompt.includes("\"monitorChecks\""));
  check("监测模式包含 modelChanges schema", monitorPrompt.includes("\"modelChanges\"") && monitorPrompt.includes("\"modelOutputs\""));

  const eventPrompt = buildTrackingPrompt({
    ...base,
    templateId: "framework",
    monitorMode: true,
    monitorItems: [{
      id: "MON1", falsifierId: "F1", thesisId: "T1", metric: "库存", threshold: "> 12 周", frequency: "monthly",
    }],
    events: [{ title: "长鑫存储发布公告", url: "https://example.com/a", sourceTier: 3, snippet: "HBM 进展" }],
  });
  check("事件被注入监测 prompt", eventPrompt.includes("本次触发的事件") && eventPrompt.includes("长鑫存储发布公告"));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
