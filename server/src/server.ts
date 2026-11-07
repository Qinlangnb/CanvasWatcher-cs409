import "dotenv/config";
import { pino } from "pino";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { startDemoCleanup } from "./demo/accounts.js";
import { createServices } from "./services.js";
import { startScheduler } from "./sync/scheduler.js";

const config = loadConfig();
const logger = pino({ level: config.logLevel });
const db = createDb(config.databaseUrl);
const services = createServices({ config, db, logger });
await services.sync.recoverInterrupted();
const stopScheduler = startScheduler(services.sync, config.syncIntervalMinutes, logger);
const stopDemoCleanup = startDemoCleanup(db, logger);
const server = createApp({ config, db, logger, services }).listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, "CanvasWatcher API listening");
});

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  stopScheduler();
  stopDemoCleanup();
  server.close(() => {
    // Let running syncs record their result; the forced exit below caps the wait.
    void services.sync
      .whenIdle()
      .then(() => db.$disconnect())
      .finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
