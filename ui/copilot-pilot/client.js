/**
 * Isolated CopilotKit Headless Core client for one workbench session.
 *
 * Core owns the run lifecycle (connect/run/stop, AG-UI events, errors). The
 * workbench keeps Pi JSONL as conversation truth: after a run or a refresh the
 * canonical `/api/sessions/:id/state` snapshot is projected into the existing
 * renderer. There is no bidirectional sync with `state.messages`.
 */

import { CopilotKitCore } from "@copilotkit/core";

import { state } from "../state/store.js";
import { runtime } from "../runtime.js";
import { renderThread, scheduleThread } from "../chat/renderer.js";
import { toast } from "../shared/toast.js";
import { api } from "../api/client.js";
import { attachAgentSubscriptions, attachCoreSubscriptions } from "./subscriptions.js";
import {
  metricsSnapshot,
  newId,
  nowHM,
  parseArgs,
  resultText,
  toolDetail,
  toolStatusFromResult,
  userMessage,
} from "./message-adapter.js";

const AGENT_ID = "pi";
const CONNECT_TIMEOUT_MS = 10000;

function freshMetrics() {
  return {
    runStarted: 0,
    textStart: 0,
    textDelta: 0,
    textEnd: 0,
    toolStart: 0,
    toolArgs: 0,
    toolEnd: 0,
    toolResult: 0,
    runFinished: 0,
    runError: 0,
    runFailed: 0,
    runFinalized: 0,
    messagesChanged: 0,
    stateChanged: 0,
    frontendToolStart: 0,
    frontendToolEnd: 0,
    connects: 0,
    reconnects: 0,
    droppedConnections: 0,
    sendStartedAt: 0,
    firstTextAt: 0,
    completedAt: 0,
  };
}

function isAbortError(error) {
  return error?.name === "AbortError"
    || /abort|cancelled|canceled/i.test(String(error?.message || ""));
}

function isNetworkError(error) {
  return /network|failed to fetch|fetch failed|load failed|networkerror|internet disconnected/i
    .test(String(error?.message || error || ""));
}

export class CopilotPilotClient {
  constructor() {
    this.core = null;
    this.agent = null;
    this.projectId = null;
    this.sessionId = null;
    this.coreSubscription = null;
    this.agentSubscription = null;
    this.agentWait = null;
    this.corePromise = null;
    this.connectPromise = null;
    this.connectSessionId = null;
    this.connectToken = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.reconnectInFlight = false;
    this.runToken = null;
    this.runIdOnWire = null;
    this.activeRunId = null;
    this.finishedRunId = null;
    this.finalized = false;
    this.finalizePromise = null;
    this.acceptEvents = false;
    this.expectedAbort = false;
    this.awaitingReconnect = false;
    this.lastError = null;
    this.metrics = freshMetrics();
  }

  /* ---------- lifecycle ---------- */

  async ensureCore() {
    const projectId = state.project?.id;
    if (!projectId) throw new Error("项目尚未加载");
    if (this.core && this.agent && this.projectId === projectId) return this.agent;
    if (this.corePromise) return this.corePromise;
    this.corePromise = this.#createCore(projectId);
    try {
      return await this.corePromise;
    } finally {
      this.corePromise = null;
    }
  }

  async #createCore(projectId) {
    this.#disposeCore();
    this.projectId = projectId;
    const core = new CopilotKitCore({
      runtimeUrl: "/api/copilotkit",
      runtimeTransport: "rest",
      deferInitialConnection: true,
      headers: { "X-Project-Id": projectId },
      credentials: "same-origin",
      properties: { projectId },
      debug: false,
    });
    this.core = core;

    const agentPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.agentWait = null;
        reject(new Error("CopilotKit runtime did not publish the pi agent"));
      }, CONNECT_TIMEOUT_MS);
      this.agentWait = {
        resolve: (agent) => {
          clearTimeout(timer);
          this.agentWait = null;
          resolve(agent);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.agentWait = null;
          reject(error);
        },
      };
    });

    this.coreSubscription = attachCoreSubscriptions(core, {
      onConnectionStatus: (status) => {
        if (status === "error" && this.agentWait) {
          this.agentWait.reject(new Error("CopilotKit runtime connection failed"));
        }
      },
      onAgentsChanged: (agents) => {
        const agent = agents?.[AGENT_ID];
        if (agent && this.agentWait) this.agentWait.resolve(agent);
      },
      onToolExecutionStart: (event) => {
        this.metrics.frontendToolStart += 1;
        this.#upsertTool({
          id: event.toolCallId,
          name: event.toolName,
          detail: toolDetail(event.toolName, event.args),
          status: "running",
          output: "",
        });
      },
      onToolExecutionEnd: (event) => {
        this.metrics.frontendToolEnd += 1;
        this.#upsertTool({
          id: event.toolCallId,
          name: event.toolName,
          status: event.error ? "error" : "done",
          output: String(event.result || event.error || ""),
        });
      },
      onError: (error, code) => {
        this.lastError = `${code}: ${error?.message || error}`;
        if (this.agentWait) this.agentWait.reject(error instanceof Error ? error : new Error(String(error)));
        if (state.agentTransport === "copilotkit") toast(`CopilotKit：${error?.message || error}`);
      },
    });

    core.connect();
    const agent = await agentPromise;
    this.agent = agent;
    agent.threadId = this.sessionId || agent.threadId;
    this.agentSubscription = attachAgentSubscriptions(core, agent, this.#agentHandlers());
    return agent;
  }

  #agentHandlers() {
    return {
      onMessagesChanged: () => {
        this.metrics.messagesChanged += 1;
      },
      onStateChanged: () => {
        this.metrics.stateChanged += 1;
      },
      onRunInitialized: () => {
        if (!this.#isCurrent() || !this.acceptEvents) return;
        state.streaming = true;
        runtime.syncStop?.();
      },
      onRunStartedEvent: ({ event }) => {
        if (!this.#isCurrent() || !this.acceptEvents) return;
        if (this.connectActiveRunId && event.runId !== this.connectActiveRunId) return;
        this.activeRunId = event.runId;
        this.finishedRunId = null;
        this.reconnectAttempts = 0;
        this.metrics.runStarted += 1;
        this.metrics.sendStartedAt = this.metrics.sendStartedAt || performance.now();
        state.streaming = true;
        state.live = { text: "", tools: [], startedAt: Date.now() };
        runtime.syncStop?.();
        renderThread(true);
      },
      onTextMessageStartEvent: () => {
        if (!this.#acceptStreamEvent()) return;
        this.metrics.textStart += 1;
      },
      onTextMessageContentEvent: ({ event }) => {
        if (!this.#acceptStreamEvent()) return;
        this.metrics.textDelta += 1;
        if (!this.metrics.firstTextAt) this.metrics.firstTextAt = performance.now();
        state.live.text += event.delta || "";
        scheduleThread();
      },
      onTextMessageEndEvent: () => {
        if (!this.#acceptStreamEvent()) return;
        this.metrics.textEnd += 1;
      },
      onToolCallStartEvent: ({ event }) => {
        if (!this.#acceptStreamEvent()) return;
        this.metrics.toolStart += 1;
        this.#upsertTool({
          id: event.toolCallId,
          name: event.toolCallName,
          detail: "",
          status: "running",
          output: "",
        });
      },
      onToolCallArgsEvent: ({ event, partialToolCallArgs, toolCallBuffer }) => {
        if (!this.#acceptStreamEvent()) return;
        this.metrics.toolArgs += 1;
        const args = partialToolCallArgs && Object.keys(partialToolCallArgs).length
          ? partialToolCallArgs
          : parseArgs(toolCallBuffer);
        const tool = this.#findTool(event.toolCallId);
        if (!tool) return;
        tool.detail = toolDetail(tool.name, args);
        scheduleThread();
      },
      onToolCallEndEvent: ({ event }) => {
        if (!this.#acceptStreamEvent()) return;
        this.metrics.toolEnd += 1;
        const tool = this.#findTool(event.toolCallId);
        if (tool && tool.status === "running") tool.status = "done";
      },
      onToolCallResultEvent: ({ event }) => {
        if (!this.#acceptStreamEvent()) return;
        this.metrics.toolResult += 1;
        const content = resultText(event.content);
        this.#upsertTool({
          id: event.toolCallId,
          name: this.#findTool(event.toolCallId)?.name || "tool",
          status: toolStatusFromResult(content, event.isError),
          output: content,
        });
      },
      onRunFinishedEvent: ({ event }) => {
        if (!this.#isCurrent() || !this.acceptEvents) return;
        if (this.connectActiveRunId && event.runId !== this.connectActiveRunId) return;
        this.metrics.runFinished += 1;
        this.finalizePromise = this.#finishRun(event.runId, null);
      },
      onRunErrorEvent: ({ event }) => {
        if (!this.#isCurrent() || !this.acceptEvents) return;
        if (this.connectActiveRunId && event.runId !== this.connectActiveRunId) return;
        this.metrics.runError += 1;
        this.finalizePromise = this.#finishRun(event.runId, new Error(event.message || "运行失败"));
      },
      onRunFailed: ({ error, input }) => {
        if (!this.#isCurrent() || !this.acceptEvents || this.finalized) return;
        // Core's subscriber params carry the run input. Ignore a delayed
        // failure from a previous send once a new run has started.
        if (this.runIdOnWire && input?.runId && input.runId !== this.runIdOnWire) return;
        this.metrics.runFailed += 1;
        if (this.expectedAbort || isAbortError(error)) return;
        if (isNetworkError(error)) {
          // Keep the run visible and let the automatic reconnect replay it.
          // Stopping the server here would turn a transport drop into data loss.
          this.awaitingReconnect = true;
          this.#scheduleReconnect();
          return;
        }
        this.finalizePromise = this.#finishRun(this.activeRunId, error);
      },
      onRunFinalized: () => {
        if (!this.#isCurrent()) return;
        this.metrics.runFinalized += 1;
        // During a thread replay onRunFinalized has no runId and fires for
        // every historical run. The run-scoped onRunFinishedEvent above is the
        // only safe terminal signal for the active run.
        if (this.connectActiveRunId) return;
        if (!this.finalized && this.acceptEvents) {
          this.finalizePromise = this.#finishRun(this.activeRunId, null);
        }
      },
    };
  }

  /* ---------- session transport ---------- */

  async connect(sessionId) {
    if (!sessionId) return null;
    if (this.connectPromise && this.connectSessionId === sessionId) return this.connectPromise;
    this.connectSessionId = sessionId;
    const promise = this.#connect(sessionId);
    this.connectPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.connectPromise === promise) {
        this.connectPromise = null;
        this.connectSessionId = null;
      }
    }
  }

  #isConnectCurrent(token, sessionId) {
    return this.connectToken === token
      && this.sessionId === sessionId
      && this.projectId === state.project?.id;
  }

  async #connect(sessionId) {
    this.sessionId = sessionId;
    const token = Symbol("connect-session");
    this.connectToken = token;
    const agent = await this.ensureCore();
    if (!this.#isConnectCurrent(token, sessionId)) return;

    this.acceptEvents = false;
    this.expectedAbort = true;
    try {
      await agent.detachActiveRun();
    } catch {
      /* no stream to detach */
    }
    this.expectedAbort = false;
    if (!this.#isConnectCurrent(token, sessionId)) return;
    this.activeRunId = null;
    this.finishedRunId = null;
    this.finalized = false;
    this.connectActiveRunId = null;
    this.finalizePromise = null;
    this.runToken = Symbol("connect");
    this.runIdOnWire = null;
    agent.threadId = sessionId;
    agent.setMessages([]);
    this.core.setProperties({ projectId: this.projectId, threadId: sessionId });

    // Canonical Pi snapshot supplies history and structured tool cards. The
    // pilot never asks Core to own or persist conversation history.
    await runtime.refreshSnapshot?.({
      watch: false,
      preserveLive: false,
      guard: () => this.#isConnectCurrent(token, sessionId),
    });
    if (!this.#isConnectCurrent(token, sessionId)) return;

    if (!state.streaming) {
      this.#resetReconnect();
      return;
    }

    // A thread replay contains every historical run. Only the run reported as
    // active by the server is allowed to drive the live UI; otherwise the first
    // historical RUN_FINISHED would end the current run on the client.
    let cursorError = null;
    try {
      const cursor = await api(`/api/copilotkit/thread/${encodeURIComponent(sessionId)}/state`);
      this.connectActiveRunId = cursor?.activeRunId || null;
    } catch (error) {
      cursorError = error;
      this.connectActiveRunId = null;
    }
    if (!this.#isConnectCurrent(token, sessionId)) return;
    if (!this.connectActiveRunId) {
      this.acceptEvents = false;
      if (cursorError && isNetworkError(cursorError)) {
        this.awaitingReconnect = true;
        this.#scheduleReconnect();
        return;
      }
      state.streaming = false;
      runtime.syncStop?.();
      toast("无法定位当前运行，已停止客户端重连");
      return;
    }

    this.acceptEvents = true;
    this.metrics.connects += 1;
    this.metrics.reconnects += 1;
    this.metrics.sendStartedAt = performance.now();
    this.metrics.firstTextAt = 0;
    this.metrics.completedAt = 0;
    const streamToken = this.runToken;
    if (!this.#isConnectCurrent(token, sessionId)) return;
    const stream = this.core.connectAgent({ agent });
    void stream
      .then(() => {
        if (streamToken === this.runToken && state.streaming && !this.finalized && !this.expectedAbort) {
          this.finalizePromise = this.#finishRun(this.activeRunId, new Error("CopilotKit 连接已结束"));
        }
      })
      .catch((error) => {
        if (streamToken !== this.runToken || this.expectedAbort) return;
        if (isAbortError(error)) return;
        if (isNetworkError(error)) {
          this.awaitingReconnect = true;
          this.#scheduleReconnect();
          return;
        }
        this.finalizePromise = this.#finishRun(this.activeRunId, error);
      });
  }

  async send({ text, attachments = [] } = {}) {
    const sessionId = state.activeSession;
    if (!sessionId) throw new Error("还没有会话");
    if (this.connectPromise) await this.connectPromise;
    if (state.streaming) throw new Error("当前回复尚未结束");
    if (this.awaitingReconnect) throw new Error("连接中断，正在重连");
    if (this.sessionId !== sessionId || this.projectId !== state.project?.id) {
      await this.connect(sessionId);
    }
    if (state.streaming) throw new Error("当前回复尚未结束");
    if (this.awaitingReconnect) throw new Error("连接中断，正在重连");
    const agent = await this.ensureCore();
    if (this.sessionId !== sessionId || state.streaming || state.project?.id !== this.projectId) {
      throw new Error("会话状态已变化，请重试");
    }
    if (this.sessionId !== sessionId) this.sessionId = sessionId;
    this.connectToken = Symbol("run");
    this.#resetReconnect();

    const message = userMessage(text);
    agent.threadId = sessionId;
    agent.setMessages([message]);
    this.core.setProperties({ projectId: this.projectId, threadId: sessionId });
    this.lastError = null;
    this.expectedAbort = false;
    this.awaitingReconnect = false;
    this.activeRunId = null;
    this.finishedRunId = null;
    this.finalized = false;
    this.connectActiveRunId = null;
    this.finalizePromise = null;
    this.runToken = Symbol("run");
    this.runIdOnWire = newId();
    this.acceptEvents = true;
    this.metrics.sendStartedAt = performance.now();
    this.metrics.firstTextAt = 0;
    this.metrics.completedAt = 0;
    state.streaming = true;
    state.live = { text: "", tools: [], startedAt: Date.now() };
    runtime.syncStop?.();
    renderThread(true);

    const token = this.runToken;
    try {
      await this.core.runAgent({
        agent,
        runId: this.runIdOnWire,
        forwardedProps: {
          projectId: this.projectId,
          attachments: Array.isArray(attachments) ? attachments : [],
        },
      });
    } catch (error) {
      if (token !== this.runToken) return;
      if (this.expectedAbort || isAbortError(error)) return;
      this.lastError = error?.message || String(error);
      if (isNetworkError(error)) {
        this.awaitingReconnect = true;
        this.#scheduleReconnect();
        return;
      }
      if (!this.finishedRunId) this.finalizePromise = this.#finishRun(this.activeRunId, error);
    } finally {
      if (!this.awaitingReconnect) {
        if (token === this.runToken && !this.finishedRunId && !this.expectedAbort) {
          this.finalizePromise = this.#finishRun(this.activeRunId, this.lastError ? new Error(this.lastError) : null);
        }
        if (this.finalizePromise) await this.finalizePromise;
      }
    }
  }

  async stop() {
    if (!this.sessionId) return;
    this.#resetReconnect();
    this.expectedAbort = true;
    this.runToken = Symbol("stop");
    this.acceptEvents = false;
    try {
      if (this.core && this.agent) this.core.stopAgent({ agent: this.agent });
    } catch {
      /* the run may already be gone */
    }
    // Core's stop is fire-and-forget; make the server-side stop observable so
    // a failed stop is not reported as a successful one.
    try {
      await api(`/api/copilotkit/agent/pi/stop/${encodeURIComponent(this.sessionId)}`, { method: "POST" });
    } catch (error) {
      this.expectedAbort = false;
      toast(`停止失败：${error?.message || error}`);
      this.finalizePromise = this.#finishRun(this.activeRunId, null);
      await this.finalizePromise;
      return;
    }
    this.finalizePromise = this.#finishRun(this.activeRunId, null);
    await this.finalizePromise;
    if (this.expectedAbort) {
      // The server abort and the final snapshot can race by a few ms. The user
      // pressed stop, so the UI must not stay in a running state.
      this.awaitingReconnect = false;
      state.streaming = false;
      runtime.syncStop?.();
      renderThread(true);
    }
  }

  async reconnect(options = {}) {
    if (this.reconnectInFlight) return;
    this.reconnectInFlight = true;
    try {
      return await this.#reconnect(options);
    } finally {
      this.reconnectInFlight = false;
    }
  }

  async #reconnect({ auto = false } = {}) {
    if (!this.core || !this.agent || !this.sessionId) return;
    if (!auto) this.#resetReconnect();
    this.#clearReconnectTimer();
    // Close the browser stream without calling Core's stop endpoint: the Pi
    // run must keep going on the server for replay to recover anything.
    this.acceptEvents = false;
    this.expectedAbort = true;
    try {
      await this.agent.detachActiveRun();
    } catch {
      /* no stream to detach */
    }
    this.expectedAbort = false;
    let cursor = null;
    let cursorError = null;
    try {
      cursor = await api(`/api/copilotkit/thread/${encodeURIComponent(this.sessionId)}/state`);
    } catch (error) {
      cursorError = error;
      cursor = null;
    }
    this.metrics.reconnects += 1;
    this.expectedAbort = false;
    this.finishedRunId = null;
    this.finalized = false;
    this.activeRunId = null;
    this.connectActiveRunId = cursor?.activeRunId || null;
    this.finalizePromise = null;
    if (!this.connectActiveRunId) {
      this.acceptEvents = false;
      if (cursorError && isNetworkError(cursorError)) {
        this.awaitingReconnect = true;
        this.#scheduleReconnect();
        return;
      }
      await runtime.refreshSnapshot?.({ watch: false, forceStopped: true, preserveLive: false });
      this.#resetReconnect();
      return;
    }
    this.acceptEvents = true;
    this.awaitingReconnect = false;
    this.reconnectAttempts = 0;
    const token = Symbol("reconnect");
    this.runToken = token;
    const stream = this.core.connectAgent({ agent: this.agent });
    void stream
      .then(() => {
        if (token === this.runToken && state.streaming && !this.finalized) {
          this.finalizePromise = this.#finishRun(this.activeRunId, new Error("CopilotKit 连接已结束"));
        }
      })
      .catch((error) => {
        if (token !== this.runToken) return;
        if (isAbortError(error)) return;
        if (isNetworkError(error)) {
          this.awaitingReconnect = true;
          this.#scheduleReconnect();
          return;
        }
        this.finalizePromise = this.#finishRun(this.activeRunId, error);
      });
    await this.finalizePromise;
  }

  /** Stop the browser run but leave the Pi session available for reconnect. */
  disconnect() {
    this.#resetReconnect();
    this.expectedAbort = true;
    this.awaitingReconnect = false;
    this.runToken = Symbol("disconnect");
    this.acceptEvents = false;
    this.activeRunId = null;
    this.finishedRunId = null;
    this.finalized = false;
    this.runIdOnWire = null;
    this.connectActiveRunId = null;
    this.sessionId = null;
    this.finalizePromise = null;
    try {
      void this.agent?.detachActiveRun().catch(() => {});
    } catch {
      /* already stopped */
    }
    state.streaming = false;
    runtime.syncStop?.();
  }

  resetForProject() {
    this.disconnect();
    this.#disposeCore();
    this.projectId = null;
    this.metrics = freshMetrics();
  }

  snapshotMetrics() {
    return metricsSnapshot(this.metrics);
  }

  /** Browser offline/online are production callers for reconnect. */
  handleOffline() {
    if (!state.streaming || !this.sessionId) return;
    this.awaitingReconnect = true;
    toast("网络已断开，恢复后自动重连…");
  }

  handleOnline() {
    if (!this.sessionId || (!state.streaming && !this.awaitingReconnect)) return;
    void this.reconnect({ auto: true });
  }

  /* ---------- internals ---------- */

  async #abandonRun(error) {
    if (!this.sessionId || !this.#isCurrent()) return;
    try {
      await api(`/api/copilotkit/agent/pi/stop/${encodeURIComponent(this.sessionId)}`, { method: "POST" });
    } catch {
      /* the final snapshot is still the best available reconciliation */
    }
    this.finalizePromise = this.#finishRun(this.activeRunId, error);
  }

  #clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  #resetReconnect() {
    this.#clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.awaitingReconnect = false;
  }

  #scheduleReconnect() {
    if (this.reconnectTimer || !this.sessionId || !state.streaming) return;
    if (this.reconnectAttempts >= 5) {
      this.awaitingReconnect = false;
      void this.#abandonRun(new Error("CopilotKit 重连失败"));
      return;
    }
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 8000);
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts === 1) toast("连接中断，正在重连…");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.awaitingReconnect || !this.#isCurrent() || !state.streaming) return;
      void this.reconnect({ auto: true });
    }, delay);
  }

  #isCurrent() {
    return Boolean(
      this.sessionId
      && this.projectId
      && state.project?.id === this.projectId
      && state.activeSession === this.sessionId,
    );
  }

  #acceptStreamEvent() {
    if (!this.#isCurrent() || !this.acceptEvents || !this.activeRunId) return false;
    if (this.connectActiveRunId && this.activeRunId !== this.connectActiveRunId) return false;
    return true;
  }

  #upsertTool(patch) {
    if (!this.#isCurrent() || !this.acceptEvents) return;
    const tools = state.live.tools;
    const existing = tools.find((tool) => tool.id === patch.id);
    if (existing) Object.assign(existing, patch);
    else tools.push({ status: "running", output: "", detail: "", ...patch });
    scheduleThread();
  }

  #findTool(id) {
    return state.live.tools.find((tool) => tool.id === id) || null;
  }

  async #finishRun(runId, error) {
    if (this.finalized) return;
    if (runId && this.activeRunId && runId !== this.activeRunId) return;
    if (this.finishedRunId && (!runId || this.finishedRunId === runId)) return;
    this.finalized = true;
    if (runId) this.finishedRunId = runId;
    else if (this.activeRunId) this.finishedRunId = this.activeRunId;
    this.metrics.completedAt = performance.now();
    this.runIdOnWire = null;
    this.#resetReconnect();
    this.acceptEvents = false;
    this.activeRunId = null;
    state.streaming = false;
    runtime.syncStop?.();
    renderThread(true);
    if (error) {
      this.lastError = error.message || String(error);
      toast(`运行失败：${this.lastError}`);
    }
    const token = this.runToken;
    try {
      await runtime.refreshSnapshot?.({
        watch: false,
        forceStopped: true,
        preserveLive: false,
        throwOnError: true,
        guard: () => this.runToken === token,
      });
    } catch {
      if (this.runToken === token) this.#commitLive();
    }
  }

  #commitLive() {
    if (!this.#isCurrent()) return;
    const live = state.live;
    if (!live.text && !live.tools.length) return;
    state.messages.push({
      role: "assistant",
      text: live.text,
      tools: live.tools.map((tool) => ({ ...tool })),
      time: nowHM(),
    });
    state.live = { text: "", tools: [], startedAt: 0 };
    renderThread(true);
  }

  #disposeCore() {
    try {
      this.agentSubscription?.unsubscribe();
    } catch {
      /* already gone */
    }
    this.agentSubscription = null;
    try {
      void this.agent?.detachActiveRun().catch(() => {});
    } catch {
      /* no active run */
    }
    try {
      this.coreSubscription?.unsubscribe();
    } catch {
      /* already gone */
    }
    this.coreSubscription = null;
    try {
      this.core?.setRuntimeUrl(undefined);
    } catch {
      /* already disconnected */
    }
    this.core = null;
    this.agent = null;
    this.agentWait?.reject?.(new Error("CopilotKit runtime disposed"));
    this.agentWait = null;
  }
}
