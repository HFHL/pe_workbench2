#!/usr/bin/env node
/**
 * Store-level smoke test for monitor_items / notifications.
 * Uses a throwaway workspace and database; never touches data/.
 *
 *   node scripts/test-monitoring-store.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../store.mjs";
import { deriveMonitorPlan, validateMonitorPlan } from "../lib/monitoring.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-monitor-store-"));
const workspace = path.join(root, "projects", "test-project");
fs.mkdirSync(path.join(workspace, "exports", "demo"), { recursive: true });

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

try {
  const store = await openStore({
    root,
    workspace,
    projectId: "test-project",
    projectName: "Test",
    seed: false,
  });

  const report = path.join(workspace, "exports", "demo", "投资框架报告.md");
  fs.writeFileSync(report, "# 投资框架报告\n\n## 六、什么情况下我们错了\n");
  const target = store.indexFile("exports/demo/投资框架报告.md", { kind: "output" });
  check("目标文件已入库", Boolean(target?.id));

  const tracking = store.createTracking({
    targetId: target.id,
    templateId: "framework",
    freq: "weekly",
    weekday: 1,
    day: 1,
    time: "09:00",
  });
  check("跟踪已创建", Boolean(tracking?.id));
  check("跟踪默认 autonomy", tracking.autonomyDefault === "auto_notify");

  const example = JSON.parse(
    fs.readFileSync(path.resolve("skills/investment-framework/assets/analysis-state.example.json"), "utf8"),
  );
  const plan = deriveMonitorPlan(example, { trackingId: tracking.id, targetPath: target.relPath });
  check("监测方案校验通过", validateMonitorPlan(plan).length === 0, validateMonitorPlan(plan).join("; "));

  const saved = store.replaceMonitorItems(tracking.id, plan.items);
  check("监测项落库", saved.length === 3, String(saved.length));
  check("falsifier 关联保留", saved[0].falsifierId === example.falsifiers[0].id);
  check("来源 JSON 可读", typeof saved[0].source === "object" && "query" in saved[0].source);

  const updated = store.updateMonitorItem(saved[0].id, { status: "warning", lastObserved: "10.5 周" });
  check("监测项可更新", updated.status === "warning" && updated.lastObserved === "10.5 周");

  store.updateMonitorItem(saved[0].id, { nextCheckAt: "2026-01-01" });
  const due = store.listDueMonitorItems(new Date("2026-10-20T09:00:00"));
  check("到期监测项可查询", due.length === 1 && due[0].id === saved[0].id, JSON.stringify(due.map(item => item.id)));

  const trackingAfter = store.getTracking(tracking.id);
  check("跟踪 DTO 带 monitors", trackingAfter.monitors.length === 3);
  check("契约版本递增", trackingAfter.contractVersion >= 1, String(trackingAfter.contractVersion));

  // MON1..MON3 are only unique inside a tracking; a second framework must be
  // able to use the same display IDs without a primary-key collision.
  fs.mkdirSync(path.join(workspace, "exports", "demo2"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "exports", "demo2", "投资框架报告.md"), "# 第二份框架\n");
  const target2 = store.indexFile("exports/demo2/投资框架报告.md", { kind: "output" });
  const tracking2 = store.createTracking({
    targetId: target2.id,
    templateId: "framework",
    freq: "weekly",
    weekday: 1,
    day: 1,
    time: "09:00",
  });
  const plan2 = deriveMonitorPlan(example, { trackingId: tracking2.id, targetPath: target2.relPath });
  const saved2 = store.replaceMonitorItems(tracking2.id, plan2.items);
  check("第二个跟踪可复用 MON 编号", saved2.length === 3 && store.listMonitorItems(tracking.id).length === 3);
  check("同名 MON 按跟踪隔离", store.getMonitorItem("MON1", tracking2.id)?.trackingId === tracking2.id);

  const bindings = store.replaceSourceBindings(tracking.id, [{
    adapter: "anysearch",
    query: "长鑫存储 公告 新闻",
    sourceTier: 3,
    intervalMinutes: 60,
    nextPollAt: "2026-01-01T00:00:00.000Z",
  }]);
  check("来源绑定可创建", bindings.length === 1);
  const dueBindings = store.listDueSourceBindings(new Date("2026-10-20T09:00:00"), 5);
  check("到期来源绑定可查询", dueBindings.length === 1);
  const event = store.createSourceEvent({
    trackingId: tracking.id,
    adapter: "anysearch",
    url: "https://example.com/news/1",
    title: "长鑫存储 HBM 进展",
    triageStatus: "relevant",
    relevance: "company+metric",
  });
  const duplicate = store.createSourceEvent({
    trackingId: tracking.id,
    adapter: "anysearch",
    url: "https://example.com/news/1",
    title: "长鑫存储 HBM 进展",
    triageStatus: "relevant",
  });
  check("事件去重", duplicate.duplicate === true && store.listSourceEvents({ trackingId: tracking.id }).length === 1);
  check("待处理相关事件可查询", store.listPendingRelevantEvents(10).length === 1);
  store.markSourceEventsUsed([event.id], "run-test");
  check("事件可标记已使用", store.listPendingRelevantEvents(10).length === 0);

  const change = store.recordRunChange({
    runId: "run-test",
    objectType: "material",
    objectId: target.id,
    before: { version: 1 },
    after: { version: 2 },
  });
  check("运行变更可记录", Boolean(change.id) && store.listRunChanges("run-test").length === 1);
  store.markRunChangesReverted("run-test");
  check("运行变更可标记撤销", store.listRunChanges("run-test")[0].applied === false);

  const notification = store.createNotification({
    trackingId: tracking.id,
    severity: "attention",
    title: "MON2 接近阈值",
    body: "库存 10.5 周",
    changes: [{ object: "monitor", id: "MON2", before: "9.2", after: "10.5" }],
    actions: ["view", "undo"],
  });
  check("通知可创建", Boolean(notification.id));
  check("通知默认未读", notification.readAt === null);
  check("通知列表可读", store.listNotifications().length === 1);
  check("通知可按跟踪过滤", store.listNotifications({ trackingId: tracking.id }).length === 1);
  const read = store.markNotificationRead(notification.id);
  check("通知可标记已读", Boolean(read.readAt));

  const version = store.latestVersion(target.id);
  check("版本默认是 checkpoint", version?.visibility === "checkpoint", JSON.stringify(version?.visibility));

  store.indexFile("exports/demo/投资框架报告.md", {
    visibility: "internal",
    runId: "run-test",
    reason: "monitor observation",
    forceVersion: true,
  });
  const internal = store.latestVersion(target.id);
  check("内部修订可标记", internal?.visibility === "internal" && internal?.run_id === "run-test");
  const dtoVersion = store.getMaterial(target.id).versions[0];
  check("DTO 暴露修订可见性", dtoVersion.visibility === "internal" && dtoVersion.runId === "run-test");
} catch (error) {
  failed += 1;
  console.error("  FAIL", error.stack || error.message);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failed ? "✗" : "✓"} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
