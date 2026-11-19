// Gradescope sources: discover the student's courses, link them to courses here, and sync each
// linked course's assignments into provider facts on tasks. Read-only, GET-only, with the session
// the Auth Broker captured. PrairieLearn signs in the same way, but its course pages are not read.
import type { Content, TrackedItem } from "../../canvas/normalize.js";
import type { Db } from "../../db.js";
import type { ProviderAssignment, SourceConnection, Task } from "../../generated/prisma/client.js";
import { HttpError } from "../../http/errors.js";
import { notify, resolveNotice } from "../../notifications/notify.js";
import type { Services } from "../../services.js";
import { reconcileSourceItems } from "../items.js";
import { clearProviderSession, openProviderSession } from "../providerSessions.js";
import type { SessionVerification, SourceContext, SourceSyncResult } from "../registry.js";
import { fetchGradescopeAssignments, parseCourses, type AssignmentBinding, type ProviderFacts } from "./gradescope.js";
import { decideProviderTask, providerFact, stronglyBoundTask, terminalState, weakTaskCandidates, type ProviderFactRow } from "./taskMatching.js";
import { ProviderError, ProviderWeb, verifySession, type Provider } from "./web.js";

export const PRAIRIELEARN_NOTE =
  "Student course parsing awaits representative course data. PrairieLearn sign-in works; its courses and assessments are not read yet.";

export const sessionKey = (sourceId: string) => `auth-required:provider:${sourceId}`;

const providerOf = (source: SourceConnection): Provider => (source.type === "PRAIRIELEARN" ? "prairielearn" : "gradescope");

/** The broker's hook: GET the dashboard with the captured cookies and look for the signed-in markers. */
export async function verifyBrokerSession(provider: Provider, baseUrl: string, cookies: Map<string, string>, services: Services): Promise<SessionVerification> {
  const check = await verifySession(provider, baseUrl, Object.fromEntries(cookies), services.sourceTransport);
  if (check.verified) return { ok: true };
  // A fixed code only: the provider's own text never reaches the page.
  return { ok: false, reason: "AUTH_LOGIN_FAILED" };
}

async function client(db: Db, services: Services, source: SourceConnection): Promise<ProviderWeb> {
  const cookies = await openProviderSession(db, services.secrets, source.userId, source.id);
  if (!cookies?.size) throw new HttpError(409, "AUTH_REQUIRED", "Sign in to this source through the Auth Broker first.");
  return new ProviderWeb(providerOf(source), source.baseUrl, Object.fromEntries(cookies), services.sourceTransport);
}

/** An expired session is cleared once (its generation guards a newer sign-in) and a banner is raised. */
async function sessionExpired(db: Db, source: SourceConnection): Promise<void> {
  const session = await db.providerSession.findUnique({ where: { connectionId: source.id } });
  await clearProviderSession(db, source.userId, source.id, { expectedGeneration: session?.generation, state: "EXPIRED", reason: "AUTH_REQUIRED" });
  await notify(db, source.userId, {
    key: sessionKey(source.id),
    level: "important",
    title: `${source.name} needs signing in`,
    body: "The saved browser session ended. Sign in again from Settings → Sources.",
  });
}

const providerError = (error: ProviderError) => {
  switch (error.code) {
    case "AUTH_REQUIRED":
      return new HttpError(409, "AUTH_REQUIRED", "The session ended. Sign in again through the Auth Broker.");
    case "PROVIDER_PERMISSION_DENIED":
      return new HttpError(409, error.code, "The provider refused access to that page.");
    case "PRAIRIELEARN_COURSE_PARSER_NOT_VERIFIED":
      return new HttpError(409, error.code, PRAIRIELEARN_NOTE);
    default:
      return new HttpError(502, error.code, "The provider's page could not be read as expected. Existing data was kept.");
  }
};

/** The student's Gradescope courses, each with the course here it is linked to (if any). */
export async function discoverCourses(db: Db, services: Services, source: SourceConnection) {
  if (source.type === "PRAIRIELEARN") throw new HttpError(409, "PRAIRIELEARN_COURSE_PARSER_NOT_VERIFIED", PRAIRIELEARN_NOTE);
  const web = await client(db, services, source);
  try {
    const courses = parseCourses(await web.probe(), web.base);
    const maps = new Map((await db.providerCourseMap.findMany({ where: { sourceId: source.id } })).map((row) => [row.providerCourseId, row.courseId]));
    await resolveNotice(db, source.userId, sessionKey(source.id));
    return courses.map((course) => ({
      external_id: course.externalId,
      course_code: course.courseCode,
      name: course.name,
      term: course.term,
      url: course.url,
      mapped_course_id: maps.get(course.externalId) ?? null,
    }));
  } catch (error) {
    if (error instanceof ProviderError) {
      if (error.code === "AUTH_REQUIRED") await sessionExpired(db, source);
      throw providerError(error);
    }
    throw error;
  } finally {
    web.close();
  }
}

export async function mapCourse(db: Db, source: SourceConnection, input: { provider_course_id: string; course_id: number; course_code?: string; name?: string }) {
  if (source.type !== "GRADESCOPE") throw new HttpError(409, "PRAIRIELEARN_COURSE_PARSER_NOT_VERIFIED", PRAIRIELEARN_NOTE);
  const course = await db.course.findFirst({ where: { id: input.course_id, userId: source.userId }, select: { id: true, courseCode: true, name: true } });
  if (!course) throw new HttpError(404, "COURSE_NOT_FOUND", "That course could not be found.");
  const existing = await db.providerCourseMap.findUnique({ where: { sourceId_providerCourseId: { sourceId: source.id, providerCourseId: input.provider_course_id } } });
  if (existing) throw new HttpError(409, "PROVIDER_COURSE_ALREADY_MAPPED", "This Gradescope course is already linked. Remove that link first.");
  const map = await db.providerCourseMap.create({
    data: {
      userId: source.userId,
      sourceId: source.id,
      providerCourseId: input.provider_course_id,
      courseId: course.id,
      courseCode: input.course_code?.slice(0, 60) || course.courseCode,
      name: input.name?.slice(0, 200) || course.name,
    },
  });
  return { provider_course_id: map.providerCourseId, course_id: map.courseId, mapping_evidence: "user_confirmed" };
}

export async function unmapCourse(db: Db, source: SourceConnection, providerCourseId: string): Promise<void> {
  await db.providerCourseMap.deleteMany({ where: { sourceId: source.id, providerCourseId } });
}

/** Tasks a Gradescope assignment may stand for: open tasks of the course, not created by a provider. */
async function courseTasks(db: Db, userId: string, courseId: number) {
  return db.task.findMany({
    where: { userId, courseId, removedAt: null, source: { in: ["CANVAS", "PERSONAL", "WEBSITE"] } },
    select: { id: true, title: true, dueAt: true, externalToolUrl: true, source: true, htmlUrl: true },
  });
}

export async function syncProvider(source: SourceConnection, context: SourceContext): Promise<SourceSyncResult> {
  const { db, services, userId } = context;
  if (source.type === "PRAIRIELEARN") throw new HttpError(409, "PRAIRIELEARN_COURSE_PARSER_NOT_VERIFIED", PRAIRIELEARN_NOTE);
  const cookies = await openProviderSession(db, services.secrets, userId, source.id);
  if (!cookies?.size) return { state: "AUTH_REQUIRED", items_seen: 0, changes: 0, errors: [{ resource: "session", code: "AUTH_REQUIRED", http_status: null }] };
  const maps = await db.providerCourseMap.findMany({ where: { sourceId: source.id } });
  if (maps.length === 0) {
    return { state: "READY", items_seen: 0, changes: 0, errors: [{ resource: "courses", code: "PROVIDER_COURSE_MAPPING_REQUIRED", http_status: null }] };
  }
  const web = new ProviderWeb("gradescope", source.baseUrl, Object.fromEntries(cookies), services.sourceTransport);
  const errors: SourceSyncResult["errors"] = [];
  let seen = 0;
  let changes = 0;
  const now = new Date();
  try {
    for (const map of maps) {
      const rows = await db.providerAssignment.findMany({ where: { sourceId: source.id, providerCourseId: map.providerCourseId } });
      const bindings: Record<string, AssignmentBinding> = {};
      for (const row of rows) {
        if (row.binding === "separate") bindings[row.providerAssignmentId] = "separate";
        else if (row.binding === "confirmed" && row.taskId) bindings[row.providerAssignmentId] = row.taskId;
      }
      let fetched;
      try {
        fetched = await fetchGradescopeAssignments(web, map.providerCourseId, bindings);
      } catch (error) {
        if (error instanceof ProviderError && error.code === "AUTH_REQUIRED") throw error;
        // One course's unexpected markup leaves its data as it was; other courses go on.
        errors.push({ resource: `course ${map.courseCode}`, code: error instanceof ProviderError ? error.code : "internal_error", http_status: null });
        continue;
      }
      // Rows without a stable id are counted, never invented.
      for (const code of Object.keys(fetched.errors)) errors.push({ resource: `course ${map.courseCode}`, code, http_status: null });
      const known = new Map(rows.map((row) => [row.providerAssignmentId, row]));
      const tasks = await courseTasks(db, userId, map.courseId);
      const baseline = rows.length === 0;
      let mappingRequired = 0;
      changes += await db.$transaction(
        async (tx) => {
          const tracked: TrackedItem[] = [];
          for (const item of fetched.items) {
            const facts = item.assignment.facts;
            const previous = known.get(facts.provider_assignment_id) ?? null;
            const linkedTaskId = previous?.taskId && previous.binding && previous.binding !== "separate" ? previous.taskId : null;
            const strongTaskId = stronglyBoundTask(
              { sourceType: "gradescope", url: item.assignment.url, structured: { provider_facts: facts } },
              tasks
                .filter((task) => task.source === "CANVAS" && task.externalToolUrl)
                .map((task) => ({ taskId: task.id, sourceType: "canvas" as const, url: task.htmlUrl, structured: { external_tool_tag_attributes: { url: task.externalToolUrl } } })),
            );
            const decision = decideProviderTask({
              linkedTaskId,
              strongTaskId,
              confirmedTaskId: item.confirmedTaskId,
              confirmedSeparate: item.confirmedSeparate || previous?.binding === "separate",
              courseTaskIds: new Set(tasks.map((task) => task.id)),
              weakCandidates: weakTaskCandidates(
                tasks.map((task) => ({ id: task.id, title: task.title, dueAt: task.dueAt?.toISOString() ?? null })),
                item.assignment.title,
                facts.due_at,
              ),
            });
            let taskId: number | null = null;
            let binding: string | null = null;
            if (decision.kind === "bound") {
              taskId = decision.taskId;
              binding = linkedTaskId === decision.taskId ? (previous?.binding ?? "confirmed") : strongTaskId === decision.taskId ? "strong" : "confirmed";
            } else if (decision.kind === "new") {
              // No task resembles it (or the student said it is separate): it becomes its own task.
              const canvasId = `gradescope:${map.providerCourseId}:${facts.provider_assignment_id}`;
              const data = {
                title: item.assignment.title.slice(0, 500),
                taskType: "assignment",
                dueAt: facts.due_at ? new Date(facts.due_at) : null,
                pointsPossible: facts.max_score,
                htmlUrl: item.assignment.url,
                submissionState: facts.submission_state === "unsubmitted" || facts.submission_state === "unknown" ? null : facts.submission_state,
                score: facts.score,
                removedAt: null,
              };
              const task = await tx.task.upsert({
                where: { courseId_canvasId: { courseId: map.courseId, canvasId } },
                create: { userId, courseId: map.courseId, canvasId, source: "GRADESCOPE", sourceId: source.id, ...data },
                update: data,
              });
              taskId = task.id;
              binding = item.confirmedSeparate || previous?.binding === "separate" ? "separate" : "created";
            } else {
              mappingRequired += 1;
            }
            const data = {
              courseId: map.courseId,
              title: item.assignment.title.slice(0, 500),
              url: item.assignment.url,
              facts: facts as unknown as object,
              taskId,
              binding,
              lastSeenAt: now,
              removedAt: null,
            };
            await tx.providerAssignment.upsert({
              where: {
                sourceId_providerCourseId_providerAssignmentId: {
                  sourceId: source.id,
                  providerCourseId: map.providerCourseId,
                  providerAssignmentId: facts.provider_assignment_id,
                },
              },
              create: { userId, sourceId: source.id, providerCourseId: map.providerCourseId, providerAssignmentId: facts.provider_assignment_id, ...data },
              update: data,
            });
            tracked.push(trackedFacts(source.id, item.assignment.title, item.assignment.url, facts));
          }
          // Empty or partial tables never authorize deletion, so nothing is reported removed.
          return reconcileSourceItems(tx, { userId, courseId: map.courseId, sourceId: source.id, baseline, now }, "ASSIGNMENT", tracked);
        },
        { timeout: 30_000 },
      );
      seen += fetched.items.length;
      if (mappingRequired) errors.push({ resource: `course ${map.courseCode}`, code: "PROVIDER_TASK_MAPPING_REQUIRED", http_status: null });
    }
    await resolveNotice(db, userId, sessionKey(source.id));
  } catch (error) {
    if (error instanceof ProviderError && error.code === "AUTH_REQUIRED") {
      await sessionExpired(db, source);
      return { state: "AUTH_REQUIRED", items_seen: seen, changes, errors: [{ resource: "session", code: "AUTH_REQUIRED", http_status: null }] };
    }
    throw error;
  } finally {
    web.close();
  }
  return { state: "READY", items_seen: seen, changes, errors };
}

/** What Changes compares between syncs: deadlines, submission and score (grade releases count as grades). */
function trackedFacts(sourceId: string, title: string, url: string, facts: ProviderFacts): TrackedItem {
  const content: Content = {
    title: title.slice(0, 500),
    due_at: facts.due_at,
    late_due_at: facts.late_due_at,
    points_possible: facts.max_score,
    score: facts.score,
  };
  return { kind: "ASSIGNMENT", canvasId: `gradescope:${sourceId}:${facts.provider_course_id}:${facts.provider_assignment_id}`, title, htmlUrl: url, content };
}

// ---------------------------------------------------------------------------------------------
// Task mapping and the task card's "Source facts"

type CandidateTask = Pick<Task, "id" | "title" | "dueAt">;

function presentAssignment(row: ProviderAssignment, candidates: CandidateTask[]) {
  const facts = row.facts as unknown as ProviderFacts;
  return {
    id: row.id,
    provider_course_id: row.providerCourseId,
    assignment_id: row.providerAssignmentId,
    title: row.title,
    url: row.url,
    due_at: facts.due_at,
    course_id: row.courseId,
    task_id: row.taskId,
    binding: row.binding,
    confirmed: row.binding === "confirmed" || row.binding === "strong" || row.binding === "separate",
    candidates: candidates.map((task) => ({ id: task.id, title: task.title, due_at: task.dueAt?.toISOString() ?? null })),
  };
}

/** Assignments of a source; `pending` only those waiting for the student to choose a task. */
export async function listAssignments(db: Db, source: SourceConnection, pendingOnly: boolean) {
  const rows = await db.providerAssignment.findMany({
    where: { sourceId: source.id, removedAt: null, ...(pendingOnly ? { binding: null } : {}) },
    orderBy: [{ courseId: "asc" }, { title: "asc" }],
    take: 500,
  });
  const byCourse = new Map<number, CandidateTask[]>();
  const result = [];
  for (const row of rows) {
    if (!byCourse.has(row.courseId)) {
      byCourse.set(row.courseId, await db.task.findMany({
        where: { userId: source.userId, courseId: row.courseId, removedAt: null, source: { in: ["CANVAS", "PERSONAL", "WEBSITE"] } },
        select: { id: true, title: true, dueAt: true },
      }));
    }
    const tasks = byCourse.get(row.courseId) ?? [];
    const facts = row.facts as unknown as ProviderFacts;
    const weak = weakTaskCandidates(tasks.map((task) => ({ ...task, dueAt: task.dueAt?.toISOString() ?? null })), row.title, facts.due_at);
    result.push(presentAssignment(row, tasks.filter((task) => weak.some((candidate) => candidate.id === task.id))));
  }
  return result;
}

/** The student's answer for one assignment: this task, or "separate" (null). */
export async function mapAssignment(db: Db, source: SourceConnection, input: { provider_course_id: string; assignment_id: string; task_id: number | null }) {
  const row = await db.providerAssignment.findUnique({
    where: {
      sourceId_providerCourseId_providerAssignmentId: { sourceId: source.id, providerCourseId: input.provider_course_id, providerAssignmentId: input.assignment_id },
    },
  });
  if (!row) throw new HttpError(404, "PROVIDER_ASSIGNMENT_NOT_FOUND", "That assignment could not be found. Sync the source first.");
  if (input.task_id !== null) {
    const task = await db.task.findFirst({ where: { id: input.task_id, userId: source.userId, courseId: row.courseId, removedAt: null } });
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "That task could not be found in this course.");
    const taken = await db.providerAssignment.findFirst({
      where: { sourceId: source.id, taskId: task.id, id: { not: row.id }, binding: { in: ["confirmed", "strong"] } },
    });
    if (taken) throw new HttpError(409, "PROVIDER_TASK_ALREADY_BOUND", "Another Gradescope assignment is already linked to that task.");
    await db.providerAssignment.update({ where: { id: row.id }, data: { taskId: task.id, binding: "confirmed" } });
  } else {
    await db.providerAssignment.update({ where: { id: row.id }, data: { binding: "separate", taskId: null } });
  }
  return { confirmed: true };
}

/** "Source facts" of a task: Canvas's own fields plus every provider assignment bound to it. */
export async function taskProviderFacts(db: Db, userId: string, taskId: number) {
  const task = await db.task.findFirst({ where: { id: taskId, userId } });
  if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "That task could not be found.");
  const rows = await db.providerAssignment.findMany({ where: { userId, taskId, removedAt: null }, orderBy: { id: "asc" } });
  const facts: ProviderFactRow[] = [];
  if (task.source === "CANVAS") {
    const canvas = providerFact(
      { id: 0, sourceType: "canvas", url: task.htmlUrl, isDeleted: task.removedAt !== null },
      {
        due_at: task.dueAt?.toISOString() ?? null,
        points_possible: task.pointsPossible,
        submission: { workflow_state: task.submissionState, submitted_at: task.submittedAt?.toISOString() ?? null, score: task.score, grade: task.grade, excused: task.excused },
      },
    );
    if (canvas) facts.push(canvas);
  }
  for (const row of rows) {
    const fact = providerFact({ id: row.id, sourceType: "gradescope", url: row.url, isDeleted: false }, { provider_facts: row.facts as unknown as Record<string, unknown> });
    if (fact) facts.push(fact);
  }
  const dues = new Set(
    [task.dueAt?.getTime() ?? null, ...rows.map((row) => (row.facts as unknown as ProviderFacts).due_at)]
      .filter((value) => value !== null)
      .map((value) => Math.round(new Date(value as string | number).getTime() / 60_000)),
  );
  return {
    local_completed: task.completedAt !== null,
    effective_submission_state: terminalState(facts),
    effective_due_at: task.dueAt?.toISOString() ?? null,
    deadlines_differ: dues.size > 1,
    provider_facts: facts,
  };
}
