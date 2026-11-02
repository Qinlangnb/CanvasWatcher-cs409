import "dotenv/config";
import { pino } from "pino";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";

const config = loadConfig();
const logger = pino({ level: config.logLevel });
const db = createDb(config.databaseUrl);
const server = createApp({ config, db, logger }).listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, "CanvasWatcher API listening");
});

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(() => {
    void db.$disconnect().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
