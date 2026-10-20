/**
 * AG-UI HTTP surface for one Pi agent.
 *
 * Endpoints (all project-scoped, same project resolution as the rest of /api):
 *   GET  /api/ag-ui/info                          runtime metadata
 *   POST /api/ag-ui/agent/pi/run                  start a run, stream SSE
 *   POST /api/ag-ui/agent/pi/connect              attach/replay a thread, SSE
 *   POST /api/ag-ui/agent/pi/stop/:threadId       abort the active run
 *
 * Frames use the standard SSE envelope with `id: <eventId>`; clients resume with
 * `Last-Event-ID` (header) or `afterEventId`. Replay is served
 * from the durable log, and the live subscription is opened *before* the replay
 * read, so the hand-off neither loses nor duplicates events.
 *
 * This module never mutates domain state and never writes session history.
 */

import path from "node:path";
import { EventType, TERMINAL_EVENT_TYPES, contentText } from "./ag-ui-events.mjs";

export const AG_UI_RUNTIME_VERSION = "1.0.0";
const MAX_REPLAY_EVENTS = 5000;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export function agUiInfo(ctx) {
  return {
    version: AG_UI_RUNTIME_VERSION,
    protocol: "ag-ui",
    projectId: ctx.id,
    defaultAgent: "pi",
    agents: [
      {
        name: "pi",
        description: "Pi AgentSession exposed as an AG-UI thread",
        threadIdSource: "pi-sessionId",
      },
    ],
    features: {
      sse: true,
      replay: true,
      lastEventId: true,
      afterEventId: true,
      attachments: true,
      projectIsolation: true,
    },
    endpoints: {
      run: "/api/ag-ui/agent/pi/run",
      connect: "/api/ag-ui/agent/pi/connect",
      stop: "/api/ag-ui/agent/pi/stop/:threadId",
    },
  };
}

/* ---------- input normalisation ---------- */

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeAttachments(ctx, items) {
  const root = path.resolve(ctx.root);
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (typeof item !== "string" || !item.trim()) continue;
    const relative = path.relative(root, path.resolve(root, item.trim()));
    if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const normalized = relative.split(path.sep).join("/");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= 50) break;
  }
  return out;
}

function promptFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message?.role !== "user") continue;
    return contentText(message.content).trim();
  }
  return "";
}

/**
 * Turn a CopilotKit-style body into the fields the adapter needs. `projectId`
 * and `attachments` are accepted either at the top level or inside
 * `forwardedProps`, which is where CopilotKit puts application state.
 */
export function normalizeRunInput(body, ctx) {
  const input = asObject(body);
  const forwarded = asObject(input.forwardedProps);

  const projectId = forwarded.projectId ?? input.projectId ?? null;
  if (projectId != null && String(projectId) !== ctx.id) {
    return { ok: false, status: 403, error: "project mismatch" };
  }

  const attachments = safeAttachments(ctx, [
    ...(Array.isArray(forwarded.attachments) ? forwarded.attachments : []),
    ...(Array.isArray(input.attachments) ? input.attachments : []),
  ]);

  const text =
    promptFromMessages(input.messages) ||
    String(forwarded.prompt ?? input.prompt ?? "").trim();

  let prompt = text;
  if (attachments.length) {
    const block = attachments.map((item) => `- ${item}`).join("\n");
    prompt = `${prompt || "看一下这几个文件。"}\n\n[已上传资料]\n${block}`;
  }
  if (!prompt.trim()) return { ok: false, status: 400, error: "empty message" };

  const rawThreadId = forwarded.threadId ?? input.threadId ?? "";
  const threadId = typeof rawThreadId === "string" ? rawThreadId.trim().slice(0, 200) : "";

  return { ok: true, threadId, prompt, attachments };
}

export function replayCursor({ body, url, headers }) {
  const input = asObject(body);
  const forwarded = asObject(input.forwardedProps);
  const eventId = String(
    headers?.["last-event-id"] ||
      url.searchParams.get("afterEventId") ||
      url.searchParams.get("lastEventId") ||
      input.afterEventId ||
      forwarded.afterEventId ||
      "",
  ).trim();
  return { afterEventId: eventId || null };
}

/* ---------- SSE ---------- */

/**
 * Replay missing events, then keep streaming live ones. The live subscription is
 * registered before the replay query; anything written concurrently is queued and
 * flushed after replay, filtered by the cursors, so each event is sent once.
 *
 * `isRunActive(runId)` reports whether a run is still emitting. The stream ends
 * after the terminal event, or immediately when the target run is already gone.
 */
export async function streamAgUiEvents({
  req,
  res,
  log,
  threadId,
  runId = null,
  afterEventId = null,
  afterSequence = 0,
  subscribe,
  isRunActive = () => false,
  pingMs = 15000,
  maxReplay = MAX_REPLAY_EVENTS,
}) {
  let afterOrdinal = 0;
  let runSequence = afterSequence;

  if (afterEventId) {
    const anchor = log.locate(afterEventId);
    if (anchor && anchor.threadId === threadId) {
      if (runId) {
        runSequence = anchor.runId === runId ? anchor.sequence : 0;
      } else {
        afterOrdinal = anchor.ordinal;
      }
    }
  }

  const seen = new Set();
  let lastOrdinal = afterOrdinal;
  let lastSequence = runSequence;
  let ended = false;
  let live = false;
  const queued = [];
  let ping = null;

  const write = (chunk) => {
    if (ended || res.writableEnded) return;
    try {
      res.write(chunk);
    } catch {
      ended = true;
    }
  };

  const end = () => {
    if (ended) return;
    ended = true;
    if (ping) clearInterval(ping);
    try {
      res.end();
    } catch {
      /* already closed */
    }
  };

  res.writeHead(200, SSE_HEADERS);
  write("retry: 2000\n\n");

  const acceptable = (record) => {
    if (!record || record.threadId !== threadId) return false;
    if (runId) {
      if (record.runId !== runId) return false;
      if (record.sequence <= runSequence) return false;
    } else if (record.ordinal <= lastOrdinal) {
      return false;
    }
    return !seen.has(record.eventId);
  };

  const send = (record) => {
    if (!acceptable(record)) return false;
    seen.add(record.eventId);
    if (runId) runSequence = Math.max(runSequence, record.sequence);
    else lastOrdinal = Math.max(lastOrdinal, record.ordinal);
    write(`id: ${record.eventId}\ndata: ${JSON.stringify(record.payload)}\n\n`);
    const terminal = TERMINAL_EVENT_TYPES.has(record.eventType);
    if (terminal) end();
    return terminal;
  };

  const unsubscribe = subscribe((record) => {
    if (!live) {
      queued.push(record);
      return;
    }
    send(record);
  });
  req.once("close", () => {
    ended = true;
    if (ping) clearInterval(ping);
    unsubscribe();
  });

  // Replay.
  let replay = [];
  try {
    replay = log.list({
      threadId,
      runId,
      afterSequence: runSequence,
      afterOrdinal,
      limit: maxReplay,
    });
  } catch (error) {
    write(`data: ${JSON.stringify({ type: EventType.RUN_ERROR, message: `replay failed: ${error.message}` })}\n\n`);
    end();
    unsubscribe();
    return;
  }

  let terminalSeen = false;
  let replayOrdinal = afterOrdinal;
  let replaySequence = runSequence;
  for (;;) {
    const batch = replay.length ? replay : log.list({
      threadId,
      runId,
      afterSequence: replaySequence,
      afterOrdinal: replayOrdinal,
      limit: maxReplay,
    });
    replay = [];
    if (!batch.length) break;
    for (const record of batch) {
      if (send(record)) {
        terminalSeen = true;
        break;
      }
    }
    const last = batch.at(-1);
    replayOrdinal = Math.max(replayOrdinal, last.ordinal);
    replaySequence = Math.max(replaySequence, last.sequence);
    if (terminalSeen || batch.length < maxReplay) break;
  }

  // Hand-off: drain everything queued while the replay query ran, still with
  // live=false so new events keep queueing in order. Node is single-threaded, so
  // nothing can arrive between the drain ending and live=true.
  while (!terminalSeen && queued.length) {
    if (send(queued.shift())) terminalSeen = true;
  }
  queued.length = 0;
  live = true;

  if (terminalSeen) {
    unsubscribe();
    return;
  }

  // Nothing live will arrive for a run that is already gone.
  if (runId) {
    if (!isRunActive(runId)) {
      unsubscribe();
      end();
      return;
    }
  } else if (!isRunActive()) {
    unsubscribe();
    end();
    return;
  }

  ping = setInterval(() => write(": ping\n\n"), pingMs);
  return;
}

function notFound(res, json) {
  json(res, 404, { error: "not found" });
}

/* ---------- router ---------- */

/**
 * @returns {Promise<boolean>} true when the request was handled here.
 */
export async function handleAgUiRequest(req, res, url, deps) {
  const { ctx, json, readJson, resolveThread, createThread } = deps;
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/ag-ui/")) return false;

  if (pathname === "/api/ag-ui/info" && req.method === "GET") {
    json(res, 200, agUiInfo(ctx));
    return true;
  }

  if (pathname === "/api/ag-ui/agent/pi/run" && req.method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    const input = normalizeRunInput(body, ctx);
    if (!input.ok) {
      json(res, input.status, { error: input.error });
      return true;
    }

    let entry;
    if (input.threadId) {
      entry = await resolveThread(input.threadId);
      if (!entry) {
        json(res, 404, { error: "thread not found" });
        return true;
      }
    } else {
      entry = await createThread();
    }
    if (!entry?.agui) {
      json(res, 500, { error: "agent protocol adapter is not attached to this session" });
      return true;
    }

    let started;
    try {
      started = await entry.agui.runPrompt(input.prompt);
    } catch (error) {
      const status = ["run_in_progress", "thread_busy"].includes(error?.code) ? 409 : 500;
      json(res, status, {
        error: error?.message || "could not start run",
        code: error?.code || "run_error",
        threadId: entry.id,
      });
      return true;
    }

    const cursor = replayCursor({ body, url, headers: req.headers });
    await streamAgUiEvents({
      req,
      res,
      log: ctx.agentEvents,
      threadId: entry.id,
      runId: started.runId,
      afterEventId: cursor.afterEventId,
      // A brand-new run has no cursor of its own; afterEventId is still honoured
      // when it points into this run (client reconnecting mid-run).
      afterSequence: 0,
      subscribe: (listener) => entry.agui.subscribeEvents(listener),
      isRunActive: (run) => entry.agui.isRunning && (!run || entry.agui.activeRunId === run),
    });
    return true;
  }

  if (pathname === "/api/ag-ui/agent/pi/connect" && req.method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    const input = asObject(body);
    const forwarded = asObject(input.forwardedProps);
    const threadId = String(
      input.threadId ?? forwarded.threadId ?? url.searchParams.get("threadId") ?? "",
    ).trim();
    if (!threadId) {
      json(res, 400, { error: "threadId is required" });
      return true;
    }
    const entry = await resolveThread(threadId);
    if (!entry?.agui) {
      json(res, 404, { error: "thread not found" });
      return true;
    }
    const cursor = replayCursor({ body, url, headers: req.headers });
    await streamAgUiEvents({
      req,
      res,
      log: ctx.agentEvents,
      threadId: entry.id,
      runId: null,
      afterEventId: cursor.afterEventId,
      afterSequence: 0,
      subscribe: (listener) => entry.agui.subscribeEvents(listener),
      isRunActive: (run) => entry.agui.isRunning && (!run || entry.agui.activeRunId === run),
    });
    return true;
  }

  const stopMatch = pathname.match(/^\/api\/ag-ui\/agent\/pi\/stop\/([^/]+)$/);
  if (stopMatch && req.method === "POST") {
    let threadId;
    try {
      threadId = decodeURIComponent(stopMatch[1]);
    } catch {
      json(res, 400, { error: "invalid thread id" });
      return true;
    }
    const entry = await resolveThread(threadId);
    if (!entry?.agui) {
      json(res, 404, { error: "thread not found" });
      return true;
    }
    const stopped = await entry.agui.abort();
    json(res, 200, { ok: true, threadId: entry.id, stopped });
    return true;
  }

  notFound(res, json);
  return true;
}
