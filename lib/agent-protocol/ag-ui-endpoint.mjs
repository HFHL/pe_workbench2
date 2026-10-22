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
 * `Last-Event-ID` (header) or `afterEventId`. Replay is served from the durable
 * log, and the live subscription is opened *before* the replay read, so the
 * hand-off neither loses nor duplicates events.
 *
 * This module never mutates domain state and never writes session history.
 */

import fs from "node:fs";
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

function isInside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Attachments must be regular files that really live inside the project root.
 * Symlinks are resolved first, so a link pointing outside is rejected even
 * though its lexical path looks local. Missing files are dropped as well.
 */
export function safeAttachments(ctx, items) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(path.resolve(ctx.root));
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (typeof item !== "string" || !item.trim()) continue;
    // Resolve first, then check containment: this rejects `..` traversal, missing
    // files and symlinks that point outside, and still accepts an absolute path
    // that resolves inside the project (e.g. a symlinked temp root).
    const candidate = path.isAbsolute(item.trim())
      ? path.resolve(item.trim())
      : path.resolve(realRoot, item.trim());
    let real;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue; // missing attachment
    }
    if (!isInside(realRoot, real)) continue;
    let stat;
    try {
      stat = fs.statSync(real);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const relative = path.relative(realRoot, real).split(path.sep).join("/");
    if (!relative || seen.has(relative)) continue;
    seen.add(relative);
    out.push(relative);
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

function projectIdOf(input) {
  const forwarded = asObject(input.forwardedProps);
  return forwarded.projectId ?? input.projectId ?? null;
}

/**
 * Turn a CopilotKit-style body into the fields the adapter needs. `projectId`
 * and `attachments` are accepted either at the top level or inside
 * `forwardedProps`, which is where CopilotKit puts application state.
 */
export function normalizeRunInput(body, ctx) {
  const input = asObject(body);
  const forwarded = asObject(input.forwardedProps);

  const projectId = projectIdOf(input);
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

/** Read a JSON body while keeping 413 and turning parse errors into 400. */
async function readBodyJson(req, readJson) {
  try {
    const body = await readJson(req);
    return asObject(body);
  } catch (error) {
    if (error?.status === 413) throw error;
    if (error instanceof SyntaxError) {
      throw Object.assign(new Error("invalid JSON body"), { status: 400 });
    }
    throw error; // unexpected I/O failure keeps its own status (500 by default)
  }
}

export { readBodyJson };

/* ---------- SSE ---------- */

/**
 * Replay missing events, then keep streaming live ones. The live subscription is
 * registered before the replay query; anything written concurrently is queued and
 * flushed after replay, filtered by the cursors, so each event is sent once.
 *
 * When `runId` is set the stream belongs to one run and closes on that run's
 * terminal event. Without `runId` (connect) it replays the whole thread — past
 * runs included — and only closes when no run is active and the replay is done;
 * a live terminal closes it only once no other run is active.
 *
 * `isRunActive(runId?)` reports whether a run is still emitting.
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
  let suppressReplay = false;

  if (afterEventId) {
    const anchor = log.locate(afterEventId);
    if (anchor && anchor.threadId === threadId) {
      if (runId) {
        runSequence = anchor.runId === runId ? anchor.sequence : 0;
      } else {
        afterOrdinal = anchor.ordinal;
      }
    } else {
      // A deleted/quarantined event cannot be used as an ordering cursor. Starting
      // again at zero would duplicate the entire thread, so require the caller to
      // reconnect without that stale cursor when it wants a full replay.
      suppressReplay = true;
    }
  }

  const seen = new Set();
  let lastOrdinal = afterOrdinal;
  let lastSequence = runSequence;
  let ended = false;
  let live = false;
  let ping = null;
  let unsubscribe = () => {};
  const queued = [];
  const terminalCache = new Map();

  const write = (chunk) => {
    if (ended || res.writableEnded) return;
    try {
      res.write(chunk);
    } catch {
      closeStream();
    }
  };

  /**
   * Single teardown path: stop the heartbeat, drop the live subscription and end
   * the response. Called on the terminal event, on replay failure, and when the
   * client goes away (ServerResponse 'close').
   */
  const closeStream = () => {
    if (ended) return;
    ended = true;
    if (ping) {
      clearInterval(ping);
      ping = null;
    }
    try {
      unsubscribe();
    } catch {
      /* already gone */
    }
    if (typeof req.off === "function") req.off("aborted", closeStream);
    else req.removeListener?.("aborted", closeStream);
    try {
      if (!res.writableEnded) res.end();
    } catch {
      /* already gone */
    }
  };

  const acceptable = (record) => {
    if (!record || record.threadId !== threadId) return false;
    if (runId && record.runId !== runId) return false;
    // A frame whose log write failed has no cursor (eventId/sequence/ordinal are
    // null). It can only be delivered live, so it bypasses the replay cursor.
    // De-duplication uses object identity: such a record must be delivered as-is
    // (never re-wrapped into a new object) or it would be written twice.
    if (record.eventId == null) return !seen.has(record);
    if (runId) {
      if (record.sequence <= runSequence) return false;
    } else if (record.ordinal <= lastOrdinal) {
      return false;
    }
    return !seen.has(record.eventId);
  };

  const replayable = (record) => {
    if (!record?.runId || isRunActive(record.runId)) return true;
    if (typeof log.hasTerminal !== "function") return true;
    if (!terminalCache.has(record.runId)) {
      terminalCache.set(record.runId, Boolean(log.hasTerminal({ threadId, runId: record.runId })));
    }
    return terminalCache.get(record.runId);
  };

  /** @returns {boolean} true when this event closed the stream. */
  const send = (record, { liveEvent = false, replayEvent = false } = {}) => {
    if (replayEvent && !replayable(record)) return false;
    if (!acceptable(record)) return false;
    seen.add(record.eventId == null ? record : record.eventId);
    if (record.eventId != null) {
      if (runId) runSequence = Math.max(runSequence, record.sequence);
      else lastOrdinal = Math.max(lastOrdinal, record.ordinal);
    }
    const idLine = record.eventId ? `id: ${record.eventId}\n` : "";
    // Volatile frames are marked so a client knows this event is live-only.
    const payload = record.persisted === false ? { ...record.payload, persisted: false } : record.payload;
    write(`${idLine}data: ${JSON.stringify(payload)}\n\n`);
    const terminal = TERMINAL_EVENT_TYPES.has(record.eventType);
    // Run streams always end on their terminal event. A thread stream only ends
    // on a live terminal when nothing else is running; historical terminals are
    // just replayed.
    const finished = terminal && (Boolean(runId) || (liveEvent && !isRunActive()));
    if (finished) {
      closeStream();
      return true;
    }
    return false;
  };

  res.writeHead(200, SSE_HEADERS);
  write("retry: 2000\n\n");

  unsubscribe =
    subscribe((record) => {
      if (!live) {
        queued.push(record);
        return;
      }
      send(record, { liveEvent: true });
    }) || (() => {});

  // ServerResponse 'close' fires both after res.end() and when the client drops,
  // so it is the reliable teardown signal for POST-based SSE. IncomingMessage
  // 'close' fires as soon as the POST body is consumed and would be too early.
  res.once("close", closeStream);
  req.once("aborted", closeStream);

  // Replay (paginated so a long run is never truncated).
  try {
    let cursorOrdinal = afterOrdinal;
    let cursorSequence = runSequence;
    for (;;) {
      if (suppressReplay) break;
      const batch = log.list({
        threadId,
        runId,
        afterSequence: cursorSequence,
        afterOrdinal: cursorOrdinal,
        limit: maxReplay,
      });
      if (!batch.length) break;
      for (const record of batch) {
        // Historical terminal events do not close a thread replay.
        if (send(record, { liveEvent: false, replayEvent: true })) return;
      }
      const last = batch.at(-1);
      cursorOrdinal = Math.max(cursorOrdinal, last.ordinal);
      cursorSequence = Math.max(cursorSequence, last.sequence);
      if (batch.length < maxReplay) break;
    }
  } catch (error) {
    // Incomplete on purpose: no id, because this frame was never persisted.
    write(
      `data: ${JSON.stringify({
        type: EventType.RUN_ERROR,
        timestamp: Date.now(),
        threadId,
        runId,
        message: `replay failed: ${error.message}`,
        code: "replay_failed",
      })}\n\n`,
    );
    closeStream();
    return;
  }

  // Hand-off: drain everything queued while replay ran, still with live=false so
  // new events keep queueing in order. Node is single-threaded, so nothing can
  // arrive between the drain ending and live=true.
  while (queued.length) {
    if (send(queued.shift(), { liveEvent: false })) return;
  }
  live = true;

  // Nothing more will arrive for an idle thread / finished run.
  if (!isRunActive(runId ?? undefined)) {
    closeStream();
    return;
  }

  ping = setInterval(() => write(": ping\n\n"), pingMs);
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
    const body = await readBodyJson(req, readJson);
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
    const body = await readBodyJson(req, readJson);
    const input = asObject(body);
    const forwarded = asObject(input.forwardedProps);
    const projectId = projectIdOf(input);
    if (projectId != null && String(projectId) !== ctx.id) {
      json(res, 403, { error: "project mismatch" });
      return true;
    }
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
