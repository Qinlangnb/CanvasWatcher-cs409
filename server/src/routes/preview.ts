import { Router } from "express";
import { currentAuth, requireUser } from "../auth/middleware.js";
import { createSession, setSessionCookies } from "../auth/sessions.js";
import { enforce } from "../auth/throttle.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { HttpError } from "../http/errors.js";
import { PREVIEW_LIFETIME_MS, createPreviewAccount, findTemplate, isPreview, resetPreview } from "../preview/accounts.js";
import { publicUser } from "./users.js";

const HOUR = 60 * 60_000;
const disabled = () => new HttpError(404, "PREVIEW_DISABLED", "This server does not offer a preview.");

export function previewRouter(db: Db, config: Config): Router {
  const router = Router();

  /** Whether this server offers previews; the sign-in page shows its Preview button only then. */
  router.get("/", async (_req, res) => {
    const template = await findTemplate(db, config.previewSource);
    res.json({ enabled: template !== null, lifetime_days: PREVIEW_LIFETIME_MS / (24 * HOUR) });
  });

  /** Creates a preview account with a scrubbed copy of the template's data and signs this browser in to it. */
  router.post("/", async (req, res) => {
    const template = await findTemplate(db, config.previewSource);
    if (!template) throw disabled();
    if (res.locals.auth) throw new HttpError(409, "ALREADY_SIGNED_IN", "Sign out before starting a preview.");
    await enforce(
      db,
      [{ key: `preview:${req.ip}`, limit: 10, windowMs: HOUR }],
      "Too many previews were started from this network. Try again in an hour.",
    );
    const user = await createPreviewAccount(db, template);
    setSessionCookies(res, config, await createSession(db, user.id));
    res.status(201).location("/api/users/me").json(publicUser(user));
  });

  /** Throws away the visitor's edits: the data is copied from the template again. */
  router.post("/reset", requireUser, async (_req, res) => {
    const user = currentAuth(res.locals).user;
    if (!isPreview(user)) throw new HttpError(403, "NOT_A_PREVIEW", "Only preview accounts can be reset.");
    const template = await findTemplate(db, config.previewSource);
    if (!template) throw disabled();
    await enforce(
      db,
      [{ key: `preview-reset:${user.id}`, limit: 30, windowMs: HOUR }],
      "This preview was reset many times this hour. Try again later.",
    );
    await resetPreview(db, user.id, template);
    res.status(204).end();
  });

  return router;
}
