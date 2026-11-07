import { Router } from "express";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { FieldError, HttpError } from "../http/errors.js";
import { idParam, parseQuery } from "../http/params.js";
import { TASK_TYPES } from "../tasks/effort.js";
import { openTaskWhere, presentTask, taskInclude } from "./present.js";

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
    notes: notes.nullable(),
    // Only for personal tasks; Canvas owns these fields of its assignments.
    title,
    type: taskType,
    due_at: instant.nullable(),
  })
  .partial()
  .strict();

const CANVAS_FIELDS = ["title", "type", "due_at"] as const;

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

  router.get("/:id", async (req, res) => {
    res.json(presentTask(await findTask(currentAuth(res.locals).user.id, req.params.id)));
  });

  /** Students add their own tasks (a study session, a reading) to one of their courses. */
  router.post("/", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const body = creation.parse(req.body ?? {});
    const course = await db.course.findFirst({ where: { id: body.course_id, userId }, select: { id: true } });
    if (!course) throw new FieldError("course_id", "Choose one of your courses.");
    const task = await db.task.create({
      data: {
        userId,
        courseId: course.id,
        source: "PERSONAL",
        title: body.title,
        taskType: body.type,
        dueAt: body.due_at,
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
    const now = new Date();
    const data: Prisma.TaskUpdateInput = {
      ...(body.done !== undefined && { completedAt: body.done ? (task.completedAt ?? now) : null }),
      ...(body.ignored !== undefined && { ignoredAt: body.ignored ? (task.ignoredAt ?? now) : null }),
      ...(body.progress !== undefined && { progress: body.progress }),
      ...(body.estimated_minutes !== undefined && { estimatedMinutes: body.estimated_minutes }),
      ...(body.notes !== undefined && { notes: body.notes || null }),
      ...(body.title !== undefined && { title: body.title }),
      ...(body.type !== undefined && { taskType: body.type }),
      ...(body.due_at !== undefined && { dueAt: body.due_at }),
    };
    const updated = await db.task.update({ where: { id: task.id }, data, include: taskInclude });
    res.json(presentTask(updated, now));
  });

  router.delete("/:id", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const task = await findTask(userId, req.params.id);
    if (task.source === "CANVAS") {
      throw new HttpError(409, "TASK_FROM_CANVAS", "Tasks from Canvas can't be deleted. Ignore it instead.");
    }
    await db.task.delete({ where: { id: task.id } });
    res.status(204).end();
  });

  return router;
}
