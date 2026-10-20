import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function handleAgUi({ req, res, url, app, ctx }) {
  const { handleAgUiRequest, sessions } = app;
  const { json, readJson } = app.http;
  const pathname = url.pathname;
  if (pathname.startsWith("/api/ag-ui/")) {
    const handled = await handleAgUiRequest(req, res, url, {
      ctx,
      json,
      readJson,
      resolveThread: (threadId) => sessions.ensureEntry(threadId, ctx),
      createThread: () => sessions.createEntry({ id: crypto.randomUUID(), ctx }),
    });
    if (handled) return;
  }

  return json(res, 404, { error: "not found" });
}
