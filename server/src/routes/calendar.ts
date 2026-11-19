import { Router } from "express";
import { DateTime, IANAZone } from "luxon";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import { capacityBetween, layersBetween } from "../calendar/capacity.js";
import {
  EVENT_TYPES,
  busyTime,
  eventInclude,
  loadAvailability,
  loadCommutes,
  occurrencesBetween,
  presentEvent,
  presentOccurrence,
  type EventWithSource,
} from "../calendar/events.js";
import { RecurrenceError, normalizeRule } from "../calendar/recurrence.js";
import type { Db } from "../db.js";
import { FieldError, HttpError } from "../http/errors.js";
import { idParam, parseQuery } from "../http/params.js";
import { availabilityRouter } from "./availability.js";
import { calendarSourcesRouter } from "./calendarSources.js";
import { getSettings } from "./settings.js";

export { ICS_BODY_LIMIT, isIcsUpload } from "./calendarSources.js";

const DAY_MS = 86_400_000;

const instantString = z.iso.datetime({ offset: true, error: "Use a date and time with a time zone." });

const rangeQuery = z
  .object({ from: instantString, to: instantString })
  .transform(({ from, to }) => ({ from: new Date(from), to: new Date(to) }))
  .refine(({ from, to }) => to > from, { message: "End the range after it starts.", path: ["to"] })
  .refine(({ from, to }) => to.getTime() - from.getTime() <= 62 * DAY_MS, {
    message: "Ask for at most 62 days at once.",
    path: ["to"],
  });

const title = z.string().trim().min(1, "Give the event a title.").max(200, "Use at most 200 characters.");
const location = z.string().trim().max(200, "Use at most 200 characters.");

const eventFields = z.object({
  title,
  location: location.nullable(),
  description: z.string().trim().max(5000, "Use at most 5,000 characters.").nullable(),
  all_day: z.boolean({ error: "Send all_day as true or false." }),
  start: z.string({ error: "Choose when the event starts." }),
  end: z.string({ error: "Choose when the event ends." }),
  busy: z.boolean({ error: "Send busy as true or false." }),
  /** IANA zone of the wall-clock times; null follows the user's zone. */
  time_zone: z.string().trim().max(64).nullable(),
  event_type: z.enum(EVENT_TYPES, { error: "Choose class, busy, personal, study or other." }),
  course_id: z.number().int().positive().nullable(),
  recurrence_rule: z.string().trim().max(512, "Use at most 512 characters.").nullable(),
});
const eventCreation = eventFields
  .partial({ location: true, description: true, all_day: true, busy: true, time_zone: true, event_type: true, course_id: true, recurrence_rule: true })
  .strict();
const eventChanges = eventFields.partial().strict();

const eventNotFound = () => new HttpError(404, "EVENT_NOT_FOUND", "That event could not be found.");

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/**
 * One timed boundary: an instant with an offset, or a wall-clock time read in `zone`. Wall-clock
 * times that fall in a daylight-saving gap, or happen twice in an overlap, are refused.
 */
function timedValue(field: "start" | "end", value: string, zone: string): Date {
  if (instantString.safeParse(value).success) return new Date(value);
  if (!LOCAL.test(value)) throw new FieldError(field, "Use a date and time like 2026-11-06T09:00.");
  const time = DateTime.fromISO(value, { zone });
  if (!time.isValid || time.toFormat("yyyy-MM-dd'T'HH:mm") !== value.slice(0, 16)) {
    throw new FieldError(field, "Invalid local time or a daylight-saving time gap. Choose another time.");
  }
  if (time.getPossibleOffsets().length > 1) {
    throw new FieldError(field, "This time occurs twice at the daylight-saving transition. Choose an unambiguous time.");
  }
  return time.toJSDate();
}

/** Turns the start and end strings into stored instants, checking they fit the kind of event. */
function eventTimes(allDay: boolean, start: string, end: string, zone: string): { startAt: Date; endAt: Date } {
  if (allDay) {
    const startAt = new Date(`${start}T00:00:00.000Z`);
    const endAt = new Date(`${end}T00:00:00.000Z`);
    if (!DATE.test(start) || Number.isNaN(startAt.getTime())) throw new FieldError("start", "Use a date like 2026-11-06.");
    if (!DATE.test(end) || Number.isNaN(endAt.getTime())) throw new FieldError("end", "Use a date like 2026-11-07.");
    if (endAt <= startAt) throw new FieldError("end", "End the event on a later date; the end date is not included.");
    if (endAt.getTime() - startAt.getTime() > 31 * DAY_MS) throw new FieldError("end", "Keep an event to 31 days or fewer.");
    return { startAt, endAt };
  }
  const startAt = timedValue("start", start, zone);
  const endAt = timedValue("end", end, zone);
  if (endAt <= startAt) throw new FieldError("end", "End the event after it starts.");
  if (endAt.getTime() - startAt.getTime() > 7 * DAY_MS) throw new FieldError("end", "Keep an event to 7 days or fewer.");
  return { startAt, endAt };
}

function checkZone(zone: string | null | undefined): void {
  if (zone && !IANAZone.isValidZone(zone)) {
    throw new FieldError("time_zone", "Unknown time zone; use an IANA time zone such as America/Chicago.");
  }
}

function checkRule(rule: string | null | undefined): string | null {
  if (!rule) return null;
  try {
    return normalizeRule(rule);
  } catch (error) {
    if (error instanceof RecurrenceError) throw new FieldError("recurrence_rule", error.message);
    throw error;
  }
}

/** A linked course must be one of the user's own. */
async function checkCourse(db: Db, userId: string, courseId: number | null | undefined): Promise<void> {
  if (courseId == null) return;
  if (!(await db.course.findFirst({ where: { id: courseId, userId }, select: { id: true } }))) {
    throw new FieldError("course_id", "Choose one of your courses.");
  }
}

/** The stored fields of a new manual event, checked like POST /events. */
export async function newEventData(db: Db, userId: string, body: z.infer<typeof eventCreation>, userZone: string) {
  checkZone(body.time_zone);
  const allDay = body.all_day ?? false;
  const times = eventTimes(allDay, body.start, body.end, body.time_zone || userZone);
  const recurrenceRule = checkRule(body.recurrence_rule);
  await checkCourse(db, userId, body.course_id);
  return {
    userId,
    title: body.title,
    location: body.location || null,
    description: body.description || null,
    allDay,
    busy: body.busy ?? !allDay,
    timeZone: body.time_zone || null,
    eventType: body.event_type ?? "other",
    courseId: body.course_id ?? null,
    recurrenceRule,
    ...times,
  };
}

/** The changed fields of a manual event, checked like PATCH /events/:id. */
export async function eventChangeData(db: Db, userId: string, event: EventWithSource, body: z.infer<typeof eventChanges>, userZone: string) {
  checkZone(body.time_zone);
  const zone = (body.time_zone !== undefined ? body.time_zone : event.timeZone) || userZone;
  const current = presentEvent(event);
  const allDay = body.all_day ?? event.allDay;
  const times: { startAt?: Date; endAt?: Date } =
    body.all_day !== undefined || body.start !== undefined || body.end !== undefined
      ? eventTimes(allDay, body.start ?? current.start, body.end ?? current.end, zone)
      : {};
  const recurrenceRule = body.recurrence_rule !== undefined ? checkRule(body.recurrence_rule) : undefined;
  await checkCourse(db, userId, body.course_id);
  return {
    ...(body.title !== undefined && { title: body.title }),
    ...(body.location !== undefined && { location: body.location || null }),
    ...(body.description !== undefined && { description: body.description || null }),
    ...(body.busy !== undefined && { busy: body.busy }),
    ...(body.time_zone !== undefined && { timeZone: body.time_zone || null }),
    ...(body.event_type !== undefined && { eventType: body.event_type }),
    ...(body.course_id !== undefined && { courseId: body.course_id }),
    ...(recurrenceRule !== undefined && { recurrenceRule }),
    allDay,
    ...times,
  };
}

export function calendarRouter(db: Db): Router {
  const router = Router();
  router.use("/sources", calendarSourcesRouter(db));
  router.use("/availability", availabilityRouter(db));

  async function findEvent(userId: string, rawId: string | undefined): Promise<EventWithSource> {
    const event = await db.calendarEvent.findFirst({
      where: { id: idParam(rawId, eventNotFound()), userId },
      include: eventInclude,
    });
    if (!event) throw eventNotFound();
    return event;
  }

  function requireManual(event: EventWithSource) {
    if (event.sourceId !== null) {
      throw new HttpError(
        409,
        "EVENT_IMPORTED",
        `This event comes from "${event.source?.name ?? "an imported calendar"}". Change it in that calendar and import it again.`,
      );
    }
  }

  async function rangeData(userId: string, from: Date, to: Date) {
    const settings = await getSettings(db, userId);
    const zone = settings.timeZone;
    const first = DateTime.fromJSDate(from, { zone }).toISODate() as string;
    const last = DateTime.fromJSDate(to, { zone }).toISODate() as string;
    const [{ occurrences, warnings }, commutes, availability] = await Promise.all([
      occurrencesBetween(db, userId, from, to, zone),
      loadCommutes(db, userId),
      loadAvailability(db, userId, first, last),
    ]);
    return { zone, occurrences, warnings, commutes, availability, ...busyTime(occurrences, warnings, commutes, { from, to }) };
  }

  router.get("/events", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const { from, to } = parseQuery(rangeQuery, req.query);
    const settings = await getSettings(db, userId);
    const { occurrences } = await occurrencesBetween(db, userId, from, to, settings.timeZone);
    res.json(occurrences.map(presentOccurrence));
  });

  /**
   * Everything the calendar page draws for [from, to): occurrences, background layers (study
   * windows, commute, bridged class gaps) and warnings for stored events that can't be expanded.
   */
  router.get("/view", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const { from, to } = parseQuery(rangeQuery, req.query);
    const data = await rangeData(userId, from, to);
    const layers = layersBetween({ from, to, zone: data.zone, availability: data.availability, events: data.events, commutes: data.commutes });
    res.json({
      time_zone: data.zone,
      events: data.occurrences.map(presentOccurrence),
      layers: layers.map((layer) => ({ kind: layer.kind, start: layer.start.toISOString(), end: layer.end.toISOString() })),
      warnings: data.warnings,
    });
  });

  /** Free study minutes in [from, to); null minutes mean no availability is configured there. */
  router.get("/capacity", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const { from, to } = parseQuery(rangeQuery, req.query);
    const data = await rangeData(userId, from, to);
    res.json({ ...capacityBetween({ from, to, zone: data.zone, availability: data.availability, busy: data.busy }), time_zone: data.zone });
  });

  /** Where events come from. Google Calendar is not available yet; .ics import stands in for it. */
  router.get("/providers", async (_req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const imported = await db.calendarSource.count({ where: { userId } });
    res.json([
      { provider: "manual", status: "active", read_only: false },
      { provider: "ics", status: imported > 0 ? "active" : "not_configured", read_only: true },
      { provider: "google", status: "coming_soon", read_only: true },
    ]);
  });

  router.post("/events", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const body = eventCreation.parse(req.body ?? {});
    const settings = await getSettings(db, userId);
    const data = await newEventData(db, userId, body, settings.timeZone);
    const event = await db.calendarEvent.create({ data, include: eventInclude });
    res.status(201).json(presentEvent(event));
  });

  /** Changes an event added by hand; for a recurring event this changes the whole series. */
  router.patch("/events/:id", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const body = eventChanges.parse(req.body ?? {});
    const event = await findEvent(userId, req.params.id);
    requireManual(event);
    const settings = await getSettings(db, userId);
    const data = await eventChangeData(db, userId, event, body, settings.timeZone);
    const updated = await db.calendarEvent.update({ where: { id: event.id }, data, include: eventInclude });
    res.json(presentEvent(updated));
  });

  /** Deletes an event added by hand; a recurring event goes with its whole series. */
  router.delete("/events/:id", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const event = await findEvent(userId, req.params.id);
    requireManual(event);
    await db.calendarEvent.delete({ where: { id: event.id } });
    res.status(204).end();
  });

  return router;
}

/** For AI Chat's confirmed changes (ai/writeTools.ts), which validate like these routes. */
export { eventChanges, eventCreation };
