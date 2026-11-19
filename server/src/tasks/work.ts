// Work timers. A user runs at most one timer (a partial unique index allows one open session per
// user), so starting one task stops the other. Finished sessions add to tasks.tracked_seconds; time
// used is that plus the student's manual correction (tasks.spent_minutes), so correcting the total
// never rewrites session history.
import { isUniqueViolation, type Db } from "../db.js";
import type { Task, WorkSession } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";
import { actionTime, applyProgress, closeOpenSession } from "./progress.js";

const iso = (date: Date | null) => (date ? date.toISOString() : null);

export const elapsedSeconds = (session: Pick<WorkSession, "startedAt">, now: Date) =>
  Math.max(0, Math.floor((now.getTime() - session.startedAt.getTime()) / 1000));

export function presentSession(session: WorkSession, now: Date) {
  return {
    id: session.id,
    task_id: session.taskId,
    started_at: session.startedAt.toISOString(),
    ended_at: iso(session.endedAt),
    duration_seconds: session.durationSeconds ?? elapsedSeconds(session, now),
    source: session.source,
  };
}

/** Totals for one task; tracked time includes the running session up to now. */
export async function workSummary(db: Db, userId: string, taskId: number, now = new Date(), withSessions = true) {
  const task = await db.task.findFirst({ where: { id: taskId, userId } });
  if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "That task could not be found.");
  const [open, sessions] = await Promise.all([
    db.workSession.findFirst({ where: { userId, taskId, endedAt: null } }),
    withSessions ? db.workSession.findMany({ where: { userId, taskId }, orderBy: [{ startedAt: "asc" }, { id: "asc" }], take: 500 }) : [],
  ]);
  const running = open ? elapsedSeconds(open, now) : 0;
  const tracked = Math.round((task.trackedSeconds + running) / 60);
  return {
    task_id: task.id,
    state_revision: task.stateRevision,
    local_completed: task.completedAt !== null,
    tracked_minutes: tracked,
    manual_adjustment_minutes: task.spentMinutes,
    effective_used_minutes: Math.max(0, tracked + task.spentMinutes),
    active_session_id: open?.id ?? null,
    active_started_at: iso(open?.startedAt ?? null),
    active_elapsed_seconds: running,
    sessions: sessions.map((session) => presentSession(session, now)),
  };
}

async function ownTask(db: Db, userId: string, taskId: number): Promise<Task> {
  const task = await db.task.findFirst({ where: { id: taskId, userId } });
  if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "That task could not be found.");
  return task;
}

/** Starts this task's timer, stopping any other; reports which task's timer was stopped. */
export async function startWork(db: Db, userId: string, taskId: number, now = new Date()) {
  const task = await ownTask(db, userId, taskId);
  if (task.completedAt) throw new HttpError(409, "TASK_COMPLETED", "Reopen this task before starting its timer.");
  if (task.ignoredAt) throw new HttpError(409, "TASK_IGNORED", "This task is ignored. Undo ignore before starting its timer.");
  if (task.removedAt) throw new HttpError(409, "TASK_REMOVED", "This assignment was removed from Canvas.");
  for (let attempt = 1; ; attempt += 1) {
    try {
      const switchedFrom = await db.$transaction(async (tx) => {
        const open = await tx.workSession.findFirst({ where: { userId, endedAt: null } });
        if (open?.taskId === taskId) return null;
        const stopped = open ? await closeOpenSession(tx, userId, now) : null;
        await tx.workSession.create({ data: { userId, taskId, startedAt: now } });
        return stopped;
      });
      return { ...(await workSummary(db, userId, taskId, now)), switched_from_task_id: switchedFrom };
    } catch (error) {
      // Two starts at once: the index let one through; the other tries again and sees it.
      if (attempt < 2 && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}

export async function stopWork(db: Db, userId: string, taskId: number, now = new Date()) {
  await ownTask(db, userId, taskId);
  await db.$transaction((tx) => closeOpenSession(tx, userId, now, taskId));
  return workSummary(db, userId, taskId, now);
}

/** Stops a task's timer if it runs; used when a task is completed or ignored. */
export async function stopTaskTimer(db: Db, userId: string, taskId: number, now = new Date()): Promise<void> {
  await db.$transaction((tx) => closeOpenSession(tx, userId, now, taskId));
}

export interface Heartbeat {
  clientTimestamp: Date;
  expectedRevision?: number;
  progressPercent?: number;
}

/**
 * A running timer's check-in. Stale (older than the last one) or out-of-revision heartbeats change
 * nothing; a progress value is applied with the revision check.
 */
export async function heartbeat(db: Db, userId: string, taskId: number, beat: Heartbeat, now = new Date()) {
  const task = await ownTask(db, userId, taskId);
  const open = await db.workSession.findFirst({ where: { userId, endedAt: null } });
  if (open?.taskId !== taskId) {
    if (task.completedAt) return workSummary(db, userId, taskId, now, false);
    throw new HttpError(409, "WORK_NOT_ACTIVE", "This task's timer isn't running.");
  }
  const stamp = actionTime(beat.clientTimestamp, now, "client_timestamp");
  const unchanged = () => workSummary(db, userId, taskId, now, false);
  if (beat.expectedRevision !== undefined && beat.expectedRevision !== task.stateRevision) return unchanged();
  if (task.completedAt || (task.lastClientReportedAt && stamp < task.lastClientReportedAt)) return unchanged();
  let current = task;
  if (beat.progressPercent !== undefined && beat.progressPercent !== task.progress) {
    const applied = await applyProgress(db, {
      userId,
      task,
      percent: beat.progressPercent,
      expectedRevision: beat.expectedRevision,
      actionAt: stamp,
      origin: "heartbeat",
    });
    if (!applied) return unchanged();
    current = await ownTask(db, userId, taskId);
  }
  // Only moves forward, and only while the revision is the one just checked.
  await db.task.updateMany({
    where: {
      id: taskId,
      stateRevision: current.stateRevision,
      OR: [{ lastClientReportedAt: null }, { lastClientReportedAt: { lte: stamp } }],
    },
    data: { lastClientReportedAt: stamp },
  });
  return unchanged();
}

/** The user's running timer, with its task, or null. */
export async function activeWork(db: Db, userId: string, now = new Date()) {
  const open = await db.workSession.findFirst({
    where: { userId, endedAt: null },
    include: { task: { select: { title: true, course: { select: { id: true, courseCode: true, name: true } } } } },
  });
  if (!open) return null;
  return {
    ...(await workSummary(db, userId, open.taskId, now, false)),
    task_title: open.task.title,
    course: { id: open.task.course.id, code: open.task.course.courseCode, name: open.task.course.name },
  };
}

/**
 * The manual correction that makes time used equal `total`: total minus tracked time, the running
 * session included (the client adds the running time to spent_minutes, so totals stay consistent).
 */
export async function correctionFor(db: Db, userId: string, task: Task, total: number, now = new Date()): Promise<number> {
  const open = await db.workSession.findFirst({ where: { userId, taskId: task.id, endedAt: null } });
  const tracked = Math.round((task.trackedSeconds + (open ? elapsedSeconds(open, now) : 0)) / 60);
  return total - tracked;
}
