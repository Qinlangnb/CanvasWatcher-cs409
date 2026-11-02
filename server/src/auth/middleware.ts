import type { Request, RequestHandler } from "express";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { User } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";
import { CSRF_HEADER, SESSION_COOKIE, findSession } from "./sessions.js";
import { csrfToken, safeEqual } from "./tokens.js";

export interface AuthContext {
  user: User;
  sessionId: string;
  token: string;
}

declare global {
  namespace Express {
    interface Locals {
      auth?: AuthContext;
    }
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function requestOrigin(req: Request): string | null {
  const origin = req.get("origin");
  if (origin && origin !== "null") return origin;
  const referer = req.get("referer");
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/** State-changing requests must come from one of our own pages (blocks cross-site form posts). */
export function originGuard(config: Config): RequestHandler {
  const allowed = new Set(config.allowedOrigins);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = requestOrigin(req);
    if (origin && allowed.has(origin)) return next();
    next(new HttpError(403, "INVALID_ORIGIN", "This request did not come from CanvasWatcher. Reload the page and try again."));
  };
}

/** Attaches the signed-in user, if any, to `res.locals.auth`. Never rejects. */
export function loadSession(db: Db): RequestHandler {
  return async (req, res, next) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token === "string" && token) {
      const session = await findSession(db, token);
      if (session) res.locals.auth = { user: session.user, sessionId: session.id, token };
    }
    next();
  };
}

/** A signed-in browser must echo its CSRF cookie in a header on every state-changing request. */
export function csrfGuard(config: Config): RequestHandler {
  return (req, res, next) => {
    const auth = res.locals.auth;
    if (SAFE_METHODS.has(req.method) || !auth) return next();
    const sent = req.get(CSRF_HEADER) ?? "";
    if (safeEqual(sent, csrfToken(config.sessionSecret, auth.token))) return next();
    next(new HttpError(403, "CSRF_REQUIRED", "Your session check failed. Reload the page and try again."));
  };
}

export const requireUser: RequestHandler = (_req, res, next) => {
  if (res.locals.auth) return next();
  next(new HttpError(401, "AUTH_REQUIRED", "Please sign in to continue."));
};

export function currentAuth(locals: Express.Locals): AuthContext {
  if (!locals.auth) throw new HttpError(401, "AUTH_REQUIRED", "Please sign in to continue.");
  return locals.auth;
}
