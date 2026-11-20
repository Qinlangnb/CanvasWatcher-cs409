// Course website sources: add/edit with a verification probe before anything is replaced, and the
// sync that crawls the site and stores pages, files (with their bytes), pending resources,
// schedule homework and changes.
import { createHash, randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import type { Content, TrackedItem } from "../../canvas/normalize.js";
import { keepSyllabus } from "../../canvas/syllabusStore.js";
import type { Db } from "../../db.js";
import { detectFileType } from "../../files/types.js";
import type { Prisma, SourceConnection } from "../../generated/prisma/client.js";
import { FieldError, HttpError } from "../../http/errors.js";
import { notify, resolveNotice } from "../../notifications/notify.js";
import { getSettings } from "../../routes/settings.js";
import type { Services } from "../../services.js";
import { reconcileSourceItems, type ItemScope } from "../items.js";
import type { NtlmCredential } from "../ntlm.js";
import type { SourceContext, SourceSyncResult } from "../registry.js";
import { crawlWebsite, type CrawlResult } from "./crawler.js";
import {
  clearWebsiteCredential,
  markWebsiteCredential,
  openWebsiteCredential,
  rejectWebsiteCredential,
  replaceWebsiteCredential,
} from "./credentials.js";
import { probeWebsite, ResourceFetcher, WebsiteProbeError, type WebsiteProbeResult } from "./fetcher.js";
import { normalizedHttpUrl, normalizedProbeUrl, protectedPrefix, websiteNtlmScope } from "./scope.js";
import { chooseSchedule, isSchedulePageUrl } from "./schedule.js";
import { isWebsiteCourse, withWebsiteSources } from "./syllabus.js";

const MAX_PAGE_TEXT = 50_000;
const MAX_BLOCK_CHARS = 200_000;
const MAX_PENDING_SEEDS = 200;
/** A file too large to store is fetched again only after this long (or once it leaves the site). */
export const OVERSIZED_RECHECK_MS = 7 * 24 * 60 * 60_000;
/** A stored file whose server sends neither ETag nor Last-Modified is downloaded again at most this often. */
export const UNVALIDATED_RECHECK_MS = 6 * 60 * 60_000;
/** pending_resources.state of such a file: not retried as a seed, not listed as pending. */
const TOO_LARGE = "TOO_LARGE";
/** Unlinked bytes younger than this may belong to a sync still running; they are pruned later. */
export const BLOB_GRACE_MS = 10 * 60_000;

/** The secret-free settings of a website source, kept in source_connections.config. */
export interface WebsiteConfig {
  authentication_method: "none" | "ntlm";
  protected_path_prefix: string | null;
  probe_url: string | null;
  discovery_path_limit: number;
  /** Monday of week 1 (YYYY-MM-DD): turns a homework schedule table into date-only tasks. */
  week_1_monday: string | null;
}

export const DEFAULT_PATH_LIMIT = 100;

export function websiteConfig(value: unknown): WebsiteConfig {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const limit = Number(raw.discovery_path_limit);
  return {
    authentication_method: raw.authentication_method === "ntlm" ? "ntlm" : "none",
    protected_path_prefix: typeof raw.protected_path_prefix === "string" && raw.protected_path_prefix ? raw.protected_path_prefix : null,
    probe_url: typeof raw.probe_url === "string" && raw.probe_url ? raw.probe_url : null,
    discovery_path_limit: Number.isInteger(limit) && limit >= 1 && limit <= 10_000 ? limit : DEFAULT_PATH_LIMIT,
    week_1_monday: typeof raw.week_1_monday === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.week_1_monday) ? raw.week_1_monday : null,
  };
}

const monday = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-08-24.")
  .refine((value) => DateTime.fromISO(value, { zone: "utc" }).isValid && DateTime.fromISO(value, { zone: "utc" }).weekday === 1, "Week 1 must start on a Monday.");

export const websiteInput = z.object({
  name: z.string().trim().max(120).optional(),
  /** Attach to an existing course instead of creating one. */
  course_id: z.number().int().positive().nullish(),
  course_code: z.string().trim().max(60).optional(),
  course_name: z.string().trim().max(200).optional(),
  /** Term name; undefined on edit keeps the current one. */
  term: z.string().trim().max(80).nullish(),
  base_url: z.string().trim().min(1, "Enter the course website address.").max(2048),
  authentication_method: z.enum(["none", "ntlm"]).default("none"),
  protected_path_prefix: z.string().trim().max(512).nullish(),
  probe_url: z.string().trim().max(512).nullish(),
  discovery_path_limit: z.number().int().min(1).max(10_000).optional(),
  week_1_monday: monday.nullish(),
  ntlm: z
    .object({
      username: z.string().trim().max(256),
      password: z.string().max(512),
    })
    .optional(),
});
export type WebsiteInput = z.infer<typeof websiteInput>;

export const authRequiredKey = (sourceId: string) => `auth-required:website:${sourceId}`;

function field<T>(name: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof FieldError || error instanceof HttpError) throw error;
    throw new FieldError(name, (error as Error).message);
  }
}

export interface SaveOutcome {
  /** Null for a test of a source not saved yet. */
  source: SourceConnection | null;
  verification: { verified: boolean; message: string; public_only: boolean } | null;
}

interface Validated {
  baseUrl: string;
  config: WebsiteConfig;
}

function validate(input: WebsiteInput, previous: WebsiteConfig | null, previousBase: string | null): Validated {
  const baseUrl = field("base_url", () => normalizedHttpUrl(input.base_url));
  // A stored test page belongs to the old origin; it is not carried to a new one.
  if (previous && previousBase && new URL(previousBase).origin !== new URL(baseUrl).origin && input.probe_url === undefined) {
    previous = { ...previous, probe_url: null };
  }
  const config: WebsiteConfig = {
    authentication_method: input.authentication_method,
    protected_path_prefix: input.protected_path_prefix === undefined ? (previous?.protected_path_prefix ?? null) : input.protected_path_prefix || null,
    probe_url: input.probe_url === undefined ? (previous?.probe_url ?? null) : input.probe_url || null,
    discovery_path_limit: input.discovery_path_limit ?? previous?.discovery_path_limit ?? DEFAULT_PATH_LIMIT,
    week_1_monday: input.week_1_monday === undefined ? (previous?.week_1_monday ?? null) : input.week_1_monday || null,
  };
  // A blank advanced prefix never widens a scope that was narrower before.
  if (!config.protected_path_prefix && previous?.protected_path_prefix && input.authentication_method === "ntlm") {
    config.protected_path_prefix = previous.protected_path_prefix;
  }
  if (config.authentication_method === "ntlm") {
    if (config.protected_path_prefix) field("protected_path_prefix", () => protectedPrefix(config.protected_path_prefix));
    if (config.probe_url) config.probe_url = field("probe_url", () => normalizedProbeUrl(config.probe_url as string));
    field("base_url", () => websiteNtlmScope(baseUrl, config.protected_path_prefix, config.probe_url));
  }
  return { baseUrl, config };
}

const probeFailed = (message: string) => new HttpError(422, "WEBSITE_VERIFICATION_FAILED", message);

async function runProbe(services: Services, baseUrl: string, config: WebsiteConfig, candidate: NtlmCredential | null): Promise<WebsiteProbeResult> {
  try {
    return await probeWebsite(
      {
        baseUrl,
        authenticationMethod: config.authentication_method,
        protectedPathPrefix: config.protected_path_prefix,
        probeUrl: config.probe_url,
      },
      candidate,
      { transport: services.sourceTransport },
    );
  } catch (error) {
    if (error instanceof WebsiteProbeError) throw probeFailed(error.message);
    throw error;
  }
}

/**
 * Tests (testOnly) or saves a website source. Nothing is replaced unless the probe passes; a new
 * password is installed with a compare-and-swap on the stored credential's generation.
 */
export async function saveWebsite(
  db: Db,
  services: Services,
  userId: string,
  input: WebsiteInput,
  options: { connectionId?: string; testOnly?: boolean } = {},
): Promise<SaveOutcome> {
  const existing = options.connectionId
    ? await db.sourceConnection.findFirst({ where: { id: options.connectionId, userId, type: "WEBSITE" }, include: { websiteCredential: true, course: true } })
    : null;
  if (options.connectionId && !existing) throw new HttpError(404, "SOURCE_NOT_FOUND", "That source could not be found.");
  const previousConfig = existing ? websiteConfig(existing.config) : null;
  const { baseUrl, config } = validate(input, previousConfig, existing?.baseUrl ?? null);

  const duplicate = await db.sourceConnection.findUnique({ where: { userId_type_baseUrl: { userId, type: "WEBSITE", baseUrl } } });
  if (duplicate && duplicate.id !== existing?.id) {
    throw new HttpError(409, "SOURCE_EXISTS", "Another source already uses this website; edit that source instead.");
  }
  if (!existing && !input.course_id && (!input.course_code || !input.course_name)) {
    throw new FieldError(input.course_code ? "course_name" : "course_code", "Enter the course code and description, or choose an existing course.");
  }
  let courseId: number | null = existing?.courseId ?? null;
  if (input.course_id !== undefined && input.course_id !== null) {
    const course = await db.course.findFirst({ where: { id: input.course_id, userId }, select: { id: true } });
    if (!course) throw new FieldError("course_id", "That course could not be found.");
    courseId = course.id;
  }

  const stored = existing?.websiteCredential ?? null;
  const previous = openWebsiteCredential(services.secrets, stored, userId);
  const ntlm = config.authentication_method === "ntlm";
  const username = input.ntlm?.username.trim() || previous?.username || stored?.username || "";
  const password = input.ntlm?.password ?? "";
  const networkChanged =
    !existing ||
    existing.baseUrl !== baseUrl ||
    previousConfig?.authentication_method !== config.authentication_method ||
    (previousConfig?.protected_path_prefix ?? null) !== config.protected_path_prefix ||
    (previousConfig?.probe_url ?? null) !== config.probe_url;

  let candidate: NtlmCredential | null = null;
  if (ntlm) {
    if (existing && previous && new URL(existing.baseUrl).origin !== new URL(baseUrl).origin && !password) {
      throw new FieldError("password", "Enter a password to verify a different website origin.");
    }
    if (password) {
      if (!username) throw new FieldError("username", "Enter the website username.");
      candidate = { username, password };
    } else if (networkChanged || options.testOnly || (input.ntlm && input.ntlm.username.trim() && input.ntlm.username.trim() !== previous?.username)) {
      // A blank password reuses the stored one only for the same username.
      if (!previous || previous.username !== username) {
        throw new FieldError("password", "Enter a username and password; no matching credential is stored.");
      }
      candidate = previous;
    }
  }

  let verification: WebsiteProbeResult | null = null;
  if (networkChanged || candidate || options.testOnly) {
    verification = await runProbe(services, baseUrl, config, ntlm ? (candidate ?? previous) : null);
    if (ntlm && verification.publicOnly && previous && candidate && candidate !== previous) {
      // A public page proves nothing about a new password: the working one stays.
      throw probeFailed("Protected access not verified; existing credential kept.");
    }
    if (verification.verified && verification.probeUrl) config.probe_url = verification.probeUrl;
  }
  const summary = verification ? { verified: verification.verified, message: verification.message, public_only: verification.publicOnly } : null;
  if (options.testOnly) return { source: existing, verification: summary };

  const name = input.name || existing?.name || `${input.course_code || "Course"} Site`;
  const saved = await db.$transaction(async (tx) => {
    const id = existing?.id ?? randomUUID();
    const configJson = config as unknown as Prisma.InputJsonValue;
    let connection = existing
      ? await tx.sourceConnection.update({ where: { id }, data: { name, baseUrl, config: configJson, courseId } })
      : await tx.sourceConnection.create({ data: { id, userId, type: "WEBSITE", name, baseUrl, config: configJson, courseId, state: "READY" } });
    if (!courseId) {
      // A course only this website knows; removing the source removes it.
      const course = await tx.course.create({
        data: {
          userId,
          canvasId: `website:${id}`,
          source: "WEBSITE",
          ownerSourceId: id,
          courseCode: input.course_code as string,
          name: input.course_name as string,
          termName: input.term || null,
          htmlUrl: baseUrl,
          lastSeenAt: new Date(),
        },
      });
      connection = await tx.sourceConnection.update({ where: { id }, data: { courseId: course.id } });
    } else if (existing?.course && existing.course.ownerSourceId === id) {
      await tx.course.update({
        where: { id: existing.course.id },
        data: {
          ...(input.course_code ? { courseCode: input.course_code } : {}),
          ...(input.course_name ? { name: input.course_name } : {}),
          ...(input.term !== undefined ? { termName: input.term || null } : {}),
          htmlUrl: baseUrl,
        },
      });
    }
    if (!ntlm) {
      // Switched to public: this source's password goes; nothing else is touched.
      await tx.websiteCredential.deleteMany({ where: { connectionId: id, userId } });
    } else if (candidate && candidate !== previous) {
      const installed = await replaceWebsiteCredential(
        tx,
        services.secrets,
        userId,
        id,
        candidate,
        verification?.verified ? { state: "VALID", lastErrorCode: null } : { state: "MISSING", lastErrorCode: "protected_access_not_verified" },
        stored?.generation ?? 0,
      );
      if (!installed) throw new HttpError(409, "CREDENTIAL_CHANGED", "The credential changed during verification. Try again.");
    } else if (verification && previous) {
      await markWebsiteCredential(tx, userId, id, verification.verified ? "VALID" : "MISSING", verification.verified ? null : "protected_access_not_verified");
    } else if (!stored && username) {
      await tx.websiteCredential.create({ data: { connectionId: id, userId, username, state: "MISSING", lastErrorCode: "credential_not_loaded" } });
    }
    if (networkChanged || candidate) await tx.sourceConnection.update({ where: { id }, data: { state: verification?.verified || !ntlm ? "READY" : "AUTH_REQUIRED" } });
    return connection;
  });
  if (verification?.verified) await resolveNotice(db, userId, authRequiredKey(saved.id));
  const fresh = await db.sourceConnection.findUniqueOrThrow({ where: { id: saved.id } });
  return { source: fresh, verification: summary };
}

/** Forgets the stored password of one website (the source and its data stay). */
export async function signOutWebsite(db: Db, userId: string, sourceId: string): Promise<void> {
  await clearWebsiteCredential(db, userId, sourceId);
  await db.sourceConnection.updateMany({ where: { id: sourceId, userId }, data: { state: "AUTH_REQUIRED" } });
}

// ---------------------------------------------------------------------------------------------
// Sync

const urlKey = (sourceId: string, url: string) => `${sourceId}:${url}`;
const fileKey = (sourceId: string, url: string) => `website:${sourceId}:${createHash("sha256").update(url).digest("hex").slice(0, 40)}`;

function cappedBlocks(blocks: unknown[]): Prisma.InputJsonValue {
  let size = 0;
  const kept: unknown[] = [];
  for (const block of blocks) {
    size += JSON.stringify(block).length;
    if (size > MAX_BLOCK_CHARS) break;
    kept.push(block);
  }
  return kept as Prisma.InputJsonValue;
}

function lastModified(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Stores one file's bytes under the user's quota and returns the blob id, or null when the file is
 * too large or the quota is full. A per-user advisory lock makes the check-and-insert atomic, so two
 * websites of one user syncing at once can't both squeeze under the quota.
 */
export async function storeWebsiteBlob(
  db: Db,
  userId: string,
  sha256: string,
  content: Buffer,
  limits: { quotaBytes: number; maxFileBytes: number },
): Promise<number | null> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`website-blobs:${userId}`}, 0))`;
    const known = await tx.websiteBlob.findUnique({ where: { userId_sha256: { userId, sha256 } }, select: { id: true } });
    if (known) return known.id;
    if (content.length > limits.maxFileBytes) return null;
    const used = Number((await tx.websiteBlob.aggregate({ where: { userId }, _sum: { sizeBytes: true } }))._sum.sizeBytes ?? 0);
    if (used + content.length > limits.quotaBytes) return null;
    const blob = await tx.websiteBlob.create({ data: { userId, sha256, sizeBytes: content.length, content: new Uint8Array(content) }, select: { id: true } });
    return blob.id;
  });
}

/** Drops bytes no file points at any more, so removed files stop counting against the quota. */
export async function pruneWebsiteBlobs(db: Db, userId: string, olderThan: Date): Promise<number> {
  // Only blobs from before this sync: another source's sync may have stored one it hasn't linked yet.
  const { count } = await db.websiteBlob.deleteMany({ where: { userId, createdAt: { lt: olderThan }, files: { none: {} } } });
  return count;
}

export async function syncWebsite(connection: SourceConnection, context: SourceContext): Promise<SourceSyncResult> {
  const { db, services, userId } = context;
  const config = websiteConfig(connection.config);
  const errors: SourceSyncResult["errors"] = [];
  if (!connection.courseId) {
    return { state: "ERROR", items_seen: 0, changes: 0, errors: [{ resource: "course", code: "course_missing", http_status: null }] };
  }
  const course = await db.course.findFirstOrThrow({ where: { id: connection.courseId, userId } });
  const credentialRow = await db.websiteCredential.findUnique({ where: { connectionId: connection.id } });
  const credential = openWebsiteCredential(services.secrets, credentialRow, userId);
  const ntlm = config.authentication_method === "ntlm";
  const scope = ntlm ? websiteNtlmScope(connection.baseUrl, config.protected_path_prefix, config.probe_url).scope : null;
  const pendingRows = await db.pendingResource.findMany({
    where: { sourceId: connection.id, state: { in: ["AUTH_REQUIRED", "DISCOVERED", "FAILED"] } },
    orderBy: { lastAttemptAt: "asc" },
    take: MAX_PENDING_SEEDS,
  });
  const recentlyTooLarge = await db.pendingResource.findMany({
    where: { sourceId: connection.id, state: TOO_LARGE, lastAttemptAt: { gt: new Date(Date.now() - OVERSIZED_RECHECK_MS) } },
    select: { url: true },
  });
  // Stored files are not downloaded in full on every sync: with an ETag or Last-Modified they are asked
  // for conditionally (304 = unchanged), without either they wait UNVALIDATED_RECHECK_MS.
  const storedFiles = await db.courseFile.findMany({
    where: { sourceId: connection.id, removedAt: null, integrityStatus: "VALID", blobId: { not: null }, sourceUrl: { not: null } },
    select: { sourceUrl: true, sourceEtag: true, sourceLastModified: true, sourceFetchedAt: true },
  });
  const knownFiles = new Map<string, { etag: string | null; lastModified: string | null }>();
  const recentlyFetched: string[] = [];
  for (const row of storedFiles) {
    if (!row.sourceUrl) continue;
    if (row.sourceEtag || row.sourceLastModified) knownFiles.set(row.sourceUrl, { etag: row.sourceEtag, lastModified: row.sourceLastModified });
    else if (row.sourceFetchedAt && row.sourceFetchedAt.getTime() > Date.now() - UNVALIDATED_RECHECK_MS) recentlyFetched.push(row.sourceUrl);
  }
  const fetcher = new ResourceFetcher({
    transport: services.sourceTransport,
    credentials: (id) => (id === connection.id ? credential : null),
    limits: { maxBytes: services.websiteLimits.maxFileBytes },
  });
  let crawl: CrawlResult;
  try {
    crawl = await crawlWebsite(
      {
        name: connection.name,
        baseUrl: connection.baseUrl,
        authRules: scope ? [{ pathPrefix: scope, credentialId: connection.id }] : [],
        pathLimit: config.discovery_path_limit,
        retryUrls: pendingRows.map((row) => row.url),
        skipUrls: [...recentlyTooLarge.map((row) => row.url), ...recentlyFetched],
        knownFiles,
      },
      fetcher,
    );
  } finally {
    fetcher.close();
  }

  const now = new Date();
  const baseline = connection.lastSuccessAt === null;
  const itemScope: ItemScope = { userId, courseId: course.id, sourceId: connection.id, baseline, now };
  const complete = crawl.health === "HEALTHY";
  const pendingUrls = new Set(crawl.pending.map((row) => row.url));
  // Files over the size limit, and files skipped as known (too large or unchanged): never "removed".
  const oversized = crawl.files.filter((file) => file.integrity.status === "TOO_LARGE");
  const oversizedUrls = new Set([...oversized.map((file) => file.url), ...crawl.skipped]);
  const zone = (await getSettings(db, userId)).timeZone;

  // Bytes go in first, each in its own short transaction: they are deduplicated by hash and harmless if unused.
  const blobIds = new Map<string, number>();
  for (const file of crawl.files) {
    if (!file.content || !file.sha256 || !file.integrity.valid) continue;
    const id = await storeWebsiteBlob(db, userId, file.sha256, file.content, services.websiteLimits);
    if (id === null) errors.push({ resource: "website_file", code: "storage_quota_exceeded", http_status: null });
    else blobIds.set(file.url, id);
  }

  // One page defines the homework deadlines (a schedule page, else the first page with the table); a
  // schedule page that could not be read this time leaves the deadlines as they are.
  const scheduleUnread = crawl.pending.some((row) => row.itemType === "website_page" && isSchedulePageUrl(row.url));
  const choice = config.week_1_monday && !scheduleUnread ? chooseSchedule(crawl.pages, config.week_1_monday) : null;
  const schedulePage = choice?.page ?? null;
  const schedule = schedulePage ? (choice?.rows ?? []).map((row) => ({ row, page: schedulePage })) : [];
  for (const page of choice?.conflicts ?? []) {
    errors.push({ resource: `website_schedule ${page.url}`, code: "schedule_conflict", http_status: null });
  }

  const changes = await db.$transaction(
    async (tx) => {
      // Pages: readable content for the syllabus finder and AI Chat, plus a tracked item for Changes.
      for (const page of crawl.pages) {
        const data = { title: page.title.slice(0, 500), text: page.text.slice(0, MAX_PAGE_TEXT), blocks: cappedBlocks(page.blocks), fetchedAt: now, removedAt: null, courseId: course.id };
        await tx.websitePage.upsert({ where: { sourceId_url: { sourceId: connection.id, url: page.url } }, create: { userId, sourceId: connection.id, url: page.url, ...data }, update: data });
      }
      if (complete) {
        await tx.websitePage.updateMany({
          where: { sourceId: connection.id, removedAt: null, url: { notIn: crawl.pages.map((page) => page.url) } },
          data: { removedAt: now },
        });
      }
      let total = await reconcileSourceItems(
        tx,
        itemScope,
        "PAGE",
        crawl.pages.map<TrackedItem>((page) => ({
          kind: "PAGE",
          canvasId: urlKey(connection.id, page.url),
          title: page.title.slice(0, 500),
          htmlUrl: page.url,
          content: { title: page.title.slice(0, 500), url: page.url, text: page.text.slice(0, 10_000) },
        })),
        (key) => complete && !pendingUrls.has(key.slice(connection.id.length + 1)),
      );

      // Files: metadata in Files (classified like Canvas files), bytes in website_blobs.
      for (const file of crawl.files) {
        const canvasId = fileKey(connection.id, file.url);
        const previousFile = await tx.courseFile.findUnique({ where: { courseId_canvasId: { courseId: course.id, canvasId } } });
        const data = {
          displayName: file.filename,
          contentType: file.contentType,
          sizeBytes: Math.min(file.size, 2 ** 31 - 1),
          detectedType: detectFileType(`${file.filename} ${file.title}`),
          canvasUpdatedAt: lastModified(file.lastModified) ?? (previousFile?.sha256 === file.sha256 ? previousFile.canvasUpdatedAt : now),
          sourceId: connection.id,
          sourceUrl: file.url,
          sha256: file.sha256,
          integrityStatus: file.integrity.status,
          validationError: file.integrity.reason,
          blobId: blobIds.get(file.url) ?? (previousFile?.sha256 === file.sha256 ? previousFile.blobId : null),
          sourceEtag: file.etag,
          sourceLastModified: file.lastModified,
          sourceFetchedAt: now,
          removedAt: null,
        };
        await tx.courseFile.upsert({
          where: { courseId_canvasId: { courseId: course.id, canvasId } },
          create: { userId, courseId: course.id, canvasId, ...data },
          update: data,
        });
      }
      const fileUrls = new Set(crawl.files.map((file) => file.url));
      if (complete) {
        await tx.courseFile.updateMany({
          where: { sourceId: connection.id, removedAt: null, sourceUrl: { notIn: [...fileUrls, ...crawl.skipped] } },
          // A removed file's bytes are let go, so they stop counting against the quota.
          data: { removedAt: now, blobId: null },
        });
        // A too-large file that left the site is fetched again if it comes back.
        await tx.pendingResource.deleteMany({ where: { sourceId: connection.id, state: TOO_LARGE, url: { notIn: [...fileUrls, ...crawl.skipped] } } });
      }
      total += await reconcileSourceItems(
        tx,
        itemScope,
        "FILE",
        crawl.files
          .filter((file) => file.integrity.valid)
          .map<TrackedItem>((file) => ({
            kind: "FILE",
            canvasId: urlKey(connection.id, file.url),
            title: file.filename,
            htmlUrl: file.url,
            content: { name: file.filename, size: file.size, content_type: file.contentType, sha256: file.sha256 },
          })),
        (key) => complete && !pendingUrls.has(key.slice(connection.id.length + 1)) && !oversizedUrls.has(key.slice(connection.id.length + 1)),
      );

      // Pending resources: retried as seeds next time; fetched ones are marked done.
      for (const row of crawl.pending) {
        const data = { title: row.title.slice(0, 500), itemType: row.itemType, state: row.state, lastErrorCode: row.errorCode, lastAttemptAt: now };
        await tx.pendingResource.upsert({
          where: { sourceId_url: { sourceId: connection.id, url: row.url } },
          create: { userId, sourceId: connection.id, url: row.url, ...data },
          update: data,
        });
      }
      const fetched = [...crawl.pages.map((page) => page.url), ...fileUrls];
      if (fetched.length) {
        await tx.pendingResource.updateMany({
          where: { sourceId: connection.id, url: { in: fetched } },
          data: { state: "FETCHED", lastErrorCode: null, lastAttemptAt: now },
        });
      }
      // Remembered so the next syncs list them without downloading them again (OVERSIZED_RECHECK_MS).
      for (const file of oversized) {
        const data = { title: file.title.slice(0, 500), itemType: "website_file", state: TOO_LARGE, lastErrorCode: "file_too_large", lastAttemptAt: now };
        await tx.pendingResource.upsert({
          where: { sourceId_url: { sourceId: connection.id, url: file.url } },
          create: { userId, sourceId: connection.id, url: file.url, ...data },
          update: data,
        });
      }

      // Schedule homework: date-only tasks, deadline changes reported like Canvas ones.
      if (schedule.length) {
        const seen: string[] = [];
        for (const { row, page } of schedule) {
          if (!row.dueDate) continue;
          const canvasId = `website:${connection.id}:${row.sourceKey}`;
          seen.push(canvasId);
          const dueAt = DateTime.fromISO(row.dueDate, { zone }).set({ hour: 23, minute: 59 }).toJSDate();
          const data = {
            title: `HW ${row.number}`,
            taskType: "homework",
            dueAt,
            dueDateOnly: true,
            htmlUrl: row.assignmentResourceUrl ?? page.url,
            removedAt: null,
          };
          await tx.task.upsert({
            where: { courseId_canvasId: { courseId: course.id, canvasId } },
            create: { userId, courseId: course.id, canvasId, source: "WEBSITE", sourceId: connection.id, ...data },
            update: data,
          });
        }
        await tx.task.updateMany({
          where: { sourceId: connection.id, source: "WEBSITE", removedAt: null, canvasId: { notIn: seen } },
          data: { removedAt: now },
        });
        total += await reconcileSourceItems(
          tx,
          itemScope,
          "ASSIGNMENT",
          schedule
            .filter(({ row }) => row.dueDate)
            .map<TrackedItem>(({ row, page }) => ({
              kind: "ASSIGNMENT",
              canvasId: `website:${connection.id}:${row.sourceKey}`,
              title: `HW ${row.number}`,
              htmlUrl: row.assignmentResourceUrl ?? page.url,
              content: { title: `HW ${row.number}`, due_at: row.dueDate, evidence: row.dueText } as Content,
            })),
        );
      }
      return total;
    },
    { timeout: 60_000 },
  );
  await pruneWebsiteBlobs(db, userId, new Date(now.getTime() - BLOB_GRACE_MS));

  // Syllabus of a course only the website knows.
  if (isWebsiteCourse(course)) {
    await keepSyllabus(db, userId, course.id, await withWebsiteSources(db, userId, course.id, { found: false, sources: [] }), now);
  }

  // Credential state and the "sign in again" banner.
  const authFailed = crawl.pending.some((row) => row.fetchStatus === "auth_failed");
  const authWorked = crawl.pages.some((page) => page.credentialId) || crawl.files.some((file) => file.credentialId);
  if (ntlm && credentialRow) {
    if (authFailed) await rejectWebsiteCredential(db, userId, connection.id, credentialRow.generation);
    else if (authWorked) await markWebsiteCredential(db, userId, connection.id, "VALID", null);
  }
  if (crawl.health === "AUTH_REQUIRED") {
    await notify(db, userId, {
      key: authRequiredKey(connection.id),
      level: "important",
      title: `${connection.name} needs signing in`,
      body: "Protected pages of this course website could not be read. Enter the website password again in Settings → Sources.",
    });
  } else if (authWorked || !crawl.pending.some((row) => row.fetchStatus === "auth_required" || row.fetchStatus === "auth_failed")) {
    await resolveNotice(db, userId, authRequiredKey(connection.id));
  }

  for (const row of crawl.pending.filter((pending) => pending.fetchStatus !== "not_found")) {
    errors.push({ resource: row.itemType, code: row.errorCode, http_status: null });
  }
  for (const file of crawl.files.filter((row) => !row.integrity.valid)) {
    errors.push({ resource: "website_file", code: file.integrity.reason ?? "invalid_download", http_status: null });
  }
  if (crawl.truncated) errors.push({ resource: "website", code: "discovery_limit_reached", http_status: null });
  return {
    state: crawl.health === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "READY",
    items_seen: crawl.pages.length + crawl.files.length,
    changes,
    errors,
  };
}

/** Pending resources of one source, for its card. */
export async function pendingResources(db: Db, userId: string, sourceId: string) {
  const rows = await db.pendingResource.findMany({
    where: { userId, sourceId, state: { in: ["AUTH_REQUIRED", "DISCOVERED", "FAILED"] } },
    orderBy: [{ state: "asc" }, { url: "asc" }],
    take: 200,
  });
  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    title: row.title,
    item_type: row.itemType,
    state: row.state,
    last_error_code: row.lastErrorCode,
    last_attempt_at: row.lastAttemptAt.toISOString(),
  }));
}
