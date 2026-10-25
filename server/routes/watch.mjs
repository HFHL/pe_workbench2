/**
 * HTTP surface for 「盯」.
 *
 * All endpoints are project-scoped (`?project=…` or `X-Project-Id`). The
 * service owns timing and concurrency; routes only parse input and translate
 * domain errors into status codes.
 */

export async function handleWatch({ req, res, url, app, ctx }) {
  const { json, readJson } = app.http;
  const service = app.watch;
  if (!service) return json(res, 503, { error: "watch service not ready" });
  const pathname = url.pathname;

  if (pathname === "/api/watch") {
    if (req.method === "GET") return json(res, 200, service.overview(ctx));
    if (req.method === "POST") {
      try {
        const body = await readJson(req);
        const result = await service.createWatch(ctx, body || {});
        if (result.created) {
          // Kick the first scan off the request path so the tab can render now.
          void service.scan(ctx, result.watch.id).catch(() => {});
        }
        return json(res, result.created ? 201 : 200, {
          watch: result.watch,
          created: result.created,
          messages: ctx.store.listWatchMessages({ watchId: result.watch.id, limit: 200 }),
          checks: ctx.store.listWatchChecks(result.watch.id, 8),
        });
      } catch (error) {
        return json(res, error.status || 500, { error: error.message });
      }
    }
    return json(res, 405, { error: "method not allowed" });
  }

  const match = pathname.match(/^\/api\/watch\/([^/]+)(?:\/(check|messages|read|refresh|logs))?$/);
  if (!match) return json(res, 404, { error: "not found" });
  let watchId;
  try {
    watchId = decodeURIComponent(match[1]);
  } catch {
    return json(res, 400, { error: "invalid watch id" });
  }
  const action = match[2];
  const watch = ctx.store.getWatch(watchId);
  if (!watch) return json(res, 404, { error: "watch not found" });

  if (!action) {
    if (req.method === "GET") return json(res, 200, service.view(ctx, watchId));
    if (req.method === "PATCH" || req.method === "POST") {
      try {
        const body = await readJson(req);
        const updated = await service.updateWatch(ctx, watchId, body || {});
        return json(res, 200, { watch: updated });
      } catch (error) {
        return json(res, error.status || 500, { error: error.message });
      }
    }
    if (req.method === "DELETE") {
      const removed = await service.deleteWatch(ctx, watchId);
      return json(res, removed ? 200 : 404, { removed });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  if (action === "logs") {
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    const runId = url.searchParams.get("run") || null;
    const limit = Number(url.searchParams.get("limit")) || 600;
    return json(res, 200, {
      logs: ctx.store.listWatchLogs({ watchId, runId, limit }),
    });
  }

  if (action === "messages") {
    if (req.method === "GET") {
      const after = url.searchParams.get("after") || null;
      return json(res, 200, {
        messages: ctx.store.listWatchMessages({
          watchId,
          limit: Number(url.searchParams.get("limit")) || 200,
          after,
        }),
      });
    }
    if (req.method === "POST") {
      try {
        const body = await readJson(req);
        const result = await service.ask(ctx, watchId, body?.text);
        return json(res, 202, result);
      } catch (error) {
        return json(res, error.status || 500, { error: error.message });
      }
    }
    return json(res, 405, { error: "method not allowed" });
  }

  if (action === "check" && req.method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    const trigger = body?.deep ? "deep" : "manual";
    void service.runCheck(ctx, watchId, { trigger, force: true })
      .then((result) => {
        if (result?.error) app.logger?.warn?.(`[watch] manual check failed: ${result.error}`);
      })
      .catch((error) => app.logger?.warn?.(`[watch] manual check failed: ${error.message}`));
    return json(res, 202, { accepted: true, trigger });
  }

  if (action === "read" && req.method === "POST") {
    const result = service.markRead(ctx, watchId);
    return json(res, 200, result);
  }

  if (action === "refresh" && req.method === "POST") {
    try {
      const updated = await service.refreshBrief(ctx, watchId);
      return json(res, 200, { watch: updated });
    } catch (error) {
      return json(res, error.status || 500, { error: error.message });
    }
  }

  return json(res, 405, { error: "method not allowed" });
}
