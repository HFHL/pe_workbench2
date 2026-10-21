/**
 * RunStateMachine — protocol state for a single AG-UI run.
 *
 * It is intentionally independent of Pi and of the transport: the adapter feeds
 * it Pi events, it validates the ordering rules and only then emits AG-UI events
 * through the supplied `emit` callback. That keeps the invariants testable with
 * no real model, session file or network.
 *
 * Guarantees:
 * - RUN_STARTED is the first business event, RUN_FINISHED/RUN_ERROR the last.
 * - TEXT_MESSAGE_CONTENT requires an open TEXT_MESSAGE_START.
 * - A message id can only be started once; late content after its END is rejected.
 * - TOOL_CALL_END always precedes TOOL_CALL_RESULT; a result cannot be emitted
 *   for an unknown or already closed call.
 * - finish()/fail() close every open message and tool call, so an abnormal end
 *   still leaves the client with a balanced stream.
 * - No business event may follow a terminal event.
 */

import { EventType, createEvent } from "./ag-ui-events.mjs";
import { toolResultMessageId } from "./ids.mjs";

function toolResultContent(content, isError) {
  const text = String(content ?? "");
  if (!isError) return text;
  if (/^error\s*:/i.test(text.trim())) return text.trim().replace(/^error\s*:/i, "Error:");
  return `Error: ${text || "tool execution failed"}`;
}

export class ProtocolError extends Error {
  constructor(message, code = "protocol_error") {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export const RunState = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  FINISHED: "finished",
  FAILED: "failed",
});

export class RunStateMachine {
  constructor({ threadId, runId, emit }) {
    if (typeof threadId !== "string" || !threadId) {
      throw new ProtocolError("threadId is required", "missing_thread_id");
    }
    if (typeof runId !== "string" || !runId) {
      throw new ProtocolError("runId is required", "missing_run_id");
    }
    if (typeof emit !== "function") {
      throw new ProtocolError("emit callback is required", "missing_emit");
    }
    this.threadId = threadId;
    this.runId = runId;
    this.emit = emit;
    this.state = RunState.IDLE;
    /** messageId -> { chars } */
    this.openMessages = new Map();
    /** every message id that already received TEXT_MESSAGE_END */
    this.closedMessages = new Set();
    /** toolCallId -> { name } */
    this.openToolCalls = new Map();
    /** every event type emitted so far, in order (handy for assertions) */
    this.history = [];
  }

  get isTerminal() {
    return this.state === RunState.FINISHED || this.state === RunState.FAILED;
  }

  get isRunning() {
    return this.state === RunState.RUNNING;
  }

  snapshot() {
    return {
      threadId: this.threadId,
      runId: this.runId,
      state: this.state,
      openMessages: [...this.openMessages.keys()],
      openToolCalls: [...this.openToolCalls.keys()],
      history: [...this.history],
    };
  }

  /* ---------- lifecycle ---------- */

  _emit(type, fields = {}) {
    const event = createEvent(type, { threadId: this.threadId, runId: this.runId, ...fields });
    this.history.push(type);
    this.emit(event);
    return event;
  }

  _assertRunning(action) {
    if (this.state === RunState.IDLE) {
      throw new ProtocolError(`${action} before RUN_STARTED`, "run_not_started");
    }
    if (this.isTerminal) {
      throw new ProtocolError(`${action} after ${this.history.at(-1)}`, "run_already_terminal");
    }
  }

  start() {
    if (this.state !== RunState.IDLE) {
      throw new ProtocolError("RUN_STARTED emitted twice", "run_already_started");
    }
    this.state = RunState.RUNNING;
    return this._emit(EventType.RUN_STARTED);
  }

  /** Close everything still open, then report RUN_FINISHED. */
  finish({ aborted = false } = {}) {
    this._assertRunning("RUN_FINISHED");
    this._closeOpen(aborted ? "aborted" : "run finished before this item closed");
    this.state = RunState.FINISHED;
    return this._emit(EventType.RUN_FINISHED, aborted ? { result: { aborted: true } } : {});
  }

  /** Close everything still open (as failed), then report RUN_ERROR. */
  fail({ message, code = "run_error" } = {}) {
    this._assertRunning("RUN_ERROR");
    const text = String(message || "run failed");
    this._closeOpen(`error: ${text}`);
    this.state = RunState.FAILED;
    return this._emit(EventType.RUN_ERROR, { message: text, code });
  }

  /* ---------- text messages ---------- */

  startTextMessage({ messageId }) {
    this._assertRunning("TEXT_MESSAGE_START");
    if (typeof messageId !== "string" || !messageId) {
      throw new ProtocolError("TEXT_MESSAGE_START requires a messageId", "missing_message_id");
    }
    if (this.openMessages.has(messageId)) return this; // idempotent for repeated starts
    if (this.closedMessages.has(messageId)) {
      throw new ProtocolError(`message ${messageId} already ended`, "message_already_ended");
    }
    // A single assistant turn owns one open text message. If Pi ever opens a
    // second one without closing the first, close it so the client never renders
    // two concurrent text streams.
    for (const openId of [...this.openMessages.keys()]) this.endTextMessage({ messageId: openId });
    this.openMessages.set(messageId, { chars: 0 });
    this._emit(EventType.TEXT_MESSAGE_START, { messageId, role: "assistant" });
    return this;
  }

  appendText({ messageId, delta }) {
    this._assertRunning("TEXT_MESSAGE_CONTENT");
    const open = this.openMessages.get(messageId);
    if (!open) {
      if (this.closedMessages.has(messageId)) {
        throw new ProtocolError(
          `TEXT_MESSAGE_CONTENT for ${messageId} after TEXT_MESSAGE_END`,
          "content_after_end",
        );
      }
      throw new ProtocolError(
        `TEXT_MESSAGE_CONTENT for ${messageId} before TEXT_MESSAGE_START`,
        "content_before_start",
      );
    }
    if (typeof delta !== "string") {
      throw new ProtocolError("TEXT_MESSAGE_CONTENT delta must be a string", "invalid_delta");
    }
    if (!delta) return this;
    open.chars += delta.length;
    this._emit(EventType.TEXT_MESSAGE_CONTENT, { messageId, delta });
    return this;
  }

  endTextMessage({ messageId }) {
    this._assertRunning("TEXT_MESSAGE_END");
    if (!this.openMessages.has(messageId)) return this; // nothing to close
    this.openMessages.delete(messageId);
    this.closedMessages.add(messageId);
    this._emit(EventType.TEXT_MESSAGE_END, { messageId });
    return this;
  }

  /* ---------- tool calls ---------- */

  startToolCall({ toolCallId, toolName, args }) {
    this._assertRunning("TOOL_CALL_START");
    if (typeof toolCallId !== "string" || !toolCallId) {
      throw new ProtocolError("TOOL_CALL_START requires a toolCallId", "missing_tool_call_id");
    }
    if (typeof toolName !== "string" || !toolName) {
      throw new ProtocolError("TOOL_CALL_START requires a toolCallName", "missing_tool_name");
    }
    if (this.openToolCalls.has(toolCallId)) {
      throw new ProtocolError(`tool call ${toolCallId} started twice`, "duplicate_tool_call");
    }
    this.openToolCalls.set(toolCallId, { name: toolName });
    this._emit(EventType.TOOL_CALL_START, { toolCallId, toolCallName: toolName });
    this._emit(EventType.TOOL_CALL_ARGS, { toolCallId, delta: JSON.stringify(args ?? {}) });
    return this;
  }

  /**
   * Streaming tool output is not part of the standard tool events; it is carried
   * as a CUSTOM event so standard consumers keep working. Pi's partialResult is a
   * cumulative snapshot, so this is sent as `content`, not a delta.
   */
  progressToolCall({ toolCallId, content }) {
    this._assertRunning("CUSTOM");
    if (!this.openToolCalls.has(toolCallId)) {
      throw new ProtocolError(`progress for unknown tool call ${toolCallId}`, "unknown_tool_call");
    }
    const snapshot = String(content ?? "").slice(0, 4000);
    if (!snapshot) return this;
    this._emit(EventType.CUSTOM, {
      name: "pi.tool_progress",
      value: { toolCallId, content: snapshot },
    });
    return this;
  }

  endToolCall({ toolCallId, content = "", isError = false }) {
    this._assertRunning("TOOL_CALL_END");
    if (!this.openToolCalls.has(toolCallId)) {
      throw new ProtocolError(
        `TOOL_CALL_END/TOOL_CALL_RESULT for unknown or already closed tool call ${toolCallId}`,
        "unknown_tool_call",
      );
    }
    this.openToolCalls.delete(toolCallId);
    // Order matters: END closes the call, RESULT is the message that carries the
    // payload. A result can never precede its END.
    this._emit(EventType.TOOL_CALL_END, { toolCallId });
    this._emit(EventType.TOOL_CALL_RESULT, {
      messageId: toolResultMessageId(toolCallId),
      toolCallId,
      content: toolResultContent(content, isError),
      role: "tool",
      // Extension: AG-UI has no error flag on tool results, but the workbench UI
      // needs to distinguish a failed tool from an empty successful one.
      isError: Boolean(isError),
    });
    return this;
  }

  /* ---------- teardown ---------- */

  /**
   * Balances the stream when a run ends abnormally. Text messages get their END;
   * tool calls get END + a synthetic RESULT (marked as an error) so a client is
   * never left waiting on a call that will not finish.
   */
  _closeOpen(reason) {
    for (const messageId of [...this.openMessages.keys()]) {
      this.openMessages.delete(messageId);
      this.closedMessages.add(messageId);
      this._emit(EventType.TEXT_MESSAGE_END, { messageId });
    }
    for (const toolCallId of [...this.openToolCalls.keys()]) {
      this.openToolCalls.delete(toolCallId);
      this._emit(EventType.TOOL_CALL_END, { toolCallId });
      this._emit(EventType.TOOL_CALL_RESULT, {
        messageId: toolResultMessageId(toolCallId),
        toolCallId,
        content: toolResultContent(reason, true),
        role: "tool",
        isError: true,
      });
    }
  }
}
