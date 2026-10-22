/**
 * CopilotKit Runtime facade over the existing Pi AG-UI adapter.
 *
 * The pilot deliberately does not use @copilotkit/runtime: that package ships a
 * second agent runtime (and its SQLite runner) which the workbench must not
 * adopt. CopilotKit Core only needs the public Runtime HTTP contract, so the
 * run/connect/stop routes are rewritten onto the same P0 handlers that already
 * own thread identity, project checks, replay and the run state machine.
 *
 *   GET  /api/copilotkit/info
 *   POST /api/copilotkit/agent/pi/run
 *   POST /api/copilotkit/agent/pi/connect
 *   POST /api/copilotkit/agent/pi/stop/:threadId
 *   GET  /api/copilotkit/thread/:threadId/state   (pilot replay cursor)
 *
 * There is no second conversation store: threadId is the Pi sessionId and Pi
 * JSONL remains the only conversation history.
 */

import { handleAgUiRequest } from "./ag-ui-endpoint.mjs";

export const COPILOTKIT_RUNTIME_VERSION = "1.0.0";

/**
 * RuntimeInfo shape consumed by CopilotKit Core (`GET {runtimeUrl}/info`).
 * Everything outside the pilot is explicitly off: no Learning, telemetry,
 * A2UI, suggestions, transcription or hosted thread/memory endpoints.
 */
export function copilotKitInfo(ctx) {
  return {
    version: COPILOTKIT_RUNTIME_VERSION,
    agents: {
      pi: {
        name: "pi",
        className: "PiAgUiAdapter",
        description: "Pi AgentSession exposed as a CopilotKit runtime agent",
      },
    },
    audioFileTranscriptionEnabled: false,
    mode: "sse",
    telemetryDisabled: true,
    suggestions: false,
    a2ui: { enabled: false },
    openGenerativeUIEnabled: false,
    // Pilot metadata (Core ignores unknown fields).
    protocol: "copilotkit-runtime",
    projectId: ctx.id,
    threadIdSource: "pi-sessionId",
  };
}

function threadIdFromPath(pathname, suffix) {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = pathname.match(new RegExp(`^/api/copilotkit/thread/([^/]+)/${escaped}$`));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

async function handleThreadState({ req, res, url, app, ctx }) {
  const { json } = app.http;
  const pathname = url.pathname;
  const threadId = threadIdFromPath(pathname, "state");
  if (threadId == null || req.method !== "GET") return false;

  // A GET must not open a Pi AgentSession as a side effect. This cursor is
  // only meaningful for a thread that is already live in this process.
  const entry = app.live?.get(threadId) || null;
  if (!entry?.agui || entry.ctx?.id !== ctx.id) {
    json(res, 404, { error: "thread not found" });
    return true;
  }
  const latest = typeof ctx.store.latestAgentEvent === "function"
    ? ctx.store.latestAgentEvent({ workspaceId: ctx.id, threadId: entry.id })
    : null;
  json(res, 200, {
    threadId: entry.id,
    projectId: ctx.id,
    streaming: Boolean(entry.agui.isRunning),
    activeRunId: entry.agui.activeRunId,
    lastEventId: latest?.eventId || null,
    lastEventOrdinal: latest?.ordinal || null,
  });
  return true;
}

/**
 * @returns {Promise<boolean>} true when the request was handled here.
 */
export async function handleCopilotKitRequest(req, res, url, deps) {
  const { ctx, json } = deps;
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/copilotkit")) return false;

  if (pathname === "/api/copilotkit/info" && req.method === "GET") {
    json(res, 200, copilotKitInfo(ctx));
    return true;
  }

  if (await handleThreadState({ req, res, url, app: deps.app, ctx })) return true;

  if (pathname.startsWith("/api/copilotkit/agent/pi/")) {
    // Reuse the P0 transport verbatim: only the public mount path changes.
    const rewritten = new URL(url.href);
    rewritten.pathname = pathname.replace(/^\/api\/copilotkit/, "/api/ag-ui");
    return handleAgUiRequest(req, res, rewritten, deps);
  }

  json(res, 404, { error: "not found" });
  return true;
}
