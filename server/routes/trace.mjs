/** Model trace API: read the ordered history, record a human judgment, confirm an adjustment. */

export async function handleTrace({ req, res, url, app, ctx }) {
  const { json, readJson } = app.http;
  const trace = ctx.trace;
  if (!trace) return json(res, 404, { error: "trace not available", code: "disabled" });
  const pathname = url.pathname;

  if (pathname === "/api/trace/current" && req.method === "GET") {
    return json(res, 200, trace.view());
  }

  if (pathname === "/api/trace/current/reset" && req.method === "POST") {
    return json(res, 200, trace.reset());
  }

  if (pathname === "/api/trace/record" && req.method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    const entry = trace.recordRun({
      sessionId: body.sessionId == null ? null : String(body.sessionId),
      runId: body.runId == null ? null : String(body.runId),
      changedFiles: Array.isArray(body.changedFiles) ? body.changedFiles.map(String) : [],
      text: String(body.text || ""),
      at: body.at == null ? null : String(body.at),
    });
    return json(res, 200, { entry, ...trace.view() });
  }

  const judgeMatch = pathname.match(/^\/api\/trace\/entries\/([^/]+)\/judge$/);
  if (judgeMatch) {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    let entryId;
    try {
      entryId = decodeURIComponent(judgeMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid entry id" });
    }
    const body = await readJson(req).catch(() => ({}));
    const result = trace.judge({
      entryId,
      verdict: String(body.verdict || ""),
      note: String(body.note || ""),
      adopt: body.adopt === true,
    });
    if (!result.ok) return json(res, result.status || 400, { error: result.error || "judgment failed" });
    return json(res, 200, result);
  }

  const confirmMatch = pathname.match(/^\/api\/trace\/judgments\/([^/]+)\/confirm$/);
  if (confirmMatch) {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    let judgmentId;
    try {
      judgmentId = decodeURIComponent(confirmMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid judgment id" });
    }
    const body = await readJson(req).catch(() => ({}));
    const result = trace.confirm({ judgmentId, action: String(body.action || "") });
    if (!result.ok) return json(res, result.status || 400, { error: result.error || "confirmation failed" });
    return json(res, 200, result);
  }

  return json(res, 404, { error: "not found" });
}
