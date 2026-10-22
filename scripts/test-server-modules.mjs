#!/usr/bin/env node
/**
 * Server module boundaries and scheduler lifecycle.
 *
 * Importing these modules must not listen or create timers. Schedulers are
 * driven manually here (tick/stop) without waiting on wall-clock intervals.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { createWorkbench } from "../server/create-app.mjs";
import { loadConfig } from "../server/config.mjs";
import { createEventBus } from "../server/events/bus.mjs";
import { createProjectManager } from "../server/project-context.mjs";
import { createSessionService } from "../server/agent/session-service.mjs";
import { createTrackingScheduler } from "../server/schedulers/tracking.mjs";
import { createMonitorScheduler } from "../server/schedulers/monitor.mjs";
import { createSourceScheduler } from "../server/schedulers/source.mjs";
import { handleProjects } from "../server/routes/projects.mjs";
import { handleApprovals } from "../server/routes/approvals.mjs";
import { handleSessions } from "../server/routes/sessions.mjs";
import { handleMaterials } from "../server/routes/materials.mjs";
import { handleTracking } from "../server/routes/tracking.mjs";
import { handlePlans } from "../server/routes/plans.mjs";
import { handleAgUi } from "../server/routes/ag-ui.mjs";

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
const entrySource = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
const appSource = fs.readFileSync(new URL("../server/create-app.mjs", import.meta.url), "utf8");

console.log("\nmodule boundaries");
await run("entry only composes and listens", () => {
  assert.match(entrySource, /createWorkbench/);
  assert.match(entrySource, /workbench\.listen\(\)/);
  assert.doesNotMatch(entrySource, /setInterval\(/);
  assert.ok(entrySource.split("\n").length < 80, "server.mjs is not a composition entry");
});

await run("create-app exports a factory instead of listening on import", () => {
  assert.equal(typeof createWorkbench, "function");
  assert.match(appSource, /export async function createWorkbench/);
  assert.doesNotMatch(appSource.split("\n").slice(0, 80).join("\n"), /\.listen\(/);
});

await run("route modules export handlers", () => {
  for (const handler of [
    handleProjects, handleApprovals, handleSessions, handleMaterials,
    handleTracking, handlePlans, handleAgUi,
  ]) {
    assert.equal(typeof handler, "function");
  }
});

await run("config import does not start schedulers", async () => {
  const config = await loadConfig({ env: { PI_FAKE_AGENT: "1", WORKBENCH_STORAGE_ROOT: "/tmp/pe-config-test" } });
  assert.equal(config.fakeAgent, true);
  assert.ok(config.toolNames.includes("read"));
});

await run("event bus is project scoped", () => {
  const bus = createEventBus();
  const sent = [];
  const response = () => ({ write: (chunk) => sent.push(chunk), writeHead() {}, end() {} });
  bus.broadcastGlobal({ type: "x" }, "p1");
  assert.equal(sent.length, 0); // no clients yet
  bus.close();
});

console.log("\nscheduler lifecycle");

function fakeContext(id, due, healthy = true) {
  const calls = [];
  const store = {
    listDueTrackings: () => due,
    listMonitorItems: () => [],
    claimTracking: () => true,
    clearTrackingLease: () => {},
    listDueMonitorItems: () => [],
    listPendingRelevantEvents: () => [],
    listDueSourceBindings: () => [],
    updateSourceBinding: (bindingId, patch) => calls.push({ bindingId, patch }),
  };
  return {
    id,
    calls,
    store,
    healthy,
  };
}

await run("tracking scheduler tick starts at most one local run", async () => {
  const contexts = new Map([
    ["a", fakeContext("a", [{ id: "t1", next_run_at: "2026-01-01" }, { id: "t2", next_run_at: "2026-01-02" }])],
    ["b", fakeContext("b", [{ id: "t3", next_run_at: "2026-01-03" }])],
  ]);
  const started = [];
  const scheduler = createTrackingScheduler({
    contexts,
    runTracking: async (ctx, id) => started.push(`${ctx.id}:${id}`),
    activeTrackingRuns: new Set(),
    enabled: false,
    logger: silent,
  });
  assert.equal(scheduler.started, false);
  await scheduler.tick();
  assert.deepEqual(started, ["a:t1"]);
  scheduler.stop();
});

await run("tracking scheduler skips monitor-driven trackings", async () => {
  const ctx = fakeContext("a", [{ id: "t1", next_run_at: "2026-01-01" }]);
  ctx.store.listMonitorItems = () => [{ id: "M1" }];
  let called = 0;
  const scheduler = createTrackingScheduler({
    contexts: new Map([["a", ctx]]),
    runTracking: async () => { called += 1; },
    activeTrackingRuns: new Set(),
    enabled: false,
    logger: silent,
  });
  await scheduler.tick();
  assert.equal(called, 0);
  scheduler.stop();
});

await run("monitor scheduler groups and starts one run", async () => {
  const ctx = fakeContext("a", []);
  ctx.store.listDueMonitorItems = () => [
    { id: "M1", trackingId: "t1" },
    { id: "M2", trackingId: "t1" },
  ];
  const calls = [];
  const scheduler = createMonitorScheduler({
    contexts: new Map([["a", ctx]]),
    runTracking: async (_ctx, trackingId, options) => calls.push({ trackingId, options }),
    activeTrackingRuns: new Set(),
    enabled: true,
    logger: silent,
  });
  await scheduler.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].trackingId, "t1");
  assert.equal(calls[0].options.monitorMode, true);
  scheduler.stop();
});

await run("source scheduler polls and reschedules", async () => {
  const ctx = fakeContext("a", []);
  ctx.store.listDueSourceBindings = () => [{ id: "b1", adapter: "anysearch", query: "x", intervalMinutes: 60 }];
  const polls = [];
  const scheduler = createSourceScheduler({
    contexts: new Map([["a", ctx]]),
    pollSourceBinding: async (_ctx, binding) => { polls.push(binding.id); return { events: 1 }; },
    enabled: true,
    logger: silent,
  });
  await scheduler.tick();
  assert.deepEqual(polls, ["b1"]);
  assert.equal(ctx.calls.length, 1);
  assert.ok(ctx.calls[0].patch.nextPollAt);
  scheduler.stop();
});

await run("disabled scheduler start is a no-op", () => {
  const scheduler = createTrackingScheduler({
    contexts: new Map(),
    runTracking: async () => {},
    activeTrackingRuns: new Set(),
    enabled: false,
    logger: silent,
  });
  assert.equal(scheduler.start(), false);
  assert.equal(scheduler.started, false);
  scheduler.stop();
});

await run("start then stop leaves no timer", () => {
  const scheduler = createTrackingScheduler({
    contexts: new Map(),
    runTracking: async () => {},
    activeTrackingRuns: new Set(),
    enabled: true,
    logger: silent,
  });
  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.started, true);
  scheduler.stop();
  assert.equal(scheduler.started, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
