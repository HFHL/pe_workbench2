import crypto from "node:crypto";

import { handleCopilotKitRequest } from "../../lib/agent-protocol/copilotkit-endpoint.mjs";

export async function handleCopilotKit({ req, res, url, app, ctx }) {
  const { sessions } = app;
  const { json, readJson } = app.http;
  if (!url.pathname.startsWith("/api/copilotkit")) return false;

  return handleCopilotKitRequest(req, res, url, {
    ctx,
    app,
    json,
    readJson,
    resolveThread: (threadId) => sessions.ensureEntry(threadId, ctx),
    createThread: () => sessions.createEntry({ id: crypto.randomUUID(), ctx }),
  });
}
