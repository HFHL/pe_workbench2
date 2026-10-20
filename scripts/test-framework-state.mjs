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
