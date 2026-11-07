import { Router } from "express";
import { currentAuth, requireUser } from "../auth/middleware.js";
import { createSession, setSessionCookies } from "../auth/sessions.js";
import { enforce } from "../auth/throttle.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { DEMO_LIFETIME_MS, createDemoAccount, isDemo, resetDemo } from "../demo/accounts.js";
import { HttpError } from "../http/errors.js";
import { publicUser } from "./users.js";

const HOUR = 60 * 60_000;

export function demoRouter(db: Db, config: Config): Router {
  const router = Router();

  /** Whether this server offers demo accounts; the sign-in page shows its demo button only then. */
  router.get("/", (_req, res) => {
    res.json({ enabled: config.demoAccounts, lifetime_days: DEMO_LIFETIME_MS / (24 * HOUR) });
  });

  /** Creates a demo account with sample data and signs this browser in to it. */
  router.post("/", async (req, res) => {
    if (!config.demoAccounts) {
      throw new HttpError(404, "DEMO_DISABLED", "This server does not offer demo accounts.");
    }
    if (res.locals.auth) throw new HttpError(409, "ALREADY_SIGNED_IN", "Sign out before starting a demo.");
    await enforce(
      db,
      [{ key: `demo:${req.ip}`, limit: 10, windowMs: HOUR }],
      "Too many demos were started from this network. Try again in an hour.",
    );
    const user = await createDemoAccount(db);
    setSessionCookies(res, config, await createSession(db, user.id));
    res.status(201).location("/api/users/me").json(publicUser(user));
  });

  /** Puts the sample data back the way it was. */
  router.post("/reset", requireUser, async (_req, res) => {
    const user = currentAuth(res.locals).user;
    if (!isDemo(user)) throw new HttpError(403, "NOT_A_DEMO", "Only demo accounts can be reset.");
    await enforce(
      db,
      [{ key: `demo-reset:${user.id}`, limit: 30, windowMs: HOUR }],
      "This demo was reset many times this hour. Try again later.",
    );
    await resetDemo(db, user.id);
    res.status(204).end();
  });

  return router;
}
