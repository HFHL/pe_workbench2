#!/usr/bin/env node
/**
 * Protocol test suite for the Pi → AG-UI bridge.
 *
 * Everything here is offline: fake Pi sessions, fixed events and a throwaway
 * SQLite database. The last section boots the real server on a random port to
 * prove the legacy HTTP surface still works.
 *
 *   node scripts/test-protocol.mjs        (or: npm run test:protocol)
 */

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { openStore } from "../store.mjs";
import { EventType } from "../lib/agent-protocol/ag-ui-events.mjs";
import {
  eventIdFor,
  messageIdFromPi,
  newMessageId,
  newRunId,
  toolResultMessageId,
} from "../lib/agent-protocol/ids.mjs";
import { RunState, RunStateMachine, ProtocolError } from "../lib/agent-protocol/run-state-machine.mjs";
import { AgentEventLog, MemoryAgentEventLog } from "../lib/agent-protocol/event-log.mjs";
import { PiAgUiAdapter } from "../lib/agent-protocol/pi-ag-ui-adapter.mjs";
import {
  handleAgUiRequest,
  normalizeRunInput,
  replayCursor,
  streamAgUiEvents,
} from "../lib/agent-protocol/ag-ui-endpoint.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

function section(title) {
  console.log(`\n${title}`);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate, { timeoutMs = 2000, label = "condition" } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    await flush();
  }
  throw new Error(`timed out waiting for ${label}`);
}

/* ---------- fake Pi session ---------- */

class FakePiSession {
  constructor({ script, sessionId = `sesn_${Math.random().toString(16).slice(2)}` }) {
    this.script = script;
    this.sessionId = sessionId;
    this.isStreaming = false;
    this.subscribers = new Set();
    this.prompts = [];
    this.abortCalls = 0;
    this.lastRun = null;
    this.gate = null;
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  emit(event) {
    for (const listener of [...this.subscribers]) listener(event);
  }

  prompt(text, options = {}) {
    this.isStreaming = true;
    this.prompts.push({ text, options });
    this.lastRun = (async () => {
      try {
        await this.script({ emit: (event) => this.emit(event), session: this, text });
      } finally {
        this.isStreaming = false;
      }
    })();
    return this.lastRun;
  }

  async abort() {
    this.abortCalls += 1;
    this.isStreaming = false;
    this.emit({ type: "agent_settled", aborted: true });
  }

  /** A promise the test resolves to continue a paused script. */
  pause() {
    return new Promise((resolve) => {
      this.gate = resolve;
    });
  }

  resume() {
    const gate = this.gate;
    this.gate = null;
    gate?.();
  }
}

const assistantMessage = (content = [], stopReason = "stop") => ({
  role: "assistant",
  content,
  stopReason,
  timestamp: Date.now(),
});

const delta = (message, text) => ({
  type: "message_update",
  message,
  assistantMessageEvent: { type: "text_delta", delta: text },
});

/* ---------- fake HTTP request/response ---------- */

class FakeRequest extends EventEmitter {
  constructor(headers = {}) {
    super();
    this.headers = headers;
  }
}

class FakeResponse {
  constructor() {
    this.chunks = [];
    this.statusCode = null;
    this.headers = null;
    this.writableEnded = false;
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  write(chunk) {
    if (this.writableEnded) return false;
    this.chunks.push(chunk);
    return true;
  }

  end() {
    this.writableEnded = true;
  }

  get body() {
    return this.chunks.join("");
  }

  get events() {
    return parseSse(this.body);
  }
}

function parseSse(body) {
  const events = [];
  for (const block of body.split("\n\n")) {
    if (!block.trim() || block.trimStart().startsWith(":") || block.startsWith("retry:")) continue;
    const lines = block.split("\n");
    const idLine = lines.find((line) => line.startsWith("id: "));
    const dataLine = lines.find((line) => line.startsWith("data: "));
    if (!dataLine) continue;
    events.push({ id: idLine ? idLine.slice(4) : null, data: JSON.parse(dataLine.slice(6)) });
  }
  return events;
}

function typesOf(records) {
  return records.map((record) => record.eventType);
}

function assertRunInvariants(name, records) {
  const types = typesOf(records);
  assert.ok(records.length > 0, `${name}: no events`);
  assert.equal(types[0], EventType.RUN_STARTED, `${name}: first event must be RUN_STARTED`);
  assert.ok(
    [EventType.RUN_FINISHED, EventType.RUN_ERROR].includes(types.at(-1)),
    `${name}: last event must be terminal, got ${types.at(-1)}`,
  );
  assert.equal(types.filter((type) => type === EventType.RUN_STARTED).length, 1, `${name}: one RUN_STARTED`);
  assert.equal(
    types.filter((type) => [EventType.RUN_FINISHED, EventType.RUN_ERROR].includes(type)).length,
    1,
    `${name}: one terminal event`,
  );
  const sequences = records.map((record) => record.sequence);
  assert.deepEqual(sequences, sequences.map((_, index) => index + 1), `${name}: sequence must be 1..n`);
  const ids = records.map((record) => record.eventId);
  assert.equal(new Set(ids).size, ids.length, `${name}: eventId must be unique`);
  for (const record of records) {
    assert.equal(record.payload.type, record.eventType, `${name}: payload.type must match`);
    assert.equal(record.payload.threadId, records[0].payload.threadId);
    assert.equal(record.payload.runId, records[0].payload.runId);
  }
}

async function runToCompletion(adapter, session, prompt = "hello") {
  const started = await adapter.runPrompt(prompt);
  await session.lastRun;
  await waitFor(() => !adapter.isRunning, { label: "run to settle" });
  const records = adapter.log.records.filter((record) => record.runId === started.runId);
  return { ...started, records };
}

/* ===================================================================== */

async function testIds() {
  section("ids");
  const runId = newRunId();
  check("runId has run_ prefix", runId.startsWith("run_"), runId);
  check("runId is unique", runId !== newRunId());
  check("eventId embeds sequence", eventIdFor(runId, 1).endsWith("_000001"));
  check("eventId is stable", eventIdFor(runId, 7) === eventIdFor(runId, 7));
  check("tool result messageId is derived from toolCallId", toolResultMessageId("tool_1") === "msg_tool_tool_1");
  check("Pi message id wins over fallback", messageIdFromPi({ id: "pi-msg-9" }, "fallback") === "pi-msg-9");
  check("missing Pi message id falls back", messageIdFromPi({}, "fallback") === "fallback");
  check("generated message ids look like msg_*", newMessageId().startsWith("msg_"));
}

function testStateMachine() {
  section("run state machine");

  const events = [];
  const machine = new RunStateMachine({ threadId: "t1", runId: "r1", emit: (event) => events.push(event) });

  machine.start();
  machine.startTextMessage({ messageId: "m1" });
  machine.appendText({ messageId: "m1", delta: "hi" });
  machine.endTextMessage({ messageId: "m1" });

  assert.throws(
    () => machine.appendText({ messageId: "m1", delta: "late" }),
    (error) => error instanceof ProtocolError && error.code === "content_before_start",
    "content after END must be rejected",
  );
  check("TEXT_MESSAGE_CONTENT before START is rejected", true);

  machine.startToolCall({ toolCallId: "c1", toolName: "read", args: { path: "a.md" } });
  assert.throws(
    () => machine.endToolCall({ toolCallId: "c1-missing" }),
    (error) => error instanceof ProtocolError && error.code === "unknown_tool_call",
    "unknown tool call must be rejected",
  );
  machine.endToolCall({ toolCallId: "c1", content: "ok" });

  const toolTypes = events
    .filter((event) => event.toolCallId === "c1")
    .map((event) => event.type);
  check(
    "TOOL_CALL_END precedes TOOL_CALL_RESULT",
    toolTypes.join(",") === "TOOL_CALL_START,TOOL_CALL_ARGS,TOOL_CALL_END,TOOL_CALL_RESULT",
    toolTypes.join(","),
  );
  check("TOOL_CALL_ARGS carries JSON", events.find((event) => event.type === EventType.TOOL_CALL_ARGS).delta === '{"path":"a.md"}');

  machine.finish();
  assert.throws(
    () => machine.appendText({ messageId: "m1", delta: "after" }),
    (error) => error instanceof ProtocolError && error.code === "run_already_terminal",
    "business events after RUN_FINISHED must be rejected",
  );
  assert.throws(
    () => machine.startToolCall({ toolCallId: "c2", toolName: "read" }),
    (error) => error instanceof ProtocolError && error.code === "run_already_terminal",
  );
  check("events after terminal are rejected", machine.state === RunState.FINISHED);

  // An abnormal end must balance the stream.
  const abnormal = [];
  const crashed = new RunStateMachine({ threadId: "t2", runId: "r2", emit: (event) => abnormal.push(event) });
  crashed.start();
  crashed.startTextMessage({ messageId: "m2" });
  crashed.appendText({ messageId: "m2", delta: "partial" });
  crashed.startToolCall({ toolCallId: "c3", toolName: "bash", args: { command: "ls" } });
  crashed.fail({ message: "boom" });
  const abnormalTypes = abnormal.map((event) => event.type);
  check(
    "fail() balances open text message and tool call",
    abnormalTypes.join(",") ===
      "RUN_STARTED,TEXT_MESSAGE_START,TEXT_MESSAGE_CONTENT,TOOL_CALL_START,TOOL_CALL_ARGS,TEXT_MESSAGE_END,TOOL_CALL_END,TOOL_CALL_RESULT,RUN_ERROR",
    abnormalTypes.join(","),
  );
  check("synthetic tool result is marked as error", abnormal.at(-2).isError === true);
  check("RUN_ERROR is last", abnormalTypes.at(-1) === EventType.RUN_ERROR);
  check("machine remembers terminal state", crashed.isTerminal && crashed.snapshot().openToolCalls.length === 0);

  const finishWithOpen = [];
  const finisher = new RunStateMachine({ threadId: "t3", runId: "r3", emit: (event) => finishWithOpen.push(event) });
  finisher.start();
  finisher.startTextMessage({ messageId: "m3" });
  finisher.finish({ aborted: true });
  check(
    "finish(aborted) closes the open message",
    finishWithOpen.map((event) => event.type).join(",") === "RUN_STARTED,TEXT_MESSAGE_START,TEXT_MESSAGE_END,RUN_FINISHED",
    finishWithOpen.map((event) => event.type).join(","),
  );
  check("aborted result flag is carried", finishWithOpen.at(-1).result?.aborted === true);
}

async function testAdapter() {
  section("Pi → AG-UI adapter");

  // 1. plain text run
  {
    const log = new MemoryAgentEventLog({ workspaceId: "p1" });
    const session = new FakePiSession({
      script: async ({ emit }) => {
        emit({ type: "agent_start" });
        const message = assistantMessage();
        emit({ type: "message_start", message });
        emit(delta(message, "你好"));
        emit(delta(message, "，世界"));
        message.content = [{ type: "text", text: "你好，世界" }];
        emit({ type: "message_end", message });
        emit({ type: "agent_settled", aborted: false });
      },
    });
    const adapter = new PiAgUiAdapter({ session, threadId: session.sessionId, workspaceId: "p1", log });
    const { records } = await runToCompletion(adapter, session, "打个招呼");
    assertRunInvariants("text run", records);
    check(
      "text run event order",
      typesOf(records).join(",") ===
        "RUN_STARTED,TEXT_MESSAGE_START,TEXT_MESSAGE_CONTENT,TEXT_MESSAGE_CONTENT,TEXT_MESSAGE_END,RUN_FINISHED",
      typesOf(records).join(","),
    );
    check("deltas are preserved", records.filter((record) => record.eventType === EventType.TEXT_MESSAGE_CONTENT).map((record) => record.payload.delta).join("") === "你好，世界");
    check("threadId is the Pi sessionId", records[0].threadId === session.sessionId);
    check("prompt text reaches Pi", session.prompts[0].text === "打个招呼");
    check("run id is generated before the prompt", records[0].runId.startsWith("run_"));
    check("TEXT_MESSAGE_START role is assistant", records[1].payload.role === "assistant");
    check("adapter is idle afterwards", adapter.isRunning === false && adapter.activeRunId === null);
  }

  // 2. text → tool → text
  {
    const log = new MemoryAgentEventLog({ workspaceId: "p1" });
    const session = new FakePiSession({
      script: async ({ emit }) => {
        emit({ type: "agent_start" });
        const first = assistantMessage();
        emit({ type: "message_start", message: first });
        emit(delta(first, "先读文件。"));
        first.content = [{ type: "text", text: "先读文件。" }];
        emit({ type: "message_end", message: first });

        emit({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "exports/a.md" } });
        emit({ type: "tool_execution_update", toolCallId: "call_1", toolName: "read", args: {}, partialResult: { content: [{ type: "text", text: "第一段" }] } });
        emit({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result: { content: [{ type: "text", text: "内容" }] }, isError: false });

        const second = assistantMessage();
        emit({ type: "message_start", message: second });
        emit(delta(second, "读完了。"));
        second.content = [{ type: "text", text: "读完了。" }];
        emit({ type: "message_end", message: second });
        emit({ type: "agent_settled", aborted: false });
      },
    });
    const adapter = new PiAgUiAdapter({ session, threadId: session.sessionId, workspaceId: "p1", log });
    const { records } = await runToCompletion(adapter, session);
    assertRunInvariants("text-tool-text", records);
    check(
      "text → tool → text order",
      typesOf(records).join(",") ===
        "RUN_STARTED,TEXT_MESSAGE_START,TEXT_MESSAGE_CONTENT,TEXT_MESSAGE_END,TOOL_CALL_START,TOOL_CALL_ARGS,CUSTOM,TOOL_CALL_END,TOOL_CALL_RESULT,TEXT_MESSAGE_START,TEXT_MESSAGE_CONTENT,TEXT_MESSAGE_END,RUN_FINISHED",
      typesOf(records).join(","),
    );
    check("tool progress is a CUSTOM event", records.find((record) => record.eventType === EventType.CUSTOM).payload.name === "pi.tool_progress");
    check("tool result content is carried", records.find((record) => record.eventType === EventType.TOOL_CALL_RESULT).payload.content === "内容");
    check(
      "two distinct text message ids",
      new Set(records.filter((record) => record.eventType === EventType.TEXT_MESSAGE_START).map((record) => record.payload.messageId)).size === 2,
    );
  }

  // 3. multiple tools
  {
    const log = new MemoryAgentEventLog({ workspaceId: "p1" });
    const session = new FakePiSession({
      script: async ({ emit }) => {
        emit({ type: "agent_start" });
        for (const id of ["a", "b", "c"]) {
          emit({ type: "tool_execution_start", toolCallId: id, toolName: "grep", args: { pattern: id } });
          emit({ type: "tool_execution_end", toolCallId: id, toolName: "grep", result: { content: [{ type: "text", text: `${id}-result` }] }, isError: false });
        }
        emit({ type: "agent_settled", aborted: false });
      },
    });
    const adapter = new PiAgUiAdapter({ session, threadId: session.sessionId, workspaceId: "p1", log });
    const { records } = await runToCompletion(adapter, session);
    assertRunInvariants("multi-tool", records);
    check(
      "three tool calls, no text",
      records.filter((record) => record.eventType === EventType.TOOL_CALL_START).length === 3 &&
        records.filter((record) => record.eventType === EventType.TOOL_CALL_RESULT).length === 3 &&
        records.filter((record) => record.eventType === EventType.TEXT_MESSAGE_START).length === 0,
    );
    check(
      "tool results keep call order",
      records.filter((record) => record.eventType === EventType.TOOL_CALL_RESULT).map((record) => record.toolCallId || record.payload.toolCallId).join(",") === "a,b,c",
    );
  }

  // 4. tool failure
  {
    const log = new MemoryAgentEventLog({ workspaceId: "p1" });
    const session = new FakePiSession({
      script: async ({ emit }) => {
        emit({ type: "agent_start" });
        emit({ type: "tool_execution_start", toolCallId: "x", toolName: "bash", args: { command: "false" } });
        emit({ type: "tool_execution_end", toolCallId: "x", toolName: "bash", result: { content: [{ type: "text", text: "permission denied" }] }, isError: true });
        emit({ type: "agent_settled", aborted: false });
      },
    });
    const adapter = new PiAgUiAdapter({ session, threadId: session.sessionId, workspaceId: "p1", log });
    const { records } = await runToCompletion(adapter, session);
    assertRunInvariants("tool failure", records);
    const result = records.find((record) => record.eventType === EventType.TOOL_CALL_RESULT);
    check("failed tool result is marked", result.payload.isError === true);
    check("failed tool keeps its text", result.payload.content === "permission denied");
    check("tool failure does not fail the run", typesOf(records).at(-1) === EventType.RUN_FINISHED);
  }

  // 5. prompt rejection before agent_start
  {
    const log = new MemoryAgentEventLog({ workspaceId: "p1" });
    const session = new FakePiSession({
      script: async () => {
        throw new Error("provider unreachable");
      },
    });
    const adapter = new PiAgUiAdapter({ session, threadId: session.sessionId, workspaceId: "p1", log });
    const started = await adapter.runPrompt("hi");
    await session.lastRun.catch(() => {});
    await flush();
    const records = log.records.filter((record) => record.runId === started.runId);
    assertRunInvariants("prompt error", records);
    check("prompt error produces RUN_STARTED + RUN_ERROR", typesOf(records).join(",") === "RUN_STARTED,RUN_ERROR", typesOf(records).join(","));
    check("error message is carried", records.at(-1).payload.message === "provider unreachable");
    check("adapter is idle after prompt error", adapter.isRunning === false);
  }

  // 6. assistant message ends with stopReason error
  {
    const log = new MemoryAgentEventLog({ workspaceId: "p1" });
    const session = new FakePiSession({
      script: async ({ emit }) => {
        emit({ type: "agent_start" });
        const message = assistantMessage([], "error");
        message.errorMessage = "model overloaded";
        emit({ type: "message_start", message });
        emit(delta(message, "半"));
        emit({ type: "message_end", message });
        emit({ type: "agent_settled", aborted: false });
      },
    });
    const adapter = new PiAgUiAdapter({ session, threadId: session.sessionId, workspaceId: "p1", log });
    const { records } = await runToCompletion(adapter, session);
    assertRunInvariants("assistant error", records);
    check("assistant error ends the run with RUN_ERROR", records.at(-1).eventType === EventType.RUN_ERROR);
    check("assistant error message is carried", records.at(-1).payload.message === "model overloaded");
  }

  // 6b. a retried error is not fatal once a later message succeeds
  {
    const log = new MemoryAgentEventLog({ workspaceId: "p1" });
    const session = new FakePiSession({
      script: async ({ emit }) => {
        emit({ type: "agent_start" });
        const failed = assistantMessage([], "error");
        failed.errorMessage = "transient overload";
        emit({ type: "message_start", message: failed });
        emit({ type: "message_end", message: failed });

        const retried = assistantMessage();
        emit({ type: "message_start", message: retried });
        emit(delta(retried, "重试成功"));
        retried.content = [{ type: "text", text: "重试成功" }];
        emit({ type: "message_end", message: retried });
        emit({ type: "agent_settled", aborted: false });
      },
    });
    const adapter = new PiAgUiAdapter({ session, threadId: session.sessionId, workspaceId: "p1", log });
    const { records } = await runToCompletion(adapter, session);
    assertRunInvariants("retry", records);
    check("a successful retry ends with RUN_FINISHED", records.at(-1).eventType === EventType.RUN_FINISHED);
    check("retry output is streamed", records.some((record) => record.payload.delta === "重试成功"));
  }

  // 6c. a synchronous prompt throw still produces a streamable RUN_ERROR
  {
    const log = new MemoryAgentEventLog({ workspaceId: "p1" });
    const session = new FakePiSession({ script: async () => {} });
    session.prompt = () => {
      throw new Error("session is disposed");
    };
    const adapter = new PiAgUiAdapter({ session, threadId: "t-sync", workspaceId: "p1", log });
    const started = await adapter.runPrompt("hi");
    const records = log.records.filter((record) => record.runId === started.runId);
    assertRunInvariants("sync prompt error", records);
    check("sync prompt error is returned, not thrown", Boolean(started.runId));
    check("sync prompt error is RUN_ERROR", records.at(-1).eventType === EventType.RUN_ERROR);
  }

  // 7. abort closes the run and stops streaming
  {
    const log = new MemoryAgentEventLog({ workspaceId: "p1" });
    const session = new FakePiSession({
      script: async ({ emit, session: self }) => {
        emit({ type: "agent_start" });
        const message = assistantMessage();
        emit({ type: "message_start", message });
        emit(delta(message, "第一段"));
        await self.pause();
        emit(delta(message, "不该出现"));
        emit({ type: "message_end", message });
        emit({ type: "agent_settled", aborted: false });
      },
    });
    const adapter = new PiAgUiAdapter({ session, threadId: session.sessionId, workspaceId: "p1", log });
    const started = await adapter.runPrompt("长任务");
    await waitFor(() => log.records.length >= 3, { label: "first deltas" });
    await adapter.abort();
    const countAtAbort = log.records.length;
    session.resume();
    await session.lastRun;
    await flush();
    const records = log.records.filter((record) => record.runId === started.runId);
    assertRunInvariants("abort", records);
    check("abort emits RUN_FINISHED(aborted)", records.at(-1).eventType === EventType.RUN_FINISHED && records.at(-1).payload.result?.aborted === true);
    check("no deltas after abort", !records.some((record) => record.payload.delta === "不该出现"));
    check("nothing appended after abort", log.records.length === countAtAbort, `${countAtAbort} → ${log.records.length}`);
    check("session.abort was called", session.abortCalls === 1);
    check("adapter idle after abort", adapter.isRunning === false);
  }

  // 8. adapter exception → RUN_ERROR
  {
    const log = new MemoryAgentEventLog({ workspaceId: "p1" });
    const session = new FakePiSession({
      script: async ({ emit }) => {
        emit({ type: "agent_start" });
        emit({ type: "tool_execution_end", toolCallId: "ghost", toolName: "read", result: "x", isError: false });
        emit({ type: "agent_settled", aborted: false });
      },
    });
    const adapter = new PiAgUiAdapter({ session, threadId: session.sessionId, workspaceId: "p1", log });
    const { records } = await runToCompletion(adapter, session);
    assertRunInvariants("adapter exception", records);
    check("adapter exception becomes RUN_ERROR", records.at(-1).eventType === EventType.RUN_ERROR);
    check("adapter stays alive after the error", adapter.isRunning === false);
  }

  // 9. one run at a time per thread
  {
    const log = new MemoryAgentEventLog({ workspaceId: "p1" });
    const session = new FakePiSession({
      script: async ({ emit, session: self }) => {
        emit({ type: "agent_start" });
        await self.pause();
        emit({ type: "agent_settled", aborted: false });
      },
    });
    const adapter = new PiAgUiAdapter({ session, threadId: session.sessionId, workspaceId: "p1", log });
    await adapter.runPrompt("first");
    let code = null;
    try {
      await adapter.runPrompt("second");
    } catch (error) {
      code = error.code;
    }
    check("concurrent run is rejected with run_in_progress", code === "run_in_progress", String(code));
    session.resume();
    await session.lastRun;
    await flush();
    const again = await adapter.runPrompt("third");
    check("a new run can start after the previous one settled", Boolean(again.runId));
    await flush();
    session.resume();
    await session.lastRun.catch(() => {});
    await flush();
    check("second run settled cleanly", adapter.isRunning === false);
  }
}

async function testSqliteLog() {
  section("SQLite event log");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-agui-"));
  const workspace = path.join(root, "projects", "p1");
  const otherWorkspace = path.join(root, "projects", "p2");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(otherWorkspace, { recursive: true });

  try {
    let store = await openStore({ root, workspace, projectId: "p1", projectName: "P1", seed: false });
    const log = new AgentEventLog({ store, workspaceId: "p1" });
    const records = [];
    for (let index = 0; index < 5; index += 1) {
      records.push(
        log.append({
          threadId: "thread-db",
          runId: "run-db",
          eventType: index === 0 ? EventType.RUN_STARTED : EventType.TEXT_MESSAGE_CONTENT,
          event: { type: index === 0 ? EventType.RUN_STARTED : EventType.TEXT_MESSAGE_CONTENT, threadId: "thread-db", runId: "run-db", delta: String(index) },
        }),
      );
    }
    check("rows get sequence 1..n", records.map((record) => record.sequence).join(",") === "1,2,3,4,5");
    check("rows get stable event ids", records.every((record) => record.eventId === eventIdFor("run-db", record.sequence)));
    check("ordinal increases", records.every((record, index) => record.ordinal === index + 1));

    const secondRun = log.append({
      threadId: "thread-db",
      runId: "run-db-2",
      eventType: EventType.RUN_STARTED,
      event: { type: EventType.RUN_STARTED, threadId: "thread-db", runId: "run-db-2" },
    });
    check("sequence restarts per run", secondRun.sequence === 1);

    // A different workspace sharing the database must not see these rows.
    const foreignLog = new AgentEventLog({ store, workspaceId: "p2" });
    check("workspace filter hides other projects", foreignLog.list({ threadId: "thread-db" }).length === 0);
    check("cross-workspace locate returns null", foreignLog.locate(records[0].eventId) === null);

    // Re-open the database: replay must return identical ids and sequences.
    store.db.close();
    store = await openStore({ root, workspace, projectId: "p1", projectName: "P1", seed: false });
    const reopened = new AgentEventLog({ store, workspaceId: "p1" });
    const replayed = reopened.list({ threadId: "thread-db", runId: "run-db" });
    check(
      "replay after restart keeps ids and sequences",
      replayed.length === records.length &&
        replayed.every((record, index) => record.eventId === records[index].eventId && record.sequence === records[index].sequence),
    );
    check("replay after restart keeps payload", replayed[1].payload.delta === "1");
    const afterId = reopened.list({ threadId: "thread-db", afterOrdinal: replayed.at(-1).ordinal });
    check("thread replay continues across runs", afterId.length === 1 && afterId[0].runId === "run-db-2");
    store.db.close();

    // Two projects with separate databases cannot read each other's events.
    const storeA = await openStore({ root, workspace, projectId: "p1", projectName: "P1", seed: false });
    const storeB = await openStore({ root, workspace: otherWorkspace, projectId: "p2", projectName: "P2", seed: false });
    const logA = new AgentEventLog({ store: storeA, workspaceId: "p1" });
    const logB = new AgentEventLog({ store: storeB, workspaceId: "p2" });
    logA.append({ threadId: "thread-a", runId: "run-a", eventType: EventType.RUN_STARTED, event: { type: EventType.RUN_STARTED } });
    check("project B cannot read project A events", logB.list({ threadId: "thread-a" }).length === 0);
    check("project B cannot locate project A events", logB.locate(eventIdFor("run-a", 1)) === null);
    check("project A still reads its own events", logA.list({ threadId: "thread-a" }).length === 1);
    storeA.db.close();
    storeB.db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testReplay() {
  section("SSE replay and live hand-off");

  const buildLog = () => {
    const log = new MemoryAgentEventLog({ workspaceId: "p1" });
    for (let index = 0; index < 6; index += 1) {
      const type = index === 0 ? EventType.RUN_STARTED : index === 5 ? EventType.RUN_FINISHED : EventType.TEXT_MESSAGE_CONTENT;
      log.append({
        threadId: "t-replay",
        runId: "r-replay",
        eventType: type,
        event: { type, threadId: "t-replay", runId: "r-replay", delta: String(index) },
      });
    }
    return log;
  };

  // Full replay, then the stream closes on the terminal event.
  {
    const log = buildLog();
    const res = new FakeResponse();
    const req = new FakeRequest();
    await streamAgUiEvents({
      req,
      res,
      log,
      threadId: "t-replay",
      runId: "r-replay",
      subscribe: () => () => {},
      isRunActive: () => false,
    });
    check("replay writes SSE headers", res.statusCode === 200 && res.headers["Content-Type"].startsWith("text/event-stream"));
    check("replay sends every event", res.events.length === 6, String(res.events.length));
    check("SSE id equals eventId", res.events[0].id === eventIdFor("r-replay", 1));
    check("stream closes after terminal event", res.writableEnded === true);
  }

  // Reconnect with afterEventId returns only the missing tail.
  {
    const log = buildLog();
    const anchor = log.list({ threadId: "t-replay" })[2].eventId;
    const res = new FakeResponse();
    await streamAgUiEvents({
      req: new FakeRequest(),
      res,
      log,
      threadId: "t-replay",
      runId: "r-replay",
      afterEventId: anchor,
      subscribe: () => () => {},
      isRunActive: () => false,
    });
    check("reconnect replays only missing events", res.events.length === 3, String(res.events.length));
    check("reconnect does not repeat the anchor", res.events[0].id !== anchor);
    check("reconnect continues the sequence", res.events.map((event) => event.data.type).join(",") === "TEXT_MESSAGE_CONTENT,TEXT_MESSAGE_CONTENT,RUN_FINISHED");
    check("reconnect ids stay stable", res.events.map((event) => event.id).join(",") === [4, 5, 6].map((sequence) => eventIdFor("r-replay", sequence)).join(","));
  }

  // afterSequence works without an event id.
  {
    const log = buildLog();
    const res = new FakeResponse();
    await streamAgUiEvents({
      req: new FakeRequest(),
      res,
      log,
      threadId: "t-replay",
      runId: "r-replay",
      afterSequence: 4,
      subscribe: () => () => {},
      isRunActive: () => false,
    });
    check("afterSequence replays the tail", res.events.map((event) => event.data.type).join(",") === "TEXT_MESSAGE_CONTENT,RUN_FINISHED");
  }

  // Replay paginates instead of truncating at one batch.
  {
    const log = buildLog();
    const res = new FakeResponse();
    await streamAgUiEvents({
      req: new FakeRequest(),
      res,
      log,
      threadId: "t-replay",
      runId: "r-replay",
      subscribe: () => () => {},
      isRunActive: () => false,
      maxReplay: 2,
    });
    check("replay paginates through batches", res.events.length === 6 && res.events.at(-1).data.type === EventType.RUN_FINISHED, String(res.events.length));
    check("paginated replay keeps every id", new Set(res.events.map((event) => event.id)).size === 6);
  }

  // Replay after a process restart: the same ids come back from SQLite.
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-agui-replay-"));
    const workspace = path.join(root, "projects", "p1");
    fs.mkdirSync(workspace, { recursive: true });
    try {
      let store = await openStore({ root, workspace, projectId: "p1", projectName: "P1", seed: false });
      let log = new AgentEventLog({ store, workspaceId: "p1" });
      const written = [
        { type: EventType.RUN_STARTED, eventType: EventType.RUN_STARTED, extra: {} },
        { type: EventType.TEXT_MESSAGE_START, eventType: EventType.TEXT_MESSAGE_START, extra: { messageId: "m1", role: "assistant" } },
        { type: EventType.TEXT_MESSAGE_CONTENT, eventType: EventType.TEXT_MESSAGE_CONTENT, extra: { messageId: "m1", delta: "重启前" } },
        { type: EventType.TEXT_MESSAGE_END, eventType: EventType.TEXT_MESSAGE_END, extra: { messageId: "m1" } },
        { type: EventType.RUN_FINISHED, eventType: EventType.RUN_FINISHED, extra: {} },
      ].map((item) =>
        log.append({
          threadId: "thread-restart",
          runId: "run-restart",
          eventType: item.eventType,
          event: { type: item.type, threadId: "thread-restart", runId: "run-restart", ...item.extra },
        }),
      );
      store.db.close();

      store = await openStore({ root, workspace, projectId: "p1", projectName: "P1", seed: false });
      log = new AgentEventLog({ store, workspaceId: "p1" });
      const res = new FakeResponse();
      await streamAgUiEvents({
        req: new FakeRequest(),
        res,
        log,
        threadId: "thread-restart",
        runId: "run-restart",
        subscribe: () => () => {},
        isRunActive: () => false,
      });
      check(
        "replay after a server restart keeps ids and sequences",
        res.events.map((event) => event.id).join(",") === written.map((record) => record.eventId).join(","),
      );
      check("replay after restart keeps the payload", res.events[2].data.delta === "重启前");
      store.db.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // Live hand-off: an event appended while the replay query runs must be sent
  // exactly once, and a duplicate delivery must be filtered.
  {
    const fake = new FakePiSession({
      script: async ({ emit, session: self }) => {
        emit({ type: "agent_start" });
        const message = assistantMessage();
        emit({ type: "message_start", message });
        emit(delta(message, "a"));
        await self.pause();
        emit(delta(message, "b"));
        message.content = [{ type: "text", text: "ab" }];
        emit({ type: "message_end", message });
        emit({ type: "agent_settled", aborted: false });
      },
    });
    const log = new MemoryAgentEventLog({ workspaceId: "p1" });
    const adapter = new PiAgUiAdapter({ session: fake, threadId: fake.sessionId, workspaceId: "p1", log });
    adapter.attach();
    const started = await adapter.runPrompt("hi");
    await waitFor(() => log.records.length >= 3, { label: "text start" });

    const anchor = log.records[1].eventId;
    const res = new FakeResponse();
    let injected = false;
    const racingLog = {
      locate: (eventId) => log.locate(eventId),
      list: (options) => {
        const rows = log.list(options);
        if (!injected) {
          injected = true;
          // Append during the replay read: must be queued, not lost.
          fake.emit(delta({ role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() }, "race"));
          // Deliver an already-replayed event twice: must be de-duplicated.
          const duplicate = rows[0];
          for (const listener of adapter.listeners) listener(duplicate);
        }
        return rows;
      },
    };

    await streamAgUiEvents({
      req: new FakeRequest(),
      res,
      log: racingLog,
      threadId: fake.sessionId,
      runId: started.runId,
      afterEventId: anchor,
      subscribe: (listener) => adapter.subscribeEvents(listener),
      isRunActive: (runId) => adapter.isRunning && (!runId || adapter.activeRunId === runId),
    });

    fake.resume();
    await fake.lastRun;
    await waitFor(() => !adapter.isRunning, { label: "live run settle" });
    await flush();

    const expected = log.records.filter((record) => record.runId === started.runId && record.sequence > 2);
    const ids = res.events.map((event) => event.id);
    check("live hand-off delivers every event", res.events.length === expected.length, `${res.events.length} vs ${expected.length}`);
    check("live hand-off has no duplicates", new Set(ids).size === ids.length);
    check("live hand-off preserves order", ids.join(",") === expected.map((record) => record.eventId).join(","));
    check("queued event is included", res.events.some((event) => event.data.delta === "race"));
    check("stream ends on RUN_FINISHED", res.writableEnded && res.events.at(-1).data.type === EventType.RUN_FINISHED);

    // A completed run replays from the durable log with the same ids.
    const replay = new FakeResponse();
    await streamAgUiEvents({
      req: new FakeRequest(),
      res: replay,
      log,
      threadId: fake.sessionId,
      runId: started.runId,
      subscribe: () => () => {},
      isRunActive: () => false,
    });
    check(
      "replay after completion reproduces the live ids",
      replay.events.map((event) => event.id).join(",") === log.records.map((record) => record.eventId).join(","),
    );
  }

  // A run registered before agent_start must not be treated as finished.
  {
    const fake = new FakePiSession({
      script: async ({ emit }) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        emit({ type: "agent_start" });
        const message = assistantMessage();
        emit({ type: "message_start", message });
        emit(delta(message, "later"));
        message.content = [{ type: "text", text: "later" }];
        emit({ type: "message_end", message });
        emit({ type: "agent_settled", aborted: false });
      },
    });
    const log = new MemoryAgentEventLog({ workspaceId: "p1" });
    const adapter = new PiAgUiAdapter({ session: fake, threadId: "t-async", workspaceId: "p1", log });
    adapter.attach();
    const started = await adapter.runPrompt("hi");
    const res = new FakeResponse();
    await streamAgUiEvents({
      req: new FakeRequest(),
      res,
      log,
      threadId: "t-async",
      runId: started.runId,
      subscribe: (listener) => adapter.subscribeEvents(listener),
      isRunActive: (run) => adapter.isRunning && (!run || adapter.activeRunId === run),
    });
    check("stream stays open before agent_start arrives", res.writableEnded === false);
    await fake.lastRun;
    await waitFor(() => res.writableEnded, { label: "stream close after settle" });
    check(
      "async-start run streams every event",
      res.events.map((event) => event.data.type).join(",") ===
        "RUN_STARTED,TEXT_MESSAGE_START,TEXT_MESSAGE_CONTENT,TEXT_MESSAGE_END,RUN_FINISHED",
      res.events.map((event) => event.data.type).join(","),
    );
  }

  // Connect with no active run and no events just closes.
  {
    const log = new MemoryAgentEventLog({ workspaceId: "p1" });
    const res = new FakeResponse();
    await streamAgUiEvents({
      req: new FakeRequest(),
      res,
      log,
      threadId: "empty-thread",
      subscribe: () => () => {},
      isRunActive: () => false,
    });
    check("empty connect closes immediately", res.writableEnded && res.events.length === 0);
  }

  // Live stream stays open until the terminal event arrives.
  {
    const listeners = new Set();
    const log = new MemoryAgentEventLog({ workspaceId: "p1" });
    const record = log.append({
      threadId: "t-live",
      runId: "r-live",
      eventType: EventType.RUN_STARTED,
      event: { type: EventType.RUN_STARTED, threadId: "t-live", runId: "r-live" },
    });
    const res = new FakeResponse();
    const streaming = streamAgUiEvents({
      req: new FakeRequest(),
      res,
      log,
      threadId: "t-live",
      runId: "r-live",
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isRunActive: () => true,
      pingMs: 100000,
    });
    await streaming;
    check("active run keeps the stream open", res.writableEnded === false);
    const terminal = log.append({
      threadId: "t-live",
      runId: "r-live",
      eventType: EventType.RUN_FINISHED,
      event: { type: EventType.RUN_FINISHED, threadId: "t-live", runId: "r-live" },
    });
    for (const listener of listeners) listener(terminal);
    check("terminal event closes the stream", res.writableEnded === true);
    check("live event was written once", res.events.filter((event) => event.id === terminal.eventId).length === 1);
    check("first record was replayed", res.events[0].id === record.eventId);
  }

  // Cursors from headers and query strings.
  {
    const url = new URL("http://x/api/ag-ui/agent/pi/connect");
    const cursor = replayCursor({ body: {}, url, headers: { "last-event-id": "evt_x_000004" } });
    check("Last-Event-ID header is preferred", cursor.afterEventId === "evt_x_000004");
    const queryCursor = replayCursor({
      body: {},
      url: new URL("http://x/api/ag-ui/agent/pi/connect?afterEventId=evt_y_000009"),
      headers: {},
    });
    check("afterEventId query is supported", queryCursor.afterEventId === "evt_y_000009");
    const bodyCursor = replayCursor({ body: { forwardedProps: { afterEventId: "evt_z_000002" } }, url, headers: {} });
    check("afterEventId from forwardedProps is supported", bodyCursor.afterEventId === "evt_z_000002");
  }
}

function testRunInput() {
  section("run input");

  const ctx = { id: "p1", root: "/tmp/project-p1" };
  const base = normalizeRunInput(
    {
      threadId: "thread-1",
      messages: [{ id: "m1", role: "user", content: "分析这份报告" }],
      forwardedProps: { projectId: "p1", attachments: ["uploads/a.md", "../escape.md", "/etc/passwd"] },
    },
    ctx,
  );
  check("prompt comes from the last user message", base.prompt.startsWith("分析这份报告"));
  check("attachments are appended", base.prompt.includes("[已上传资料]") && base.prompt.includes("- uploads/a.md"));
  check("path escapes are dropped", !base.prompt.includes("escape.md") && !base.prompt.includes("passwd"));
  check("threadId is passed through", base.threadId === "thread-1");

  const mismatch = normalizeRunInput({ messages: [{ role: "user", content: "hi" }], forwardedProps: { projectId: "p2" } }, ctx);
  check("project mismatch is rejected", mismatch.ok === false && mismatch.status === 403);

  const empty = normalizeRunInput({ messages: [] }, ctx);
  check("empty prompt is rejected", empty.ok === false && empty.status === 400);

  const arrayContent = normalizeRunInput(
    { messages: [{ role: "assistant", content: "x" }, { role: "user", content: [{ type: "text", text: "第二条" }] }] },
    ctx,
  );
  check("array content is flattened", arrayContent.prompt === "第二条");
}

/* ---------- endpoint routing ---------- */

class FakeAgUiAdapter {
  constructor() {
    this.listeners = new Set();
    this.isRunning = false;
    this.activeRunId = null;
    this.prompts = [];
    this.abortCalls = 0;
  }

  subscribeEvents(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async runPrompt(text) {
    this.prompts.push(text);
    this.isRunning = true;
    this.activeRunId = "run_ep";
    return { threadId: "thread-1", runId: "run_ep" };
  }

  async abort() {
    this.abortCalls += 1;
    const wasRunning = this.isRunning;
    this.isRunning = false;
    this.activeRunId = null;
    return wasRunning;
  }

  push(record) {
    for (const listener of this.listeners) listener(record);
  }
}

async function testEndpointRoutes() {
  section("endpoint routes");

  const log = new MemoryAgentEventLog({ workspaceId: "p1" });
  const adapter = new FakeAgUiAdapter();
  const ctx = { id: "p1", root: "/tmp/project-p1", agentEvents: log };
  const entries = new Map([["thread-1", { id: "thread-1", agui: adapter }]]);
  const deps = {
    ctx,
    json: (res, status, body) => {
      res.statusCode = status;
      res.bodyJson = body;
      res.end();
    },
    readJson: async (req) => req.body || {},
    resolveThread: async (threadId) => entries.get(threadId) || null,
    createThread: async () => {
      const entry = { id: "thread-new", agui: new FakeAgUiAdapter() };
      entries.set(entry.id, entry);
      return entry;
    },
  };

  const request = (method, body) => Object.assign(new FakeRequest(), { method, body });

  {
    const res = new FakeResponse();
    const handled = await handleAgUiRequest(request("GET"), res, new URL("http://x/api/ag-ui/info"), deps);
    check("info route is handled", handled === true && res.statusCode === 200 && res.bodyJson.protocol === "ag-ui");
    check("info is project scoped", res.bodyJson.projectId === "p1");
  }

  {
    const res = new FakeResponse();
    const handled = await handleAgUiRequest(request("GET"), res, new URL("http://x/api/ag-ui/nope"), deps);
    check("unknown ag-ui route is handled as 404", handled === true && res.statusCode === 404);
  }

  {
    const res = new FakeResponse();
    await handleAgUiRequest(
      request("POST", { threadId: "thread-1", messages: [{ role: "user", content: "hi" }], forwardedProps: { projectId: "p2" } }),
      res,
      new URL("http://x/api/ag-ui/agent/pi/run"),
      deps,
    );
    check("run route rejects a foreign project", res.statusCode === 403);
  }

  {
    const res = new FakeResponse();
    await handleAgUiRequest(
      request("POST", { threadId: "thread-1", messages: [] }),
      res,
      new URL("http://x/api/ag-ui/agent/pi/run"),
      deps,
    );
    check("run route rejects an empty prompt", res.statusCode === 400);
  }

  {
    const res = new FakeResponse();
    await handleAgUiRequest(
      request("POST", { threadId: "ghost", messages: [{ role: "user", content: "hi" }] }),
      res,
      new URL("http://x/api/ag-ui/agent/pi/run"),
      deps,
    );
    check("run route 404s for an unknown thread", res.statusCode === 404);
  }

  {
    const res = new FakeResponse();
    await handleAgUiRequest(request("POST", {}), res, new URL("http://x/api/ag-ui/agent/pi/connect"), deps);
    check("connect requires a threadId", res.statusCode === 400);
  }

  // connect attaches to a live run, streams, and closes on the terminal event
  {
    adapter.isRunning = true;
    adapter.activeRunId = "run_ep";
    const started = log.append({
      threadId: "thread-1",
      runId: "run_ep",
      eventType: EventType.RUN_STARTED,
      event: { type: EventType.RUN_STARTED, threadId: "thread-1", runId: "run_ep" },
    });
    const res = new FakeResponse();
    await handleAgUiRequest(
      request("POST", { threadId: "thread-1" }),
      res,
      new URL("http://x/api/ag-ui/agent/pi/connect"),
      deps,
    );
    check("connect replays the active run", res.events.length === 1 && res.events[0].id === started.eventId);
    check("connect stays open while the run is active", res.writableEnded === false, "stream closed too early");
    const finished = log.append({
      threadId: "thread-1",
      runId: "run_ep",
      eventType: EventType.RUN_FINISHED,
      event: { type: EventType.RUN_FINISHED, threadId: "thread-1", runId: "run_ep" },
    });
    adapter.isRunning = false;
    adapter.activeRunId = null;
    adapter.push(finished);
    check("connect closes on RUN_FINISHED", res.writableEnded === true && res.events.at(-1).id === finished.eventId);
  }

  // run starts the adapter and streams until terminal
  {
    const adapter2 = new FakeAgUiAdapter();
    entries.set("thread-2", { id: "thread-2", agui: adapter2 });
    const res = new FakeResponse();
    await handleAgUiRequest(
      request("POST", {
        threadId: "thread-2",
        messages: [{ role: "user", content: [{ type: "text", text: "跑一下" }] }],
        forwardedProps: { projectId: "p1", attachments: ["uploads/spec.md"] },
      }),
      res,
      new URL("http://x/api/ag-ui/agent/pi/run"),
      deps,
    );
    check("run route starts the adapter", adapter2.prompts.length === 1 && adapter2.prompts[0].includes("跑一下"));
    check("run route forwards attachments", adapter2.prompts[0].includes("- uploads/spec.md"));
    check("run route streams with SSE headers", res.statusCode === 200 && res.headers["Content-Type"].startsWith("text/event-stream"));
    const started = log.append({
      threadId: "thread-2",
      runId: "run_ep",
      eventType: EventType.RUN_STARTED,
      event: { type: EventType.RUN_STARTED, threadId: "thread-2", runId: "run_ep" },
    });
    adapter2.push(started);
    const finished = log.append({
      threadId: "thread-2",
      runId: "run_ep",
      eventType: EventType.RUN_FINISHED,
      event: { type: EventType.RUN_FINISHED, threadId: "thread-2", runId: "run_ep" },
    });
    adapter2.isRunning = false;
    adapter2.activeRunId = null;
    adapter2.push(finished);
    check("run stream ends on RUN_FINISHED", res.writableEnded === true && res.events.at(-1).data.type === EventType.RUN_FINISHED);
    check("run stream starts with RUN_STARTED", res.events[0].data.type === EventType.RUN_STARTED);
  }

  // stop
  {
    const res = new FakeResponse();
    await handleAgUiRequest(
      request("POST"),
      res,
      new URL("http://x/api/ag-ui/agent/pi/stop/thread-1"),
      deps,
    );
    check("stop aborts the adapter", res.statusCode === 200 && res.bodyJson.ok === true && adapter.abortCalls === 1);
  }

  {
    const res = new FakeResponse();
    await handleAgUiRequest(request("POST"), res, new URL("http://x/api/ag-ui/agent/pi/stop/ghost"), deps);
    check("stop 404s for an unknown thread", res.statusCode === 404);
  }
}

/* ---------- legacy server regression ---------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function getJson(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), ...options });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function readSse(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch (error) {
      // Long-lived legacy streams are aborted after the first chunks arrive.
      if (error.name !== "AbortError") throw error;
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* closed */
      }
    }
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      events: parseSse(text),
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function testLegacyServer() {
  section("legacy HTTP surface (spawned server)");

  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    DEEPSEEK_API_KEY: "protocol-test-key",
    TRACKING_SCHEDULER: "0",
    MONITOR_SCHEDULER: "0",
    SOURCE_SCHEDULER: "0",
    ASR: "0",
    WORKBOOK_QUERY: "0",
    PDF_READ: "0",
    WESTOCK_QUERY: "0",
    ANYSEARCH_QUERY: "0",
    WEB_FETCH: "0",
    WORKBENCH_SEED: "0",
  };
  const child = spawn(process.execPath, ["server.mjs"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(
      async () => {
        try {
          const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
          return response.ok;
        } catch {
          return false;
        }
      },
      { timeoutMs: 40000, label: "server boot" },
    );

    const health = await getJson(`${base}/api/health`);
    check("GET /api/health still works", health.status === 200 && health.body.ok === true);

    const projects = await getJson(`${base}/api/projects`);
    check("GET /api/projects still works", projects.status === 200 && projects.body.length >= 1);
    const projectId = projects.body[0].id;

    const created = await getJson(`${base}/api/sessions`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    check("POST /api/sessions still works", created.status === 201 && Boolean(created.body.id), JSON.stringify(created.body));
    const sessionId = created.body.id;

    const state = await getJson(`${base}/api/sessions/${sessionId}/state`);
    check("GET /api/sessions/:id/state still works", state.status === 200 && state.body.type === "snapshot" && state.body.sessionId === sessionId);

    const sessionEvents = await readSse(`${base}/api/sessions/${sessionId}/events`);
    check("GET /api/sessions/:id/events still streams", sessionEvents.status === 200 && sessionEvents.text.includes("snapshot"));

    const globalEvents = await readSse(`${base}/api/events`);
    check("GET /api/events still streams", globalEvents.status === 200 && globalEvents.text.includes('"hello"'));

    const abort = await getJson(`${base}/api/sessions/${sessionId}/abort`, { method: "POST" });
    check("POST /api/sessions/:id/abort still works", abort.status === 200 && abort.body.ok === true);

    const emptyMessage = await getJson(`${base}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    check("POST /api/sessions/:id/messages still validates input", emptyMessage.status === 400);

    const missing = await getJson(`${base}/api/sessions/nope/state`);
    check("unknown session still 404s", missing.status === 404);

    const info = await getJson(`${base}/api/ag-ui/info`);
    check(
      "GET /api/ag-ui/info works",
      info.status === 200 && info.body.protocol === "ag-ui" && info.body.projectId === projectId && info.body.agents[0].name === "pi",
    );

    const connect = await readSse(`${base}/api/ag-ui/agent/pi/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: sessionId }),
    });
    check("POST /api/ag-ui/agent/pi/connect replays and closes", connect.status === 200 && connect.text.includes("retry: 2000") && connect.events.length === 0);

    const unknownThread = await getJson(`${base}/api/ag-ui/agent/pi/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "missing-thread" }),
    });
    check("connect rejects unknown threads", unknownThread.status === 404);

    const mismatch = await getJson(`${base}/api/ag-ui/agent/pi/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: sessionId,
        messages: [{ role: "user", content: "hi" }],
        forwardedProps: { projectId: "another-project" },
      }),
    });
    check("run rejects a mismatched projectId", mismatch.status === 403);

    const emptyRun = await getJson(`${base}/api/ag-ui/agent/pi/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: sessionId, messages: [] }),
    });
    check("run rejects an empty message", emptyRun.status === 400);

    const stop = await getJson(`${base}/api/ag-ui/agent/pi/stop/${sessionId}`, { method: "POST" });
    check("stop works when no run is active", stop.status === 200 && stop.body.ok === true && stop.body.stopped === false);

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    check("npm start entry point is unchanged", pkg.scripts.start === "node server.mjs");
  } finally {
    child.kill("SIGTERM");
    const exited = await Promise.race([once(child, "exit").then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 8000))]);
    if (!exited) child.kill("SIGKILL");
    if (failed && output) console.log(output.slice(-4000));
  }
}

/* ===================================================================== */

try {
  testIds();
  testStateMachine();
  await testAdapter();
  await testSqliteLog();
  await testReplay();
  testRunInput();
  await testEndpointRoutes();
  await testLegacyServer();
} catch (error) {
  failed += 1;
  console.error("\n  FAIL uncaught:", error.stack || error.message);
}

console.log(`\n${failed ? "✗" : "✓"} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
