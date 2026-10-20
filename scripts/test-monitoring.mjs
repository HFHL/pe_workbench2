#!/usr/bin/env node
/**
 * Monitoring contract self-test. No network, no model.
 *
 *   node scripts/test-monitoring.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeConfidence,
  computeNextCheck,
  decideAction,
  deriveMonitorPlan,
  isMonitorDue,
  normalizeMonitorItem,
  statusForObservation,
  validateMonitorItem,
  validateMonitorPlan,
  shouldCheckpoint,
} from "../lib/monitoring.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = path.join(ROOT, "skills/investment-framework/assets/analysis-state.example.json");

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

const state = JSON.parse(fs.readFileSync(EXAMPLE, "utf8"));

console.log("监测方案生成");
{
  const plan = deriveMonitorPlan(state, {
    trackingId: "trk-test",
    targetPath: "exports/demo/投资框架报告.md",
    now: new Date("2026-10-20T09:00:00+08:00"),
  });
  check("示例状态生成 3 个监测项", plan.items.length === 3, String(plan.items.length));
  check("保留 falsifier ID", plan.items[0].falsifier_id === state.falsifiers[0].id);
  check("保留观点关联", plan.items[0].thesis_id === state.falsifiers[0].thesis_id);
  check("保留指标与阈值", Boolean(plan.items[0].metric && plan.items[0].threshold));
  check("默认自治为自动并通知", plan.items.every(item => item.autonomy === "auto_notify"));
  check("无结构错误", validateMonitorPlan(plan).length === 0, validateMonitorPlan(plan).join("; "));
  check("生成来源查询", plan.items[0].source.query.includes("DDR5"), plan.items[0].source.query);
}

console.log("监测项校验");
{
  const item = normalizeMonitorItem({
    id: "MON9",
    thesis_id: "T1",
    metric: "库存周数",
    threshold: "> 12 周",
    frequency: "monthly",
    source: "渠道调研",
    action: "下调假设",
  });
  check("合法监测项通过", validateMonitorItem(item).length === 0, validateMonitorItem(item).join("; "));
  const broken = { ...item, id: "MON10", metric: "", threshold: "", action: "" };
  const errors = validateMonitorItem(broken);
  check("缺指标/阈值/动作被拦下", errors.length >= 3, errors.join("; "));
  const badFreq = { ...item, frequency: "hourly" };
  check("非法频率被拦下", validateMonitorItem(badFreq).some(error => error.includes("频率")));
}

console.log("状态与检查周期");
{
  check("日频 +1 天", computeNextCheck("daily", new Date("2026-10-20T09:00:00")) === "2026-10-21");
  check("周频 +7 天", computeNextCheck("weekly", new Date("2026-10-20T09:00:00")) === "2026-10-27");
  check("季频 +3 个月", computeNextCheck("quarterly", new Date("2026-10-20T09:00:00")) === "2027-01-20");
  check("事件型没有固定下次", computeNextCheck("event", new Date("2026-10-20T09:00:00")) === null);
  check("触发优先于预警", statusForObservation({ warning: true, triggered: true }) === "triggered");
  check("预警状态", statusForObservation({ warning: true }) === "warning");
  check("未触发保持 armed", statusForObservation({}) === "armed");
  const due = normalizeMonitorItem({ id: "MON1", next_check_at: "2026-10-19" });
  check("过期监测项到期", isMonitorDue(due, new Date("2026-10-20T09:00:00")) === true);
  const future = normalizeMonitorItem({ id: "MON2", next_check_at: "2026-10-25" });
  check("未到期监测项不触发", isMonitorDue(future, new Date("2026-10-20T09:00:00")) === false);
  const event = normalizeMonitorItem({ id: "MON3", frequency: "event" });
  check("事件型不按时间触发", isMonitorDue(event, new Date("2026-10-20T09:00:00")) === false);
}

console.log("置信度与自治");
{
  const high = computeConfidence({
    sourceTier: 1, directness: "direct", corroboration: 2, freshness: "fresh", mapping: "confirmed",
  });
  const low = computeConfidence({
    sourceTier: 3, directness: "proxy", corroboration: 0, freshness: "stale", mapping: "none",
  });
  check("一手+直接+多源=高", high.level === "high", JSON.stringify(high));
  check("高频线索+代理+未映射=低", low.level === "low", JSON.stringify(low));

  check("C0 自动观察", decideAction({ changeClass: "C0", confidence: "high" }).action === "observe");
  check("C1 自动提醒", decideAction({ changeClass: "C1", confidence: "high" }).action === "notify");
  check("C2 自动应用并通知", decideAction({ changeClass: "C2", confidence: "high" }).action === "apply");
  check("C3 自动应用并通知", decideAction({ changeClass: "C3", confidence: "high" }).notify === true);
  check("低置信度降级为提议", decideAction({ changeClass: "C2", confidence: "low" }).action === "propose");
  check("C4 永远先提议", decideAction({ changeClass: "C4", confidence: "high" }).action === "propose");
  check("观察模式不通知", decideAction({ changeClass: "C2", confidence: "high", autonomy: "observe" }).notify === false);
  check("C2 生成检查点", shouldCheckpoint("C2") === true);
  check("C0 不生成检查点", shouldCheckpoint("C0") === false);
  check("手动保存总是检查点", shouldCheckpoint("C0", { manual: true }) === true);
}

console.log(`\n${failed ? "✗" : "✓"} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
