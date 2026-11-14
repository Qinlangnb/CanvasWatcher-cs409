import { Router } from "express";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import { enforce } from "../auth/throttle.js";
import { CanvasError } from "../canvas/client.js";
import { CanvasAddressError, canvasOrigin } from "../canvas/hosts.js";
import type { CanvasUser } from "../canvas/types.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { isPreview, previewUnavailable } from "../preview/accounts.js";
import { FieldError, HttpError } from "../http/errors.js";
import type { Services } from "../services.js";
import { presentConnection, presentRun } from "./present.js";

const connect = z.object({
  base_url: z.string().trim().min(1, "Enter your school's Canvas address.").max(2048),
  access_token: z.string().trim().min(1, "Paste your Canvas access token.").max(512, "That is too long to be a Canvas token."),
});

const HOUR = 60 * 60_000;

export const notConnected = () =>
  new HttpError(404, "CANVAS_NOT_CONNECTED", "Connect your Canvas account to get started.");

export function canvasRouter(db: Db, config: Config, services: Services): Router {
  const router = Router();

  router.get("/connection", async (_req, res) => {
    const connection = await db.canvasConnection.findUnique({ where: { userId: currentAuth(res.locals).user.id } });
    if (!connection) throw notConnected();
    res.json(presentConnection(connection));
  });

  /** Connects Canvas, or replaces the token. The token is checked with Canvas before it is stored. */
  router.put("/connection", async (req, res) => {
    const { user } = currentAuth(res.locals);
    if (isPreview(user)) throw previewUnavailable();
    const userId = user.id;
    const body = connect.parse(req.body ?? {});
    await enforce(
      db,
      [{ key: `canvas-connect:${userId}`, limit: 10, windowMs: HOUR }],
      "Too many attempts to connect Canvas. Try again in an hour.",
    );
    let baseUrl: string;
    try {
      baseUrl = canvasOrigin(body.base_url, config.canvasAllowedHosts);
    } catch (error) {
      if (error instanceof CanvasAddressError) throw new FieldError("base_url", error.message);
      throw error;
    }

    let me: CanvasUser;
    try {
      me = await services.canvas(baseUrl, body.access_token).self();
    } catch (error) {
      if (!(error instanceof CanvasError)) throw error;
      if (error.kind === "TOKEN_REJECTED") {
        throw new FieldError("access_token", "Canvas did not accept this token. Check that you copied all of it, or create a new one.");
      }
      throw new HttpError(502, "CANVAS_UNAVAILABLE", `Could not check the token with Canvas. ${error.message}`);
    }

    const canvasUserId = String(me.id);
    const now = new Date();
    const connection = await db.$transaction(async (tx) => {
      const previous = await tx.canvasConnection.findUnique({ where: { userId } });
      const switched = previous && (previous.baseUrl !== baseUrl || previous.canvasUserId !== canvasUserId);
      if (switched) {
        // Another Canvas account: its courses must not mix with the old one's.
        await tx.course.deleteMany({ where: { userId } });
        await tx.syncRun.deleteMany({ where: { userId } });
      }
      const fields = {
        baseUrl,
        tokenCiphertext: services.secrets.seal(body.access_token, userId),
        canvasUserId,
        displayName: me.name ?? me.short_name ?? "",
        status: "OK" as const,
        verifiedAt: now,
        ...(switched ? { lastSyncedAt: null, syncLeaseUntil: null } : {}),
      };
      return tx.canvasConnection.upsert({ where: { userId }, create: { userId, ...fields }, update: fields });
    });

    const sync = await services.sync.start(userId, "CONNECT");
    res.json({ connection: presentConnection(connection), sync_run: sync ? presentRun(sync.run) : null });
  });

  /** Forgets the token and everything synced from Canvas. */
  router.delete("/connection", async (_req, res) => {
    const { user } = currentAuth(res.locals);
    if (isPreview(user)) throw previewUnavailable();
    const userId = user.id;
    await db.$transaction([
      db.canvasConnection.deleteMany({ where: { userId } }),
      db.course.deleteMany({ where: { userId } }),
      db.syncRun.deleteMany({ where: { userId } }),
    ]);
    res.status(204).end();
  });

  return router;
}
