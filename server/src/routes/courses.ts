import { Router } from "express";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import { CanvasError } from "../canvas/client.js";
import { findSyllabus } from "../canvas/syllabus.js";
import { keepSyllabus, keptSyllabus } from "../canvas/syllabusStore.js";
import { isWebsiteCourse, withWebsiteSources } from "../sources/website/syllabus.js";
import type { Db } from "../db.js";
import type { Course } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";
import { idParam, parseQuery } from "../http/params.js";
import { isPreview, previewUnavailable } from "../preview/accounts.js";
import type { Services } from "../services.js";
import { chooseDefaultTerm, normalizeTerm } from "../courses/terms.js";
import { notConnected } from "./canvas.js";
import { openTaskWhere, presentCourse, type CourseCounts } from "./present.js";

const listQuery = z.object({
  archived: z.enum(["true", "false"]).default("false"),
  /** A term id from GET /api/courses/terms; "all" or absent lists every term. */
  term_id: z.string().trim().max(80).optional(),
});

const archive = z.object({ archived: z.boolean({ error: "Send archived as true or false." }) });

const commute = z
  .object({
    commute_minutes: z
      .number({ error: "Send a whole number of minutes." })
      .int("Send a whole number of minutes.")
      .min(0, "Use 0 to 240 minutes.")
      .max(240, "Use 0 to 240 minutes."),
  })
  .strict();

const courseNotFound = () => new HttpError(404, "COURSE_NOT_FOUND", "That course could not be found.");

/** Open tasks, unread changes and files per course, in three grouped queries. */
async function countsFor(db: Db, userId: string, courseIds: number[]): Promise<Map<number, CourseCounts>> {
  const where = { userId, courseId: { in: courseIds } };
  const [tasks, changes, files] = await Promise.all([
    db.task.groupBy({ by: ["courseId"], where: { ...where, ...openTaskWhere }, _count: { _all: true } }),
    db.changeEvent.groupBy({ by: ["courseId"], where: { ...where, readAt: null }, _count: { _all: true } }),
    db.courseFile.groupBy({ by: ["courseId"], where: { ...where, removedAt: null }, _count: { _all: true } }),
  ]);
  const tally = (rows: { courseId: number; _count: { _all: number } }[]) =>
    new Map(rows.map((row) => [row.courseId, row._count._all]));
  const [taskCounts, changeCounts, fileCounts] = [tally(tasks), tally(changes), tally(files)];
  return new Map(
    courseIds.map((id) => [
      id,
      { open_tasks: taskCounts.get(id) ?? 0, unread_changes: changeCounts.get(id) ?? 0, files: fileCounts.get(id) ?? 0 },
    ]),
  );
}

export function coursesRouter(db: Db, services: Services): Router {
  const router = Router();

  async function presentOne(userId: string, course: Course) {
    const counts = await countsFor(db, userId, [course.id]);
    return presentCourse(course, counts.get(course.id) as CourseCounts);
  }

  router.get("/", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const query = parseQuery(listQuery, req.query);
    const all = await db.course.findMany({
      where: { userId, archivedAt: query.archived === "true" ? { not: null } : null },
      orderBy: [{ courseCode: "asc" }, { id: "asc" }],
    });
    const termId = query.term_id && query.term_id !== "all" ? query.term_id : null;
    const courses = termId ? all.filter((course) => normalizeTerm(course.termName, course.termStartAt, course.termEndAt).id === termId) : all;
    const counts = await countsFor(db, userId, courses.map((course) => course.id));
    res.json(courses.map((course) => presentCourse(course, counts.get(course.id) as CourseCounts)));
  });

  /** Terms of the user's courses, newest first, with course counts and the default (containing today, else newest). */
  router.get("/terms", async (_req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const courses = await db.course.findMany({
      where: { userId },
      select: { termName: true, termStartAt: true, termEndAt: true, archivedAt: true },
    });
    const terms = new Map<string, { term: ReturnType<typeof normalizeTerm>; active: number; archived: number }>();
    for (const course of courses) {
      const term = normalizeTerm(course.termName, course.termStartAt, course.termEndAt);
      const entry = terms.get(term.id) ?? { term, active: 0, archived: 0 };
      if (course.archivedAt) entry.archived += 1;
      else entry.active += 1;
      // Dates fill in from any course of the term that has them.
      entry.term.startAt ??= term.startAt;
      entry.term.endAt ??= term.endAt;
      terms.set(term.id, entry);
    }
    const withActive = [...terms.values()].filter((entry) => entry.active > 0).map((entry) => entry.term);
    const defaultId = chooseDefaultTerm(withActive);
    res.json(
      [...terms.values()]
        .sort((a, b) => (a.term.sortKey < b.term.sortKey ? 1 : a.term.sortKey > b.term.sortKey ? -1 : 0))
        .map(({ term, active, archived }) => ({
          term_id: term.id,
          display_name: term.displayName,
          start_at: term.startAt?.toISOString() ?? null,
          end_at: term.endAt?.toISOString() ?? null,
          sort_key: term.sortKey,
          active_course_count: active,
          archived_course_count: archived,
          is_default: term.id === defaultId,
        })),
    );
  });

  router.get("/:id", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const course = await db.course.findFirst({ where: { id: idParam(req.params.id, courseNotFound()), userId } });
    if (!course) throw courseNotFound();
    res.json(await presentOne(userId, course));
  });

  /**
   * The course syllabus, found wherever the instructor put it (see canvas/syllabus.ts). It is read
   * from Canvas with the user's token and a copy is kept. The copy is answered instead when Canvas
   * can't be asked: in a preview (no token), with a rejected token, or while Canvas is down.
   */
  router.get("/:id/syllabus", async (req, res) => {
    const { user } = currentAuth(res.locals);
    const userId = user.id;
    const course = await db.course.findFirst({ where: { id: idParam(req.params.id, courseNotFound()), userId } });
    if (!course) throw courseNotFound();
    const kept = await keptSyllabus(db, userId, course.id);
    const answerKept = () => {
      if (!kept) return false;
      res.json({ ...kept.syllabus, fetched_at: kept.fetchedAt.toISOString(), saved_copy: true });
      return true;
    };
    if (isPreview(user)) {
      if (answerKept()) return;
      throw previewUnavailable();
    }
    if (isWebsiteCourse(course)) {
      // A course only a website knows: its syllabus comes from the pages and files the last crawl kept.
      const syllabus = await withWebsiteSources(db, userId, course.id, { found: false, sources: [] });
      const now = new Date();
      await keepSyllabus(db, userId, course.id, syllabus, now);
      res.json({ ...syllabus, fetched_at: now.toISOString(), saved_copy: false });
      return;
    }
    const connection = await db.canvasConnection.findUnique({ where: { userId } });
    if (!connection) {
      if (answerKept()) return;
      throw notConnected();
    }
    const files = await db.courseFile.findMany({
      where: { userId, courseId: course.id, removedAt: null },
      select: { id: true, canvasId: true, displayName: true },
    });
    const client = await services.credentials.routed(userId);
    try {
      if (!client?.hasCredential()) throw new CanvasError("TOKEN_REJECTED", "Canvas needs you to sign in again.");
      const syllabus = await withWebsiteSources(db, userId, course.id, await findSyllabus(client, course.canvasId, course.htmlUrl, files));
      const now = new Date();
      await keepSyllabus(db, userId, course.id, syllabus, now);
      res.json({ ...syllabus, fetched_at: now.toISOString(), saved_copy: false });
    } catch (error) {
      if (!(error instanceof CanvasError)) throw error;
      if (error.kind === "TOKEN_REJECTED") {
        await services.credentials.markAuthRequired(userId);
        if (answerKept()) return;
        throw new HttpError(409, "CANVAS_RECONNECT_REQUIRED", "Canvas no longer accepts your access token. Reconnect Canvas in Settings.");
      }
      if (answerKept()) return;
      throw new HttpError(502, "CANVAS_UNAVAILABLE", error.message);
    } finally {
      await client?.flush();
    }
  });

  /** Archiving hides a finished course from lists; syncing keeps it up to date. */
  router.patch("/:id", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const id = idParam(req.params.id, courseNotFound());
    const body = archive.parse(req.body ?? {});
    const course = await db.course.findFirst({ where: { id, userId } });
    if (!course) throw courseNotFound();
    const updated =
      body.archived === (course.archivedAt !== null)
        ? course
        : await db.course.update({ where: { id }, data: { archivedAt: body.archived ? new Date() : null } });
    res.json(await presentOne(userId, updated));
  });

  /** Travel time around this course's class events; Today and the calendar treat it as busy. */
  router.patch("/:id/commute", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const id = idParam(req.params.id, courseNotFound());
    const body = commute.parse(req.body ?? {});
    const { count } = await db.course.updateMany({ where: { id, userId }, data: { commuteMinutes: body.commute_minutes } });
    if (!count) throw courseNotFound();
    const course = (await db.course.findFirst({ where: { id, userId } })) as Course;
    res.json(await presentOne(userId, course));
  });

  router.post("/:id/archive", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const course = await db.course.findFirst({ where: { id: idParam(req.params.id, courseNotFound()), userId } });
    if (!course) throw courseNotFound();
    const updated = course.archivedAt ? course : await db.course.update({ where: { id: course.id }, data: { archivedAt: new Date() } });
    res.json(await presentOne(userId, updated));
  });

  /**
   * Restores an archived course and queues a sync, so anything that changed while it was hidden is
   * reconciled. `reconciliation_queued` is false when no sync could start (a preview, or no Canvas).
   */
  router.post("/:id/restore", async (req, res) => {
    const { user } = currentAuth(res.locals);
    const course = await db.course.findFirst({ where: { id: idParam(req.params.id, courseNotFound()), userId: user.id } });
    if (!course) throw courseNotFound();
    const updated = course.archivedAt ? await db.course.update({ where: { id: course.id }, data: { archivedAt: null } }) : course;
    let queued = false;
    if (!isPreview(user)) {
      const connection = await db.canvasConnection.findUnique({ where: { userId: user.id }, select: { status: true } });
      if (connection?.status === "OK") queued = (await services.sync.start(user.id, "MANUAL")) !== null;
    }
    res.json({ ...(await presentOne(user.id, updated)), reconciliation_queued: queued });
  });

  return router;
}
