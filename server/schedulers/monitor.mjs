/**
 * Monitor scheduler: groups due items and pending source events per tracking,
 * then starts at most one local agent run per tick.
 */

import { createPeriodicScheduler } from "./periodic.mjs";

export function createMonitorScheduler({
  contexts,
  runTracking,
  activeTrackingRuns,
  enabled = true,
  logger = console,
} = {}) {
  if (!contexts || !runTracking || !activeTrackingRuns) {
    throw new Error("createMonitorScheduler requires contexts, runTracking and activeTrackingRuns");
  }
  let busy = false;

  async function tick() {
    if (!enabled) return;
    if (busy) return;
    busy = true;
    try {
      for (const ctx of contexts.values()) {
        const grouped = new Map();
        const ensureGroup = (trackingId) => {
          if (!grouped.has(trackingId)) grouped.set(trackingId, { ids: new Set(), events: [] });
          return grouped.get(trackingId);
        };

        for (const item of ctx.store.listDueMonitorItems(new Date(), 20)) {
          ensureGroup(item.trackingId).ids.add(item.id);
        }

        for (const event of ctx.store.listPendingRelevantEvents(20)) {
          if (!event.trackingId) continue;
          const items = ctx.store.listMonitorItems(event.trackingId);
          if (!items.length) continue;
          const group = ensureGroup(event.trackingId);
          let matchedIds = [];
          try {
            matchedIds = JSON.parse(event.relevance || "{}").itemIds || [];
          } catch {
            matchedIds = [];
          }
          if (!matchedIds.length && event.monitorItemId) matchedIds = [event.monitorItemId];
          const valid = matchedIds.filter((id) => items.some((item) => item.id === id));
          if (valid.length) {
            for (const id of valid) group.ids.add(id);
          } else {
            for (const item of items) group.ids.add(item.id);
          }
          group.events.push({
            id: event.id,
            title: event.title,
            url: event.url,
            publishedAt: event.publishedAt,
            sourceTier: event.sourceTier,
            snippet: event.payload?.snippet || "",
          });
        }

        let started = false;
        for (const [trackingId, group] of grouped) {
          if (activeTrackingRuns.has(trackingId)) continue;
          try {
            await runTracking(ctx, trackingId, {
              trigger: group.events.length ? "event" : "monitor",
              monitorMode: true,
              monitorItemIds: [...group.ids],
              events: group.events,
              eventIds: group.events.map((event) => event.id),
            });
            started = true;
          } catch (error) {
            logger.warn?.(`[monitor] scheduled check failed (${ctx.id}/${trackingId}): ${error.message}`);
          }
          break;
        }
        if (started) break;
      }
    } catch (error) {
      logger.warn?.(`[monitor] scheduler tick failed: ${error.message}`);
    } finally {
      busy = false;
    }
  }

  const loop = createPeriodicScheduler({
    name: "monitor",
    tick,
    enabled,
    intervalMs: 30_000,
    initialDelayMs: 8_000,
    logger,
  });
  return Object.assign(loop, { tick });
}
