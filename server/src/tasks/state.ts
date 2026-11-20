// A task's own state (done, ignored, progress) changes in one place for every path that edits it:
// PATCH /api/tasks/:id and AI Chat's confirmed changes. Like applyProgress (POST /:id/progress), a
// change compare-and-swaps on state_revision, progress 100 completes the task, completing or ignoring
// stops its running timer, and done/progress changes leave a task_progress row.
import type { Db } from "../db.js";
import type { Prisma, Task } from "../generated/prisma/client.js";
import { FieldError } from "../http/errors.js";
import { closeOpenSession, taskChanged, type ProgressOrigin } from "./progress.js";

export interface TaskStateChange {
  done?: boolean;
  ignored?: boolean;
  progress?: number;
}

export interface TaskChangeRequest {
  userId: string;
  task: Pick<Task, "id" | "stateRevision" | "completedAt" | "ignoredAt" | "progress">;
  state: TaskStateChange;
  /** Other columns written with the same compare-and-swap (estimate, notes, title...). */
  data?: Prisma.TaskUpdateInput;
  /** The revision the client last saw; a newer one refuses a state change (409 TASK_CHANGED). */
  expectedRevision?: number;
  now: Date;
  origin?: ProgressOrigin;
}

export const isStateChange = (state: TaskStateChange) =>
  state.done !== undefined || state.ignored !== undefined || state.progress !== undefined;

/**
 * Applies the change, or throws taskChanged() when the task moved on since it was read. Progress 100
 * marks the task done (as POST /:id/progress does) unless `done: false` is sent with it, which is
 * refused as contradictory.
 */
export async function applyTaskChange(db: Db, request: TaskChangeRequest): Promise<void> {
  const { userId, task, state, now } = request;
  const stateChange = isStateChange(state);
  if (stateChange && request.expectedRevision !== undefined && request.expectedRevision !== task.stateRevision) throw taskChanged();
  if (state.done === false && state.progress === 100) {
    throw new FieldError("progress", "Progress 100% marks the task done; lower it to reopen the task.");
  }
  const completes = state.done === true || (state.done === undefined && state.progress === 100);
  const completedAt = completes ? (task.completedAt ?? now) : state.done === false ? null : undefined;
  const ignoredAt = state.ignored === undefined ? undefined : state.ignored ? (task.ignoredAt ?? now) : null;
  const data: Prisma.TaskUpdateInput = {
    ...request.data,
    ...(completedAt !== undefined && { completedAt }),
    ...(ignoredAt !== undefined && { ignoredAt }),
    ...(state.progress !== undefined && { progress: state.progress }),
    ...(stateChange && { stateRevision: { increment: 1 } }),
  };
  await db.$transaction(async (tx) => {
    let updated;
    try {
      updated = await tx.task.update({ where: { id: task.id, userId, stateRevision: task.stateRevision }, data });
    } catch (error) {
      // Another change landed between reading and writing this task.
      if ((error as { code?: string }).code === "P2025") throw taskChanged();
      throw error;
    }
    // Completing or ignoring work ends its timer.
    if (completes || state.ignored === true) await closeOpenSession(tx, userId, now, task.id);
    if (state.done !== undefined || state.progress !== undefined) {
      await tx.taskProgress.create({
        data: {
          userId,
          taskId: task.id,
          recordedAt: now,
          progress: updated.progress,
          completed: updated.completedAt !== null,
          origin: request.origin ?? "user",
        },
      });
    }
  });
}
