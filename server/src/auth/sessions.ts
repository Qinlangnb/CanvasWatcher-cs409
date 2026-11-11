import type { Response } from "express";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { Session, User } from "../generated/prisma/client.js";
import { csrfToken, digest, newToken } from "./tokens.js";

export const SESSION_COOKIE = "aw_session";
/** Read by the frontend (`api.ts`) and echoed in the X-AW-CSRF header. */
export const CSRF_COOKIE = "aw_csrf";
export const CSRF_HEADER = "x-aw-csrf";

const MINUTE = 60_000;
const IDLE_LIFETIME = 7 * 24 * 60 * MINUTE;
const ABSOLUTE_LIFETIME = 30 * 24 * 60 * MINUTE;
/** Sliding expiry is written at most this often, so reads do not write on every request. */
const TOUCH_INTERVAL = 10 * MINUTE;

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

export type SessionWithUser = Session & { user: User };

function expiryFor(createdAt: Date, now: Date): Date {
  return new Date(Math.min(createdAt.getTime() + ABSOLUTE_LIFETIME, now.getTime() + IDLE_LIFETIME));
}

export async function createSession(db: Db, userId: string, now = new Date()): Promise<IssuedSession> {
  const token = newToken();
  const expiresAt = expiryFor(now, now);
  await db.session.create({
    data: { tokenHash: digest(token), userId, createdAt: now, lastSeenAt: now, expiresAt },
  });
  return { token, expiresAt };
}

export async function findSession(db: Db, token: string, now = new Date()): Promise<SessionWithUser | null> {
  const session = await db.session.findUnique({
    where: { tokenHash: digest(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt <= now) return null;
  // An expired demo account is about to be deleted; it no longer signs anyone in.
  if (session.user.demoExpiresAt && session.user.demoExpiresAt <= now) return null;
  if (now.getTime() - session.lastSeenAt.getTime() >= TOUCH_INTERVAL) {
    const expiresAt = expiryFor(session.createdAt, now);
    await db.session.update({ where: { id: session.id }, data: { lastSeenAt: now, expiresAt } });
    return { ...session, lastSeenAt: now, expiresAt };
  }
  return session;
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.session.deleteMany({ where: { id: sessionId } });
}

export function setSessionCookies(res: Response, config: Config, session: IssuedSession): void {
  const common = { path: config.cookiePath, sameSite: "lax", secure: config.secureCookies, expires: session.expiresAt } as const;
  res.cookie(SESSION_COOKIE, session.token, { ...common, httpOnly: true });
  res.cookie(CSRF_COOKIE, csrfToken(config.sessionSecret, session.token), { ...common, httpOnly: false });
}

export function clearSessionCookies(res: Response, config: Config): void {
  // Cleared on the path they were set on, or the browser keeps them.
  const common = { path: config.cookiePath, sameSite: "lax", secure: config.secureCookies } as const;
  res.clearCookie(SESSION_COOKIE, { ...common, httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...common, httpOnly: false });
}
