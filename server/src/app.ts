import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import { csrfGuard, loadSession, originGuard, requireUser } from "./auth/middleware.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { errorHandler, notFound } from "./http/errors.js";
import { calendarRouter, isIcsUpload } from "./routes/calendar.js";
import { canvasRouter } from "./routes/canvas.js";
import { changesRouter } from "./routes/changes.js";
import { coursesRouter } from "./routes/courses.js";
import { filesRouter } from "./routes/files.js";
import { sessionsRouter } from "./routes/sessions.js";
import { settingsRouter } from "./routes/settings.js";
import { syncRouter } from "./routes/sync.js";
import { tasksRouter } from "./routes/tasks.js";
import { todayRouter } from "./routes/today.js";
import { usersRouter } from "./routes/users.js";
import type { Services } from "./services.js";

export interface AppDependencies {
  config: Config;
  db: Db;
  logger: Logger;
  services: Services;
}

export function createApp({ config, db, logger, services }: AppDependencies): Express {
  const app = express();
  app.set("trust proxy", config.trustProxy);
  app.use(helmet());
  app.use(pinoHttp({ logger, redact: ["req.headers.cookie", "res.headers['set-cookie']"] }));
  const json = express.json({ limit: "100kb" });
  // Calendar imports carry a whole .ics file; that route parses its own body, after sign-in is checked.
  app.use((req, res, next) => (isIcsUpload(req.method, req.path) ? next() : json(req, res, next)));
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
  // Everything below belongs to the signed-in user and is always queried with their id.
  app.use("/api/canvas", requireUser, canvasRouter(db, config, services));
  app.use("/api/sync", requireUser, syncRouter(db, services));
  app.use("/api/courses", requireUser, coursesRouter(db));
  app.use("/api/tasks", requireUser, tasksRouter(db));
  app.use("/api/files", requireUser, filesRouter(db, services));
  app.use("/api/changes", requireUser, changesRouter(db));
  app.use("/api/today", requireUser, todayRouter(db));
  app.use("/api/calendar", requireUser, calendarRouter(db));
  app.use("/api/settings", requireUser, settingsRouter(db));
  app.use("/api", notFound);
  app.use(errorHandler(logger));
  return app;
}
