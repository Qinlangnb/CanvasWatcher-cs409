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
import type { Db } from "../db.js";
import { normalizeCourseDisplay, normalizeTerm } from "../courses/terms.js";
import { effectiveFileType } from "../files/types.js";
import { remainingBasis, remainingMinutes, totalMinutes, usedMinutes } from "../tasks/effort.js";
import { safeTaskUrl } from "../tasks/links.js";

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
  const term = normalizeTerm(course.termName, course.termStartAt, course.termEndAt);
  const display = normalizeCourseDisplay(course.courseCode, course.name, course.termName);
  return {
    id: course.id,
    canvas_id: course.canvasId,
    code: course.courseCode,
    name: course.name,
    /** "CS 409" and the section ("Section AL1"), read from Canvas's code and name. */
    display_code: display.code,
    section: display.section,
    term: course.termName
      ? {
          name: course.termName,
          start_at: iso(course.termStartAt),
          end_at: iso(course.termEndAt),
          id: term.id,
          display_name: term.displayName,
          sort_key: term.sortKey,
        }
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

/** `aiEstimate` is the AI's estimate of the total work, used for time left when the student gave none. */
export type TaskWithCourse = Task & { course: CourseSummary; aiEstimate?: { minutes: number | null } | null };
export const taskInclude = {
  course: { select: courseSummarySelect },
  aiEstimate: { select: { minutes: true } },
} satisfies Prisma.TaskInclude;

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
    /** What remaining_minutes is based on: the pace so far, the student's estimate, the AI's estimate, or the type's default. */
    remaining_basis: remainingBasis(task),
    /** Minutes used: finished timer sessions plus the student's correction (a running timer is not included). */
    spent_minutes: usedMinutes(task),
    tracked_minutes: Math.round(task.trackedSeconds / 60),
    manual_adjustment_minutes: task.spentMinutes,
    /** Send back as expected_revision with progress and completion changes. */
    state_revision: task.stateRevision,
    /** The validated page a task card opens, or null. */
    source_url: safeTaskUrl(task.htmlUrl),
    /** date_only when the deadline is a day without a time; due_at is then 23:59 local that day. */
    deadline_precision: task.dueAt ? (task.dueDateOnly ? "date_only" : "exact") : null,
    /** Canvas score and grade, once Canvas shows them to the student. */
    score: task.score,
    grade: task.grade,
    excused: task.excused,
    /** Local date the student started it ahead of the plan; that day's plan includes it. */
    started_on: task.startedOn,
    notes: task.notes,
  };
}

/** The Canvas assignment's description, as text, when Canvas has one (never for personal tasks). */
export async function taskDescription(db: Db, task: Pick<Task, "courseId" | "canvasId">): Promise<string | null> {
  if (!task.canvasId) return null;
  const item = await db.sourceItem.findUnique({
    where: { courseId_kind_canvasId: { courseId: task.courseId, kind: "ASSIGNMENT", canvasId: task.canvasId } },
    select: { content: true },
  });
  const description = (item?.content as { description?: unknown } | undefined)?.description;
  return typeof description === "string" && description.trim() ? description : null;
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
    /** lecture, homework, discussion, reading, exam, solution or other: the student's choice, else detected. */
    type: effectiveFileType(file),
    detected_type: file.detectedType,
    user_override_type: file.userOverrideType,
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
