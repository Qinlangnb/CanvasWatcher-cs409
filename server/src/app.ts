import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import { csrfGuard, loadSession, originGuard } from "./auth/middleware.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { errorHandler, notFound } from "./http/errors.js";
import { sessionsRouter } from "./routes/sessions.js";
import { usersRouter } from "./routes/users.js";

export interface AppDependencies {
  config: Config;
  db: Db;
  logger: Logger;
}

export function createApp({ config, db, logger }: AppDependencies): Express {
  const app = express();
  app.set("trust proxy", config.trustProxy);
  app.use(helmet());
  app.use(pinoHttp({ logger, redact: ["req.headers.cookie", "res.headers['set-cookie']"] }));
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());
  app.use("/api", (_req, res, next) => {
    // Responses carry account data; never let a shared cache keep them.
    res.set("Cache-Control", "no-store");
    next();
  });

  app.get("/api/health", async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  app.use("/api", originGuard(config), loadSession(db), csrfGuard(config));
  app.use("/api/users", usersRouter(db, config));
  app.use("/api/sessions", sessionsRouter(db, config));
  app.use("/api", notFound);
  app.use(errorHandler(logger));
  return app;
}
