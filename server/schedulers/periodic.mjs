/**
 * A scheduler that is inert until start() is called.
 *
 * Tests can call tick() directly and stop() without waiting on timers. Importing
 * any scheduler module never creates an interval.
 */

export function createPeriodicScheduler({
  name,
  tick,
  enabled = true,
  intervalMs = 30_000,
  initialDelayMs = 3_000,
  logger = console,
} = {}) {
  if (typeof tick !== "function") throw new Error("createPeriodicScheduler requires tick");
  let interval = null;
  let initial = null;
  let running = false;
  let started = false;

  async function runTick() {
    if (running) return { skipped: true };
    running = true;
    try {
      await tick();
      return { skipped: false };
    } finally {
      running = false;
    }
  }

  function start() {
    if (started) return false;
    if (!enabled) {
      logger.log?.(`[${name}] scheduler disabled`);
      return false;
    }
    started = true;
    interval = setInterval(() => {
      void runTick();
    }, intervalMs);
    interval.unref?.();
    initial = setTimeout(() => {
      void runTick();
    }, initialDelayMs);
    initial.unref?.();
    logger.log?.(`[${name}] scheduler started (${Math.round(intervalMs / 1000)}s tick)`);
    return true;
  }

  function stop() {
    if (interval) clearInterval(interval);
    if (initial) clearTimeout(initial);
    interval = null;
    initial = null;
    started = false;
  }

  return {
    name,
    start,
    stop,
    tick: runTick,
    get running() {
      return running;
    },
    get started() {
      return started;
    },
  };
}
