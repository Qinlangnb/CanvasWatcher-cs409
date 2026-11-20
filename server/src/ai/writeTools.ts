// Changes AI Chat can propose. A call never changes anything by itself: it is checked like the REST
// route would check it, then stored as a pending confirmation that only its owner can confirm, within
// CONFIRMATION_TTL_MS, through POST /api/ai/chat/confirm. Only then does `applyWrite` run.
import { z } from "zod";
import { eventInclude, presentEvent } from "../calendar/events.js";
import type { Db } from "../db.js";
import { FieldError, HttpError } from "../http/errors.js";
import { eventChangeData, eventChanges, eventCreation, newEventData } from "../routes/calendar.js";
import { taskChangeSchema } from "../routes/tasks.js";
import { applyTaskChange } from "../tasks/state.js";
import type { ToolSpec } from "./provider.js";
import { issuesText, localTime, parseArguments } from "./tools.js";

export const CONFIRMATION_TTL_MS = 30 * 60_000;

export interface WriteContext {
  db: Db;
  userId: string;
  timeZone: string;
  now: Date;
}

export interface Detail {
  label: string;
  value: string;
}

export interface Proposal {
  toolName: WriteToolName;
  arguments: Record<string, unknown>;
  summary: string;
  details: Detail[];
}

const id = z.coerce.number().int().positive();
const taskArgs = z.object({ task_id: id }).strict();
const courseArgs = z.object({ course_id: id }).strict();
const eventFields = {
  title: z.string(),
  start: z.string(),
  end: z.string(),
  all_day: z.boolean().optional(),
  location: z.string().nullable().optional(),
  busy: z.boolean().optional(),
  description: z.string().nullable().optional(),
  time_zone: z.string().nullable().optional(),
  event_type: z.string().optional(),
  course_id: z.coerce.number().int().positive().nullable().optional(),
  recurrence_rule: z.string().nullable().optional(),
};

const schemas = {
  set_task_progress: z.object({ task_id: id, progress_percent: z.number().int().min(0).max(100) }).strict(),
  mark_task_completed: taskArgs,
  ignore_task: taskArgs,
  undo_ignore_task: taskArgs,
  archive_course: courseArgs,
  restore_course: courseArgs,
  create_manual_event: z.object(eventFields).strict(),
  update_manual_event: z
    .object({ event_id: id, ...Object.fromEntries(Object.entries(eventFields).map(([key, value]) => [key, value.optional()])) })
    .strict(),
  delete_manual_event: z.object({ event_id: id }).strict(),
};

export type WriteToolName = keyof typeof schemas;

export const isWriteTool = (name: string): name is WriteToolName => name in schemas;

const taskParam = { task_id: { type: "integer", description: "A task id from list_tasks." } };
const courseParam = { course_id: { type: "integer", description: "A course id from list_courses." } };
const eventProperties = {
  title: { type: "string" },
  start: {
    type: "string",
    description: "All-day: YYYY-MM-DD. Otherwise an ISO date-time with offset (2026-11-20T14:00:00-06:00) or a wall-clock time (2026-11-20T14:00) in time_zone.",
  },
  end: { type: "string", description: "Exclusive. All-day: the day after the last day. Otherwise an ISO date-time with offset." },
  all_day: { type: "boolean" },
  location: { type: "string" },
  busy: { type: "boolean", description: "Busy time is kept free of study in the Today plan. Defaults to true for timed events." },
  description: { type: "string" },
  time_zone: { type: "string", description: "IANA zone of the times, e.g. America/Chicago. Omit to use the student's zone." },
  event_type: { type: "string", enum: ["class", "busy", "personal", "study", "other"], description: "Class events linked to a course get its commute." },
  course_id: { type: "integer", description: "A course id from list_courses." },
  recurrence_rule: {
    type: "string",
    description: "Optional RRULE, e.g. FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261211. Allowed: FREQ, INTERVAL, COUNT or UNTIL, BYDAY, BYMONTHDAY, BYMONTH, BYSETPOS, WKST.",
  },
};
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const NOTE = " Proposes the change; the student must confirm it in the app before anything happens.";

export const WRITE_TOOL_SPECS: ToolSpec[] = [
  {
    name: "set_task_progress",
    description: "Set how far along the student is on a task, 0-100%." + NOTE,
    parameters: object({ ...taskParam, progress_percent: { type: "integer", minimum: 0, maximum: 100 } }, ["task_id", "progress_percent"]),
  },
  { name: "mark_task_completed", description: "Check a task off as done (this does not submit anything to Canvas)." + NOTE, parameters: object(taskParam, ["task_id"]) },
  { name: "ignore_task", description: "Hide a task from plans and lists." + NOTE, parameters: object(taskParam, ["task_id"]) },
  { name: "undo_ignore_task", description: "Bring an ignored task back." + NOTE, parameters: object(taskParam, ["task_id"]) },
  { name: "archive_course", description: "Archive a finished course so it leaves lists and plans." + NOTE, parameters: object(courseParam, ["course_id"]) },
  { name: "restore_course", description: "Restore an archived course." + NOTE, parameters: object(courseParam, ["course_id"]) },
  { name: "create_manual_event", description: "Add an event to the student's calendar." + NOTE, parameters: object(eventProperties, ["title", "start", "end"]) },
  {
    name: "update_manual_event",
    description:
      "Change an event the student added by hand (editable true in list_calendar_events). For a repeating event this changes the whole series. Send only the fields to change." +
      NOTE,
    parameters: object({ event_id: { type: "integer" }, ...eventProperties }, ["event_id"]),
  },
  {
    name: "delete_manual_event",
    description: "Delete an event the student added by hand (editable true in list_calendar_events); a repeating event goes with its whole series." + NOTE,
    parameters: object({ event_id: { type: "integer" } }, ["event_id"]),
  },
].map((tool) => ({ type: "function" as const, function: tool }));

const taskNotFound = () => new HttpError(404, "TASK_NOT_FOUND", "That task could not be found.");
const courseNotFound = () => new HttpError(404, "COURSE_NOT_FOUND", "That course could not be found.");
const eventNotFound = () => new HttpError(404, "EVENT_NOT_FOUND", "That event could not be found.");

async function findTask(ctx: WriteContext, taskId: number) {
  const task = await ctx.db.task.findFirst({ where: { id: taskId, userId: ctx.userId }, include: { course: { select: { courseCode: true } } } });
  if (!task) throw taskNotFound();
  return task;
}

async function findCourse(ctx: WriteContext, courseId: number) {
  const course = await ctx.db.course.findFirst({ where: { id: courseId, userId: ctx.userId } });
  if (!course) throw courseNotFound();
  return course;
}

/** Same rule as the calendar routes: imported events change only through their calendar file. */
async function findManualEvent(ctx: WriteContext, eventId: number) {
  const event = await ctx.db.calendarEvent.findFirst({ where: { id: eventId, userId: ctx.userId }, include: eventInclude });
  if (!event) throw eventNotFound();
  if (event.sourceId !== null) {
    throw new HttpError(409, "EVENT_IMPORTED", `This event comes from "${event.source?.name ?? "an imported calendar"}". Change it in that calendar and import it again.`);
  }
  return event;
}

const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

/** A new event's stored fields, checked by the calendar route's own schema and rules (zone, RRULE, course, DST). */
async function newEventBody(args: z.infer<typeof schemas.create_manual_event>, ctx: WriteContext) {
  const body = eventCreation.parse(defined({ ...args, location: args.location ?? undefined }));
  const data = await newEventData(ctx.db, ctx.userId, body, ctx.timeZone);
  return { body, data, allDay: data.allDay, times: { startAt: data.startAt, endAt: data.endAt } };
}

async function eventPatch(args: z.infer<typeof schemas.update_manual_event>, event: Awaited<ReturnType<typeof findManualEvent>>, ctx: WriteContext) {
  const { event_id: _id, ...fields } = args;
  const body = eventChanges.parse(defined(fields));
  const data = await eventChangeData(ctx.db, ctx.userId, event, body, ctx.timeZone);
  return { body, data, allDay: data.allDay, times: { startAt: data.startAt, endAt: data.endAt } };
}

function when(allDay: boolean, start: Date, end: Date, zone: string): string {
  if (allDay) {
    const last = new Date(end.getTime() - 86_400_000).toISOString().slice(0, 10);
    const first = start.toISOString().slice(0, 10);
    return first === last ? `${first} (all day)` : `${first} to ${last} (all day)`;
  }
  return `${localTime(start, zone)} to ${localTime(end, zone)}`;
}

/** Plain-language message of a validation problem, for the model or the confirmation card. */
export function problemText(error: unknown): string | null {
  if (error instanceof HttpError) return error.message;
  if (error instanceof FieldError) return `${error.field}: ${error.message}`;
  if (error instanceof z.ZodError) return issuesText(error);
  return null;
}

/**
 * Checks a write call and describes it for the confirmation card. Returns `{ error }` for the model
 * to correct, or the proposal to store. Nothing is changed here.
 */
export async function proposeWrite(name: WriteToolName, rawArguments: string, ctx: WriteContext): Promise<{ error: string } | { proposal: Proposal }> {
  const parsed = parseArguments(rawArguments);
  if (parsed === undefined) return { error: "The arguments were not valid JSON." };
  const checked = schemas[name].safeParse(parsed ?? {});
  if (!checked.success) return { error: issuesText(checked.error) };
  const args = checked.data as Record<string, unknown>;
  try {
    const described = await describe(name, args as never, ctx);
    return { proposal: { toolName: name, arguments: args, ...described } };
  } catch (error) {
    const text = problemText(error);
    if (text === null) throw error;
    return { error: text };
  }
}

async function describe(name: WriteToolName, args: never, ctx: WriteContext): Promise<{ summary: string; details: Detail[] }> {
  switch (name) {
    case "set_task_progress": {
      const { task_id, progress_percent } = args as z.infer<typeof schemas.set_task_progress>;
      taskChangeSchema.parse({ progress: progress_percent });
      const task = await findTask(ctx, task_id);
      return {
        summary: `Set progress on "${task.title}" to ${progress_percent}%`,
        details: [
          { label: "Task", value: task.title },
          { label: "Course", value: task.course.courseCode },
          { label: "Progress", value: `${task.progress}% → ${progress_percent}%` },
        ],
      };
    }
    case "mark_task_completed":
    case "ignore_task":
    case "undo_ignore_task": {
      const task = await findTask(ctx, (args as z.infer<typeof taskArgs>).task_id);
      const verb = name === "mark_task_completed" ? "Mark as done" : name === "ignore_task" ? "Ignore" : "Stop ignoring";
      const details = [
        { label: "Task", value: task.title },
        { label: "Course", value: task.course.courseCode },
      ];
      if (name === "mark_task_completed") details.push({ label: "Note", value: "This does not submit anything to Canvas." });
      return { summary: `${verb}: "${task.title}"`, details };
    }
    case "archive_course":
    case "restore_course": {
      const course = await findCourse(ctx, (args as z.infer<typeof courseArgs>).course_id);
      return {
        summary: `${name === "archive_course" ? "Archive" : "Restore"} ${course.courseCode}`,
        details: [
          { label: "Course", value: `${course.courseCode} · ${course.name}` },
          { label: "Effect", value: name === "archive_course" ? "Hidden from lists and plans; syncing keeps it up to date." : "Shown in lists and plans again." },
        ],
      };
    }
    case "create_manual_event": {
      const { body, data, allDay, times } = await newEventBody(args as z.infer<typeof schemas.create_manual_event>, ctx);
      const details = [
        { label: "Title", value: body.title },
        { label: "When", value: when(allDay, times.startAt, times.endAt, ctx.timeZone) },
        { label: "Busy", value: data.busy ? "Yes" : "No" },
      ];
      if (body.location) details.push({ label: "Location", value: body.location });
      if (data.recurrenceRule) details.push({ label: "Repeats", value: data.recurrenceRule });
      if (data.eventType !== "other") details.push({ label: "Type", value: data.eventType });
      return { summary: `Add "${body.title}" to the calendar`, details };
    }
    case "update_manual_event": {
      const typed = args as z.infer<typeof schemas.update_manual_event>;
      const event = await findManualEvent(ctx, typed.event_id);
      const { body, data, allDay, times } = await eventPatch(typed, event, ctx);
      const details = [{ label: "Event", value: event.recurrenceRule ? `${event.title} (whole repeating series)` : event.title }];
      if (body.title !== undefined) details.push({ label: "New title", value: body.title });
      if (times.startAt && times.endAt) details.push({ label: "New time", value: when(allDay, times.startAt, times.endAt, ctx.timeZone) });
      if (body.location !== undefined) details.push({ label: "Location", value: body.location || "(none)" });
      if (body.busy !== undefined) details.push({ label: "Busy", value: body.busy ? "Yes" : "No" });
      if (body.recurrence_rule !== undefined) details.push({ label: "Repeats", value: data.recurrenceRule ?? "(no longer repeats)" });
      if (body.event_type !== undefined) details.push({ label: "Type", value: body.event_type });
      if (body.description !== undefined) details.push({ label: "Description", value: body.description || "(none)" });
      if (body.time_zone !== undefined) details.push({ label: "Time zone", value: body.time_zone || "(your zone)" });
      if (body.course_id !== undefined) details.push({ label: "Course", value: body.course_id === null ? "(none)" : String(body.course_id) });
      if (details.length === 1) throw new FieldError("arguments", "Send at least one field to change.");
      return { summary: `Change "${event.title}"`, details };
    }
    case "delete_manual_event": {
      const event = await findManualEvent(ctx, (args as z.infer<typeof schemas.delete_manual_event>).event_id);
      return {
        summary: event.recurrenceRule ? `Delete the repeating "${event.title}" series` : `Delete "${event.title}" from the calendar`,
        details: [
          { label: "Event", value: event.title },
          { label: "When", value: when(event.allDay, event.startAt, event.endAt, ctx.timeZone) },
        ],
      };
    }
  }
}

/** Runs a confirmed proposal, checking everything again: the data may have changed since. */
export async function applyWrite(name: string, rawArgs: unknown, ctx: WriteContext): Promise<Record<string, unknown>> {
  if (!isWriteTool(name)) throw new HttpError(422, "UNKNOWN_TOOL", "This action is no longer supported.");
  const args = schemas[name].parse(rawArgs);
  const now = ctx.now;
  switch (name) {
    // Task changes go through the same state machine as PATCH /api/tasks/:id (tasks/state.ts):
    // revision bump, progress 100 completes, completing or ignoring stops the timer, progress history.
    case "set_task_progress": {
      const typed = args as z.infer<typeof schemas.set_task_progress>;
      const { progress } = taskChangeSchema.parse({ progress: typed.progress_percent });
      const task = await findTask(ctx, typed.task_id);
      await applyTaskChange(ctx.db, { userId: ctx.userId, task, state: { progress }, now });
      return { task_id: task.id, progress };
    }
    case "mark_task_completed": {
      const task = await findTask(ctx, (args as z.infer<typeof taskArgs>).task_id);
      await applyTaskChange(ctx.db, { userId: ctx.userId, task, state: { done: true }, now });
      return { task_id: task.id, done: true };
    }
    case "ignore_task":
    case "undo_ignore_task": {
      const task = await findTask(ctx, (args as z.infer<typeof taskArgs>).task_id);
      const ignored = name === "ignore_task";
      await applyTaskChange(ctx.db, { userId: ctx.userId, task, state: { ignored }, now });
      return { task_id: task.id, ignored };
    }
    case "archive_course":
    case "restore_course": {
      const course = await findCourse(ctx, (args as z.infer<typeof courseArgs>).course_id);
      const archived = name === "archive_course";
      if (archived !== (course.archivedAt !== null)) {
        await ctx.db.course.update({ where: { id: course.id }, data: { archivedAt: archived ? now : null } });
      }
      return { course_id: course.id, archived };
    }
    case "create_manual_event": {
      const { data } = await newEventBody(args as z.infer<typeof schemas.create_manual_event>, ctx);
      const event = await ctx.db.calendarEvent.create({ data });
      return { event_id: event.id, title: event.title };
    }
    case "update_manual_event": {
      const typed = args as z.infer<typeof schemas.update_manual_event>;
      const event = await findManualEvent(ctx, typed.event_id);
      const { data } = await eventPatch(typed, event, ctx);
      await ctx.db.calendarEvent.update({ where: { id: event.id }, data });
      return { event_id: event.id };
    }
    case "delete_manual_event": {
      const event = await findManualEvent(ctx, (args as z.infer<typeof schemas.delete_manual_event>).event_id);
      await ctx.db.calendarEvent.delete({ where: { id: event.id } });
      return { event_id: event.id, deleted: true };
    }
  }
}
