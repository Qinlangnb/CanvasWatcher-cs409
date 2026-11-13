import { Router } from "express";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import { CanvasError, openToken } from "../canvas/client.js";
import { findSyllabus, sampleSyllabus } from "../canvas/syllabus.js";
import type { Db } from "../db.js";
import { isDemo } from "../demo/accounts.js";
import type { Course } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";
import { idParam, parseQuery } from "../http/params.js";
import type { Services } from "../services.js";
import { notConnected } from "./canvas.js";
import { openTaskWhere, presentCourse, type CourseCounts } from "./present.js";

const listQuery = z.object({
  archived: z.enum(["true", "false"]).default("false"),
});

const archive = z.object({ archived: z.boolean({ error: "Send archived as true or false." }) });

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
    const courses = await db.course.findMany({
      where: { userId, archivedAt: query.archived === "true" ? { not: null } : null },
      orderBy: [{ courseCode: "asc" }, { id: "asc" }],
    });
    const counts = await countsFor(db, userId, courses.map((course) => course.id));
    res.json(courses.map((course) => presentCourse(course, counts.get(course.id) as CourseCounts)));
  });

  router.get("/:id", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const course = await db.course.findFirst({ where: { id: idParam(req.params.id, courseNotFound()), userId } });
    if (!course) throw courseNotFound();
    res.json(await presentOne(userId, course));
  });

  /**
   * The course syllabus, found wherever the instructor put it (see canvas/syllabus.ts). It is read
   * from Canvas on request with the user's token and not stored.
   */
  router.get("/:id/syllabus", async (req, res) => {
    const { user } = currentAuth(res.locals);
    const userId = user.id;
    const course = await db.course.findFirst({ where: { id: idParam(req.params.id, courseNotFound()), userId } });
    if (!course) throw courseNotFound();
    if (isDemo(user)) {
      res.json(sampleSyllabus(course.htmlUrl));
      return;
    }
    const connection = await db.canvasConnection.findUnique({ where: { userId } });
    if (!connection) throw notConnected();
    const files = await db.courseFile.findMany({
      where: { userId, courseId: course.id, removedAt: null },
      select: { id: true, canvasId: true, displayName: true },
    });
    try {
      const client = services.canvas(connection.baseUrl, openToken(services.secrets, connection.tokenCiphertext, userId));
      res.json(await findSyllabus(client, course.canvasId, course.htmlUrl, files));
    } catch (error) {
      if (!(error instanceof CanvasError)) throw error;
      if (error.kind === "TOKEN_REJECTED") {
        await db.canvasConnection.updateMany({ where: { userId }, data: { status: "TOKEN_REJECTED" } });
        throw new HttpError(409, "CANVAS_RECONNECT_REQUIRED", "Canvas no longer accepts your access token. Reconnect Canvas in Settings.");
      }
      throw new HttpError(502, "CANVAS_UNAVAILABLE", error.message);
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

  return router;
}
