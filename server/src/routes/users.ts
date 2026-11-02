import { Router, type Request } from "express";
import { z } from "zod";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashPassword, verifyPassword } from "../auth/passwords.js";
import { currentAuth, requireUser } from "../auth/middleware.js";
import { createSession, setSessionCookies } from "../auth/sessions.js";
import { enforce } from "../auth/throttle.js";
import type { Config } from "../config.js";
import { isUniqueViolation, type Db } from "../db.js";
import type { User } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";

const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`);

const registration = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Use at least 3 characters.")
    .max(32, "Use at most 32 characters.")
    .regex(/^[A-Za-z0-9_.-]+$/, "Use only letters, numbers, dots, dashes and underscores."),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, "Use at most 254 characters.")
    .pipe(z.email("Enter a valid email address.")),
  password,
});

const passwordChange = z.object({
  current_password: z.string().min(1, "Enter your current password.").max(PASSWORD_MAX_LENGTH),
  new_password: password,
});

const HOUR = 60 * 60_000;

/** The only user fields the API ever returns. */
export function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    created_at: user.createdAt.toISOString(),
  };
}

export function usersRouter(db: Db, config: Config): Router {
  const router = Router();

  router.post("/", async (req: Request, res) => {
    await enforce(
      db,
      [{ key: `register:${req.ip}`, limit: 20, windowMs: HOUR }],
      "Too many sign-up attempts from this network. Try again in an hour.",
    );
    const body = registration.parse(req.body ?? {});
    const passwordHash = await hashPassword(body.password);
    let user: User;
    try {
      user = await db.user.create({
        data: {
          username: body.username,
          usernameKey: body.username.toLowerCase(),
          email: body.email,
          passwordHash,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "ACCOUNT_EXISTS", "That username or email is already registered. Try signing in instead.");
      }
      throw error;
    }
    setSessionCookies(res, config, await createSession(db, user.id));
    res.status(201).location("/api/users/me").json(publicUser(user));
  });

  router.get("/me", requireUser, (_req, res) => {
    res.json(publicUser(currentAuth(res.locals).user));
  });

  router.put("/me/password", requireUser, async (req, res) => {
    const auth = currentAuth(res.locals);
    const body = passwordChange.parse(req.body ?? {});
    if (!(await verifyPassword(auth.user.passwordHash, body.current_password))) {
      throw new HttpError(400, "WRONG_PASSWORD", "Your current password is incorrect.");
    }
    const passwordHash = await hashPassword(body.new_password);
    // Changing the password signs out every other device and rotates this browser's session.
    await db.$transaction([
      db.user.update({ where: { id: auth.user.id }, data: { passwordHash } }),
      db.session.deleteMany({ where: { userId: auth.user.id } }),
    ]);
    setSessionCookies(res, config, await createSession(db, auth.user.id));
    res.status(204).end();
  });

  return router;
}
