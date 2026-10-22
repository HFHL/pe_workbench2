/**
 * Agent settle hook test.
 *
 * Verifies that write/edit paths are collected during a run and handed to
 * onRunSettled, which is the same path the live trace hook uses.
 */

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openStore } from "../store.mjs";
import { createTraceService } from "../lib/trace/service.mjs";
import { attachSessionEvents } from "../server/agent/event-bridge.mjs";

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pe-trace-hook-"));
try {
  const projectRoot = path.join(dir, "project");
  await fsp.mkdir(path.join(projectRoot, "exports"), { recursive: true });
  const store = await openStore({
    root: dir,
    workspace: projectRoot,
    projectId: "p-hook",
    projectName: "Hook",
    seed: false,
  });
  const trace = createTraceService({ store, projectId: "p-hook", projectName: "Hook", root: projectRoot });

  let listener = null;
  const session = {
    messages: [],
    sessionName: "Hook test",
    subscribe(fn) {
      listener = fn;
      return () => { listener = null; };
    },
  };
  const entry = {
    id: "s-hook",
    session,
    ctx: { root: projectRoot, store, trace },
    toolArgs: new Map(),
    localRunId: null,
    agui: null,
    title: "Hook test",
    updatedAt: null,
  };
  const received = [];
  attachSessionEvents(entry, {
    bus: { broadcast() {} },
    onMaterialSaved() {},
    onRunSettled(_entry, data) {
      received.push(data);
      return trace.recordRun({
        sessionId: _entry.id,
        runId: data.runId,
        changedFiles: data.changedFiles,
        text: "目标价区间从 88–100 元整体下移到 60–85 元。引入归母系数 Mi。",
      });
    },
  });

  assert.equal(typeof listener, "function");
  listener({ type: "agent_start" });
  listener({
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "write",
    args: { path: "exports/估值模型调整提案.md" },
  });
  listener({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "write",
    args: { path: "exports/估值模型调整提案.md" },
    result: { content: [{ type: "text", text: "ok" }] },
  });
  listener({ type: "agent_settled", aborted: false });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].changedFiles, ["exports/估值模型调整提案.md"]);
  const view = trace.view();
  assert.equal(view.entries.length, 1);
  assert.equal(view.entries[0].kind, "proposed");
  assert.equal(view.entries[0].title.includes("60–85"), true);
  assert.equal(view.focus.id, view.entries[0].id);

  listener({ type: "agent_start" });
  listener({ type: "agent_settled", aborted: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(received.length, 2, "aborted settle still reaches the callback; the callback decides to skip");
  assert.equal(received[1].aborted, true);

  console.log("trace hook: ok");
} finally {
  await fsp.rm(dir, { recursive: true, force: true });
}
