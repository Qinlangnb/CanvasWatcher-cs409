// What AI Chat can look up. Every tool here only reads, and only the signed-in user's own rows.
// Changes go through ai/writeTools.ts, which only proposes them for the student to confirm.
// Single-item lookups add an `evidence` card ({ title, summary, route }) the chat shows with its answer.
import { DateTime } from "luxon";
import { z } from "zod";
import { availabilityOn, subtract } from "../calendar/capacity.js";
import { blocksText } from "../canvas/richText.js";
import { findSyllabus, type Syllabus } from "../canvas/syllabus.js";
import { keepSyllabus, keptSyllabus } from "../canvas/syllabusStore.js";
import { isWebsiteCourse, withWebsiteSources } from "../sources/website/syllabus.js";
import { occurrencesBetween, planningInputs } from "../calendar/events.js";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { openTaskWhere, presentTask, taskDescription, taskInclude, type TaskWithCourse } from "../routes/present.js";
import { getSettings } from "../routes/settings.js";
import type { Services } from "../services.js";
import { HORIZON_DAYS, OVERDUE_LOOKBACK_DAYS, buildPlan } from "../today/plan.js";
import type { ToolSpec } from "./provider.js";

export interface ToolContext {
  db: Db;
  services: Services;
  userId: string;
  /** Previews have no Canvas token: they get kept copies only. */
  preview: boolean;
  timeZone: string;
  now: Date;
}

/** A card shown under the answer, linking to where the fact came from. */
export interface Evidence {
  title: string;
  summary: string | null;
  /** An app route ("/courses/3") or an API download ("/api/files/7/download"). */
  route: string | null;
}

const SYLLABUS_CHARS = 24_000;
const DESCRIPTION_CHARS = 8_000;
const DAY_MS = 86_400_000;

const id = z.coerce.number().int().positive();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

const taskSearch = z
  .object({
    course_id: id.optional(),
    status: z.enum(["open", "done", "all"]).default("open"),
    due_from: day.optional(),
    due_to: day.optional(),
    query: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(60).default(30),
  })
  .strict();

const schemas = {
  list_courses: z.object({}).strict(),
  get_course: z.object({ course_id: id }).strict(),
  get_course_grades: z.object({ course_id: id }).strict(),
  list_tasks: taskSearch,
  search_tasks: taskSearch,
  get_task: z.object({ task_id: id }).strict(),
  get_course_syllabus: z.object({ course_id: id }).strict(),
  list_calendar_events: z
    .object({ from: day.optional(), to: day.optional(), limit: z.coerce.number().int().min(1).max(200).default(100) })
    .strict(),
  get_calendar_capacity: z.object({ from: day.optional(), days: z.coerce.number().int().min(1).max(14).default(7) }).strict(),
  get_today: z.object({}).strict(),
  list_changes: z.object({ course_id: id.optional(), limit: z.coerce.number().int().min(1).max(30).default(15) }).strict(),
  search_changes: z
    .object({ query: z.string().trim().min(1).max(200), course_id: id.optional(), limit: z.coerce.number().int().min(1).max(30).default(15) })
    .strict(),
  get_change: z.object({ change_id: id }).strict(),
  list_files: z
    .object({ course_id: id.optional(), query: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(60).default(30) })
    .strict(),
  get_file_metadata: z.object({ file_id: id }).strict(),
  get_sync_status: z.object({}).strict(),
};

export type ToolName = keyof typeof schemas;

const courseId = { type: "integer", description: "A course id from list_courses." };
const dayParam = (what: string) => ({ type: "string", description: `${what}, as YYYY-MM-DD in the student's time zone.` });
const noArguments = { type: "object", properties: {}, additionalProperties: false };
const oneId = (name: string, description?: string) => ({
  type: "object",
  properties: { [name]: description ? { type: "integer", description } : { type: "integer" } },
  required: [name],
  additionalProperties: false,
});
const taskSearchParameters = {
  type: "object",
  properties: {
    course_id: courseId,
    status: { type: "string", enum: ["open", "done", "all"], description: "open (default): not handed in yet; done: submitted, graded or checked off; all." },
    due_from: dayParam("Earliest due date"),
    due_to: dayParam("Latest due date"),
    query: { type: "string", description: "Words that must appear in the title." },
    limit: { type: "integer", minimum: 1, maximum: 60 },
  },
  additionalProperties: false,
};

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "list_courses",
    description: "The student's current courses: id, code, name and term. Start here to find a course id.",
    parameters: noArguments,
  },
  {
    name: "get_course",
    description: "One course: code, name, term, whether it is archived, and counts of open tasks, unread changes and files.",
    parameters: oneId("course_id", "A course id from list_courses."),
  },
  {
    name: "get_course_grades",
    description: "Every graded or scored task in a course: score, points possible and letter grade.",
    parameters: oneId("course_id", "A course id from list_courses."),
  },
  {
    name: "list_tasks",
    description:
      "Assignments and the student's own tasks, soonest due first: due date, points, Canvas submission state, score and grade, progress, time used and time left. Open work by default.",
    parameters: taskSearchParameters,
  },
  {
    name: "search_tasks",
    description: "Finds tasks by words in their title; same filters as list_tasks.",
    parameters: taskSearchParameters,
  },
  {
    name: "get_task",
    description: "One task in full, including the assignment description from Canvas and the student's notes.",
    parameters: oneId("task_id"),
  },
  {
    name: "get_course_syllabus",
    description:
      "The course syllabus as text: grading weights, letter-grade cutoffs, late and exam policies. Use it for any question about grading rules or course policies.",
    parameters: oneId("course_id", "A course id from list_courses."),
  },
  {
    name: "list_calendar_events",
    description:
      "Events on the student's calendar (classes, imported calendars, events they added), with ids. Only events with editable true can be changed. Defaults to the next 14 days.",
    parameters: {
      type: "object",
      properties: { from: dayParam("First day"), to: dayParam("Last day"), limit: { type: "integer", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
  },
  {
    name: "get_calendar_capacity",
    description:
      "Free study minutes per day: the student's weekly study availability (or, without it, their study window and daily goal) less busy events, commute around classes and short gaps between classes.",
    parameters: {
      type: "object",
      properties: { from: dayParam("First day (default today)"), days: { type: "integer", minimum: 1, maximum: 14 } },
      additionalProperties: false,
    },
  },
  {
    name: "get_today",
    description: "Today's study plan as the Today page shows it: planned tasks with minutes and reasons, free time, and today's events.",
    parameters: noArguments,
  },
  {
    name: "list_changes",
    description: "Recent changes found in Canvas, newest first: new or edited assignments, moved due dates, new files and announcements.",
    parameters: {
      type: "object",
      properties: { course_id: courseId, limit: { type: "integer", minimum: 1, maximum: 30 } },
      additionalProperties: false,
    },
  },
  {
    name: "search_changes",
    description: "Changes whose summary or item title contains the words, newest first.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, course_id: courseId, limit: { type: "integer", minimum: 1, maximum: 30 } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_change",
    description: "One change in full: which fields changed, with the values before and after.",
    parameters: oneId("change_id"),
  },
  {
    name: "list_files",
    description: "Files shared in the student's courses: name, type, size and when they were updated. File contents are not available.",
    parameters: {
      type: "object",
      properties: { course_id: courseId, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 60 } },
      additionalProperties: false,
    },
  },
  {
    name: "get_file_metadata",
    description: "One course file: name, type, size, update time and its download link. File contents are not available.",
    parameters: oneId("file_id"),
  },
  {
    name: "get_sync_status",
    description: "Whether Canvas is connected, when it was last synced and how the last sync went.",
    parameters: noArguments,
  },
].map((tool) => ({ type: "function" as const, function: tool }));

const clip = (text: string, max: number) => (text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false });

export function localTime(date: Date | null, zone: string): string | null {
  return date ? DateTime.fromJSDate(date, { zone }).toFormat("ccc yyyy-LL-dd HH:mm") : null;
}

function dayStart(value: string, zone: string): Date {
  return DateTime.fromISO(value, { zone }).startOf("day").toJSDate();
}

function dayEnd(value: string, zone: string): Date {
  return DateTime.fromISO(value, { zone }).endOf("day").toJSDate();
}

function taskFacts(task: TaskWithCourse, ctx: ToolContext) {
  const shown = presentTask(task, ctx.now);
  return {
    id: task.id,
    course: { id: task.course.id, code: task.course.courseCode },
    title: task.title,
    type: task.taskType,
    source: shown.source,
    due: localTime(task.dueAt, ctx.timeZone),
    state: shown.state,
    points_possible: task.pointsPossible,
    submission_state: task.submissionState,
    submitted: localTime(task.submittedAt, ctx.timeZone),
    score: task.score,
    grade: task.grade,
    excused: task.excused,
    progress_percent: task.progress,
    minutes_used: shown.spent_minutes,
    minutes_left: shown.remaining_minutes,
  };
}

async function readSyllabus(ctx: ToolContext, course: { id: number; canvasId: string; htmlUrl: string }): Promise<{ syllabus: Syllabus; fetchedAt: Date } | null> {
  const kept = await keptSyllabus(ctx.db, ctx.userId, course.id);
  if (ctx.preview) return kept;
  if (isWebsiteCourse(course)) {
    const syllabus = await withWebsiteSources(ctx.db, ctx.userId, course.id, { found: false, sources: [] });
    return { syllabus, fetchedAt: ctx.now };
  }
  if (kept && ctx.now.getTime() - kept.fetchedAt.getTime() < 6 * 60 * 60_000) return kept;
  const connection = await ctx.db.canvasConnection.findUnique({ where: { userId: ctx.userId } });
  if (!connection || connection.status !== "OK") return kept;
  const client = await ctx.services.credentials.routed(ctx.userId);
  if (!client) return kept;
  try {
    const files = await ctx.db.courseFile.findMany({
      where: { userId: ctx.userId, courseId: course.id, removedAt: null },
      select: { id: true, canvasId: true, displayName: true },
    });
    const syllabus = await withWebsiteSources(ctx.db, ctx.userId, course.id, await findSyllabus(client, course.canvasId, course.htmlUrl, files));
    await keepSyllabus(ctx.db, ctx.userId, course.id, syllabus, ctx.now);
    return { syllabus, fetchedAt: ctx.now };
  } catch {
    return kept;
  } finally {
    await client.flush();
  }
}

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

type Handler = (args: never, ctx: ToolContext) => Promise<unknown>;

async function listTasks(args: z.infer<typeof taskSearch>, ctx: ToolContext) {
  const due: Prisma.DateTimeNullableFilter = {
    ...(args.due_from ? { gte: dayStart(args.due_from, ctx.timeZone) } : {}),
    ...(args.due_to ? { lte: dayEnd(args.due_to, ctx.timeZone) } : {}),
  };
  const done: Prisma.TaskWhereInput = {
    OR: [{ completedAt: { not: null } }, { submissionState: { in: ["submitted", "graded", "pending_review"] } }],
  };
  const where: Prisma.TaskWhereInput = {
    userId: ctx.userId,
    removedAt: null,
    course: { archivedAt: null },
    ...(args.course_id ? { courseId: args.course_id } : {}),
    ...(args.status === "open" ? openTaskWhere : args.status === "done" ? done : {}),
    ...(args.due_from || args.due_to ? { dueAt: due } : {}),
    ...(args.query ? { title: { contains: args.query, mode: "insensitive" as const } } : {}),
  };
  const tasks = await ctx.db.task.findMany({
    where,
    include: taskInclude,
    orderBy: args.status === "done" ? [{ dueAt: "desc" }, { id: "desc" }] : [{ dueAt: { sort: "asc", nulls: "last" } }, { id: "asc" }],
    take: args.limit,
  });
  return { count: tasks.length, tasks: tasks.map((task) => taskFacts(task, ctx)) };
}

const changeInclude = { course: { select: { courseCode: true } }, sourceItem: { select: { kind: true, title: true } } } as const;

function changeRows(changes: Prisma.ChangeEventGetPayload<{ include: typeof changeInclude }>[], ctx: ToolContext) {
  return changes.map((change) => ({
    id: change.id,
    when: localTime(change.detectedAt, ctx.timeZone),
    course: change.course.courseCode,
    item: `${change.sourceItem.kind.toLowerCase()}: ${change.sourceItem.title}`,
    summary: change.summary,
  }));
}

const handlers: Record<ToolName, Handler> = {
  async list_courses(_args: z.infer<typeof schemas.list_courses>, ctx) {
    const courses = await ctx.db.course.findMany({
      where: { userId: ctx.userId, archivedAt: null },
      orderBy: { courseCode: "asc" },
      select: { id: true, courseCode: true, name: true, termName: true },
    });
    return { courses: courses.map((course) => ({ id: course.id, code: course.courseCode, name: course.name, term: course.termName })) };
  },

  async get_course(args: z.infer<typeof schemas.get_course>, ctx) {
    const course = await ctx.db.course.findFirst({ where: { id: args.course_id, userId: ctx.userId } });
    if (!course) return { error: "No course with that id." };
    const where = { userId: ctx.userId, courseId: course.id };
    const [openTasks, unreadChanges, files] = await Promise.all([
      ctx.db.task.count({ where: { ...where, ...openTaskWhere } }),
      ctx.db.changeEvent.count({ where: { ...where, readAt: null } }),
      ctx.db.courseFile.count({ where: { ...where, removedAt: null } }),
    ]);
    return {
      id: course.id,
      code: course.courseCode,
      name: course.name,
      term: course.termName,
      archived: course.archivedAt !== null,
      open_tasks: openTasks,
      unread_changes: unreadChanges,
      files,
      canvas_url: course.htmlUrl,
      evidence: { title: course.courseCode, summary: course.name, route: `/courses/${course.id}` },
    };
  },

  async get_course_grades(args: z.infer<typeof schemas.get_course_grades>, ctx) {
    const course = await ctx.db.course.findFirst({ where: { id: args.course_id, userId: ctx.userId }, select: { id: true, courseCode: true } });
    if (!course) return { error: "No course with that id." };
    const tasks = await ctx.db.task.findMany({
      where: { userId: ctx.userId, courseId: course.id, removedAt: null, OR: [{ score: { not: null } }, { excused: true }, { submissionState: "graded" }] },
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { id: "asc" }],
      take: 200,
    });
    return {
      course: course.courseCode,
      note: "A null score means not graded yet or not released, never zero.",
      grades: tasks.map((task) => ({
        task_id: task.id,
        title: task.title,
        due: localTime(task.dueAt, ctx.timeZone),
        score: task.score,
        points_possible: task.pointsPossible,
        grade: task.grade,
        excused: task.excused,
      })),
      evidence: { title: `${course.courseCode} grades`, summary: `${tasks.length} graded tasks`, route: `/courses/${course.id}` },
    };
  },

  async list_tasks(args: z.infer<typeof schemas.list_tasks>, ctx) {
    return listTasks(args, ctx);
  },

  async search_tasks(args: z.infer<typeof schemas.search_tasks>, ctx) {
    return listTasks(args, ctx);
  },

  async get_task(args: z.infer<typeof schemas.get_task>, ctx) {
    const task = await ctx.db.task.findFirst({ where: { id: args.task_id, userId: ctx.userId }, include: taskInclude });
    if (!task) return { error: "No task with that id." };
    const description = await taskDescription(ctx.db, task);
    return {
      ...taskFacts(task, ctx),
      estimated_total_minutes: task.estimatedMinutes,
      notes: task.notes,
      description: description ? clip(description, DESCRIPTION_CHARS) : null,
      canvas_url: task.htmlUrl,
      evidence: {
        title: task.title,
        summary: `${task.course.courseCode} · due ${localTime(task.dueAt, ctx.timeZone) ?? "without a date"}`,
        route: `/courses/${task.course.id}`,
      },
    };
  },

  async get_course_syllabus(args: z.infer<typeof schemas.get_course_syllabus>, ctx) {
    const course = await ctx.db.course.findFirst({
      where: { id: args.course_id, userId: ctx.userId },
      select: { id: true, courseCode: true, canvasId: true, htmlUrl: true },
    });
    if (!course) return { error: "No course with that id." };
    const found = await readSyllabus(ctx, course);
    if (!found) return { course: course.courseCode, found: false, note: "No syllabus has been read for this course yet." };
    let budget = SYLLABUS_CHARS;
    const sources = found.syllabus.sources.map((source) => {
      const text = clip(blocksText(source.blocks), Math.max(0, budget));
      budget -= text.text.length;
      return { kind: source.kind, title: source.title, url: source.html_url, ...text };
    });
    return {
      course: course.courseCode,
      found: found.syllabus.found,
      read_at: localTime(found.fetchedAt, ctx.timeZone),
      sources,
      evidence: { title: `${course.courseCode} syllabus`, summary: sources[0]?.title ?? null, route: `/courses/${course.id}` },
    };
  },

  async list_calendar_events(args: z.infer<typeof schemas.list_calendar_events>, ctx) {
    const today = DateTime.fromJSDate(ctx.now, { zone: ctx.timeZone }).toISODate() as string;
    const from = dayStart(args.from ?? today, ctx.timeZone);
    const to = args.to ? dayEnd(args.to, ctx.timeZone) : DateTime.fromJSDate(from).plus({ days: 14 }).toJSDate();
    // Recurring events added by hand are stored once; occurrencesBetween expands them.
    const span = Math.min(to.getTime(), from.getTime() + 62 * 86_400_000);
    const { occurrences } = await occurrencesBetween(ctx.db, ctx.userId, from, new Date(Math.max(span, from.getTime() + 1)), ctx.timeZone);
    const events = occurrences.slice(0, args.limit);
    return {
      count: events.length,
      events: events.map(({ event, start, end }) => ({
        id: event.id,
        // Imported events belong to their calendar file; only events added by hand can be changed.
        editable: event.sourceId === null,
        title: event.title,
        location: event.location,
        start: event.allDay ? start.toISOString().slice(0, 10) : localTime(start, ctx.timeZone),
        end: event.allDay ? end.toISOString().slice(0, 10) : localTime(end, ctx.timeZone),
        // A recurring event's occurrences share one id; changing it changes the whole series.
        repeats: event.recurrenceRule,
        all_day: event.allDay,
        busy: event.busy,
        type: event.eventType,
        course: event.course?.courseCode ?? null,
      })),
    };
  },

  async get_calendar_capacity(args: z.infer<typeof schemas.get_calendar_capacity>, ctx) {
    const settings = await getSettings(ctx.db, ctx.userId);
    const zone = settings.timeZone;
    const first = args.from ? DateTime.fromISO(args.from, { zone }).startOf("day") : DateTime.fromJSDate(ctx.now, { zone }).startOf("day");
    const inputs = await planningInputs(ctx.db, ctx.userId, first.toJSDate(), first.plus({ days: args.days }).toJSDate(), zone);
    const busy = inputs.busy.map((span) => ({ start: span.start.getTime(), end: span.end.getTime() }));
    return {
      study_window: `${hhmm(settings.studyStartMinute)}-${hhmm(settings.studyEndMinute)}`,
      daily_goal_minutes: settings.dailyStudyMinutes,
      days: Array.from({ length: args.days }, (_, index) => {
        const date = first.plus({ days: index });
        // A day with weekly availability or an override uses it, uncapped; otherwise the study window.
        const available = availabilityOn(inputs.availability, date);
        const windows = available ?? [
          { start: date.plus({ minutes: settings.studyStartMinute }).toMillis(), end: date.plus({ minutes: settings.studyEndMinute }).toMillis() },
        ];
        const total = windows.reduce((sum, span) => sum + (span.end - span.start), 0);
        const free = subtract(windows, busy).reduce((sum, span) => sum + (span.end - span.start), 0);
        return {
          date: date.toISODate(),
          source: available ? "availability" : "study_window",
          busy_minutes: Math.round((total - free) / 60_000),
          free_minutes: Math.round(free / 60_000),
        };
      }),
    };
  },

  async get_today(_args: z.infer<typeof schemas.get_today>, ctx) {
    const settings = await getSettings(ctx.db, ctx.userId);
    const today = DateTime.fromJSDate(ctx.now, { zone: settings.timeZone }).startOf("day");
    // The same inputs as GET /api/today, so the answer matches the page.
    const [tasks, events] = await Promise.all([
      ctx.db.task.findMany({
        where: {
          userId: ctx.userId,
          course: { archivedAt: null },
          ...openTaskWhere,
          AND: [{ OR: [{ dueAt: null }, { dueAt: { gte: new Date(ctx.now.getTime() - OVERDUE_LOOKBACK_DAYS * DAY_MS) } }] }],
        },
        include: taskInclude,
        take: 1000,
      }),
      planningInputs(
        ctx.db,
        ctx.userId,
        today.toJSDate(),
        today.plus({ days: HORIZON_DAYS + 1 }).toJSDate(),
        settings.timeZone,
        today.plus({ days: 366 }).toISODate() as string,
      ),
    ]);
    const plan = buildPlan({ now: ctx.now, settings, tasks, busy: events.busy, availability: events.availability });
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const tomorrow = today.plus({ days: 1 }).toJSDate();
    return {
      date: plan.date,
      goal_minutes: plan.goalMinutes,
      free_minutes: plan.freeMinutes,
      capacity_minutes: plan.capacityMinutes,
      capacity_source: plan.capacitySource,
      planned_minutes: plan.plannedMinutes,
      items: plan.items.map((item) => {
        const task = byId.get(item.taskId) as TaskWithCourse;
        return {
          task_id: item.taskId,
          title: task.title,
          course: task.course.courseCode,
          due: localTime(task.dueAt, ctx.timeZone),
          remaining_minutes: item.remainingMinutes,
          planned_minutes: item.plannedMinutes,
          reasons: item.reasons,
        };
      }),
      events_today: events.occurrences
        .filter((occurrence) => occurrence.start < tomorrow)
        .map(({ event, start, end }) => ({ title: event.title, start: localTime(start, ctx.timeZone), end: localTime(end, ctx.timeZone), busy: event.busy })),
      evidence: { title: "Today's plan", summary: `${plan.items.filter((item) => item.plannedMinutes > 0).length} tasks planned`, route: "/" },
    };
  },

  async list_changes(args: z.infer<typeof schemas.list_changes>, ctx) {
    const changes = await ctx.db.changeEvent.findMany({
      where: { userId: ctx.userId, ...(args.course_id ? { courseId: args.course_id } : {}) },
      orderBy: { id: "desc" },
      take: args.limit,
      include: changeInclude,
    });
    return { changes: changeRows(changes, ctx) };
  },

  async search_changes(args: z.infer<typeof schemas.search_changes>, ctx) {
    const changes = await ctx.db.changeEvent.findMany({
      where: {
        userId: ctx.userId,
        ...(args.course_id ? { courseId: args.course_id } : {}),
        OR: [
          { summary: { contains: args.query, mode: "insensitive" } },
          { sourceItem: { title: { contains: args.query, mode: "insensitive" } } },
        ],
      },
      orderBy: { id: "desc" },
      take: args.limit,
      include: changeInclude,
    });
    return { changes: changeRows(changes, ctx) };
  },

  async get_change(args: z.infer<typeof schemas.get_change>, ctx) {
    const change = await ctx.db.changeEvent.findFirst({
      where: { id: args.change_id, userId: ctx.userId },
      include: { course: { select: { courseCode: true } }, sourceItem: { select: { kind: true, title: true, htmlUrl: true } } },
    });
    if (!change) return { error: "No change with that id." };
    const values = (value: unknown) => clip(JSON.stringify(value ?? null), 4000).text;
    return {
      id: change.id,
      when: localTime(change.detectedAt, ctx.timeZone),
      course: change.course.courseCode,
      kind: change.sourceItem.kind.toLowerCase(),
      change_type: change.changeType.toLowerCase(),
      title: change.sourceItem.title,
      summary: change.summary,
      fields: change.fields,
      before: values(change.before),
      after: values(change.after),
      read: change.readAt !== null,
      canvas_url: change.sourceItem.htmlUrl,
      evidence: { title: change.sourceItem.title, summary: change.summary, route: "/changes" },
    };
  },

  async list_files(args: z.infer<typeof schemas.list_files>, ctx) {
    const files = await ctx.db.courseFile.findMany({
      where: {
        userId: ctx.userId,
        removedAt: null,
        course: { archivedAt: null },
        ...(args.course_id ? { courseId: args.course_id } : {}),
        ...(args.query ? { displayName: { contains: args.query, mode: "insensitive" as const } } : {}),
      },
      orderBy: [{ canvasUpdatedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
      take: args.limit,
      include: { course: { select: { courseCode: true } } },
    });
    return {
      files: files.map((file) => ({
        id: file.id,
        name: file.displayName,
        course: file.course.courseCode,
        type: file.contentType,
        size_bytes: file.sizeBytes,
        updated: localTime(file.canvasUpdatedAt, ctx.timeZone),
      })),
    };
  },

  async get_file_metadata(args: z.infer<typeof schemas.get_file_metadata>, ctx) {
    const file = await ctx.db.courseFile.findFirst({
      where: { id: args.file_id, userId: ctx.userId },
      include: { course: { select: { courseCode: true } } },
    });
    if (!file) return { error: "No file with that id." };
    const route = `/api/files/${file.id}/download`;
    return {
      id: file.id,
      name: file.displayName,
      course: file.course.courseCode,
      type: file.contentType,
      size_bytes: file.sizeBytes,
      updated: localTime(file.canvasUpdatedAt, ctx.timeZone),
      removed_from_canvas: file.removedAt !== null,
      download_route: route,
      evidence: { title: file.displayName, summary: file.course.courseCode, route },
    };
  },

  async get_sync_status(_args: z.infer<typeof schemas.get_sync_status>, ctx) {
    const [connection, run] = await Promise.all([
      ctx.db.canvasConnection.findUnique({ where: { userId: ctx.userId } }),
      ctx.db.syncRun.findFirst({ where: { userId: ctx.userId }, orderBy: { startedAt: "desc" } }),
    ]);
    if (!connection) return { connected: false };
    return {
      connected: true,
      canvas_host: new URL(connection.baseUrl).host,
      token_accepted: connection.status === "OK",
      last_synced: localTime(connection.lastSyncedAt, ctx.timeZone),
      last_run: run ? { status: run.status.toLowerCase(), started: localTime(run.startedAt, ctx.timeZone), error: run.error } : null,
    };
  },
};

/** JSON arguments of a tool call; undefined when they don't parse. */
export function parseArguments(rawArguments: string): unknown {
  try {
    return rawArguments.trim() ? JSON.parse(rawArguments) : {};
  } catch {
    return undefined;
  }
}

export const issuesText = (error: z.ZodError) =>
  error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ");

/** Runs one tool call. Bad arguments and unknown tools come back as data the model can correct. */
export async function runTool(name: string, rawArguments: string, ctx: ToolContext): Promise<unknown> {
  if (!(name in schemas)) return { error: `There is no tool named ${name}.` };
  const parsed = parseArguments(rawArguments);
  if (parsed === undefined) return { error: "The arguments were not valid JSON." };
  const result = schemas[name as ToolName].safeParse(parsed ?? {});
  if (!result.success) return { error: issuesText(result.error) };
  return handlers[name as ToolName](result.data as never, ctx);
}

/** The evidence card a lookup's result carries, if any. */
export function evidenceOf(result: unknown): Evidence | null {
  const evidence = (result as { evidence?: Evidence } | null)?.evidence;
  return evidence && typeof evidence.title === "string" ? evidence : null;
}
