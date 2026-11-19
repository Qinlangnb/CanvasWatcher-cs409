import { Router } from "express";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import { enforce } from "../auth/throttle.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { isPreview, previewUnavailable } from "../preview/accounts.js";
import { FieldError, HttpError } from "../http/errors.js";
import type { Services } from "../services.js";
import { resolveCanvasBase, verifyAndInstall } from "./canvasAuth.js";
import { presentConnection } from "./present.js";

const connect = z.object({
  base_url: z.string().trim().min(1, "Enter your school's Canvas address.").max(2048),
  access_token: z.string().trim().min(1, "Paste your Canvas access token.").max(512, "That is too long to be a Canvas token."),
});

const HOUR = 60 * 60_000;

export const notConnected = () =>
  new HttpError(404, "CANVAS_NOT_CONNECTED", "Connect your Canvas account to get started.");

/** Deletes the Canvas binding, every credential slot and everything synced from Canvas. */
export async function disconnectCanvas(db: Db, userId: string): Promise<void> {
  await db.$transaction([
    db.canvasConnection.deleteMany({ where: { userId } }),
    db.canvasCredential.deleteMany({ where: { userId } }),
    db.canvasOAuthState.deleteMany({ where: { userId } }),
    db.sourceConnection.deleteMany({ where: { userId, type: "CANVAS" } }),
    db.course.deleteMany({ where: { userId } }),
    db.syncRun.deleteMany({ where: { userId } }),
  ]);
}

/**
 * The original single-token flow (welcome page). It imports a PAT into the PAT slot; Settings → Sources
 * has every other method.
 */
export function canvasRouter(db: Db, config: Config, services: Services): Router {
  const router = Router();

  router.get("/connection", async (_req, res) => {
    const connection = await db.canvasConnection.findUnique({ where: { userId: currentAuth(res.locals).user.id } });
    if (!connection) throw notConnected();
    res.json(presentConnection(connection));
  });

  /**
   * Connects Canvas, or replaces the token. The token is checked with Canvas before it is stored. Once an
   * account is connected, a token for another account or site is refused (account_mismatch); switching
   * accounts means disconnecting first, which deletes the old account's data.
   */
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
    const baseUrl = await resolveCanvasBase(db, config, userId, body.base_url);
    let result;
    try {
      result = await verifyAndInstall(db, services, userId, {
        method: "PAT",
        baseUrl,
        auth: body.access_token,
        secret: body.access_token,
        field: "access_token",
        rejectedMessage: "Canvas did not accept this token. Check that you copied all of it, or create a new one.",
        expirationSource: "UNKNOWN",
      });
    } catch (error) {
      // This form has one token field: a rejected replacement is reported there too.
      if (error instanceof HttpError && error.code === "replacement_invalid") {
        throw new FieldError("access_token", "Canvas did not accept this token. Check that you copied all of it, or create a new one.");
      }
      throw error;
    }
    const connection = await db.canvasConnection.findUniqueOrThrow({ where: { userId } });
    res.json({ connection: presentConnection(connection), sync_run: result.sync_run });
  });

  /** Forgets every Canvas credential and everything synced from Canvas. */
  router.delete("/connection", async (_req, res) => {
    const { user } = currentAuth(res.locals);
    if (isPreview(user)) throw previewUnavailable();
    await disconnectCanvas(db, user.id);
    res.status(204).end();
  });

  return router;
}
