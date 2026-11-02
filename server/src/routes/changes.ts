import { Router } from "express";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";
import { idParam, parseQuery } from "../http/params.js";
import { changeInclude, courseSummarySelect, presentChange, presentTask } from "./present.js";

const listQuery = z.object({
  course_id: z.coerce.number().int().positive().optional(),
  unread: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** Cursor: the `next_before` of the previous page. */
  before: z.coerce.number().int().positive().optional(),
});

const readState = z.object({ read: z.boolean({ error: "Send read as true or false." }) });
const markAll = z.object({ course_id: z.number().int().positive().optional() });

const changeNotFound = () => new HttpError(404, "CHANGE_NOT_FOUND", "That change could not be found.");

/** Without a course filter, changes of archived courses are left out. */
function scope(userId: string, courseId: number | undefined): Prisma.ChangeEventWhereInput {
  return { userId, ...(courseId ? { courseId } : { course: { archivedAt: null } }) };
}

export function changesRouter(db: Db): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const query = parseQuery(listQuery, req.query);
    const rows = await db.changeEvent.findMany({
      where: {
        ...scope(userId, query.course_id),
        ...(query.unread === "true" ? { readAt: null } : query.unread === "false" ? { readAt: { not: null } } : {}),
        ...(query.before ? { id: { lt: query.before } } : {}),
      },
      include: changeInclude,
      // Ids grow with detection time, so they double as a stable cursor.
      orderBy: { id: "desc" },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    res.json({
      items: page.map(presentChange),
      next_before: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    });
  });

  router.get("/unread-count", async (_req, res) => {
    const userId = currentAuth(res.locals).user.id;
    res.json({ count: await db.changeEvent.count({ where: { ...scope(userId, undefined), readAt: null } }) });
  });

  router.post("/mark-all-read", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const body = markAll.parse(req.body ?? {});
    const result = await db.changeEvent.updateMany({
      where: { ...scope(userId, body.course_id), readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ updated: result.count });
  });

  async function findChange(userId: string, rawId: string | undefined) {
    const change = await db.changeEvent.findFirst({
      where: { id: idParam(rawId, changeNotFound()), userId },
      include: { ...changeInclude, sourceItem: { select: { kind: true, title: true, htmlUrl: true, canvasId: true } } },
    });
    if (!change) throw changeNotFound();
    return change;
  }

  /** One change with the before and after versions, and its task when it is about an assignment. */
  router.get("/:id", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const change = await findChange(userId, req.params.id);
    const task =
      change.sourceItem.kind === "ASSIGNMENT"
        ? await db.task.findFirst({
            where: { userId, courseId: change.courseId, canvasId: change.sourceItem.canvasId },
            include: { course: { select: courseSummarySelect } },
          })
        : null;
    res.json({
      ...presentChange(change),
      before: change.before,
      after: change.after,
      related_task: task ? presentTask(task) : null,
    });
  });

  router.patch("/:id", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const change = await findChange(userId, req.params.id);
    const body = readState.parse(req.body ?? {});
    const updated =
      body.read === (change.readAt !== null)
        ? change
        : await db.changeEvent.update({
            where: { id: change.id },
            data: { readAt: body.read ? new Date() : null },
            include: changeInclude,
          });
    res.json(presentChange(updated));
  });

  return router;
}
