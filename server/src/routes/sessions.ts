import { Router } from "express";
import { z } from "zod";
import { currentAuth, requireUser } from "../auth/middleware.js";
import { PASSWORD_MAX_LENGTH, rejectAfterVerifyDelay, verifyPassword } from "../auth/passwords.js";
import { clearSessionCookies, createSession, revokeSession, setSessionCookies } from "../auth/sessions.js";
import { clearAttempts, enforce } from "../auth/throttle.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { isPreview } from "../preview/accounts.js";
import { HttpError } from "../http/errors.js";
import { publicUser } from "./users.js";

const signIn = z.object({
  /** Username or email address. */
  username: z.string().trim().toLowerCase().min(1, "Enter your username or email.").max(254),
  password: z.string().min(1, "Enter your password.").max(PASSWORD_MAX_LENGTH),
});

const WINDOW = 15 * 60_000;

export function sessionsRouter(db: Db, config: Config): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const body = signIn.parse(req.body ?? {});
    const accountKey = `login:${req.ip}:${body.username}`;
    await enforce(
      db,
      [
        { key: accountKey, limit: 10, windowMs: WINDOW },
        { key: `login-ip:${req.ip}`, limit: 100, windowMs: WINDOW },
      ],
      "Too many sign-in attempts. Wait 15 minutes and try again.",
    );
    const user = await db.user.findUnique({
      where: body.username.includes("@") ? { email: body.username } : { usernameKey: body.username },
    });
    const valid = user
      ? await verifyPassword(user.passwordHash, body.password)
      : await rejectAfterVerifyDelay(body.password);
    if (!user || !valid) {
      throw new HttpError(401, "INVALID_CREDENTIALS", "Incorrect username or password.");
    }
    await clearAttempts(db, accountKey);
    setSessionCookies(res, config, await createSession(db, user.id));
    res.status(201).json(publicUser(user));
  });

  /** Signs out. Signing out of a preview ends it: the preview account and its copy of the data are deleted. */
  router.delete("/current", requireUser, async (_req, res) => {
    const auth = currentAuth(res.locals);
    if (isPreview(auth.user)) await db.user.deleteMany({ where: { id: auth.user.id } });
    else await revokeSession(db, auth.sessionId);
    clearSessionCookies(res, config);
    res.status(204).end();
  });

  return router;
}
