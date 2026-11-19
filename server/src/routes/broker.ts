import express, { Router, type ErrorRequestHandler, type Request } from "express";
import { z, ZodError } from "zod";
import { currentAuth } from "../auth/middleware.js";
import { ChallengeError, ChallengeStore, type Identity } from "../broker/challenges.js";
import { CanvasError } from "../canvas/client.js";
import { usable } from "../canvas/credentials.js";
import { canvasOrigin } from "../canvas/hosts.js";
import { brokerCookies } from "../canvas/sessionImport.js";
import type { CanvasUser } from "../canvas/types.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { AuthChallenge, Prisma } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";
import { isPreview, previewUnavailable } from "../preview/accounts.js";
import type { Services } from "../services.js";
import { clearProviderSession, storeProviderSession } from "../sources/providerSessions.js";
import { verifyProviderSession, type ProviderType } from "../sources/registry.js";
import { brokerHeader } from "./canvasAuth.js";

// The Auth Broker protocol (v1) between this server, the page and the desktop helper in auth-broker/.
// Page side (signed in, Origin + CSRF + X-AW-Broker: 1): configuration, challenges, status, cancel.
// Broker side (no Origin, no Sec-Fetch-Site, no cookies, X-AW-Broker: 1): claim, failed, complete. These
// are mounted before the session and CSRF middleware and find their user only through the challenge row.

/** The broker-side paths, which parse their own (larger) JSON body. */
export const BROKER_BOUNDARY_PATHS = new Set(["/api/auth/broker/claim", "/api/auth/broker/failed", "/api/auth/broker/complete"]);

const PROVIDERS = ["canvas", "gradescope", "prairielearn", "all"] as const;
const PROVIDER_TYPES: Record<string, ProviderType> = { gradescope: "GRADESCOPE", prairielearn: "PRAIRIELEARN" };

const identity = {
  challenge_id: z.string().min(16).max(128),
  instance_id: z.string().min(16).max(128),
  provider: z.enum(PROVIDERS),
};
const newChallenge = z
  .object({
    provider: z.enum(PROVIDERS),
    credential_id: z.string().max(120).default(""),
    operation: z.enum(["login", "clear", "clear_all"]).default("login"),
  })
  .strict();
const control = z.object({ ...identity, control_token: z.string().min(1).max(256) }).strict();
const claim = z.object({ ...identity, one_time_token: z.string().min(1).max(256) }).strict();
const failure = z
  .object({ ...identity, exchange_token: z.string().min(1).max(256), reason: z.enum(["AUTH_LOGIN_FAILED", "AUTH_USER_CANCELLED", "AUTH_LOGIN_TIMEOUT"]) })
  .strict();
const completion = z
  .object({
    ...identity,
    exchange_token: z.string().min(1).max(256),
    cookies: z
      .record(z.string().max(16_384), z.string().max(16_384))
      .default({})
      .refine((cookies) => Object.keys(cookies).length <= 100),
  })
  .strict();

const ident = (body: Identity): Identity => ({ challenge_id: body.challenge_id, instance_id: body.instance_id, provider: body.provider });

/** Page side: mounted at /api/auth/broker after the session and CSRF guards. */
export function brokerRouter(db: Db, config: Config, services: Services, store: ChallengeStore): Router {
  const router = Router();

  router.get("/configuration", (_req, res) => {
    res.json({ broker_url: config.authBrokerUrl, protocol_version: 1 });
  });

  router.post("/challenges", brokerHeader, async (req, res) => {
    const { user } = currentAuth(res.locals);
    if (isPreview(user)) throw previewUnavailable();
    const userId = user.id;
    const body = newChallenge.parse(req.body ?? {});
    if ((body.provider === "all") !== (body.operation === "clear_all")) {
      throw new HttpError(422, "AUTH_OPERATION_INVALID", "Clearing all sessions is the only operation for every provider.");
    }
    let target: Record<string, unknown>;
    if (body.operation === "clear_all") {
      const [canvas, providers] = await Promise.all([
        db.sourceConnection.findFirst({ where: { userId, type: "CANVAS" } }),
        db.providerSession.findMany({ where: { userId } }),
      ]);
      const session = await db.canvasCredential.findUnique({ where: { userId_method: { userId, method: "BROWSER_SESSION" } } });
      target = {
        credential_id: "all",
        generations: canvas ? { [canvas.id]: session?.generation ?? 0 } : {},
        provider_generations: Object.fromEntries(providers.map((row) => [row.connectionId, row.generation])),
      };
    } else if (body.provider === "canvas") {
      const source = await db.sourceConnection.findFirst({
        where: { userId, type: "CANVAS", ...(body.credential_id ? { id: validId(body.credential_id) } : {}) },
      });
      if (!source) throw new HttpError(404, "AUTH_PROFILE_NOT_FOUND", "Add Canvas in Settings → Sources first.");
      let baseUrl: string;
      try {
        baseUrl = canvasOrigin(source.baseUrl, config.canvasAllowedHosts);
      } catch {
        throw new HttpError(422, "AUTH_PROVIDER_NOT_CONFIGURED", "This Canvas address is not supported.");
      }
      const session = await db.canvasCredential.findUnique({ where: { userId_method: { userId, method: "BROWSER_SESSION" } } });
      target = { base_url: baseUrl, credential_id: source.id, generation: session?.generation ?? 0 };
    } else {
      const source = await db.sourceConnection.findFirst({
        where: { userId, id: validId(body.credential_id), type: PROVIDER_TYPES[body.provider] },
        include: { providerSession: true },
      });
      if (!source) throw new HttpError(404, "AUTH_PROFILE_NOT_FOUND", "That source could not be found.");
      target = { base_url: source.baseUrl, credential_id: source.id, generation: source.providerSession?.generation ?? 0 };
    }
    res.json(await store.create(userId, body.provider, body.operation, target));
  });

  router.post("/status", brokerHeader, async (req, res) => {
    const body = control.parse(req.body ?? {});
    res.json(await store.control(currentAuth(res.locals).user.id, ident(body), body.control_token));
  });

  router.post("/cancel", brokerHeader, async (req, res) => {
    const body = control.parse(req.body ?? {});
    res.json(await store.control(currentAuth(res.locals).user.id, ident(body), body.control_token, true));
  });

  router.use(((error, _req, res, next) => {
    if (error instanceof ChallengeError) {
      res.status(error.code === "AUTH_BROKER_BUSY" ? 429 : 409).json({ detail: brokerMessage(error.code), code: error.code });
      return;
    }
    next(error);
  }) as ErrorRequestHandler);

  return router;
}

function validId(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new HttpError(404, "AUTH_PROFILE_NOT_FOUND", "That source could not be found.");
  return value;
}

function brokerMessage(code: string): string {
  if (code === "AUTH_BROKER_BUSY") return "Too many sign-ins are waiting. Cancel one or try again in a few minutes.";
  if (code === "AUTH_CHALLENGE_EXPIRED") return "This sign-in expired. Start it again.";
  return "This sign-in is no longer valid. Start it again.";
}

class AccountMismatch extends Error {}

/** Broker side: mounted at /api/auth/broker before the origin, session and CSRF middleware. */
export function brokerBoundaryRouter(db: Db, services: Services, store: ChallengeStore): Router {
  const router = Router();

  // Only the desktop helper may call these: a browser always adds Origin or Sec-Fetch-Site, which
  // page scripts cannot remove.
  router.use((req: Request, res, next) => {
    if (!BROKER_BOUNDARY_PATHS.has(req.baseUrl + req.path)) return next("router");
    if (req.method !== "POST" || req.get("origin") !== undefined || req.get("sec-fetch-site") !== undefined || req.get("x-aw-broker") !== "1") {
      res.status(403).json({ detail: "AUTH_BROKER_ONLY", code: "AUTH_BROKER_ONLY" });
      return;
    }
    next();
  });
  // 100 cookies of up to 16 KB each.
  router.use(express.json({ limit: "2mb" }));

  router.post("/claim", async (req, res) => {
    const body = claim.parse(req.body ?? {});
    res.json(await store.claim(ident(body), body.one_time_token));
  });

  router.post("/failed", async (req, res) => {
    const body = failure.parse(req.body ?? {});
    const row = await store.beginCompletion(ident(body), body.exchange_token);
    await store.fail(row, body.reason);
    res.json({ state: "FAILED", reason: body.reason });
  });

  router.post("/complete", async (req, res) => {
    const body = completion.parse(req.body ?? {});
    const row = await store.beginCompletion(ident(body), body.exchange_token);
    let cookies: Map<string, string> | null = null;
    try {
      cookies = brokerCookies(body.cookies);
      if (!cookies) throw new Error("invalid cookie");
      await complete(db, services, store, row, cookies);
      if (row.provider === "canvas" && row.operation === "login") await services.sync.start(row.userId, "CONNECT");
      res.json({ state: "AUTHENTICATED" });
    } catch (error) {
      if (error instanceof AccountMismatch) {
        await store.fail(row, "CANVAS_ACCOUNT_MISMATCH");
        res.status(409).json({ detail: "CANVAS_ACCOUNT_MISMATCH", code: "CANVAS_ACCOUNT_MISMATCH" });
        return;
      }
      if (error instanceof ChallengeError) throw error;
      await store.fail(row, "AUTH_LOGIN_FAILED");
      res.status(409).json({ detail: "AUTH_LOGIN_FAILED", code: "AUTH_LOGIN_FAILED" });
    } finally {
      // Drop every reference to the captured cookies.
      cookies?.clear();
      for (const name of Object.keys(body.cookies)) delete body.cookies[name];
    }
  });

  router.use(((error, _req, res, _next) => {
    if (error instanceof ChallengeError) {
      res.status(409).json({ detail: error.code, code: error.code });
      return;
    }
    if (error instanceof ZodError || (error as { type?: string })?.type === "entity.parse.failed" || error instanceof SyntaxError) {
      res.status(422).json({ detail: "AUTH_REQUEST_INVALID", code: "AUTH_REQUEST_INVALID" });
      return;
    }
    if ((error as { type?: string })?.type === "entity.too.large") {
      res.status(413).json({ detail: "AUTH_REQUEST_INVALID", code: "AUTH_REQUEST_INVALID" });
      return;
    }
    res.status(500).json({ detail: "AUTH_BROKER_ERROR", code: "AUTH_BROKER_ERROR" });
  }) as ErrorRequestHandler);

  return router;
}

/** Checks what the broker captured and publishes it in the same transaction that finishes the challenge. */
async function complete(db: Db, services: Services, store: ChallengeStore, row: AuthChallenge, cookies: Map<string, string>): Promise<void> {
  const target = row.target as {
    base_url?: string;
    credential_id: string;
    generation?: number;
    generations?: Record<string, number>;
    provider_generations?: Record<string, number>;
  };
  const userId = row.userId;

  if (row.operation === "clear_all") {
    await store.finish(row, async (tx) => {
      for (const expected of Object.values(target.generations ?? {})) {
        await services.credentials.remove(userId, "BROWSER_SESSION", { generation: expected, state: "MISSING", reason: "CLEARED" }, tx);
      }
      for (const [connectionId, expected] of Object.entries(target.provider_generations ?? {})) {
        await clearProviderSession(tx, userId, connectionId, { expectedGeneration: expected });
      }
      await afterCanvasChange(tx, services, userId);
    });
    return;
  }

  const baseUrl = target.base_url as string;
  const expected = target.generation ?? 0;
  if (row.provider === "canvas") {
    if (row.operation === "clear") {
      await store.finish(row, async (tx) => {
        await services.credentials.remove(userId, "BROWSER_SESSION", { generation: expected, state: "MISSING", reason: "CLEARED" }, tx);
        await afterCanvasChange(tx, services, userId);
      });
      return;
    }
    if (cookies.size === 0) throw new Error("no cookies");
    let account: CanvasUser;
    try {
      account = await services.credentials.probe(baseUrl, { kind: "browser_session", cookies });
    } catch (error) {
      if (error instanceof CanvasError) throw new Error("probe failed");
      throw error;
    }
    const binding = await db.canvasConnection.findUnique({ where: { userId } });
    if (binding && (binding.baseUrl !== baseUrl || binding.canvasUserId !== String(account.id))) throw new AccountMismatch();
    await store.finish(row, async (tx) => {
      try {
        await services.credentials.install(
          userId,
          "BROWSER_SESSION",
          { secret: JSON.stringify(Object.fromEntries(cookies)), baseUrl, account, expectedGeneration: expected },
          tx,
        );
      } catch (error) {
        if (error instanceof HttpError && error.code === "account_mismatch") throw new AccountMismatch();
        throw error;
      }
    });
    return;
  }

  const provider = PROVIDER_TYPES[row.provider];
  if (!provider) throw new Error("unknown provider");
  if (row.operation === "clear") {
    await store.finish(row, async (tx) => {
      await clearProviderSession(tx, userId, target.credential_id, { expectedGeneration: expected });
    });
    return;
  }
  const verification = await verifyProviderSession(provider, baseUrl, cookies);
  if (!verification.ok) throw new Error("provider rejected");
  await store.finish(row, async (tx) => {
    const source = await tx.sourceConnection.findFirst({ where: { id: target.credential_id, userId, type: provider } });
    if (!source || source.baseUrl !== baseUrl) throw new Error("source changed");
    if (!(await storeProviderSession(tx, services.secrets, userId, source.id, cookies, expected))) throw new Error("credential changed");
  });
}

/** After a browser session is cleared: with no other working slot, Canvas now needs a sign-in. */
async function afterCanvasChange(tx: Prisma.TransactionClient, services: Services, userId: string): Promise<void> {
  const rows = await services.credentials.rows(userId, tx);
  if ([...rows.values()].some(usable)) return;
  await tx.canvasConnection.updateMany({ where: { userId }, data: { status: "TOKEN_REJECTED" } });
  await tx.sourceConnection.updateMany({ where: { userId, type: "CANVAS" }, data: { state: "AUTH_REQUIRED" } });
}
