/**
 * Tracking scheduler: at most one local agent run starts per tick.
 *
 * The lease is claimed before launching; a failed launch clears it. Import has
 * no side effects.
 */

import { createPeriodicScheduler } from "./periodic.mjs";

export function createTrackingScheduler({
  contexts,
  runTracking,
  activeTrackingRuns,
  onError = null,
  enabled = true,
  logger = console,
} = {}) {
  if (!contexts || !runTracking || !activeTrackingRuns) {
    throw new Error("createTrackingScheduler requires contexts, runTracking and activeTrackingRuns");
  }
  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      for (const ctx of contexts.values()) {
        const store = ctx.store;
        const due = store.listDueTrackings(new Date());
        let started = false;
        for (const row of due) {
          if (activeTrackingRuns.has(row.id)) continue;
          // Trackings with a monitoring contract are driven by monitor_items;
          // the legacy "full review" schedule must not double-run them.
          if (store.listMonitorItems(row.id).length) continue;
          const leaseUntil = new Date(Date.now() + 10 * 60 * 1000);
          if (!store.claimTracking(row.id, leaseUntil)) continue;
          try {
            await runTracking(ctx, row.id, {
              trigger: "schedule",
              scheduledFor: row.next_run_at,
            });
            started = true;
          } catch (error) {
            logger.warn?.(`[tracking] scheduled run failed (${ctx.id}): ${error.message}`);
            store.clearTrackingLease(row.id);
            onError?.(ctx, row.id);
          }
          break;
        }
        if (started) break;
      }
    } catch (error) {
      logger.warn?.(`[tracking] scheduler tick failed: ${error.message}`);
    } finally {
      busy = false;
    }
  }

  const loop = createPeriodicScheduler({
    name: "tracking",
    tick,
    enabled,
    intervalMs: 30_000,
    initialDelayMs: 3_000,
    logger,
  });
  return Object.assign(loop, { tick });
}
