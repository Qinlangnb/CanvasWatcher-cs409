import { Router } from "express";
import { DateTime } from "luxon";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { FieldError, HttpError } from "../http/errors.js";
import { idParam, parseQuery } from "../http/params.js";
import { TASK_TYPES } from "../tasks/effort.js";
import { applyTaskChange } from "../tasks/state.js";
import { correctionFor } from "../tasks/work.js";
import { endOfLocalDay, mountProgressRoutes, taskAttachments } from "./work.js";
import { openTaskWhere, presentTask, taskDescription, taskInclude } from "./present.js";
import { getSettings } from "./settings.js";

const instant = z.iso
  .datetime({ offset: true, error: "Use a date and time with a time zone, for example 2026-11-06T23:59:00-06:00." })
  .transform((value) => new Date(value))
  .refine((date) => date.getUTCFullYear() >= 2000 && date.getUTCFullYear() <= 2100, "Use a date between 2000 and 2100.");

const listQuery = z.object({
  course_id: z.coerce.number().int().positive().optional(),
  /** `open` is everything not yet handed in, overdue included. */
  status: z.enum(["open", "all"]).default("open"),
  due_after: instant.optional(),
  due_before: instant.optional(),
});

const title = z.string().trim().min(1, "Give the task a title.").max(200, "Use at most 200 characters.");
const taskType = z.enum(TASK_TYPES, { error: `Choose one of: ${TASK_TYPES.join(", ")}.` });
const estimate = z
  .number({ error: "Send a whole number of minutes." })
  .int("Send a whole number of minutes.")
  .min(5, "Estimate at least 5 minutes.")
  .max(100 * 60, "Estimate at most 100 hours.");
const notes = z.string().trim().max(2000, "Use at most 2,000 characters.");

const creation = z
  .object({
    course_id: z.number({ error: "Choose a course." }).int().positive(),
    title,
    type: taskType.default("other"),
    due_at: instant.nullable().default(null),
    /** The due date has no time: due_at's local day is kept, at 23:59. */
    due_date_only: z.boolean({ error: "Send due_date_only as true or false." }).default(false),
    estimated_minutes: estimate.nullable().default(null),
    notes: notes.nullable().default(null),
  })
  .strict();

const changes = z
  .object({
    done: z.boolean({ error: "Send done as true or false." }),
    ignored: z.boolean({ error: "Send ignored as true or false." }),
    progress: z
      .number({ error: "Send a whole percentage." })
      .int("Send a whole percentage.")
      .min(0, "Use 0 to 100.")
      .max(100, "Use 0 to 100."),
    estimated_minutes: estimate.nullable(),
    /** Total minutes spent so far, as the student counts it (not added to: it replaces). */
    spent_minutes: z
      .number({ error: "Send a whole number of minutes." })
      .int("Send a whole number of minutes.")
      .min(0, "Use 0 or more minutes.")
      .max(1000 * 60, "Use at most 1,000 hours."),
    notes: notes.nullable(),
    /** Put the task on today's plan now, ahead of the planner (false takes it back off). */
    start_today: z.boolean({ error: "Send start_today as true or false." }),
    // Only for personal tasks; Canvas owns these fields of its assignments.
    title,
    type: taskType,
    due_at: instant.nullable(),
    due_date_only: z.boolean({ error: "Send due_date_only as true or false." }),
    /** The task's state_revision as last seen; a newer one refuses done, ignored and progress changes. */
    expected_revision: z.number({ error: "Send the revision as a whole number." }).int().min(0),
  })
  .partial()
  .strict();

const CANVAS_FIELDS = ["title", "type", "due_at", "due_date_only"] as const;

const taskNotFound = () => new HttpError(404, "TASK_NOT_FOUND", "That task could not be found.");

export function tasksRouter(db: Db): Router {
  const router = Router();

  async function findTask(userId: string, rawId: string | undefined) {
    const task = await db.task.findFirst({ where: { id: idParam(rawId, taskNotFound()), userId }, include: taskInclude });
    if (!task) throw taskNotFound();
    return task;
  }

  router.get("/", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const query = parseQuery(listQuery, req.query);
    const due =
      query.due_after || query.due_before
        ? { dueAt: { ...(query.due_after && { gte: query.due_after }), ...(query.due_before && { lt: query.due_before }) } }
        : {};
    const where: Prisma.TaskWhereInput = {
      userId,
      // Tasks of archived courses only show up when that course is asked for.
      ...(query.course_id ? { courseId: query.course_id } : { course: { archivedAt: null } }),
      ...(query.status === "open" ? openTaskWhere : { removedAt: null }),
      ...due,
    };
    const tasks = await db.task.findMany({
      where,
      include: taskInclude,
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { id: "asc" }],
      take: 1000,
    });
    const now = new Date();
    res.json(tasks.map((task) => presentTask(task, now)));
  });

  /** One task, with the assignment's description from Canvas when there is one. */
  router.get("/:id", async (req, res) => {
    const task = await findTask(currentAuth(res.locals).user.id, req.params.id);
    const [description, attachments] = await Promise.all([taskDescription(db, task), taskAttachments(db, task)]);
    res.json({ ...presentTask(task), description, attachments });
  });

  mountProgressRoutes(router, db);

  /** Students add their own tasks (a study session, a reading) to one of their courses. */
  router.post("/", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const body = creation.parse(req.body ?? {});
    const course = await db.course.findFirst({ where: { id: body.course_id, userId }, select: { id: true } });
    if (!course) throw new FieldError("course_id", "Choose one of your courses.");
    if (body.due_date_only && !body.due_at) throw new FieldError("due_at", "Choose the day it's due.");
    const zone = body.due_date_only ? (await getSettings(db, userId)).timeZone : null;
    const task = await db.task.create({
      data: {
        userId,
        courseId: course.id,
        source: "PERSONAL",
        title: body.title,
        taskType: body.type,
        dueAt: zone && body.due_at ? endOfLocalDay(body.due_at, zone) : body.due_at,
        dueDateOnly: Boolean(zone && body.due_at),
        estimatedMinutes: body.estimated_minutes,
        notes: body.notes || null,
      },
      include: taskInclude,
    });
    res.status(201).json(presentTask(task));
  });

  router.patch("/:id", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const body = changes.parse(req.body ?? {});
    const task = await findTask(userId, req.params.id);
    if (task.source === "CANVAS" && CANVAS_FIELDS.some((field) => body[field] !== undefined)) {
      throw new HttpError(409, "TASK_FROM_CANVAS", "This task comes from Canvas. Change its title and due date in Canvas.");
    }
    // Course-website and Gradescope tasks are rewritten by their next sync, like Canvas ones.
    if (task.source !== "PERSONAL" && task.source !== "CANVAS" && CANVAS_FIELDS.some((field) => body[field] !== undefined)) {
      throw new HttpError(409, "TASK_FROM_SOURCE", "This task comes from a synced source; its title and due date follow that source.");
    }
    const now = new Date();
    const settings = body.start_today !== undefined || body.due_at !== undefined || body.due_date_only !== undefined ? await getSettings(db, userId) : null;
    let startedOn: string | null | undefined;
    if (body.start_today !== undefined && settings) {
      startedOn = body.start_today ? DateTime.fromJSDate(now, { zone: settings.timeZone }).toISODate() : null;
    }
    // A date-only deadline keeps its day at 23:59 local time.
    const dateOnly = body.due_date_only ?? (body.due_at !== undefined ? false : task.dueDateOnly);
    const dueAt = body.due_at !== undefined ? body.due_at : body.due_date_only !== undefined ? task.dueAt : undefined;
    const due =
      dueAt === undefined
        ? {}
        : { dueAt: dueAt && dateOnly && settings ? endOfLocalDay(dueAt, settings.timeZone) : dueAt, dueDateOnly: Boolean(dueAt && dateOnly) };
    const spent = body.spent_minutes !== undefined ? await correctionFor(db, userId, task, body.spent_minutes, now) : undefined;
    // Done, ignored and progress are the task's state (tasks/state.ts): they bump its revision, a stale
    // revision is refused, progress 100 completes the task and completing or ignoring stops its timer.
    await applyTaskChange(db, {
      userId,
      task,
      state: { done: body.done, ignored: body.ignored, progress: body.progress },
      expectedRevision: body.expected_revision,
      now,
      data: {
        ...(body.estimated_minutes !== undefined && { estimatedMinutes: body.estimated_minutes }),
        ...(spent !== undefined && { spentMinutes: spent }),
        ...(body.notes !== undefined && { notes: body.notes || null }),
        ...(startedOn !== undefined && { startedOn }),
        ...(body.title !== undefined && { title: body.title }),
        ...(body.type !== undefined && { taskType: body.type }),
        ...due,
      },
    });
    const updated = await db.task.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
    res.json(presentTask(updated, now));
  });

  router.delete("/:id", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const task = await findTask(userId, req.params.id);
    if (task.source === "CANVAS") {
      throw new HttpError(409, "TASK_FROM_CANVAS", "Tasks from Canvas can't be deleted. Ignore it instead.");
    }
    if (task.source !== "PERSONAL") throw new HttpError(409, "TASK_FROM_SOURCE", "Synced tasks can't be deleted. Ignore it instead.");
    await db.task.delete({ where: { id: task.id } });
    res.status(204).end();
  });

  return router;
}

/** For AI Chat's confirmed changes (ai/writeTools.ts), which validate like this route. */
export { changes as taskChangeSchema };
