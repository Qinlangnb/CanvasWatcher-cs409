// JSON shapes the API returns. Database rows never go out as they are.
import type {
  CanvasConnection,
  ChangeEvent,
  Course,
  CourseFile,
  Prisma,
  SourceItem,
  SyncRun,
  Task,
} from "../generated/prisma/client.js";
import { remainingMinutes, totalMinutes } from "../tasks/effort.js";

const iso = (date: Date | null) => (date ? date.toISOString() : null);
const lower = <T extends string>(value: T) => value.toLowerCase() as Lowercase<T>;

/** Canvas submission states that mean the student has handed the work in. */
export const SUBMITTED_STATES = ["submitted", "graded", "pending_review"];

/** Tasks the student still has to do, overdue ones included. */
export const openTaskWhere = {
  removedAt: null,
  completedAt: null,
  ignoredAt: null,
  OR: [{ submissionState: null }, { submissionState: { notIn: SUBMITTED_STATES } }],
} satisfies Prisma.TaskWhereInput;

export type CourseSummary = Pick<Course, "id" | "courseCode" | "name">;
export const courseSummarySelect = { id: true, courseCode: true, name: true } satisfies Prisma.CourseSelect;

export function presentCourseSummary(course: CourseSummary) {
  return { id: course.id, code: course.courseCode, name: course.name };
}

export function presentConnection(connection: CanvasConnection, now = new Date()) {
  return {
    base_url: connection.baseUrl,
    canvas_user_name: connection.displayName,
    status: lower(connection.status),
    verified_at: iso(connection.verifiedAt),
    last_synced_at: iso(connection.lastSyncedAt),
    syncing: connection.syncLeaseUntil !== null && connection.syncLeaseUntil > now,
  };
}

export function presentRun(run: SyncRun) {
  return {
    id: run.id,
    trigger: lower(run.trigger),
    status: lower(run.status),
    started_at: iso(run.startedAt),
    finished_at: iso(run.finishedAt),
    courses_synced: run.coursesSynced,
    changes_detected: run.changesDetected,
    error: run.error,
  };
}

export interface CourseCounts {
  open_tasks: number;
  unread_changes: number;
  files: number;
}

export function presentCourse(course: Course, counts: CourseCounts) {
  return {
    id: course.id,
    canvas_id: course.canvasId,
    code: course.courseCode,
    name: course.name,
    term: course.termName
      ? { name: course.termName, start_at: iso(course.termStartAt), end_at: iso(course.termEndAt) }
      : null,
    html_url: course.htmlUrl,
    archived: course.archivedAt !== null,
    last_seen_at: iso(course.lastSeenAt),
    counts,
  };
}

export type TaskState = "open" | "overdue" | "done" | "ignored" | "removed";

export function taskState(task: Task, now = new Date()): TaskState {
  if (task.removedAt) return "removed";
  if (task.completedAt || SUBMITTED_STATES.includes(task.submissionState ?? "")) return "done";
  if (task.ignoredAt) return "ignored";
  return task.dueAt && task.dueAt < now ? "overdue" : "open";
}

export type TaskWithCourse = Task & { course: CourseSummary };
export const taskInclude = { course: { select: courseSummarySelect } } satisfies Prisma.TaskInclude;

export function presentTask(task: TaskWithCourse, now = new Date()) {
  const state = taskState(task, now);
  return {
    id: task.id,
    course: presentCourseSummary(task.course),
    source: lower(task.source),
    title: task.title,
    type: task.taskType,
    due_at: iso(task.dueAt),
    points_possible: task.pointsPossible,
    html_url: task.htmlUrl,
    submission_state: task.submissionState,
    submitted_at: iso(task.submittedAt),
    completed_at: iso(task.completedAt),
    ignored_at: iso(task.ignoredAt),
    state,
    progress: task.progress,
    /** The student's estimate, or null while the type's default is used. */
    estimated_minutes: task.estimatedMinutes,
    total_minutes: totalMinutes(task),
    remaining_minutes: state === "done" ? 0 : remainingMinutes(task),
    /** Local date the student started it ahead of the plan; that day's plan includes it. */
    started_on: task.startedOn,
    notes: task.notes,
  };
}

export function presentFile(file: CourseFile & { course: CourseSummary }) {
  return {
    id: file.id,
    course: presentCourseSummary(file.course),
    name: file.displayName,
    content_type: file.contentType,
    size_bytes: file.sizeBytes,
    updated_at: iso(file.canvasUpdatedAt),
    download_url: `/api/files/${file.id}/download`,
  };
}

export type ChangeWithItem = ChangeEvent & {
  course: CourseSummary;
  sourceItem: Pick<SourceItem, "kind" | "title" | "htmlUrl">;
};

export const changeInclude = {
  course: { select: courseSummarySelect },
  sourceItem: { select: { kind: true, title: true, htmlUrl: true } },
} satisfies Prisma.ChangeEventInclude;

export function presentChange(change: ChangeWithItem) {
  return {
    id: change.id,
    course: presentCourseSummary(change.course),
    kind: lower(change.sourceItem.kind),
    change_type: lower(change.changeType),
    fields: change.fields,
    summary: change.summary,
    title: change.sourceItem.title,
    html_url: change.sourceItem.htmlUrl,
    detected_at: iso(change.detectedAt),
    read: change.readAt !== null,
  };
}
