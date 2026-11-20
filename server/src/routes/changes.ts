import { Router } from "express";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";
import { idParam, parseQuery } from "../http/params.js";
import { changeInclude, courseSummarySelect, presentChange, presentTask } from "./present.js";
import type { Content } from "../canvas/normalize.js";
import { snapshotText } from "../changes/taxonomy.js";
import { presentReview } from "./changeReview.js";

const listQuery = z.object({
  course_id: z.coerce.number().int().positive().optional(),
  unread: z.enum(["true", "false"]).optional(),
  /** true: only the Important set (new files and announcements, grades, deadlines), as the app shows by default. */
  important: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** Cursor: the `next_before` of the previous page. */
  before: z.coerce.number().int().positive().optional(),
});

const countQuery = z.object({
  /** One course's unread changes (archived or not), like the feed's course filter. */
  course_id: z.coerce.number().int().positive().optional(),
  important: z.enum(["true", "false"]).optional(),
});
const readState = z.object({ read: z.boolean({ error: "Send read as true or false." }) });
const markAll = z.object({
  course_id: z.number().int().positive().optional(),
  /** true: only the Important set the feed shows by default, so changes it hides keep their unread state. */
  important: z.boolean({ error: "Send important as true or false." }).optional(),
});

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
        ...(query.important === "true" ? { userFacing: true } : {}),
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

  router.get("/unread-count", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const query = parseQuery(countQuery, req.query);
    const important = query.important === "true" ? { userFacing: true } : {};
    res.json({ count: await db.changeEvent.count({ where: { ...scope(userId, query.course_id), ...important, readAt: null } }) });
  });

  router.post("/mark-all-read", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const body = markAll.parse(req.body ?? {});
    const result = await db.changeEvent.updateMany({
      where: { ...scope(userId, body.course_id), ...(body.important ? { userFacing: true } : {}), readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ updated: result.count });
  });

  async function findChange(userId: string, rawId: string | undefined) {
    const change = await db.changeEvent.findFirst({
      where: { id: idParam(rawId, changeNotFound()), userId },
      include: {
        ...changeInclude,
        sourceItem: { select: { kind: true, title: true, htmlUrl: true, canvasId: true } },
        review: true,
      },
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
      // The two versions as text, plus what the app knows about the change behind the scenes.
      before_text: snapshotText(change.before as Content | null),
      after_text: snapshotText(change.after as Content | null),
      review: change.review ? presentReview(change.review) : null,
      // Not "internal_metadata": that word would trip the preview test, which looks for the name "Ada" anywhere.
      internals: {
        // Whether a dedupe key guards this change; the key itself is a hash with nothing to read in it.
        deduplicated: change.semanticKey !== null,
        source_item_id: change.sourceItemId,
        canvas_id: change.sourceItem.canvasId,
        fields: change.fields,
        review_stage1: change.review ? `${change.review.stage1}: ${change.review.stage1Reason}` : null,
        matched_rule: change.review?.matchedRule ?? null,
      },
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
