// Progress and completion with a state revision. Every change compare-and-swaps on
// tasks.state_revision, so a stale tab or a late heartbeat can't overwrite newer work; a refused
// change answers `applied: false` and the client refreshes. Canvas's own submission state is kept
// apart (submission_state) and never written here.
import type { Db } from "../db.js";
import type { Prisma, Task } from "../generated/prisma/client.js";
import { FieldError, HttpError } from "../http/errors.js";

/** Client action times are accepted from a day ago (offline edits) to 5 minutes ahead (clock skew). */
export const ACTION_PAST_MS = 24 * 60 * 60_000;
export const ACTION_FUTURE_MS = 5 * 60_000;

export type ProgressOrigin = "user" | "heartbeat" | "reopen";

export const taskChanged = () =>
  new HttpError(409, "TASK_CHANGED", "Task changed elsewhere; refreshed the saved state.");

/** The client's action time, or now; out of the window is a 422 on `field`. */
export function actionTime(at: Date | undefined, now: Date, field: string): Date {
  if (!at) return now;
  if (at.getTime() > now.getTime() + ACTION_FUTURE_MS || at.getTime() < now.getTime() - ACTION_PAST_MS) {
    throw new FieldError(field, "This time is outside the synchronization window (a day ago to 5 minutes ahead).");
  }
  return at;
}

/**
 * Ends the user's running timer session (only if it belongs to `taskId`, when given) at `at`, and
 * adds its length to the task's tracked time. Returns the task id whose timer stopped, or null.
 */
export async function closeOpenSession(
  tx: Prisma.TransactionClient,
  userId: string,
  at: Date,
  taskId?: number,
): Promise<number | null> {
  const open = await tx.workSession.findFirst({ where: { userId, endedAt: null, ...(taskId ? { taskId } : {}) } });
  if (!open) return null;
  const end = at < open.startedAt ? open.startedAt : at;
  const seconds = Math.max(0, Math.round((end.getTime() - open.startedAt.getTime()) / 1000));
  // Guarded on ended_at, so two concurrent stops count the session once.
  const closed = await tx.workSession.updateMany({
    where: { id: open.id, endedAt: null },
    data: { endedAt: end, durationSeconds: seconds },
  });
  if (closed.count === 0) return null;
  await tx.task.update({ where: { id: open.taskId }, data: { trackedSeconds: { increment: seconds } } });
  return open.taskId;
}

export interface ProgressChange {
  userId: string;
  task: Task;
  percent: number;
  expectedRevision?: number;
  actionAt: Date;
  reopen?: boolean;
  origin?: ProgressOrigin;
}

/**
 * Sets progress; 100 completes the task locally and stops its timer at the action time. Reopening
 * completed work needs `reopen` and the current revision. Returns whether the change was applied.
 */
export async function applyProgress(db: Db | Prisma.TransactionClient, change: ProgressChange): Promise<boolean> {
  const { userId, task, percent, expectedRevision, actionAt } = change;
  const revision = task.stateRevision;
  if (expectedRevision !== undefined && expectedRevision !== revision) return false;
  const completed = task.completedAt !== null;
  if (completed && (percent === 100 || !change.reopen)) return false;
  if (completed && expectedRevision === undefined) {
    throw new FieldError("expected_revision", "Send the task's current revision to reopen it.");
  }
  if (!completed && percent === task.progress && percent < 100) return true;

  const run = async (tx: Prisma.TransactionClient): Promise<boolean> => {
    // Out-of-order: an older action than the last recorded one is ignored.
    const latest = await tx.taskProgress.findFirst({ where: { taskId: task.id }, orderBy: [{ recordedAt: "desc" }, { id: "desc" }] });
    if (latest && actionAt < latest.recordedAt) return false;
    if (percent === 100) {
      const open = await tx.workSession.findFirst({ where: { userId, taskId: task.id, endedAt: null } });
      if (open && actionAt < open.startedAt) {
        throw new FieldError("action_at", "Completion can't be earlier than the start of the running timer.");
      }
    }
    const claimed = await tx.task.updateMany({
      where: { id: task.id, userId, stateRevision: revision, completedAt: completed ? { not: null } : null },
      data: { stateRevision: revision + 1, progress: percent, completedAt: percent === 100 ? actionAt : null },
    });
    if (claimed.count !== 1) return false;
    if (percent === 100) await closeOpenSession(tx, userId, actionAt, task.id);
    await tx.taskProgress.create({
      data: {
        userId,
        taskId: task.id,
        recordedAt: actionAt,
        progress: percent,
        completed: percent === 100,
        origin: completed ? "reopen" : (change.origin ?? "user"),
      },
    });
    return true;
  };
  return "$transaction" in db ? db.$transaction(run) : run(db);
}
