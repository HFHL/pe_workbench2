import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function handleSessions({ req, res, url, app, ctx }) {
  const { json, readJson } = app.http;
  const { sessions, bus, broadcast, nowIso, ALLOWED_MODELS, getModel, makeTitle } = app;
  const pathname = url.pathname;
  if (pathname === "/api/sessions" && req.method === "GET") {
    return json(res, 200, await sessions.listSessions(ctx));
  }

  if (pathname === "/api/sessions" && req.method === "POST") {
    const entry = await sessions.createEntry({ id: crypto.randomUUID(), ctx });
    return json(res, 201, { id: entry.id, title: entry.title, messageCount: 0, updatedAt: entry.updatedAt });
  }

  if (pathname === "/api/events" && req.method === "GET") {
    bus.openGlobal(req, res, ctx);
    return;
  }

  const match = pathname.match(/^\/api\/sessions\/([^/]+)\/(state|events|messages|abort|model)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    const entry = await sessions.ensureEntry(id, ctx);
    if (!entry) return json(res, 404, { error: "session not found" });

    if (action === "state" && req.method === "GET") {
      return json(res, 200, entry.snapshot());
    }

    if (action === "events" && req.method === "GET") {
      bus.openSession(req, res, entry);
      return;
    }

    if (action === "messages" && req.method === "POST") {
      // A legacy prompt must not be injected into an active AG-UI run: it would
      // be queued as a followUp and its events would leak into that run.
      if (entry.agui?.isRunning) {
        return json(res, 409, {
          error: "an AG-UI run is active on this session",
          code: "ag_ui_run_active",
          threadId: entry.id,
        });
      }
      const body = await readJson(req);
      const text = String(body.text || "").trim();
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      if (!text && !attachments.length) return json(res, 400, { error: "empty message" });

      const safeAttachments = attachments
        .filter((item) => typeof item === "string")
        .map((item) => path.relative(ctx.root, path.resolve(ctx.root, item)))
        .filter((item) => item && !item.startsWith(".."));

      let promptText = text || "看一下这几个文件。";
      if (safeAttachments.length) {
        promptText += `\n\n[已上传资料]\n${safeAttachments.map((item) => `- ${item}`).join("\n")}`;
      }

      if (entry.title === "新会话" || !entry.title) {
        const title = makeTitle(text);
        entry.title = title;
        entry.session.setSessionName(title);
      }

      entry.updatedAt = nowIso();
      const streaming = entry.session.isStreaming;
      const run = entry.session.prompt(
        promptText,
        streaming ? { streamingBehavior: "followUp" } : {},
      );
      run.catch((error) => {
        broadcast(entry, { type: "run.error", message: error?.message || String(error) });
      });

      broadcast(entry, {
        type: "session.updated",
        id: entry.id,
        title: entry.title,
        messageCount: entry.session.messages.length,
        updatedAt: entry.updatedAt,
      });

      return json(res, 202, { accepted: true, queued: streaming, sessionId: entry.id, title: entry.title });
    }

    if (action === "abort" && req.method === "POST") {
      // Keep both abort entry points identical: adapter.abort() stops the AG-UI
      // stream immediately, then lets Pi settle.
      if (entry.agui?.isRunning) await entry.agui.abort();
      else await entry.session.abort();
      return json(res, 200, { ok: true });
    }

    if (action === "model" && req.method === "POST") {
      const body = await readJson(req);
      const requested = String(body.model || "");
      if (!ALLOWED_MODELS.has(requested)) return json(res, 400, { error: "unsupported model" });
      const next = getModel("deepseek", requested);
      if (!next) return json(res, 400, { error: "model not found" });
      await entry.session.setModel(next);
      entry.modelId = requested;
      broadcast(entry, { type: "session.updated", id: entry.id, title: entry.title, messageCount: entry.session.messages.length, updatedAt: entry.updatedAt, model: requested });
      return json(res, 200, { ok: true, model: requested });
    }
  }

  return json(res, 404, { error: "not found" });
}
