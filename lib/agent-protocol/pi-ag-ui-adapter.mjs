/**
 * PiAgUiAdapter — Pi AgentSession events → AG-UI protocol events.
 *
 * It is a *transport* adapter: it never writes session history, never changes
 * tool behaviour and never touches the workbench domain stores. Pi's JSONL stays
 * the conversation source of truth; this layer only assigns protocol ids,
 * enforces the run state machine and appends to the replay log.
 *
 * One adapter belongs to one thread (= one Pi session). A thread can have at most
 * one active run; `agent_settled` (or `abort`) closes it.
 */

import { contentText, toolResultText } from "./ag-ui-events.mjs";
import { RunStateMachine, ProtocolError } from "./run-state-machine.mjs";
import { newMessageId, newRunId } from "./ids.mjs";

const MAX_PROGRESS_CHARS = 4000;
const MAX_RESULT_CHARS = 20000;

export class PiAgUiAdapter {
  constructor({ session, threadId, workspaceId, log, onEvent = null }) {
    if (!session) throw new Error("PiAgUiAdapter requires a Pi session");
    if (!threadId) throw new Error("PiAgUiAdapter requires a threadId");
    if (!workspaceId) throw new Error("PiAgUiAdapter requires a workspaceId");
    if (!log) throw new Error("PiAgUiAdapter requires an event log");

    this.session = session;
    this.threadId = threadId;
    this.workspaceId = workspaceId;
    this.log = log;
    this.onEvent = onEvent;
    this.listeners = new Set();
    this.unsubscribe = null;

    /** @type {null | {runId: string, machine: RunStateMachine, started: boolean, pendingAssistant: null | {messageId: string, sawDelta: boolean}, lastStopReason: string|null, errorMessage: string|null, aborted: boolean}} */
    this.activeRun = null;
    this.messageIds = new WeakMap();
  }

  /* ---------- lifecycle ---------- */

  attach() {
    if (this.unsubscribe) return this;
    this.unsubscribe = this.session.subscribe((event) => this.handlePiEvent(event));
    return this;
  }

  detach() {
    if (!this.unsubscribe) return;
    try {
      this.unsubscribe();
    } catch {
      /* session already disposed */
    }
    this.unsubscribe = null;
  }

  /**
   * True from the moment runPrompt() registers a run until it reaches a terminal
   * event. Pi emits agent_start asynchronously, so a run is "active" while its
   * state machine is still idle; checking machine.isRunning alone would let an
   * SSE attach close the stream in the gap before agent_start.
   */
  get isRunning() {
    return Boolean(this.activeRun && !this.activeRun.machine.isTerminal);
  }

  /** Id of the run currently emitting, or null. Used by SSE attach logic. */
  get activeRunId() {
    return this.activeRun?.runId ?? null;
  }

  /** Live fan-out for SSE clients. Returns an unsubscribe function. */
  subscribeEvents(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Start a run. The run id exists before the prompt so a client can correlate
   * the request, but RUN_STARTED is emitted when Pi reports agent_start (or
   * immediately before RUN_ERROR if the prompt fails first).
   *
   * Rejects with code `run_in_progress` / `thread_busy` when the thread already
   * has an active run; the HTTP layer maps that to 409.
   */
  async runPrompt(promptText, { images } = {}) {
    if (this.isRunning) {
      throw new ProtocolError("a run is already active on this thread", "run_in_progress");
    }
    if (this.session.isStreaming) {
      throw new ProtocolError("Pi session is already streaming", "thread_busy");
    }
    this.attach();

    const run = {
      runId: newRunId(),
      machine: null,
      started: false,
      pendingAssistant: null,
      lastStopReason: null,
      errorMessage: null,
      aborted: false,
    };
    run.machine = new RunStateMachine({
      threadId: this.threadId,
      runId: run.runId,
      emit: (event) => this.record(run, event),
    });
    this.activeRun = run;

    const options = {};
    if (Array.isArray(images) && images.length) options.images = images;

    let pending;
    try {
      pending = this.session.prompt(promptText, options);
    } catch (error) {
      // Emit RUN_STARTED + RUN_ERROR instead of failing the HTTP request: the
      // client can consume the same SSE stream it asked for.
      this.failRun(run, error);
      return { threadId: this.threadId, runId: run.runId };
    }
    Promise.resolve(pending).catch((error) => this.failRun(run, error));

    return { threadId: this.threadId, runId: run.runId };
  }

  /**
   * Abort the current run. Pi emits agent_settled(aborted) which closes the run;
   * if it does not, close it here so no further deltas reach the client.
   */
  async abort() {
    const run = this.activeRun;
    if (!run || run.machine.isTerminal) return false;
    run.aborted = true;
    try {
      await this.session.abort();
    } catch {
      /* nothing to abort or session already settled */
    }
    if (!run.machine.isTerminal) this.finishRun(run, { aborted: true });
    return true;
  }

  /* ---------- Pi event handling ---------- */

  handlePiEvent(event) {
    const run = this.activeRun;
    if (!run || run.machine.isTerminal) return; // late events after a terminal event are dropped
    try {
      this.dispatch(run, event);
    } catch (error) {
      // An adapter bug is an abnormal end of the run, not a crash of the server.
      this.failRun(run, error);
    }
  }

  dispatch(run, event) {
    switch (event?.type) {
      case "agent_start": {
        if (!run.started) {
          run.machine.start();
          run.started = true;
        }
        break;
      }

      case "message_start": {
        if (event.message?.role !== "assistant") break;
        const messageId = this.messageIdFor(event.message, { create: true, allowPending: false });
        run.pendingAssistant = { messageId, sawDelta: false };
        break;
      }

      case "message_update": {
        const update = event.assistantMessageEvent;
        if (!update || update.type !== "text_delta" || typeof update.delta !== "string") break;
        const messageId = this.messageIdFor(event.message, { create: true });
        if (!run.machine.openMessages.has(messageId)) run.machine.startTextMessage({ messageId });
        run.machine.appendText({ messageId, delta: update.delta });
        if (run.pendingAssistant?.messageId === messageId) run.pendingAssistant.sawDelta = true;
        break;
      }

      case "message_end": {
        const message = event.message;
        if (message?.role !== "assistant") break;
        run.lastStopReason = message.stopReason || null;
        // A retried run can end with several messages; only the last outcome counts.
        run.errorMessage =
          message.stopReason === "error"
            ? message.errorMessage || "assistant message ended with an error"
            : null;
        const messageId = this.messageIdFor(message, { create: true });
        // Non-streamed text (restored or aborted partial message): emit it once.
        if (!run.machine.openMessages.has(messageId)) {
          const text = contentText(message.content);
          if (text) {
            run.machine.startTextMessage({ messageId });
            run.machine.appendText({ messageId, delta: text });
          }
        }
        if (run.machine.openMessages.has(messageId)) run.machine.endTextMessage({ messageId });
        if (run.pendingAssistant?.messageId === messageId) run.pendingAssistant = null;
        break;
      }

      case "tool_execution_start": {
        run.machine.startToolCall({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;
      }

      case "tool_execution_update": {
        const text = toolResultText(event.partialResult);
        if (text) run.machine.progressToolCall({ toolCallId: event.toolCallId, text: text.slice(0, MAX_PROGRESS_CHARS) });
        break;
      }

      case "tool_execution_end": {
        run.machine.endToolCall({
          toolCallId: event.toolCallId,
          content: toolResultText(event.result).slice(0, MAX_RESULT_CHARS),
          isError: Boolean(event.isError),
        });
        break;
      }

      case "agent_settled": {
        const aborted = Boolean(event.aborted) || run.aborted || run.lastStopReason === "aborted";
        if (!aborted && run.errorMessage) {
          this.failRun(run, new ProtocolError(run.errorMessage, "assistant_error"));
        } else {
          this.finishRun(run, { aborted });
        }
        break;
      }

      default:
        // turn_*, agent_end, compaction_*, queue_update, ... are not part of the
        // AG-UI lifecycle; they stay available on the legacy SSE stream.
        break;
    }
  }

  finishRun(run, { aborted = false } = {}) {
    if (!run || run.machine.isTerminal) return;
    try {
      if (!run.started) {
        run.machine.start();
        run.started = true;
      }
      run.machine.finish({ aborted });
    } catch (error) {
      console.warn(`[ag-ui] could not finish run ${run.runId}: ${error.message}`);
    }
    this.releaseRun(run);
  }

  failRun(run, error) {
    if (!run || run.machine.isTerminal) return;
    try {
      if (!run.started) {
        run.machine.start();
        run.started = true;
      }
      run.machine.fail({
        message: error?.message || String(error),
        code: error?.code || "run_error",
      });
    } catch (inner) {
      console.warn(`[ag-ui] could not fail run ${run.runId}: ${inner.message}`);
    }
    this.releaseRun(run);
  }

  releaseRun(run) {
    if (this.activeRun === run) this.activeRun = null;
  }

  /* ---------- emission ---------- */

  record(run, event) {
    const record = this.log.append({
      threadId: this.threadId,
      runId: run.runId,
      eventType: event.type,
      event,
    });
    if (this.onEvent) {
      try {
        this.onEvent(record);
      } catch (error) {
        console.warn(`[ag-ui] onEvent listener failed: ${error.message}`);
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch (error) {
        console.warn(`[ag-ui] subscriber failed: ${error.message}`);
      }
    }
    return record;
  }

  messageIdFor(message, { create = false, allowPending = true } = {}) {
    if (message && typeof message === "object" && this.messageIds.has(message)) {
      return this.messageIds.get(message);
    }
    const pending = allowPending ? this.activeRun?.pendingAssistant : null;
    if (pending?.messageId) return pending.messageId;
    if (!create) throw new ProtocolError("no message id available", "missing_message_id");
    const messageId = newMessageId();
    if (message && typeof message === "object") this.messageIds.set(message, messageId);
    return messageId;
  }
}
