import type { Logger } from "pino";
import { CanvasError, openToken, type CanvasClient, type CanvasClientFactory } from "../canvas/client.js";
import {
  changeSummary,
  changedFields,
  contentHash,
  dateOrNull,
  isReadableCourse,
  taskType,
  trackedAnnouncement,
  trackedAssignment,
  trackedFile,
  type Content,
  type TrackedItem,
} from "../canvas/normalize.js";
import type { CanvasAssignment, CanvasCourse, CanvasFile } from "../canvas/types.js";
import type { Db } from "../db.js";
import type { Prisma, SyncRun } from "../generated/prisma/client.js";
import type { ChangeType, ItemKind, SyncStatus, SyncTrigger } from "../generated/prisma/enums.js";
import type { SecretBox } from "../security/secretBox.js";

const DAY = 24 * 60 * 60_000;
/** How long a sync may run without renewing its lease before another may take over. */
const LEASE_MS = 5 * 60_000;
const COURSE_CONCURRENCY = 3;
/** Most syncs the scheduler runs at once in this process. */
const SCHEDULED_CONCURRENCY = 4;
const ANNOUNCEMENT_WINDOW_MS = 120 * DAY;

export interface SyncServiceOptions {
  db: Db;
  logger: Logger;
  secrets: SecretBox;
  canvas: CanvasClientFactory;
}

interface SyncContext {
  userId: string;
  client: CanvasClient;
  baseUrl: string;
  lease: { until: Date };
}

interface CourseResult {
  changes: number;
  problems: string[];
}

/** A resource Canvas may refuse for one course (for example a hidden Files tab). */
type Section<T> = { ok: true; rows: T[] } | { ok: false; problem: string | null };

function isFatal(error: unknown): boolean {
  return error instanceof CanvasError && error.kind === "TOKEN_REJECTED";
}

/** Runs `work` over `items`, at most `limit` at a time; the first fatal error stops new work and is rethrown. */
async function eachLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let fatal: unknown = null;
  const worker = async () => {
    while (fatal === null && next < items.length) {
      const item = items[next++] as T;
      try {
        await work(item);
      } catch (error) {
        fatal ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (fatal !== null) throw fatal;
}

/**
 * Copies each user's Canvas courses, assignments, files and announcements into the database and
 * records what changed since the last sync. Syncs run in the background of this process; a lease
 * on the user's connection row keeps a user to one sync at a time.
 */
export class SyncService {
  private readonly db: Db;
  private readonly logger: Logger;
  private readonly secrets: SecretBox;
  private readonly canvas: CanvasClientFactory;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: SyncServiceOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.secrets = options.secrets;
    this.canvas = options.canvas;
  }

  /**
   * Starts a sync for the user unless one is already running, in which case that run is returned
   * with `started: false`. Returns null if the user has not connected Canvas.
   */
  async start(userId: string, trigger: SyncTrigger): Promise<{ run: SyncRun; started: boolean } | null> {
    const now = new Date();
    const until = new Date(now.getTime() + LEASE_MS);
    const claimed = await this.db.$transaction(async (tx) => {
      const lease = await tx.canvasConnection.updateMany({
        where: { userId, OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }] },
        data: { syncLeaseUntil: until },
      });
      if (lease.count === 0) return null;
      // A run still marked RUNNING lost its lease: its process stopped before finishing.
      await tx.syncRun.updateMany({
        where: { userId, status: "RUNNING" },
        data: { status: "FAILED", finishedAt: now, error: "The sync was interrupted. It will run again." },
      });
      return tx.syncRun.create({ data: { userId, trigger } });
    });
    if (claimed) {
      this.track(this.execute(claimed, { until }));
      return { run: claimed, started: true };
    }
    // The lease and its run are written in one transaction, so a held lease always has a run.
    const connected = await this.db.canvasConnection.count({ where: { userId } });
    if (connected === 0) return null;
    const run = await this.db.syncRun.findFirstOrThrow({ where: { userId }, orderBy: { startedAt: "desc" } });
    return { run, started: false };
  }

  /** Starts scheduled syncs for connections not synced within `intervalMs`. */
  async startDue(intervalMs: number): Promise<number> {
    const room = SCHEDULED_CONCURRENCY - this.inFlight.size;
    if (room <= 0) return 0;
    const now = new Date();
    const due = await this.db.canvasConnection.findMany({
      where: {
        status: "OK",
        OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(now.getTime() - intervalMs) } }],
        AND: [{ OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }] }],
      },
      orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } },
      select: { userId: true },
      take: room,
    });
    let started = 0;
    for (const { userId } of due) {
      if ((await this.start(userId, "SCHEDULED"))?.started) started += 1;
    }
    return started;
  }

  /**
   * Marks runs left RUNNING by a previous process as failed and frees their leases. Call once at
   * startup; it assumes this is the only API process (true for the Compose deployment).
   */
  async recoverInterrupted(): Promise<void> {
    await this.db.$transaction([
      this.db.syncRun.updateMany({
        where: { status: "RUNNING" },
        data: { status: "FAILED", finishedAt: new Date(), error: "The server restarted during this sync." },
      }),
      this.db.canvasConnection.updateMany({ where: { syncLeaseUntil: { not: null } }, data: { syncLeaseUntil: null } }),
    ]);
  }

  /** Resolves once no sync started by this process is running. */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private track(job: Promise<void>): void {
    const tracked = job
      .catch((error: unknown) => this.logger.error({ err: error }, "sync crashed"))
      .finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  private async execute(run: SyncRun, lease: { until: Date }): Promise<void> {
    const { userId } = run;
    let status: SyncStatus = "SUCCEEDED";
    let error: string | null = null;
    let tokenRejected = false;
    let coursesSynced = 0;
    let changesDetected = 0;
    try {
      const connection = await this.db.canvasConnection.findUniqueOrThrow({ where: { userId } });
      const context: SyncContext = {
        userId,
        client: this.canvas(connection.baseUrl, openToken(this.secrets, connection.tokenCiphertext, userId)),
        baseUrl: connection.baseUrl,
        lease,
      };
      const courses = (await context.client.courses()).filter(isReadableCourse);
      const problems: string[] = [];
      await eachLimit(courses, COURSE_CONCURRENCY, async (course) => {
        try {
          const result = await this.syncCourse(context, course);
          coursesSynced += 1;
          changesDetected += result.changes;
          problems.push(...result.problems);
        } catch (courseError) {
          if (isFatal(courseError)) throw courseError;
          problems.push(`${course.course_code ?? course.name ?? course.id}: ${this.describe(courseError)}`);
        }
        await this.renewLease(userId, lease);
      });
      if (problems.length > 0) {
        status = "PARTIAL";
        const more = problems.length > 3 ? ` (and ${problems.length - 3} more)` : "";
        error = `Some Canvas pages could not be read. ${problems.slice(0, 3).join("; ")}${more}`;
      }
    } catch (runError) {
      status = "FAILED";
      tokenRejected = isFatal(runError);
      error = this.describe(runError);
    }
    const finishedAt = new Date();
    await this.db.syncRun.update({
      where: { id: run.id },
      data: { status, error, coursesSynced, changesDetected, finishedAt },
    });
    const released = await this.db.canvasConnection.updateMany({
      where: { userId, syncLeaseUntil: lease.until },
      data: { syncLeaseUntil: null, lastSyncedAt: finishedAt, ...(tokenRejected ? { status: "TOKEN_REJECTED" } : {}) },
    });
    if (released.count === 0 && (await this.db.canvasConnection.count({ where: { userId } })) === 0) {
      // The user disconnected while this sync ran; drop what it wrote afterwards.
      await this.db.course.deleteMany({ where: { userId } });
    }
    this.logger.info({ runId: run.id, status, coursesSynced, changesDetected }, "sync finished");
  }

  private describe(error: unknown): string {
    if (error instanceof CanvasError) return error.message;
    this.logger.error({ err: error }, "unexpected sync error");
    return "The sync stopped because of an unexpected error.";
  }

  private async renewLease(userId: string, lease: { until: Date }): Promise<void> {
    const until = new Date(Date.now() + LEASE_MS);
    const renewed = await this.db.canvasConnection.updateMany({
      where: { userId, syncLeaseUntil: lease.until },
      data: { syncLeaseUntil: until },
    });
    if (renewed.count > 0) lease.until = until;
  }

  /** Fetches one resource; a page the student may not open is skipped instead of failing the course. */
  private async section<T>(label: string, fetchRows: () => Promise<T[]>): Promise<Section<T>> {
    try {
      return { ok: true, rows: await fetchRows() };
    } catch (error) {
      if (isFatal(error)) throw error;
      if (error instanceof CanvasError && (error.kind === "FORBIDDEN" || error.kind === "NOT_FOUND")) {
        return { ok: false, problem: null };
      }
      return { ok: false, problem: `${label}: ${this.describe(error)}` };
    }
  }

  private async syncCourse(context: SyncContext, canvasCourse: CanvasCourse): Promise<CourseResult> {
    const { userId, client, baseUrl } = context;
    const canvasId = String(canvasCourse.id);
    const now = new Date();
    const fields = {
      courseCode: canvasCourse.course_code?.trim() || canvasCourse.name?.trim() || `Course ${canvasId}`,
      name: canvasCourse.name?.trim() || canvasCourse.course_code?.trim() || `Course ${canvasId}`,
      termName: canvasCourse.term?.name ?? null,
      termStartAt: dateOrNull(canvasCourse.term?.start_at),
      termEndAt: dateOrNull(canvasCourse.term?.end_at),
      htmlUrl: `${baseUrl}/courses/${encodeURIComponent(canvasId)}`,
      lastSeenAt: now,
    };
    const existing = await this.db.course.findUnique({ where: { userId_canvasId: { userId, canvasId } } });
    const course = existing
      ? await this.db.course.update({ where: { id: existing.id }, data: fields })
      : await this.db.course.create({ data: { userId, canvasId, ...fields } });
    // The first sync of a course records what exists without reporting all of it as new.
    const baseline = !existing;

    const [assignments, files, announcements] = await Promise.all([
      this.section("Assignments", () => client.assignments(canvasId)),
      this.section("Files", () => client.files(canvasId)),
      this.section("Announcements", () =>
        client.announcements(canvasId, new Date(now.getTime() - ANNOUNCEMENT_WINDOW_MS), new Date(now.getTime() + DAY)),
      ),
    ]);

    const result: CourseResult = { changes: 0, problems: [] };
    const scope = { userId, courseId: course.id, baseline, now };
    if (assignments.ok) {
      result.changes += await this.db.$transaction(
        async (tx) => {
          await this.saveTasks(tx, scope, assignments.rows);
          return this.reconcile(tx, scope, "ASSIGNMENT", assignments.rows.map(trackedAssignment), true);
        },
        { timeout: 30_000 },
      );
    }
    if (files.ok) {
      result.changes += await this.db.$transaction(
        async (tx) => {
          await this.saveFiles(tx, scope, files.rows);
          return this.reconcile(tx, scope, "FILE", files.rows.map((file) => trackedFile(file, fields.htmlUrl)), true);
        },
        { timeout: 30_000 },
      );
    }
    if (announcements.ok) {
      // Announcements are fetched for a time window, so one missing from it was not deleted.
      result.changes += await this.db.$transaction(
        (tx) => this.reconcile(tx, scope, "ANNOUNCEMENT", announcements.rows.map(trackedAnnouncement), false),
        { timeout: 30_000 },
      );
    }
    for (const section of [assignments, files, announcements]) {
      if (!section.ok && section.problem) result.problems.push(`${fields.courseCode} ${section.problem}`);
    }
    return result;
  }

  private async saveTasks(tx: Prisma.TransactionClient, scope: Scope, rows: CanvasAssignment[]): Promise<void> {
    const { userId, courseId, now } = scope;
    for (const assignment of rows) {
      const canvasId = String(assignment.id);
      const title = assignment.name?.trim() || "Untitled assignment";
      const data = {
        title,
        taskType: taskType(title),
        dueAt: dateOrNull(assignment.due_at),
        pointsPossible: assignment.points_possible ?? null,
        htmlUrl: assignment.html_url ?? null,
        submissionState: assignment.submission?.workflow_state ?? null,
        submittedAt: dateOrNull(assignment.submission?.submitted_at),
        removedAt: null,
      };
      await tx.task.upsert({
        where: { courseId_canvasId: { courseId, canvasId } },
        create: { userId, courseId, canvasId, ...data },
        update: data,
      });
    }
    // Only Canvas tasks can disappear from Canvas; the student's own tasks are never touched.
    await tx.task.updateMany({
      where: { courseId, source: "CANVAS", removedAt: null, canvasId: { notIn: rows.map((row) => String(row.id)) } },
      data: { removedAt: now },
    });
  }

  private async saveFiles(tx: Prisma.TransactionClient, scope: Scope, rows: CanvasFile[]): Promise<void> {
    const { userId, courseId, now } = scope;
    for (const file of rows) {
      const canvasId = String(file.id);
      const data = {
        displayName: file.display_name?.trim() || file.filename || "Untitled file",
        contentType: file["content-type"] ?? null,
        sizeBytes: Math.max(0, Math.min(file.size ?? 0, 2 ** 31 - 1)),
        canvasUpdatedAt: dateOrNull(file.modified_at ?? file.updated_at),
        removedAt: null,
      };
      await tx.courseFile.upsert({
        where: { courseId_canvasId: { courseId, canvasId } },
        create: { userId, courseId, canvasId, ...data },
        update: data,
      });
    }
    await tx.courseFile.updateMany({
      where: { courseId, removedAt: null, canvasId: { notIn: rows.map((row) => String(row.id)) } },
      data: { removedAt: now },
    });
  }

  /** Compares fetched items with their last-seen versions and records a change event for each difference. */
  private async reconcile(
    tx: Prisma.TransactionClient,
    scope: Scope,
    kind: ItemKind,
    items: TrackedItem[],
    trackRemovals: boolean,
  ): Promise<number> {
    const { userId, courseId, baseline, now } = scope;
    const known = new Map(
      (await tx.sourceItem.findMany({ where: { courseId, kind } })).map((item) => [item.canvasId, item]),
    );
    const events: Prisma.ChangeEventCreateManyInput[] = [];
    const fresh: TrackedItem[] = [];
    const record = (sourceItemId: number, title: string, changeType: ChangeType, detail: ChangeDetail) =>
      events.push({
        userId,
        courseId,
        sourceItemId,
        changeType,
        fields: detail.fields ?? [],
        summary: changeSummary(kind, changeType, title, detail.fields),
        before: detail.before,
        after: detail.after,
        detectedAt: now,
      });

    for (const item of items) {
      const previous = known.get(item.canvasId);
      known.delete(item.canvasId);
      if (!previous) {
        fresh.push(item);
        continue;
      }
      const hash = contentHash(item.content);
      if (previous.removedAt === null && previous.contentHash === hash) {
        if (previous.htmlUrl !== item.htmlUrl) {
          await tx.sourceItem.update({ where: { id: previous.id }, data: { htmlUrl: item.htmlUrl } });
        }
        continue;
      }
      await tx.sourceItem.update({
        where: { id: previous.id },
        data: { title: item.title, htmlUrl: item.htmlUrl, contentHash: hash, content: item.content, removedAt: null },
      });
      if (previous.removedAt !== null) {
        record(previous.id, item.title, "CREATED", { after: item.content });
        continue;
      }
      const before = previous.content as Content;
      const fields = changedFields(before, item.content);
      if (fields.length > 0) record(previous.id, item.title, "UPDATED", { fields, before, after: item.content });
    }

    if (fresh.length > 0) {
      const created = await tx.sourceItem.createManyAndReturn({
        data: fresh.map((item) => ({
          userId,
          courseId,
          kind,
          canvasId: item.canvasId,
          title: item.title,
          htmlUrl: item.htmlUrl,
          contentHash: contentHash(item.content),
          content: item.content,
          firstSeenAt: now,
        })),
        select: { id: true, canvasId: true },
      });
      if (!baseline) {
        const ids = new Map(created.map((row) => [row.canvasId, row.id]));
        for (const item of fresh) record(ids.get(item.canvasId) as number, item.title, "CREATED", { after: item.content });
      }
    }

    if (trackRemovals) {
      for (const gone of known.values()) {
        if (gone.removedAt !== null) continue;
        await tx.sourceItem.update({ where: { id: gone.id }, data: { removedAt: now } });
        record(gone.id, gone.title, "REMOVED", { before: gone.content as Content });
      }
    }

    if (events.length > 0) await tx.changeEvent.createMany({ data: events });
    return events.length;
  }
}

interface Scope {
  userId: string;
  courseId: number;
  baseline: boolean;
  now: Date;
}

interface ChangeDetail {
  fields?: string[];
  before?: Content;
  after?: Content;
}
