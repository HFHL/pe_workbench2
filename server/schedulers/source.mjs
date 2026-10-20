/**
 * Source scheduler: polls due source bindings, reschedules with backoff on
 * failure. Import has no side effects.
 */

import { createPeriodicScheduler } from "./periodic.mjs";

export function createSourceScheduler({
  contexts,
  pollSourceBinding,
  nowIso = () => new Date().toISOString(),
  enabled = true,
  logger = console,
} = {}) {
  if (!contexts || !pollSourceBinding) {
    throw new Error("createSourceScheduler requires contexts and pollSourceBinding");
  }
  let busy = false;

  async function tick() {
    if (!enabled) return;
    if (busy) return;
    busy = true;
    try {
      for (const ctx of contexts.values()) {
        const due = ctx.store.listDueSourceBindings(new Date(), 2);
        for (const binding of due) {
          const interval = Math.max(30, Number(binding.intervalMinutes) || 360);
          try {
            const result = await pollSourceBinding(ctx, binding);
            ctx.store.updateSourceBinding(binding.id, {
              lastPolledAt: nowIso(),
              nextPollAt: new Date(Date.now() + interval * 60 * 1000).toISOString(),
            });
            if (result.events) {
              logger.log?.(`[source] ${binding.adapter} "${binding.query}" -> ${result.events} new event(s)`);
            }
          } catch (error) {
            logger.warn?.(`[source] poll failed (${binding.adapter}): ${error.message}`);
            ctx.store.updateSourceBinding(binding.id, {
              lastPolledAt: nowIso(),
              nextPollAt: new Date(Date.now() + Math.min(interval, 30) * 60 * 1000).toISOString(),
            });
          }
        }
      }
    } catch (error) {
      logger.warn?.(`[source] scheduler tick failed: ${error.message}`);
    } finally {
      busy = false;
    }
  }

  const loop = createPeriodicScheduler({
    name: "source",
    tick,
    enabled,
    intervalMs: 60_000,
    initialDelayMs: 15_000,
    logger,
  });
  return Object.assign(loop, { tick });
}
