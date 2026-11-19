import { Router } from "express";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import { ensureCanvasSource, methodFromName, METHODS } from "../canvas/credentials.js";
import { CanvasAddressError, canvasOrigin } from "../canvas/hosts.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { Prisma, ProviderSession, SourceConnection } from "../generated/prisma/client.js";
import type { SourceType } from "../generated/prisma/enums.js";
import { FieldError, HttpError } from "../http/errors.js";
import { isPreview, previewUnavailable } from "../preview/accounts.js";
import type { Services } from "../services.js";
import { sourceAdapter } from "../sources/registry.js";
import { BLOB_GRACE_MS, pruneWebsiteBlobs } from "../sources/website/service.js";
import { disconnectCanvas } from "./canvas.js";
import { presentRun } from "./present.js";
import { startCanvasSync } from "./sync.js";

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);
const TYPES: Record<string, SourceType> = { canvas: "CANVAS", website: "WEBSITE", gradescope: "GRADESCOPE", prairielearn: "PRAIRIELEARN" };
const PROVIDERS = new Set<SourceType>(["GRADESCOPE", "PRAIRIELEARN"]);

const sourceNotFound = () => new HttpError(404, "SOURCE_NOT_FOUND", "That source could not be found.");

type SourceRow = SourceConnection & { providerSession?: ProviderSession | null };

/** A source as the API shows it. Never includes secrets. */
export function presentSource(source: SourceRow) {
  const adapter = source.type === "CANVAS" ? null : sourceAdapter(source.type);
  return {
    id: source.id,
    source_type: source.type.toLowerCase(),
    name: source.name,
    base_url: source.baseUrl,
    course_id: source.courseId,
    /** The id the broker and credential routes use for this source. */
    credential_id: source.id,
    config_json: source.config,
    state: source.enabled ? source.state : "DISABLED",
    enabled: source.enabled,
    health: source.health,
    health_summary: source.healthSummary,
    health_diagnostics: source.diagnostics,
    last_sync_at: iso(source.lastSyncAt),
    last_success_at: iso(source.lastSuccessAt),
    last_error: source.lastError,
    session: PROVIDERS.has(source.type)
      ? {
          state: source.providerSession?.cookieCiphertext ? source.providerSession.state : (source.providerSession?.state ?? "MISSING"),
          present: Boolean(source.providerSession?.cookieCiphertext),
          generation: source.providerSession?.generation ?? 0,
          verified_at: iso(source.providerSession?.verifiedAt),
        }
      : null,
    /** False while no module handles this type yet; the UI shows it as coming soon. */
    supported: source.type === "CANVAS" || adapter !== null,
    ...(adapter?.present?.(source) ?? {}),
  };
}

const createCanvas = z.object({
  name: z.string().trim().max(120).optional(),
  base_url: z.string().trim().min(1, "Enter your school's Canvas address.").max(2048),
});

const createOther = z.object({
  type: z.enum(["website", "gradescope", "prairielearn"]),
  name: z.string().trim().max(120).optional(),
  base_url: z.string().trim().min(1, "Enter the address.").max(2048),
  course_id: z.number().int().positive().nullish(),
  config: z.unknown().optional(),
});

const update = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(120).optional(),
  base_url: z.string().trim().min(1).max(2048).optional(),
  enabled: z.boolean().optional(),
  default_auth_method: z.enum(["pat", "browser_session", "oauth"]).nullish(),
  course_id: z.number().int().positive().nullish(),
  config: z.unknown().optional(),
});

function canvasBase(config: Config, input: string): string {
  try {
    return canvasOrigin(input, config.canvasAllowedHosts);
  } catch (error) {
    if (error instanceof CanvasAddressError) throw new FieldError("base_url", error.message);
    throw error;
  }
}

/** A new address must answer before it replaces a working one: below 400, or 401/403 (sign-in needed). */
async function probeAddress(services: Services, baseUrl: string): Promise<void> {
  let status: number;
  try {
    const response = await services.credentials.fetchImpl(`${baseUrl}/`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    status = response.status;
    await response.body?.cancel().catch(() => {});
  } catch {
    throw new FieldError("base_url", "That address did not answer. The current address was kept.");
  }
  if (status >= 400 && status !== 401 && status !== 403) {
    throw new FieldError("base_url", `That address answered with an error (${status}). The current address was kept.`);
  }
}

async function ownCourse(db: Db, userId: string, courseId: number | null | undefined): Promise<number | null> {
  if (!courseId) return null;
  const course = await db.course.findFirst({ where: { id: courseId, userId }, select: { id: true } });
  if (!course) throw new FieldError("course_id", "That course could not be found.");
  return course.id;
}

/** Settings → Sources: every connection of the signed-in user. Mounted at /api/sources. */
export function sourcesRouter(db: Db, config: Config, services: Services): Router {
  const router = Router();

  const load = async (userId: string, id: string): Promise<SourceRow> => {
    if (!z.uuid().safeParse(id).success) throw sourceNotFound();
    const source = await db.sourceConnection.findFirst({ where: { id, userId }, include: { providerSession: true } });
    if (!source) throw sourceNotFound();
    return source;
  };

  const ownerOnly = (locals: Express.Locals) => {
    const { user } = currentAuth(locals);
    if (isPreview(user)) throw previewUnavailable();
    return user.id;
  };

  router.get("/", async (_req, res) => {
    const userId = currentAuth(res.locals).user.id;
    // Accounts connected before sources existed (or copied into a preview) get their Canvas source here.
    const binding = await db.canvasConnection.findUnique({ where: { userId } });
    if (binding) await ensureCanvasSource(db, userId, binding.baseUrl);
    const rows = await db.sourceConnection.findMany({
      where: { userId },
      include: { providerSession: true },
      orderBy: [{ type: "asc" }, { createdAt: "asc" }],
    });
    res.json(rows.map(presentSource));
  });

  /** Adds the Canvas source (one per account). Credentials are added afterwards. */
  router.post("/canvas", async (req, res) => {
    const userId = ownerOnly(res.locals);
    const body = createCanvas.parse(req.body ?? {});
    const baseUrl = canvasBase(config, body.base_url);
    if (await db.sourceConnection.findFirst({ where: { userId, type: "CANVAS" } })) {
      throw new HttpError(409, "CANVAS_SOURCE_EXISTS", "Canvas is already set up. Edit the existing Canvas source instead.");
    }
    const created = await db.sourceConnection.create({
      data: { userId, type: "CANVAS", name: body.name || "Canvas", baseUrl, state: "AUTH_REQUIRED" },
      include: { providerSession: true },
    });
    res.status(201).json(presentSource(created));
  });

  /** Adds a course website, Gradescope or PrairieLearn source, once a module for that type is installed. */
  router.post("/", async (req, res) => {
    const userId = ownerOnly(res.locals);
    const body = createOther.parse(req.body ?? {});
    const type = TYPES[body.type] as SourceType;
    const adapter = sourceAdapter(type);
    if (!adapter) throw new HttpError(501, "SOURCE_TYPE_UNAVAILABLE", "This kind of source is coming in this release.");
    const baseUrl = adapter.normalizeBaseUrl(body.base_url);
    const context = { db, services, userId };
    const sourceConfig = adapter.validateConfig ? await adapter.validateConfig(body.config ?? {}, context) : {};
    const courseId = await ownCourse(db, userId, body.course_id);
    const existing = await db.sourceConnection.findUnique({ where: { userId_type_baseUrl: { userId, type, baseUrl } } });
    if (existing) throw new HttpError(409, "SOURCE_EXISTS", "This source is already set up.");
    const provider = PROVIDERS.has(type);
    const created = await db.sourceConnection.create({
      data: {
        userId,
        type,
        name: body.name || adapter.defaultName?.(baseUrl) || new URL(baseUrl).host,
        baseUrl,
        courseId,
        config: sourceConfig as Prisma.InputJsonValue,
        state: provider ? "AUTH_REQUIRED" : "READY",
        ...(provider ? { providerSession: { create: { userId } } } : {}),
      },
      include: { providerSession: true },
    });
    res.status(201).json(presentSource(created));
  });

  router.get("/:id", async (req, res) => {
    res.json(presentSource(await load(currentAuth(res.locals).user.id, req.params.id)));
  });

  /** Renames, re-points (probing the new address first), enables or disables a source. */
  router.patch("/:id", async (req, res) => {
    const userId = ownerOnly(res.locals);
    const source = await load(userId, req.params.id);
    const body = update.parse(req.body ?? {});
    const data: Prisma.SourceConnectionUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.enabled !== undefined) {
      data.enabled = body.enabled;
      if (source.type === "CANVAS" && body.enabled) data.state = (await db.canvasConnection.findUnique({ where: { userId } }))?.status === "OK" ? "READY" : "AUTH_REQUIRED";
    }
    if (body.course_id !== undefined) data.course = body.course_id ? { connect: { id: await ownCourse(db, userId, body.course_id) as number } } : { disconnect: true };

    if (source.type === "CANVAS") {
      if (body.default_auth_method !== undefined) {
        const preferred = body.default_auth_method ? methodFromName(body.default_auth_method) : null;
        await db.canvasConnection.updateMany({ where: { userId }, data: { preferredMethod: preferred } });
      }
      if (body.base_url !== undefined) {
        const baseUrl = canvasBase(config, body.base_url);
        if (baseUrl !== source.baseUrl) {
          await probeAddress(services, baseUrl);
          // Every credential belongs to the old site: they are signed out, the account id stays bound.
          for (const method of METHODS) {
            await services.credentials.remove(userId, method, { state: "MISSING", reason: "BASE_URL_CHANGED" });
          }
          await db.canvasConnection.updateMany({ where: { userId }, data: { baseUrl, status: "TOKEN_REJECTED", fallback: undefined } });
          data.baseUrl = baseUrl;
          data.state = "AUTH_REQUIRED";
        }
      }
    } else {
      const adapter = sourceAdapter(source.type);
      if ((body.base_url !== undefined || body.config !== undefined) && !adapter) {
        throw new HttpError(501, "SOURCE_TYPE_UNAVAILABLE", "This kind of source is coming in this release.");
      }
      // A website's address and access settings change only through its own editor, which verifies them.
      if (source.type === "WEBSITE" && (body.base_url !== undefined || body.config !== undefined)) {
        throw new HttpError(409, "WEBSITE_EDITOR_REQUIRED", "Change a course website's address and access in its editor.");
      }
      if (adapter && body.base_url !== undefined) {
        const baseUrl = adapter.normalizeBaseUrl(body.base_url);
        if (baseUrl !== source.baseUrl) {
          await probeAddress(services, baseUrl);
          data.baseUrl = baseUrl;
        }
      }
      if (adapter?.validateConfig && body.config !== undefined) {
        data.config = (await adapter.validateConfig(body.config, { db, services, userId })) as Prisma.InputJsonValue;
      }
    }
    const updated = await db.sourceConnection.update({ where: { id: source.id }, data, include: { providerSession: true } });
    res.json(presentSource(updated));
  });

  /** Removes a source. For Canvas this is "Disconnect and delete data": courses and history go too. */
  router.delete("/:id", async (req, res) => {
    const userId = ownerOnly(res.locals);
    const source = await load(userId, req.params.id);
    if (source.type === "CANVAS") await disconnectCanvas(db, userId);
    else {
      await db.sourceConnection.delete({ where: { id: source.id } });
      // The website's files went with it; their stored bytes stop counting against the quota.
      if (source.type === "WEBSITE") await pruneWebsiteBlobs(db, userId, new Date(Date.now() - BLOB_GRACE_MS));
    }
    res.status(204).end();
  });

  /** Syncs one source now. */
  router.post("/:id/sync", async (req, res) => {
    const userId = ownerOnly(res.locals);
    const source = await load(userId, req.params.id);
    if (source.type === "CANVAS") {
      const run = await startCanvasSync(db, services, userId);
      res.status(202).json({ state: "running", sync_run: presentRun(run), errors: [] });
      return;
    }
    if (!source.enabled) throw new HttpError(409, "SOURCE_DISABLED", "This source is turned off. Turn it on to sync.");
    // Health and diagnostics are recorded the same way for "Sync now" and the scheduler (sources/run.ts).
    res.json(await services.sourceSyncs.run(source));
  });

  return router;
}

/** GET /api/settings/credential-storage: every secret is sealed in the database here. */
export function credentialStorage() {
  return { mode: "server_encrypted" as const };
}
