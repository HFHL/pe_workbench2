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
import { messageIdFromPi, newMessageId, newRunId } from "./ids.mjs";

const MAX_PROGRESS_CHARS = 4000;
const MAX_RESULT_CHARS = 20000;
const SETTLE_DELAY_MS = 0;

export class PiAgUiAdapter {
  constructor({ session, threadId, workspaceId, log }) {
    if (!session) throw new Error("PiAgUiAdapter requires a Pi session");
    if (!threadId) throw new Error("PiAgUiAdapter requires a threadId");
    if (!workspaceId) throw new Error("PiAgUiAdapter requires a workspaceId");
    if (!log) throw new Error("PiAgUiAdapter requires an event log");

    this.session = session;
    this.threadId = threadId;
    this.workspaceId = workspaceId;
    this.log = log;
    this.listeners = new Set();
    this.unsubscribe = null;

    /** @type {null | object} */
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
    this.clearSettleTimer(this.activeRun);
    if (!this.unsubscribe) return;
    try {
      this.unsubscribe();
    } catch {
      /* session already disposed */
    }
    this.unsubscribe = null;
  }

  clearSettleTimer(run) {
    if (!run?.settleTimer) return;
    clearTimeout(run.settleTimer);
    run.settleTimer = null;
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
      finishedMessages: new Set(),
      lastStopReason: null,
      errorMessage: null,
      promptError: null,
      aborted: false,
      abortRequested: false,
      settleTimer: null,
      persistenceFailure: null,
      terminalizing: false,
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
      run.promptError = error;
      this.failRun(run, error);
      return { threadId: this.threadId, runId: run.runId };
    }
    if (!pending || typeof pending.then !== "function") {
      // Defensive: an extension/input handler swallowed the prompt. Without a
      // promise nothing would ever settle, so fail the run here.
      run.promptError = new ProtocolError("Pi prompt did not start a run", "prompt_not_started");
      this.failRun(run, run.promptError);
      return { threadId: this.threadId, runId: run.runId };
    }
    Promise.resolve(pending).catch((error) => {
      run.promptError = error;
      this.failRun(run, error);
    });

    return { threadId: this.threadId, runId: run.runId };
  }

  /**
   * Abort the current run. Events are dropped as soon as abort is requested (no
   * more deltas reach the client), then the run is closed either by Pi's
   * agent_settled or by this method if the session does not emit one.
   */
  async abort() {
    const run = this.activeRun;
    if (!run || run.machine.isTerminal) return false;
    run.aborted = true;
    run.abortRequested = true;
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
    // Abort stops the stream immediately; only the settle event may still arrive.
    if (run.abortRequested && event?.type !== "agent_settled") return;

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
        run.pendingAssistant = { messageId };
        break;
      }

      case "message_update": {
        const update = event.assistantMessageEvent;
        if (!update || update.type !== "text_delta" || typeof update.delta !== "string") break;
        const messageId = this.messageIdFor(event.message, { create: true });
        if (run.finishedMessages.has(messageId)) break; // late delta after TEXT_MESSAGE_END
        if (!run.machine.openMessages.has(messageId)) run.machine.startTextMessage({ messageId });
        run.machine.appendText({ messageId, delta: update.delta });
        break;
      }

      case "message_end": {
        const message = event.message;
        if (message?.role !== "assistant") break;
        const messageId = this.messageIdFor(message, { create: true });
        if (run.finishedMessages.has(messageId)) break;
        run.lastStopReason = message.stopReason || null;
        // A retried run can end with several messages; only the last outcome counts.
        run.errorMessage =
          message.stopReason === "error"
            ? message.errorMessage || "assistant message ended with an error"
            : null;
        // Non-streamed text (restored or aborted partial message): emit it once.
        if (!run.machine.openMessages.has(messageId)) {
          const text = contentText(message.content);
          if (text) {
            run.machine.startTextMessage({ messageId });
            run.machine.appendText({ messageId, delta: text });
          }
        }
        if (run.machine.openMessages.has(messageId)) run.machine.endTextMessage({ messageId });
        run.finishedMessages.add(messageId);
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
        if (text) run.machine.progressToolCall({ toolCallId: event.toolCallId, content: text.slice(0, MAX_PROGRESS_CHARS) });
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
        // Pi emits agent_settled from a `finally` block, then lets a prompt()
        // rejection surface. Deferring one macrotask lets that rejection be
        // classified as RUN_ERROR instead of RUN_FINISHED.
        const settle = () => {
          run.settleTimer = null;
          if (run.machine.isTerminal) return;
          if (!aborted && run.promptError) {
            this.failRun(run, run.promptError);
            return;
          }
          if (!aborted && run.lastStopReason === "error") {
            this.failRun(run, new ProtocolError(run.errorMessage || "assistant message ended with an error", "assistant_error"));
            return;
          }
          this.finishRun(run, { aborted });
        };
        // agent_settled is emitted once per run; be defensive if it repeats.
        this.clearSettleTimer(run);
        run.settleTimer = setTimeout(settle, SETTLE_DELAY_MS);
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
    run.terminalizing = true;
    try {
      if (run.machine.state === "idle") {
        run.machine.start();
      }
      run.started = true;
      run.machine.finish({ aborted });
    } catch (error) {
      console.warn(`[ag-ui] could not finish run ${run.runId}: ${error.message}`);
    }
    this.releaseRun(run);
  }

  failRun(run, error) {
    if (!run || run.machine.isTerminal) return;
    run.terminalizing = true;
    try {
      if (run.machine.state === "idle") {
        run.machine.start();
      }
      run.started = true;
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
    this.clearSettleTimer(run);
    if (this.activeRun === run) this.activeRun = null;
  }

  /* ---------- emission ---------- */

  /**
   * Persist and fan out one event. After the first log failure the run becomes
   * live-only: later frames are not appended, because replaying a partial run
   * would violate the protocol ordering guarantees. A non-terminal failure is
   * rethrown once so handlePiEvent() can close the run with a volatile RUN_ERROR;
   * failures during terminal balancing are suppressed so the terminal frame is
   * always delivered to live subscribers.
   */
  record(run, event) {
    let record = null;
    let failure = null;
    if (run.persistenceFailure) {
      failure = run.persistenceFailure;
    } else {
      try {
        record = this.log.append({
          threadId: this.threadId,
          runId: run.runId,
          eventType: event.type,
          event,
        });
      } catch (error) {
        failure = error;
        run.persistenceFailure = error;
        console.warn(`[ag-ui] could not persist ${event.type} for run ${run.runId}: ${error.message}`);
      }
    }
    if (!record) {
      record = {
        eventId: null,
        workspaceId: this.workspaceId,
        threadId: this.threadId,
        runId: run.runId,
        sequence: null,
        ordinal: null,
        eventType: event.type,
        payload: event,
        createdAt: new Date().toISOString(),
        persisted: false,
      };
    }

    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch (error) {
        console.warn(`[ag-ui] subscriber failed: ${error.message}`);
      }
    }
    if (failure && !run.terminalizing) throw failure;
    return record;
  }

  messageIdFor(message, { create = false, allowPending = true } = {}) {
    if (message && typeof message === "object" && this.messageIds.has(message)) {
      return this.messageIds.get(message);
    }
    const pending = allowPending ? this.activeRun?.pendingAssistant : null;
    if (pending?.messageId) return pending.messageId;
    if (!create) throw new ProtocolError("no message id available", "missing_message_id");
    // Prefer a Pi-provided message id; today's AssistantMessage has none, so the
    // generated id is the normal path.
    const messageId = messageIdFromPi(message, newMessageId());
    if (message && typeof message === "object") this.messageIds.set(message, messageId);
    return messageId;
  }
}
