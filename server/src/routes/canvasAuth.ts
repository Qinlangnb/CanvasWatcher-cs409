import { createHash, randomBytes } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import { enforce } from "../auth/throttle.js";
import { CanvasError, type CanvasAuth } from "../canvas/client.js";
import {
  accountMismatch,
  endOfDay,
  expiration,
  METHOD_LABELS,
  methodFromName,
  methodName,
  METHODS,
  priority,
  usable,
  type Method,
} from "../canvas/credentials.js";
import { CanvasAddressError, canvasOrigin } from "../canvas/hosts.js";
import { callbackPage, exchangeOAuth } from "../canvas/oauth.js";
import { parseSessionImport, SessionImportError } from "../canvas/sessionImport.js";
import type { CanvasUser } from "../canvas/types.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { CanvasCredential } from "../generated/prisma/client.js";
import { FieldError, HttpError } from "../http/errors.js";
import { isPreview, previewUnavailable } from "../preview/accounts.js";
import type { Services } from "../services.js";
import { presentRun } from "./present.js";

const HOUR = 60 * 60_000;
const OAUTH_STATE_TTL_MS = 240_000;
/** Pending OAuth authorizations across all users; one per user. */
const MAX_OAUTH_STATES = 256;

/** The page-side boundary of the original app: these calls carry X-AW-Broker: 1 as well as the CSRF header. */
export const brokerHeader: RequestHandler = (req, _res, next) => {
  if (req.get("x-aw-broker") === "1") return next();
  next(new HttpError(403, "AUTH_ORIGIN_DENIED", "This request is missing its sign-in header. Reload the page and try again."));
};

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

function slotStatus(row: CanvasCredential | undefined, method: Method, now: Date) {
  const base = {
    present: usable(row),
    generation: row?.generation ?? 0,
    credential_type: methodName(method),
    state: usable(row) ? row.state : row && row.state !== "VALID" ? row.state : "MISSING",
    last_verified_at: iso(row?.verifiedAt),
    last_success_at: iso(row?.lastSuccessAt),
    last_failure_at: iso(row?.failedAt),
    last_failure_reason: row?.failureReason ?? null,
    account_identity_fingerprint: usable(row) ? row.accountFingerprint : null,
    expires_at: usable(row) || method === "PAT" ? iso(row?.expiresAt) : null,
  };
  if (method !== "PAT") return base;
  const lifecycle = expiration(usable(row) ? row.expiresAt : null, now);
  return {
    ...base,
    expiration_source: row?.expirationSource ?? "UNKNOWN",
    origin: "server",
    days_remaining: lifecycle.days,
    expiration_state: usable(row) ? lifecycle.state : "unknown",
  };
}

/** Everything the Sources page shows about the Canvas sign-in, in the original app's shape. */
export async function canvasStatus(db: Db, services: Services, userId: string) {
  await services.credentials.refreshLifecycle(userId);
  const now = new Date();
  const [source, binding, rows] = await Promise.all([
    db.sourceConnection.findFirst({ where: { userId, type: "CANVAS" } }),
    db.canvasConnection.findUnique({ where: { userId } }),
    services.credentials.rows(userId),
  ]);
  const effective = priority(binding?.preferredMethod).find((method) => usable(rows.get(method))) ?? null;
  const credentials = Object.fromEntries(METHODS.map((method) => [methodName(method), slotStatus(rows.get(method), method, now)]));
  const valid = METHODS.filter((method) => usable(rows.get(method)) && rows.get(method)?.state === "VALID").length;
  const pat = rows.get("PAT");
  const patActive = effective === "PAT" && usable(pat);
  const lifecycle = expiration(patActive ? pat.expiresAt : null, now);
  const state = !source && !binding ? "NOT_CONFIGURED" : effective && binding?.status === "OK" ? "ACTIVE" : "AUTH_REQUIRED";
  return {
    configured: Boolean(source || binding),
    credential_id: source?.id ?? null,
    base_url: binding?.baseUrl ?? source?.baseUrl ?? null,
    // Every secret is sealed in the database, so credentials survive restarts.
    credential_storage: "server_encrypted",
    auth_mode: effective ? methodName(effective) : null,
    credential_state: state,
    connection_state: state,
    preferred_method: binding?.preferredMethod ? methodName(binding.preferredMethod) : null,
    effective_method: effective ? methodName(effective) : null,
    backup_ready: valid >= 2,
    credentials,
    fallback: (binding?.fallback as Record<string, string> | null) ?? null,
    source_health: source?.health ?? "UNKNOWN",
    verified: state === "ACTIVE" && rows.get(effective as Method)?.state === "VALID",
    verified_at: iso(effective ? rows.get(effective)?.verifiedAt : null),
    account_id: binding?.canvasUserId ?? null,
    account_display_name: binding?.displayName ?? null,
    expires_at: patActive ? iso(pat.expiresAt) : null,
    days_remaining: patActive ? lifecycle.days : null,
    expiration_state: patActive ? lifecycle.state : "unknown",
    expiration_source: patActive ? (pat.expirationSource ?? "UNKNOWN") : null,
  };
}

/** The Canvas site a credential is for: the one asked for, else the bound account's, else the Canvas source's. */
export async function resolveCanvasBase(db: Db, config: Config, userId: string, input: string | undefined): Promise<string> {
  if (input?.trim()) {
    try {
      return canvasOrigin(input, config.canvasAllowedHosts);
    } catch (error) {
      if (error instanceof CanvasAddressError) throw new FieldError("base_url", error.message);
      throw error;
    }
  }
  const binding = await db.canvasConnection.findUnique({ where: { userId } });
  if (binding) return binding.baseUrl;
  const source = await db.sourceConnection.findFirst({ where: { userId, type: "CANVAS" } });
  if (source) return source.baseUrl;
  throw new FieldError("base_url", "Enter your school's Canvas address.");
}

export interface CandidateOptions {
  method: Method;
  baseUrl: string;
  auth: CanvasAuth;
  /** What is stored in the slot when it works. */
  secret: string;
  /** The form field to blame when Canvas rejects the candidate and there is nothing to keep. */
  field: string;
  rejectedMessage: string;
  expiresAt?: Date | null;
  expirationSource?: string | null;
}

/**
 * Checks a candidate credential with Canvas and stores it. A rejected candidate never replaces a
 * working credential (replacement_invalid); one for another account never replaces the bound one.
 */
export async function verifyAndInstall(db: Db, services: Services, userId: string, candidate: CandidateOptions) {
  const current = await db.canvasCredential.findUnique({ where: { userId_method: { userId, method: candidate.method } } });
  const binding = await db.canvasConnection.findUnique({ where: { userId } });
  if (binding && binding.baseUrl !== candidate.baseUrl) throw accountMismatch();
  let me: CanvasUser;
  try {
    me = await services.credentials.probe(candidate.baseUrl, candidate.auth);
  } catch (error) {
    if (!(error instanceof CanvasError)) throw error;
    if (error.kind === "TOKEN_REJECTED") {
      if (usable(current)) {
        throw new HttpError(409, "replacement_invalid", "Canvas did not accept the new credential. The current one was kept.");
      }
      throw new FieldError(candidate.field, candidate.rejectedMessage);
    }
    throw new HttpError(502, "CANVAS_UNAVAILABLE", `Could not check the credential with Canvas. ${error.message}`);
  }
  if (binding && String(me.id) !== binding.canvasUserId) throw accountMismatch();
  await services.credentials.install(userId, candidate.method, {
    secret: candidate.secret,
    baseUrl: candidate.baseUrl,
    account: me,
    expiresAt: candidate.expiresAt,
    expirationSource: candidate.expirationSource,
    expectedGeneration: current?.generation ?? 0,
  });
  const sync = await services.sync.start(userId, "CONNECT");
  return { verified: true, method: methodName(candidate.method), sync_run: sync ? presentRun(sync.run) : null };
}

const patBody = z.object({
  base_url: z.string().trim().max(2048).optional(),
  token: z.string().trim().min(1, "Paste your Canvas access token.").max(512, "That is too long to be a Canvas token."),
  expiration_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date as YYYY-MM-DD.")
    .nullish(),
});

const sessionBody = z.object({
  base_url: z.string().trim().max(2048).optional(),
  session_import: z.string().min(1, "Paste the Cookie header or the copied cURL request.").max(131_072, "That is too long to be a Canvas session (128 KB at most)."),
});

const preferredBody = z.object({ method: z.enum(["pat", "browser_session", "oauth"]).nullable() });

function methodParam(value: unknown): Method {
  const method = typeof value === "string" ? methodFromName(value) : null;
  if (!method) throw new HttpError(404, "NOT_FOUND", "There is no such Canvas sign-in method.");
  return method;
}

async function throttle(db: Db, userId: string): Promise<void> {
  await enforce(db, [{ key: `canvas-connect:${userId}`, limit: 20, windowMs: HOUR }], "Too many attempts to connect Canvas. Try again in an hour.");
}

function requireNotPreview(locals: Express.Locals): string {
  const { user } = currentAuth(locals);
  if (isPreview(user)) throw previewUnavailable();
  return user.id;
}

/** Credential slots, preferred method and OAuth start. Mounted at /api/auth/canvas for signed-in users. */
export function canvasAuthRouter(db: Db, config: Config, services: Services): Router {
  const router = Router();

  router.get("/status", async (_req, res) => {
    res.json(await canvasStatus(db, services, currentAuth(res.locals).user.id));
  });

  /** Imports (or replaces) the personal access token, with an optional expiry date. */
  router.post("/pat", async (req, res) => {
    const userId = requireNotPreview(res.locals);
    const body = patBody.parse(req.body ?? {});
    await throttle(db, userId);
    const baseUrl = await resolveCanvasBase(db, config, userId, body.base_url);
    let expiresAt: Date | null = null;
    if (body.expiration_date) {
      const settings = await db.userSettings.findUnique({ where: { userId } });
      expiresAt = endOfDay(body.expiration_date, settings?.timeZone ?? "America/Chicago");
      if (expiresAt <= new Date()) throw new FieldError("expiration_date", "That date has passed. Enter when the token expires.");
    }
    res.json(
      await verifyAndInstall(db, services, userId, {
        method: "PAT",
        baseUrl,
        auth: body.token,
        secret: body.token,
        field: "token",
        rejectedMessage: "Canvas did not accept this token. Check that you copied all of it, or create a new one.",
        expiresAt,
        expirationSource: expiresAt ? "USER_ENTERED" : "UNKNOWN",
      }),
    );
  });

  /** Imports a browser session from a Cookie header or a copied cURL request. */
  router.post("/browser-session", async (req, res) => {
    const userId = requireNotPreview(res.locals);
    const body = sessionBody.parse(req.body ?? {});
    await throttle(db, userId);
    const baseUrl = await resolveCanvasBase(db, config, userId, body.base_url);
    let cookies: Map<string, string>;
    try {
      cookies = parseSessionImport(body.session_import);
    } catch (error) {
      if (error instanceof SessionImportError) throw new FieldError("session_import", error.message);
      throw error;
    }
    try {
      res.json(
        await verifyAndInstall(db, services, userId, {
          method: "BROWSER_SESSION",
          baseUrl,
          auth: { kind: "browser_session", cookies },
          secret: JSON.stringify(Object.fromEntries(cookies)),
          field: "session_import",
          rejectedMessage: "Canvas did not accept this session. Sign in to Canvas in your browser and copy a fresh request.",
        }),
      );
    } finally {
      cookies.clear();
      body.session_import = "";
    }
  });

  /** Removes one slot. With ?generation=, only if it is still that credential. */
  router.delete("/methods/:method", async (req, res) => {
    const userId = requireNotPreview(res.locals);
    const method = methodParam(req.params.method);
    const generation = req.query.generation === undefined ? undefined : Number(req.query.generation);
    if (generation !== undefined && !Number.isInteger(generation)) throw new FieldError("generation", "Generation must be a whole number.");
    const row = await db.canvasCredential.findUnique({ where: { userId_method: { userId, method } } });
    if (generation !== undefined && (row?.generation ?? 0) !== generation) {
      throw new HttpError(409, "stale_generation", "This credential changed in the meantime. Reload and try again.");
    }
    await services.credentials.remove(userId, method, { generation: row?.generation, state: "MISSING", reason: "REMOVED" });
    if (![...(await services.credentials.rows(userId)).values()].some(usable)) {
      await services.credentials.markAuthRequired(userId, { quiet: true });
    }
    res.status(204).end();
  });

  /** Asks Canvas whether one slot still signs in as the bound account. */
  router.post("/methods/:method/verify", async (req, res) => {
    const userId = requireNotPreview(res.locals);
    const method = methodParam(req.params.method);
    const [row, binding] = await Promise.all([
      db.canvasCredential.findUnique({ where: { userId_method: { userId, method } } }),
      db.canvasConnection.findUnique({ where: { userId } }),
    ]);
    if (!usable(row) || !binding) throw new HttpError(404, "CREDENTIAL_MISSING", `There is no ${METHOD_LABELS[method]} to verify.`);
    let verified = false;
    try {
      const secret = await services.credentials.open(row);
      const me = await services.credentials.probe(binding.baseUrl, services.credentials.authFor(method, secret));
      if (String(me.id) === binding.canvasUserId) {
        await services.credentials.markVerified(userId, method, row.generation);
        verified = true;
      } else {
        await services.credentials.remove(userId, method, { generation: row.generation, state: "REVOKED", reason: "ACCOUNT_CHANGED" });
      }
    } catch (error) {
      if (!(error instanceof CanvasError)) throw error;
      if (error.kind !== "TOKEN_REJECTED") throw new HttpError(502, "CANVAS_UNAVAILABLE", error.message);
      await services.credentials.remove(userId, method, { generation: row.generation, reason: "TOKEN_REJECTED" });
    }
    if (verified) await db.canvasConnection.updateMany({ where: { userId }, data: { status: "OK" } });
    res.json({ verified, method: methodName(method) });
  });

  /** The method to use first when it works; null restores OAuth → PAT → browser session. */
  router.put("/preferred", async (req, res) => {
    const userId = requireNotPreview(res.locals);
    const body = preferredBody.parse(req.body ?? {});
    const updated = await db.canvasConnection.updateMany({
      where: { userId },
      data: { preferredMethod: body.method ? methodFromName(body.method) : null },
    });
    if (updated.count === 0) throw new HttpError(404, "CANVAS_NOT_CONNECTED", "Sign in to Canvas first.");
    res.json(await canvasStatus(db, services, userId));
  });

  /** Signs out of every method but keeps the account binding and all synced course data. */
  router.delete("/credentials", async (_req, res) => {
    const userId = requireNotPreview(res.locals);
    for (const method of METHODS) {
      await services.credentials.remove(userId, method, { state: "MISSING", reason: "CLEARED" });
    }
    await services.credentials.markAuthRequired(userId, { quiet: true });
    res.status(204).end();
  });

  router.get("/oauth/capability", async (_req, res) => {
    res.json({ configured: services.credentials.oauth !== null, reason: services.credentials.oauth ? null : "CANVAS_OAUTH_NOT_CONFIGURED" });
  });

  /** Returns Canvas's authorization page address; the state is single use, bound to this user, 240 s. */
  router.post("/oauth/start", brokerHeader, async (_req, res) => {
    const userId = requireNotPreview(res.locals);
    const oauth = services.credentials.oauth;
    if (!oauth) throw new HttpError(409, "CANVAS_OAUTH_NOT_CONFIGURED", "Canvas OAuth is not set up on this server.");
    const baseUrl = await resolveCanvasBase(db, config, userId, undefined);
    const now = new Date();
    await db.canvasOAuthState.deleteMany({ where: { OR: [{ userId }, { expiresAt: { lt: now } }] } });
    if ((await db.canvasOAuthState.count()) >= MAX_OAUTH_STATES) {
      throw new HttpError(409, "CANVAS_OAUTH_BUSY", "Too many Canvas authorizations are pending. Try again in a few minutes.");
    }
    const state = randomBytes(32).toString("base64url");
    const current = await db.canvasCredential.findUnique({ where: { userId_method: { userId, method: "OAUTH" } } });
    await db.canvasOAuthState.create({
      data: {
        stateHash: createHash("sha256").update(state).digest("hex"),
        userId,
        generation: current?.generation ?? 0,
        baseUrl,
        redirectUri: oauth.redirectUri,
        expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
      },
    });
    const url = new URL("/login/oauth2/auth", baseUrl);
    url.search = new URLSearchParams({ client_id: oauth.clientId, response_type: "code", redirect_uri: oauth.redirectUri, state }).toString();
    res.json({ authorization_url: url.toString() });
  });

  return router;
}

/**
 * Canvas sends the browser back here after authorization. The user comes from the state row, not the
 * session. The page says only "connected" or "failed"; nothing from Canvas is reflected or logged.
 */
export function canvasOAuthCallback(db: Db, services: Services): RequestHandler {
  return async (req, res) => {
    let success = false;
    try {
      const oauth = services.credentials.oauth;
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const code = typeof req.query.code === "string" ? req.query.code : "";
      if (!oauth || !state || state.length > 128 || !code || code.length > 8192) throw new Error("invalid");
      if (req.hostname !== new URL(oauth.redirectUri).hostname) throw new Error("host");
      const stateHash = createHash("sha256").update(state).digest("hex");
      const row = await db.canvasOAuthState.findUnique({ where: { stateHash } });
      // Single use: whoever deletes the row owns the state.
      const consumed = await db.canvasOAuthState.deleteMany({ where: { stateHash } });
      if (!row || consumed.count === 0 || row.expiresAt <= new Date() || row.redirectUri !== oauth.redirectUri) throw new Error("state");
      const result = await exchangeOAuth(services.credentials, row.baseUrl, {
        grant_type: "authorization_code",
        code,
      });
      await services.credentials.install(row.userId, "OAUTH", {
        secret: JSON.stringify(result.tokens),
        baseUrl: row.baseUrl,
        account: result.account,
        expiresAt: result.expiresAt,
        expirationSource: "CANVAS_API",
        expectedGeneration: row.generation,
      });
      await services.sync.start(row.userId, "CONNECT");
      success = true;
    } catch {
      success = false;
    }
    res
      .status(success ? 200 : 400)
      .set({
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      })
      .type("html")
      .send(callbackPage(success));
  };
}
