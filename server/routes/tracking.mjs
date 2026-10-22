import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function handleTracking({ req, res, url, app, ctx }) {
  const { json, readJson } = app.http;
  const { runTracking, readTrackingState, writeTrackingState, syncSourceBindings, pollSourceBinding, broadcastTracking, broadcastPlan, broadcastGlobal, withAsr, prepareWorkingModel, TRACKING_TEMPLATES, normalizeSchedule, templateForFile, computeNextCheck, deriveMonitorPlan, normalizeMonitorItem, validateMonitorPlan, triageSourceEvent, nowIso } = app;
  const pathname = url.pathname;
  if (pathname === "/api/trackings") {
    if (req.method === "GET") return json(res, 200, ctx.store.listTrackings());
    if (req.method === "POST") {
      const body = await readJson(req);
      const target = ctx.store.getMaterial(body.targetId);
      if (!target) return json(res, 404, { error: "target file not found" });
      const existing = ctx.store.findTrackingByTarget(target.id);
      if (existing) {
        return json(res, 409, {
          error: "这个文件已经在跟踪中",
          tracking: ctx.store.getTracking(existing.id),
        });
      }
      const templateId = TRACKING_TEMPLATES[body.templateId]
        ? body.templateId
        : templateForFile(target.name);
      if (TRACKING_TEMPLATES[templateId].writeMode === "in_place" && !String(target.relPath).startsWith("exports/")) {
        return json(res, 400, {
          error: "原位更新只能跟踪 exports/ 下的产出文件；uploads/ 和 inputs/ 是只读的",
        });
      }
      const schedule = normalizeSchedule(body);
      try {
        const tracking = ctx.store.createTracking({
          targetId: target.id,
          templateId,
          ...schedule,
        });
        broadcastTracking(tracking, ctx.id);
        return json(res, 201, tracking);
      } catch (error) {
        return json(res, error.status || 500, { error: error.message });
      }
    }
  }

  const eventsMatch = pathname.match(/^\/api\/trackings\/([^/]+)\/events(?:\/(refresh))?$/);
  if (eventsMatch) {
    let trackingId;
    try {
      trackingId = decodeURIComponent(eventsMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid tracking id" });
    }
    const tracking = ctx.store.getTracking(trackingId);
    if (!tracking) return json(res, 404, { error: "tracking not found" });
    const action = eventsMatch[2];

    if (!action && req.method === "GET") {
      return json(res, 200, {
        trackingId,
        events: ctx.store.listSourceEvents({ trackingId, limit: 30 }),
        bindings: ctx.store.listSourceBindings(trackingId),
      });
    }

    if (action === "refresh" && req.method === "POST") {
      if (!ctx.store.listSourceBindings(trackingId).length) {
        await syncSourceBindings(ctx, trackingId);
      }
      const bindings = ctx.store.listSourceBindings(trackingId);
      const results = [];
      for (const binding of bindings) {
        try {
          const result = await pollSourceBinding(ctx, binding);
          ctx.store.updateSourceBinding(binding.id, {
            lastPolledAt: nowIso(),
            nextPollAt: new Date(Date.now() + Math.max(30, binding.intervalMinutes) * 60 * 1000).toISOString(),
          });
          results.push({ id: binding.id, ...result });
        } catch (error) {
          results.push({ id: binding.id, error: error.message });
        }
      }
      return json(res, 200, { trackingId, results, events: ctx.store.listSourceEvents({ trackingId, limit: 20 }) });
    }

    if (!action && req.method === "POST") {
      const body = await readJson(req);
      const title = String(body.title || "").trim();
      if (!title) return json(res, 400, { error: "title 不能为空" });
      const { state } = await readTrackingState(ctx, tracking);
      const items = ctx.store.listMonitorItems(trackingId);
      const candidate = {
        title,
        url: String(body.url || "").trim(),
        snippet: String(body.snippet || "").trim(),
        content: String(body.content || "").trim(),
      };
      const triage = triageSourceEvent({ event: candidate, state, items });
      let domain = "";
      try {
        domain = new URL(candidate.url).hostname;
      } catch {
        domain = "";
      }
      const event = ctx.store.createSourceEvent({
        trackingId,
        monitorItemId: triage.itemIds[0] || null,
        adapter: "manual",
        sourceTier: Number(body.sourceTier) || 3,
        domain,
        url: candidate.url,
        title: candidate.title,
        payload: { snippet: candidate.snippet, content: candidate.content },
        triageStatus: triage.status,
        relevance: triage.relevance,
      });
      broadcastGlobal({ type: "event.created", event }, ctx.id);
      return json(res, 201, event);
    }

    return json(res, 405, { error: "method not allowed" });
  }

  const modelMatch = pathname.match(/^\/api\/trackings\/([^/]+)\/model(?:\/(prepare|bindings))?$/);
  if (modelMatch) {
    let trackingId;
    try {
      trackingId = decodeURIComponent(modelMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid tracking id" });
    }
    const tracking = ctx.store.getTracking(trackingId);
    if (!tracking) return json(res, 404, { error: "tracking not found" });
    const action = modelMatch[2];
    const { relPath, state, error } = await readTrackingState(ctx, tracking);
    if (!state) return json(res, 409, { error, statePath: relPath });

    if (!action && req.method === "GET") {
      return json(res, 200, {
        trackingId,
        statePath: relPath,
        model: state.model || {},
        available: Boolean(state.model?.working_file),
      });
    }

    if (action === "prepare" && req.method === "POST") {
      try {
        const prepared = await prepareWorkingModel({ ctx, tracking, state, stateRel: relPath });
        broadcastMaterial(prepared.material, ctx.id);
        return json(res, 200, {
          trackingId,
          model: prepared.state.model,
          material: prepared.material,
        });
      } catch (err) {
        return json(res, err.status || 500, { error: err.message });
      }
    }

    if (action === "bindings" && req.method === "POST") {
      const body = await readJson(req);
      const bindings = Array.isArray(body.bindings) ? body.bindings : [];
      const outputs = Array.isArray(body.outputs) ? body.outputs : [];
      const normalizedBindings = bindings
        .filter((binding) => binding && binding.sheet && binding.cell)
        .map((binding) => ({
          metric: String(binding.metric || "").trim(),
          sheet: String(binding.sheet).trim(),
          cell: String(binding.cell).trim().toUpperCase(),
          kind: String(binding.kind || "input").trim(),
          verified: binding.verified === true,
          note: String(binding.note || "").trim(),
        }));
      const normalizedOutputs = outputs
        .filter((output) => output && output.sheet && output.cell)
        .map((output) => ({
          label: String(output.label || output.name || "").trim(),
          sheet: String(output.sheet).trim(),
          cell: String(output.cell).trim().toUpperCase(),
        }));
      state.model = state.model && typeof state.model === "object" ? state.model : {};
      state.model.bindings = normalizedBindings;
      state.model.outputs = normalizedOutputs;
      state.model.write_enabled = body.writeEnabled === true;
      await writeTrackingState(ctx, relPath, state, { note: "模型绑定确认", reason: "model bindings" });
      return json(res, 200, { trackingId, model: state.model });
    }

    return json(res, 405, { error: "method not allowed" });
  }

  const monitorMatch = pathname.match(/^\/api\/trackings\/([^/]+)\/monitors(?:\/(plan|activate|check))?$/);
  if (monitorMatch) {
    let trackingId;
    try {
      trackingId = decodeURIComponent(monitorMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid tracking id" });
    }
    const tracking = ctx.store.getTracking(trackingId);
    if (!tracking) return json(res, 404, { error: "tracking not found" });
    const action = monitorMatch[2];

    if (!action && req.method === "GET") {
      return json(res, 200, {
        trackingId,
        items: ctx.store.listMonitorItems(trackingId),
      });
    }

    if (action === "plan" && req.method === "POST") {
      const { relPath, state, error } = await readTrackingState(ctx, tracking);
      if (!state) return json(res, 409, { error, statePath: relPath });
      const plan = deriveMonitorPlan(state, {
        trackingId,
        targetPath: tracking.targetPath || tracking.relPath,
        now: new Date(),
      });
      return json(res, 200, {
        ...plan,
        statePath: relPath,
        existing: ctx.store.listMonitorItems(trackingId),
      });
    }

    if (action === "activate" && req.method === "POST") {
      const body = await readJson(req);
      let items = Array.isArray(body.items) ? body.items : null;
      if (!items) {
        const { relPath, state, error } = await readTrackingState(ctx, tracking);
        if (!state) return json(res, 409, { error, statePath: relPath });
        items = deriveMonitorPlan(state, {
          trackingId,
          targetPath: tracking.targetPath || tracking.relPath,
          now: new Date(),
        }).items;
      }
      const normalized = items.map((item, index) => normalizeMonitorItem(item, { index, trackingId }));
      const errors = validateMonitorPlan({ items: normalized });
      if (errors.length) {
        return json(res, 400, { error: "监测方案校验失败", errors });
      }
      const saved = ctx.store.replaceMonitorItems(trackingId, normalized);
      try {
        await syncSourceBindings(ctx, trackingId);
      } catch (error) {
        console.warn(`[source] binding sync failed: ${error.message}`);
      }
      broadcastGlobal({ type: "monitor.updated", trackingId, items: saved }, ctx.id);
      return json(res, 200, { trackingId, items: saved });
    }

    if (action === "check" && req.method === "POST") {
      const body = await readJson(req);
      const ids = Array.isArray(body.itemIds) ? body.itemIds.map(String) : [];
      const pending = ctx.store.listPendingRelevantEvents(20)
        .filter((event) => event.trackingId === trackingId);
      const events = pending.map((event) => ({
        id: event.id,
        title: event.title,
        url: event.url,
        publishedAt: event.publishedAt,
        sourceTier: event.sourceTier,
        snippet: event.payload?.snippet || "",
      }));
      if (!ids.length) {
        for (const event of pending) {
          try {
            const parsed = JSON.parse(event.relevance || "{}");
            for (const id of parsed.itemIds || []) ids.push(id);
          } catch {
            /* ignore malformed relevance */
          }
        }
      }
      const uniqueIds = [...new Set(ids)];
      try {
        const result = await runTracking(ctx, trackingId, {
          trigger: events.length ? "event" : (body.trigger === "schedule" ? "schedule" : "manual"),
          monitorMode: true,
          monitorItemIds: uniqueIds,
          events,
          eventIds: events.map((event) => event.id),
        });
        return json(res, 202, result);
      } catch (error) {
        return json(res, error.status || 500, { error: error.message });
      }
    }

    return json(res, 405, { error: "method not allowed" });
  }

  const monitorItemMatch = pathname.match(/^\/api\/monitors\/([^/]+)$/);
  if (monitorItemMatch && (req.method === "PATCH" || req.method === "POST")) {
    let id;
    try {
      id = decodeURIComponent(monitorItemMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid monitor id" });
    }
    const body = await readJson(req);
    const trackingId = String(body.trackingId || url.searchParams.get("tracking") || "").trim() || null;
    const current = ctx.store.getMonitorItem(id, trackingId);
    if (!current) return json(res, 404, { error: "monitor not found" });
    if (body.frequency || body.next_check_at || body.nextCheckAt) {
      body.nextCheckAt = body.nextCheckAt || body.next_check_at
        || computeNextCheck(body.frequency || current.frequency);
    }
    const item = ctx.store.updateMonitorItem(id, body, current.trackingId);
    broadcastGlobal({ type: "monitor.updated", trackingId: item.trackingId, items: ctx.store.listMonitorItems(item.trackingId) }, ctx.id);
    return json(res, 200, item);
  }

  const undoMatch = pathname.match(/^\/api\/runs\/([^/]+)\/undo$/);
  if (undoMatch && req.method === "POST") {
    let runId;
    try {
      runId = decodeURIComponent(undoMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid run id" });
    }
    const runRow = ctx.store.getTrackingRun(runId);
    if (!runRow) return json(res, 404, { error: "run not found" });
    const changes = ctx.store.listRunChanges(runId).filter((change) => change.applied);
    if (!changes.length) return json(res, 409, { error: "这次运行没有可撤销的文件变更" });
    const reverted = [];
    for (const change of changes) {
      const beforeVersion = Number(change.before?.version);
      if (!Number.isFinite(beforeVersion) || beforeVersion < 1) continue;
      const material = ctx.store.restoreVersion(change.objectId, beforeVersion);
      if (material) {
        broadcastMaterial(material, ctx.id);
        reverted.push({ objectType: change.objectType, objectId: change.objectId, version: beforeVersion });
      }
    }
    ctx.store.markRunChangesReverted(runId);
    let notification = null;
    try {
      notification = ctx.store.createNotification({
        trackingId: runRow.tracking_id,
        runId,
        severity: "info",
        title: "已撤销一次更新",
        body: reverted.length
          ? `恢复了 ${reverted.length} 个文件到运行前版本。`
          : "没有可恢复的版本，变更标记已清除。",
        changes: reverted,
        actions: [{ action: "open", label: "查看运行" }],
      });
      broadcastGlobal({ type: "notification.created", notification }, ctx.id);
    } catch (error) {
      console.warn(`[undo] notification failed: ${error.message}`);
    }
    return json(res, 200, { ok: true, reverted, notification });
  }

  if (pathname === "/api/notifications") {
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    const limit = Number(url.searchParams.get("limit") || 30);
    const unreadOnly = url.searchParams.get("unread") === "1";
    const trackingId = url.searchParams.get("tracking") || null;
    return json(res, 200, ctx.store.listNotifications({ limit, unreadOnly, trackingId }));
  }

  const notificationMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (notificationMatch && req.method === "POST") {
    let id;
    try {
      id = decodeURIComponent(notificationMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid notification id" });
    }
    const notification = ctx.store.markNotificationRead(id);
    if (!notification) return json(res, 404, { error: "notification not found" });
    broadcastGlobal({ type: "notification.updated", notification }, ctx.id);
    return json(res, 200, notification);
  }

  const trackingMatch = pathname.match(/^\/api\/trackings\/([^/]+)(?:\/(toggle|run|schedule))?$/);
  if (trackingMatch) {
    let trackingId;
    try {
      trackingId = decodeURIComponent(trackingMatch[1]);
    } catch {
      return json(res, 400, { error: "invalid tracking id" });
    }
    const action = trackingMatch[2];

    if (!action && req.method === "GET") {
      const tracking = ctx.store.getTracking(trackingId);
      return tracking ? json(res, 200, tracking) : json(res, 404, { error: "tracking not found" });
    }
    if (action === "toggle" && req.method === "POST") {
      const tracking = ctx.store.toggleTracking(trackingId);
      if (!tracking) return json(res, 404, { error: "tracking not found" });
      broadcastTracking(tracking, ctx.id);
      return json(res, 200, tracking);
    }
    if (action === "schedule" && (req.method === "POST" || req.method === "PATCH")) {
      const body = await readJson(req);
      const tracking = ctx.store.updateTrackingSchedule(trackingId, normalizeSchedule(body));
      if (!tracking) return json(res, 404, { error: "tracking not found" });
      broadcastTracking(tracking, ctx.id);
      return json(res, 200, tracking);
    }
    if (action === "run" && req.method === "POST") {
      try {
        const result = await runTracking(ctx, trackingId, { trigger: "manual" });
        return json(res, 202, result);
      } catch (error) {
        return json(res, error.status || 500, { error: error.message });
      }
    }
    if (!action && req.method === "DELETE") {
      const deleted = ctx.store.deleteTracking(trackingId);
      if (!deleted) return json(res, 404, { error: "tracking not found" });
      broadcastGlobal({ type: "tracking.deleted", id: trackingId }, ctx.id);
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { error: "not found" });
}
