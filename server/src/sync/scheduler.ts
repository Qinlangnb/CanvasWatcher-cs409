import type { Logger } from "pino";
import type { SyncService } from "./service.js";

const TICK_MS = 60_000;

/** Every minute, starts syncs for connections not synced within the interval. Returns a stop function. */
export function startScheduler(sync: SyncService, intervalMinutes: number, logger: Logger): () => void {
  if (intervalMinutes <= 0) return () => {};
  const tick = () => {
    sync
      .startDue(intervalMinutes * 60_000)
      .then((started) => {
        if (started > 0) logger.info({ started }, "scheduled syncs started");
      })
      .catch((error: unknown) => logger.error({ err: error }, "sync scheduler failed"));
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
