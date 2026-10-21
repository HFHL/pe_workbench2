#!/usr/bin/env node
/**
 * CopilotKit Runtime facade tests (no browser, no model, no network).
 *
 * Proves that /api/copilotkit is a thin public-contract mount over the P0
 * PiAgUiAdapter: same thread id, same replay log, same project checks, and no
 * second conversation database.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { toolStatusFromResult } from "../ui/copilot-pilot/message-adapter.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitHealth(base, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("server did not become healthy");
}

async function jsonRequest(base, method, pathname, body, headers = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

/**
 * Read an SSE response, calling onEvent for every data frame. Resolves with all
 * frames once the server closes the stream.
 */
async function readSse(response, onEvent = () => {}) {
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) continue;
      const event = JSON.parse(data);
      events.push(event);
      onEvent(event);
    }
  }
  return events;
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "pe-copilotkit-"));
  const env = {
    ...process.env,
    WORKBENCH_STORAGE_ROOT: storage,
    PORT: String(port),
    PI_FAKE_AGENT: "1",
    WORKBENCH_TEST: "1",
    COPILOTKIT_CORE_EXPERIMENT: "1",
    TRACKING_SCHEDULER: "0",
    MONITOR_SCHEDULER: "0",
    SOURCE_SCHEDULER: "0",
  };
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    text: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    await waitHealth(base);
    const headers = { "X-Project-Id": "product-eng" };

    console.log("\nCopilotKit runtime info");
    const health = await jsonRequest(base, "GET", "/api/health");
    check("health advertises the opt-in flag", health.data?.features?.copilotkit === true);
    const info = await jsonRequest(base, "GET", "/api/copilotkit/info", undefined, headers);
    check("info is served", info.status === 200, JSON.stringify(info.data));
    check("info exposes one pi agent", Boolean(info.data?.agents?.pi));
    check("info disables telemetry", info.data?.telemetryDisabled === true);
    check("info disables A2UI", info.data?.a2ui?.enabled === false);
    check("info disables suggestions", info.data?.suggestions === false);
    check("info uses SSE mode", info.data?.mode === "sse");

    console.log("\nthread identity and run stream");
    const created = await jsonRequest(base, "POST", "/api/sessions", {}, headers);
    const sessionId = created.data.id;
    check("session created", Boolean(sessionId));

    const runBody = {
      threadId: sessionId,
      messages: [{ role: "user", content: "你好 [scenario:settle]" }],
      forwardedProps: { projectId: "product-eng" },
    };
    const runRes = await fetch(`${base}/api/copilotkit/agent/pi/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(runBody),
    });
    check("run returns SSE", runRes.status === 200 && /text\/event-stream/.test(runRes.headers.get("content-type") || ""));
    const runEvents = await readSse(runRes);
    const first = runEvents[0];
    const last = runEvents.at(-1);
    check("first event is RUN_STARTED", first?.type === "RUN_STARTED");
    check("threadId equals Pi sessionId", first?.threadId === sessionId);
    check("terminal event is RUN_FINISHED", last?.type === "RUN_FINISHED");
    check("text arrived", runEvents.some((event) => event.type === "TEXT_MESSAGE_CONTENT"));
    check("no RUN_ERROR on success", !runEvents.some((event) => event.type === "RUN_ERROR"));

    console.log("\nreplay cursor and connect");
    const state = await jsonRequest(base, "GET", `/api/copilotkit/thread/${encodeURIComponent(sessionId)}/state`, undefined, headers);
    check("cursor is project scoped", state.data?.projectId === "product-eng");
    check("cursor reports the last event", typeof state.data?.lastEventId === "string" && state.data.lastEventId.startsWith("evt_"));
    check("idle cursor reports no active run", state.data?.streaming === false && state.data?.activeRunId === null);

    const connectRes = await fetch(`${base}/api/copilotkit/agent/pi/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ threadId: sessionId, forwardedProps: { projectId: "product-eng" } }),
    });
    const connectEvents = await readSse(connectRes);
    check("connect replays the run", connectEvents.some((event) => event.type === "RUN_STARTED"));
    check("connect replays the terminal", connectEvents.some((event) => event.type === "RUN_FINISHED"));
    const replayIds = new Set(connectEvents.map((event) => event.runId));
    check("connect replay has no duplicate run ids", replayIds.size === 1);

    const afterRes = await fetch(`${base}/api/copilotkit/agent/pi/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        threadId: sessionId,
        forwardedProps: { projectId: "product-eng", afterEventId: state.data.lastEventId },
      }),
    });
    const afterEvents = await readSse(afterRes);
    check("afterEventId suppresses the replayed run", afterEvents.length === 0, JSON.stringify(afterEvents));

    console.log("\nstandard tool error propagation");
    const errorRes = await fetch(`${base}/api/copilotkit/agent/pi/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        threadId: sessionId,
        messages: [{ role: "user", content: "missing workbook [scenario:tool-error]" }],
        forwardedProps: { projectId: "product-eng" },
      }),
    });
    const errorEvents = await readSse(errorRes);
    const toolError = errorEvents.find((event) => event.type === "TOOL_CALL_RESULT");
    check(
      "tool failure is encoded in standard content",
      toolError?.content === "Error: No such workbook: uploads/missing.xlsx",
      JSON.stringify(toolError),
    );
    check(
      "client recognizes failure without the extension field",
      toolStatusFromResult(toolError?.content) === "error",
    );

    console.log("\nproject isolation and errors");
    const foreign = await fetch(`${base}/api/copilotkit/agent/pi/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        threadId: sessionId,
        messages: [{ role: "user", content: "x" }],
        forwardedProps: { projectId: "other-project" },
      }),
    });
    check("foreign projectId is rejected", foreign.status === 403);
    const missing = await jsonRequest(base, "POST", "/api/copilotkit/agent/pi/stop/not-a-thread", {}, headers);
    check("unknown thread stop is 404", missing.status === 404);
    check("legacy AG-UI info still works", (await jsonRequest(base, "GET", "/api/ag-ui/info", undefined, headers)).status === 200);

    console.log("\nstop during an active run");
    const slowBody = {
      threadId: sessionId,
      messages: [{ role: "user", content: "慢速 [scenario:slow]" }],
      forwardedProps: { projectId: "product-eng" },
    };
    let stopWhenStarted;
    const started = new Promise((resolve) => { stopWhenStarted = resolve; });
    const slowRes = await fetch(`${base}/api/copilotkit/agent/pi/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(slowBody),
    });
    const slowEventsPromise = readSse(slowRes, (event) => {
      if (event.type === "RUN_STARTED") stopWhenStarted();
    });
    await started;
    const stop = await jsonRequest(base, "POST", `/api/copilotkit/agent/pi/stop/${encodeURIComponent(sessionId)}`, {}, headers);
    check("stop reports the active run", stop.data?.stopped === true);
    const slowEvents = await slowEventsPromise;
    const slowLast = slowEvents.at(-1);
    check("stop closes the stream", slowLast?.type === "RUN_FINISHED");
    check("stop marks the run aborted", slowLast?.result?.aborted === true);
    check("no event follows RUN_FINISHED", slowEvents.filter((event) => event.type === "RUN_FINISHED").length === 1);

    console.log("\ndependency and storage boundary");
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    check("@copilotkit/core is pinned exactly", pkg.dependencies?.["@copilotkit/core"] === "1.79.1");
    check("@copilotkit/runtime is not installed", !pkg.dependencies?.["@copilotkit/runtime"]);
    check("better-sqlite3 is not installed", !pkg.dependencies?.["better-sqlite3"]);
    const serverSource = fs.readFileSync(path.join(ROOT, "lib/agent-protocol/copilotkit-endpoint.mjs"), "utf8");
    check("pilot endpoint delegates run/connect/stop to P0", serverSource.includes("handleAgUiRequest"));
    check("pilot endpoint does not open a conversation database", !/openStore|better-sqlite3|create table/i.test(serverSource));
  } finally {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(3000)]);
    if (child.exitCode == null) child.kill("SIGKILL");
    fs.rmSync(storage, { recursive: true, force: true });
  }

  if (failed) {
    console.log(`\n${passed} passed, ${failed} failed`);
    console.log(failures.join(", "));
    if (output) console.log(output.slice(-4000));
    process.exitCode = 1;
  } else {
    console.log(`\n${passed} passed, 0 failed`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
