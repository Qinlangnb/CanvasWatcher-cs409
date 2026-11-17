// What AI Chat can look up. Every tool only reads, and only the signed-in user's own rows.
import { DateTime } from "luxon";
import { z } from "zod";
import { openToken } from "../canvas/client.js";
import { blocksText } from "../canvas/richText.js";
import { findSyllabus, type Syllabus } from "../canvas/syllabus.js";
import { keepSyllabus, keptSyllabus } from "../canvas/syllabusStore.js";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { openTaskWhere, presentTask, taskDescription, taskInclude, type TaskWithCourse } from "../routes/present.js";
import type { Services } from "../services.js";
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

const SYLLABUS_CHARS = 24_000;
const DESCRIPTION_CHARS = 8_000;

const id = z.coerce.number().int().positive();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

const schemas = {
  list_courses: z.object({}).strict(),
  list_tasks: z
    .object({
      course_id: id.optional(),
      status: z.enum(["open", "done", "all"]).default("open"),
      due_from: day.optional(),
      due_to: day.optional(),
      query: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(60).default(30),
    })
    .strict(),
  get_task: z.object({ task_id: id }).strict(),
  get_course_syllabus: z.object({ course_id: id }).strict(),
  list_calendar_events: z
    .object({ from: day.optional(), to: day.optional(), limit: z.coerce.number().int().min(1).max(200).default(100) })
    .strict(),
  list_changes: z.object({ course_id: id.optional(), limit: z.coerce.number().int().min(1).max(30).default(15) }).strict(),
  list_files: z
    .object({ course_id: id.optional(), query: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(60).default(30) })
    .strict(),
};

export type ToolName = keyof typeof schemas;

const courseId = { type: "integer", description: "A course id from list_courses." };
const dayParam = (what: string) => ({ type: "string", description: `${what}, as YYYY-MM-DD in the student's time zone.` });

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "list_courses",
    description: "The student's current courses: id, code, name and term. Start here to find a course id.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_tasks",
    description:
      "Assignments and the student's own tasks, soonest due first: due date, points, Canvas submission state, score and grade, progress, time used and time left. Open work by default.",
    parameters: {
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
    },
  },
  {
    name: "get_task",
    description: "One task in full, including the assignment description from Canvas and the student's notes.",
    parameters: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"], additionalProperties: false },
  },
  {
    name: "get_course_syllabus",
    description:
      "The course syllabus as text: grading weights, letter-grade cutoffs, late and exam policies. Use it for any question about grading rules or course policies.",
    parameters: { type: "object", properties: { course_id: courseId }, required: ["course_id"], additionalProperties: false },
  },
  {
    name: "list_calendar_events",
    description: "Events on the student's calendar (classes, imported calendars, events they added). Defaults to the next 14 days.",
    parameters: {
      type: "object",
      properties: { from: dayParam("First day"), to: dayParam("Last day"), limit: { type: "integer", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
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
    name: "list_files",
    description: "Files shared in the student's courses: name, type, size and when they were updated. File contents are not available.",
    parameters: {
      type: "object",
      properties: { course_id: courseId, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 60 } },
      additionalProperties: false,
    },
  },
].map((tool) => ({ type: "function" as const, function: tool }));

const clip = (text: string, max: number) => (text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false });

function localTime(date: Date | null, zone: string): string | null {
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
    minutes_used: task.spentMinutes,
    minutes_left: shown.remaining_minutes,
  };
}

async function readSyllabus(ctx: ToolContext, course: { id: number; canvasId: string; htmlUrl: string }): Promise<{ syllabus: Syllabus; fetchedAt: Date } | null> {
  const kept = await keptSyllabus(ctx.db, ctx.userId, course.id);
  if (ctx.preview) return kept;
  if (kept && ctx.now.getTime() - kept.fetchedAt.getTime() < 6 * 60 * 60_000) return kept;
  const connection = await ctx.db.canvasConnection.findUnique({ where: { userId: ctx.userId } });
  if (!connection || connection.status !== "OK") return kept;
  try {
    const files = await ctx.db.courseFile.findMany({
      where: { userId: ctx.userId, courseId: course.id, removedAt: null },
      select: { id: true, canvasId: true, displayName: true },
    });
    const client = ctx.services.canvas(connection.baseUrl, openToken(ctx.services.secrets, connection.tokenCiphertext, ctx.userId));
    const syllabus = await findSyllabus(client, course.canvasId, course.htmlUrl, files);
    await keepSyllabus(ctx.db, ctx.userId, course.id, syllabus, ctx.now);
    return { syllabus, fetchedAt: ctx.now };
  } catch {
    return kept;
  }
}

type Handler = (args: never, ctx: ToolContext) => Promise<unknown>;

const handlers: Record<ToolName, Handler> = {
  async list_courses(_args: z.infer<typeof schemas.list_courses>, ctx) {
    const courses = await ctx.db.course.findMany({
      where: { userId: ctx.userId, archivedAt: null },
      orderBy: { courseCode: "asc" },
      select: { id: true, courseCode: true, name: true, termName: true },
    });
    return { courses: courses.map((course) => ({ id: course.id, code: course.courseCode, name: course.name, term: course.termName })) };
  },

  async list_tasks(args: z.infer<typeof schemas.list_tasks>, ctx) {
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
    return { course: course.courseCode, found: found.syllabus.found, read_at: localTime(found.fetchedAt, ctx.timeZone), sources };
  },

  async list_calendar_events(args: z.infer<typeof schemas.list_calendar_events>, ctx) {
    const today = DateTime.fromJSDate(ctx.now, { zone: ctx.timeZone }).toISODate() as string;
    const from = dayStart(args.from ?? today, ctx.timeZone);
    const to = args.to ? dayEnd(args.to, ctx.timeZone) : DateTime.fromJSDate(from).plus({ days: 14 }).toJSDate();
    const events = await ctx.db.calendarEvent.findMany({
      where: { userId: ctx.userId, startAt: { lte: to }, endAt: { gte: from } },
      orderBy: [{ startAt: "asc" }, { id: "asc" }],
      take: args.limit,
      select: { title: true, location: true, startAt: true, endAt: true, allDay: true, busy: true },
    });
    return {
      count: events.length,
      events: events.map((event) => ({
        title: event.title,
        location: event.location,
        start: localTime(event.startAt, ctx.timeZone),
        end: localTime(event.endAt, ctx.timeZone),
        all_day: event.allDay,
        busy: event.busy,
      })),
    };
  },

  async list_changes(args: z.infer<typeof schemas.list_changes>, ctx) {
    const changes = await ctx.db.changeEvent.findMany({
      where: { userId: ctx.userId, ...(args.course_id ? { courseId: args.course_id } : {}) },
      orderBy: { id: "desc" },
      take: args.limit,
      include: { course: { select: { courseCode: true } }, sourceItem: { select: { kind: true, title: true } } },
    });
    return {
      changes: changes.map((change) => ({
        when: localTime(change.detectedAt, ctx.timeZone),
        course: change.course.courseCode,
        item: `${change.sourceItem.kind.toLowerCase()}: ${change.sourceItem.title}`,
        summary: change.summary,
      })),
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
        name: file.displayName,
        course: file.course.courseCode,
        type: file.contentType,
        size_bytes: file.sizeBytes,
        updated: localTime(file.canvasUpdatedAt, ctx.timeZone),
      })),
    };
  },
};

/** Runs one tool call. Bad arguments and unknown tools come back as data the model can correct. */
export async function runTool(name: string, rawArguments: string, ctx: ToolContext): Promise<unknown> {
  if (!(name in schemas)) return { error: `There is no tool named ${name}.` };
  let parsed: unknown;
  try {
    parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  } catch {
    return { error: "The arguments were not valid JSON." };
  }
  const result = schemas[name as ToolName].safeParse(parsed ?? {});
  if (!result.success) return { error: result.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ") };
  return handlers[name as ToolName](result.data as never, ctx);
}

