import { Router } from "express";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import { enforce } from "../auth/throttle.js";
import type { Db } from "../db.js";
import type { SyncRun } from "../generated/prisma/client.js";
import { isPreview, previewUnavailable } from "../preview/accounts.js";
import { HttpError } from "../http/errors.js";
import type { Services } from "../services.js";
import { notConnected } from "./canvas.js";
import { presentRun } from "./present.js";

const HOUR = 60 * 60_000;
const runNotFound = () => new HttpError(404, "SYNC_RUN_NOT_FOUND", "That sync could not be found.");

/** A sync the user asked for: refused while Canvas needs a new sign-in or its source is disabled. */
export async function startCanvasSync(db: Db, services: Services, userId: string): Promise<SyncRun> {
  const connection = await db.canvasConnection.findUnique({ where: { userId } });
  if (!connection) throw notConnected();
  if (connection.status === "TOKEN_REJECTED") {
    throw new HttpError(409, "CANVAS_RECONNECT_REQUIRED", "Canvas no longer accepts your access token. Reconnect Canvas in Settings.");
  }
  if ((await db.sourceConnection.count({ where: { userId, type: "CANVAS", enabled: false } })) > 0) {
    throw new HttpError(409, "SOURCE_DISABLED", "Canvas is turned off in Settings → Sources. Turn it on to sync.");
  }
  await enforce(
    db,
    [{ key: `sync:${userId}`, limit: 30, windowMs: HOUR }],
    "You have synced many times this hour. CanvasWatcher also syncs on its own; try again later.",
  );
  const result = await services.sync.start(userId, "MANUAL");
  if (!result) throw notConnected();
  return result.run;
}

export function syncRouter(db: Db, services: Services): Router {
  const router = Router();

  /** Starts a sync, or returns the one already running. Poll the Location until it finishes. */
  router.post("/", async (_req, res) => {
    const { user } = currentAuth(res.locals);
    // A preview copies someone's synced data but has no Canvas token to sync with.
    if (isPreview(user)) throw previewUnavailable();
    const run = await startCanvasSync(db, services, user.id);
    res.status(202).location(`/api/sync/runs/${run.id}`).json(presentRun(run));
  });

  router.get("/runs/latest", async (_req, res) => {
    const run = await db.syncRun.findFirst({
      where: { userId: currentAuth(res.locals).user.id },
      orderBy: { startedAt: "desc" },
    });
    if (!run) throw new HttpError(404, "NO_SYNC_RUNS", "Canvas has not been synced yet.");
    res.json(presentRun(run));
  });

  router.get("/runs/:id", async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw runNotFound();
    const run = await db.syncRun.findFirst({ where: { id: id.data, userId: currentAuth(res.locals).user.id } });
    if (!run) throw runNotFound();
    res.json(presentRun(run));
  });

  return router;
}
