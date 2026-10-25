/**
 * Watch scheduler: rule scan on a short cadence, LLM gate only when candidates
 * appear, and one deep check per day. It never runs two checks for the same
 * watch at once; the service owns the active-check set.
 */

import { createPeriodicScheduler } from "./periodic.mjs";

export function createWatchScheduler({
  contexts,
  watchService,
  enabled = true,
  logger = console,
} = {}) {
  if (!contexts || !watchService) {
    throw new Error("createWatchScheduler requires contexts and watchService");
  }
  let busy = false;

  async function tick() {
    if (!enabled || busy) return;
    busy = true;
    try {
      for (const ctx of contexts.values()) {
        const current = ctx.store.getCurrentWatch();
        if (!current || !current.enabled) continue;
        const now = Date.now();
        const dueScan = !current.nextScanAt || new Date(current.nextScanAt).getTime() <= now;
        const dueDeep = Boolean(current.nextDeepAt) && new Date(current.nextDeepAt).getTime() <= now;

        if (dueScan) {
          try {
            const result = await watchService.scan(ctx, current.id);
            if (result?.errors?.length) {
              logger.warn?.(`[watch] ${ctx.id} scan warnings: ${result.errors.join("; ")}`);
            }
          } catch (error) {
            logger.warn?.(`[watch] scan failed (${ctx.id}): ${error.message}`);
          }
        }

        const fresh = ctx.store.getCurrentWatch();
        if (!fresh || !fresh.enabled) continue;
        const hasCandidates = Number(fresh.counts?.newEvents) > 0;
        if (dueDeep) {
          try {
            await watchService.runCheck(ctx, fresh.id, { trigger: "deep", force: true });
          } catch (error) {
            logger.warn?.(`[watch] deep check failed (${ctx.id}): ${error.message}`);
          }
        } else if (hasCandidates) {
          try {
            await watchService.runCheck(ctx, fresh.id, { trigger: "scan" });
          } catch (error) {
            logger.warn?.(`[watch] gate failed (${ctx.id}): ${error.message}`);
          }
        }
      }
    } catch (error) {
      logger.warn?.(`[watch] scheduler tick failed: ${error.message}`);
    } finally {
      busy = false;
    }
  }

  const loop = createPeriodicScheduler({
    name: "watch",
    tick,
    enabled,
    intervalMs: 60_000,
    initialDelayMs: 12_000,
    logger,
  });
  return Object.assign(loop, { tick });
}
