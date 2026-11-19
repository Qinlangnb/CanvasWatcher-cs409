// Progress with revisions, work timers and assignment attachments. The per-task routes are added to
// the tasks router (mountProgressRoutes); GET /api/work/active is its own router.
import { Router } from "express";
import { DateTime } from "luxon";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";
import type { Task } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";
import { idParam } from "../http/params.js";
import { actionTime, applyProgress } from "../tasks/progress.js";
import { activeWork, heartbeat, startWork, stopWork, workSummary } from "../tasks/work.js";
import { presentTask, taskInclude } from "./present.js";

const instant = z.iso
  .datetime({ offset: true, error: "Use a date and time with a time zone, for example 2026-11-06T23:59:00-06:00." })
  .transform((value) => new Date(value));
const percent = z
  .number({ error: "Send a whole percentage." })
  .int("Send a whole percentage.")
  .min(0, "Use 0 to 100.")
  .max(100, "Use 0 to 100.");
const revision = z.number({ error: "Send the revision as a whole number." }).int().min(0);

const progressBody = z
  .object({
    progress_percent: percent,
    expected_revision: revision.optional(),
    /** When the student made the change; defaults to now. */
    action_at: instant.optional(),
    /** Needed to lower progress on locally completed work. */
    reopen: z.boolean().optional(),
  })
  .strict();

const heartbeatBody = z
  .object({
    client_timestamp: instant,
    expected_revision: revision.optional(),
    progress_percent: percent.optional(),
    /** The client's own count; informational, the server times sessions itself. */
    elapsed_snapshot_seconds: z.number().int().min(0).optional(),
    remaining_minutes: z.number().int().min(0).optional(),
  })
  .strict();

const taskNotFound = () => new HttpError(404, "TASK_NOT_FOUND", "That task could not be found.");

/** 23:59 local time on `date`'s local day: the planning cutoff of a date-only deadline. */
export function endOfLocalDay(date: Date, zone: string): Date {
  return DateTime.fromJSDate(date, { zone }).set({ hour: 23, minute: 59, second: 0, millisecond: 0 }).toJSDate();
}

/** Course files the assignment's description links to, by name; removed files are left out. */
export async function taskAttachments(db: Db, task: Pick<Task, "id" | "courseId">) {
  const links = await db.taskFileLink.findMany({ where: { taskId: task.id }, select: { fileCanvasId: true } });
  if (links.length === 0) return [];
  const files = await db.courseFile.findMany({
    where: { courseId: task.courseId, removedAt: null, canvasId: { in: links.map((link) => link.fileCanvasId) } },
    select: { id: true, displayName: true },
  });
  return files
    .map((file) => ({ file_id: file.id, filename: file.displayName, download_url: `/api/files/${file.id}/download` }))
    .sort((a, b) => a.filename.toLowerCase().localeCompare(b.filename.toLowerCase()) || a.file_id - b.file_id);
}

export function mountProgressRoutes(router: Router, db: Db): void {
  const taskId = (raw: string | undefined) => idParam(raw, taskNotFound());

  /** Progress with a revision check; 100 completes the task. `applied: false` means it changed elsewhere. */
  router.post("/:id/progress", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const body = progressBody.parse(req.body ?? {});
    const task = await db.task.findFirst({ where: { id: taskId(req.params.id), userId } });
    if (!task) throw taskNotFound();
    const now = new Date();
    const applied = await applyProgress(db, {
      userId,
      task,
      percent: body.progress_percent,
      expectedRevision: body.expected_revision,
      actionAt: actionTime(body.action_at, now, "action_at"),
      reopen: body.reopen,
    });
    const fresh = await db.task.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
    res.json({ applied, state_revision: fresh.stateRevision, task: presentTask(fresh, now) });
  });

  router.get("/:id/work", async (req, res) => {
    res.json(await workSummary(db, currentAuth(res.locals).user.id, taskId(req.params.id)));
  });

  /** Starts this task's timer; another running timer stops (switched_from_task_id names it). */
  router.post("/:id/work/start", async (req, res) => {
    res.json(await startWork(db, currentAuth(res.locals).user.id, taskId(req.params.id)));
  });

  router.post("/:id/work/stop", async (req, res) => {
    res.json(await stopWork(db, currentAuth(res.locals).user.id, taskId(req.params.id)));
  });

  router.post("/:id/work/heartbeat", async (req, res) => {
    const body = heartbeatBody.parse(req.body ?? {});
    res.json(
      await heartbeat(db, currentAuth(res.locals).user.id, taskId(req.params.id), {
        clientTimestamp: body.client_timestamp,
        expectedRevision: body.expected_revision,
        progressPercent: body.progress_percent,
      }),
    );
  });
}

export function workRouter(db: Db): Router {
  const router = Router();
  /** The running timer, if any: `{ active: summary + task_title + course | null }`. */
  router.get("/active", async (_req, res) => {
    res.json({ active: await activeWork(db, currentAuth(res.locals).user.id) });
  });
  return router;
}
