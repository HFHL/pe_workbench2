#!/usr/bin/env node
/**
 * create_tracking tool test: natural-language schedule -> tracking row ->
 * monitor items + source bindings.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../store.mjs";
import { createTrackingTool } from "../lib/tracking-tool.mjs";

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-track-tool-"));
const workspace = path.join(root, "projects", "test-project");
fs.mkdirSync(path.join(workspace, "exports", "demo"), { recursive: true });

try {
  fs.writeFileSync(path.join(workspace, "exports", "demo", "投资框架报告.md"), "# 测试框架\n");
  fs.writeFileSync(
    path.join(workspace, "exports", "demo", "analysis-state.json"),
    JSON.stringify({
      schema_version: "2.0",
      subject: { company: "测试公司", security: "688981.SS" },
      model: {},
      theses: [{ id: "T1", statement: "测试观点", status: "active" }],
      falsifiers: [{
        id: "F1",
        monitor_id: "MON1",
        thesis_id: "T1",
        metric: "测试指标",
        threshold: "> 10",
        source: "测试来源",
        frequency: "monthly",
        action: "下调假设",
        status: "armed",
        source_tier: 3,
        source_query: "测试公司 测试指标",
      }],
    }, null, 2),
  );

  const store = await openStore({
    root,
    workspace,
    projectId: "test-project",
    projectName: "Test",
    seed: false,
  });
  store.indexFile("exports/demo/投资框架报告.md", { kind: "output" });
  store.indexFile("exports/demo/analysis-state.json", { kind: "output" });

  let tracked = null;
  let monitors = [];
  const tool = createTrackingTool({
    store,
    workspace,
    onTracking: (tracking) => { tracked = tracking; },
    onMonitors: (_id, items) => { monitors = items; },
  });

  const result = await tool.execute("test", {
    targetPath: "exports/demo/投资框架报告.md",
    freq: "weekly",
    weekday: 3,
    time: "10:30",
    activateMonitors: true,
  });
  check("工具调用成功", !result.isError, result.content?.[0]?.text || "");
  check("返回跟踪对象", Boolean(result.details?.tracking?.id));
  check("频率解析为周三 10:30", result.details?.tracking?.scheduleLabel?.includes("周三") && result.details?.tracking?.scheduleLabel?.includes("10:30"), result.details?.tracking?.scheduleLabel);
  check("监测项已激活", monitors.length === 1 && monitors[0].id === "MON1", String(monitors.length));
  check("来源绑定已创建", store.listSourceBindings(result.details.tracking.id).length === 2);
  check("触发 onTracking 回调", Boolean(tracked));

  const again = await tool.execute("test", {
    targetPath: "projects/test-project/exports/demo/投资框架报告.md",
    freq: "daily",
  });
  check("重复建立被拦下", again.isError === true || /已经有跟踪/.test(again.content?.[0]?.text || ""), again.content?.[0]?.text || "");
} catch (error) {
  failed += 1;
  console.error("  FAIL", error.stack || error.message);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failed ? "✗" : "✓"} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
