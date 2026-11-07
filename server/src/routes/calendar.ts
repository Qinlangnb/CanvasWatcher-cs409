import express, { Router } from "express";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import { eventInclude, eventsBetween, presentEvent, type EventWithSource } from "../calendar/events.js";
import { IcsError, parseIcs } from "../calendar/ics.js";
import type { Db } from "../db.js";
import { FieldError, HttpError } from "../http/errors.js";
import { idParam, parseQuery } from "../http/params.js";
import { getSettings } from "./settings.js";

/** An .ics file of a full semester with recurring classes is typically well under 1 MB. */
export const ICS_BODY_LIMIT = "1.5mb";
const MAX_SOURCES = 20;
const DAY_MS = 86_400_000;
/** Imports keep events from a month back to a year ahead. */
const IMPORT_PAST_DAYS = 31;
const IMPORT_FUTURE_DAYS = 366;

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
  all_day: z.boolean({ error: "Send all_day as true or false." }),
  start: z.string({ error: "Choose when the event starts." }),
  end: z.string({ error: "Choose when the event ends." }),
  busy: z.boolean({ error: "Send busy as true or false." }),
});
const eventCreation = eventFields.partial({ location: true, all_day: true, busy: true }).strict();
const eventChanges = eventFields.partial().strict();

const sourceCreation = z
  .object({
    name: z.string().trim().max(100, "Use at most 100 characters.").optional(),
    file_name: z.string().trim().max(255).optional(),
    ics: z.string({ error: "Choose an .ics file." }).min(1, "Choose an .ics file."),
  })
  .strict();

const eventNotFound = () => new HttpError(404, "EVENT_NOT_FOUND", "That event could not be found.");
const sourceNotFound = () => new HttpError(404, "CALENDAR_NOT_FOUND", "That calendar could not be found.");

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Turns the start and end strings into stored instants, checking they fit the kind of event. */
function eventTimes(allDay: boolean, start: string, end: string): { startAt: Date; endAt: Date } {
  if (allDay) {
    const startAt = new Date(`${start}T00:00:00.000Z`);
    const endAt = new Date(`${end}T00:00:00.000Z`);
    if (!DATE.test(start) || Number.isNaN(startAt.getTime())) throw new FieldError("start", "Use a date like 2026-11-06.");
    if (!DATE.test(end) || Number.isNaN(endAt.getTime())) throw new FieldError("end", "Use a date like 2026-11-07.");
    if (endAt <= startAt) throw new FieldError("end", "End the event on a later date; the end date is not included.");
    if (endAt.getTime() - startAt.getTime() > 31 * DAY_MS) throw new FieldError("end", "Keep an event to 31 days or fewer.");
    return { startAt, endAt };
  }
  if (!instantString.safeParse(start).success) throw new FieldError("start", "Use a date and time with a time zone.");
  if (!instantString.safeParse(end).success) throw new FieldError("end", "Use a date and time with a time zone.");
  const startAt = new Date(start);
  const endAt = new Date(end);
  if (endAt <= startAt) throw new FieldError("end", "End the event after it starts.");
  if (endAt.getTime() - startAt.getTime() > 7 * DAY_MS) throw new FieldError("end", "Keep an event to 7 days or fewer.");
  return { startAt, endAt };
}

function presentSource(source: { id: number; name: string; fileName: string | null; importedAt: Date }, eventCount: number) {
  return {
    id: source.id,
    name: source.name,
    file_name: source.fileName,
    imported_at: source.importedAt.toISOString(),
    event_count: eventCount,
  };
}

export function calendarRouter(db: Db): Router {
  const router = Router();

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

  router.get("/events", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const { from, to } = parseQuery(rangeQuery, req.query);
    const settings = await getSettings(db, userId);
    const events = await eventsBetween(db, userId, from, to, settings.timeZone);
    res.json(events.map(presentEvent));
  });

  router.post("/events", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const body = eventCreation.parse(req.body ?? {});
    const allDay = body.all_day ?? false;
    const times = eventTimes(allDay, body.start, body.end);
    const event = await db.calendarEvent.create({
      data: {
        userId,
        title: body.title,
        location: body.location || null,
        allDay,
        busy: body.busy ?? !allDay,
        ...times,
      },
      include: eventInclude,
    });
    res.status(201).json(presentEvent(event));
  });

  router.patch("/events/:id", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const body = eventChanges.parse(req.body ?? {});
    const event = await findEvent(userId, req.params.id);
    requireManual(event);
    const current = presentEvent(event);
    const allDay = body.all_day ?? event.allDay;
    const times =
      body.all_day !== undefined || body.start !== undefined || body.end !== undefined
        ? eventTimes(allDay, body.start ?? current.start, body.end ?? current.end)
        : {};
    const updated = await db.calendarEvent.update({
      where: { id: event.id },
      data: {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.location !== undefined && { location: body.location || null }),
        ...(body.busy !== undefined && { busy: body.busy }),
        allDay,
        ...times,
      },
      include: eventInclude,
    });
    res.json(presentEvent(updated));
  });

  router.delete("/events/:id", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const event = await findEvent(userId, req.params.id);
    requireManual(event);
    await db.calendarEvent.delete({ where: { id: event.id } });
    res.status(204).end();
  });

  router.get("/sources", async (_req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const sources = await db.calendarSource.findMany({
      where: { userId },
      include: { _count: { select: { events: true } } },
      orderBy: [{ importedAt: "desc" }, { id: "desc" }],
    });
    res.json(sources.map((source) => presentSource(source, source._count.events)));
  });

  /** Imports an .ics file. Its own larger body limit is applied here, after sign-in is checked. */
  router.post("/sources", express.json({ limit: ICS_BODY_LIMIT }), async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const body = sourceCreation.parse(req.body ?? {});
    if ((await db.calendarSource.count({ where: { userId } })) >= MAX_SOURCES) {
      throw new HttpError(409, "TOO_MANY_CALENDARS", `You can import up to ${MAX_SOURCES} calendars. Remove one first.`);
    }
    const settings = await getSettings(db, userId);
    const now = Date.now();
    let parsed;
    try {
      parsed = parseIcs(body.ics, {
        timeZone: settings.timeZone,
        windowStart: new Date(now - IMPORT_PAST_DAYS * DAY_MS),
        windowEnd: new Date(now + IMPORT_FUTURE_DAYS * DAY_MS),
      });
    } catch (error) {
      if (error instanceof IcsError) throw new FieldError("ics", error.message);
      throw error;
    }
    if (!parsed.events.length) {
      throw new FieldError("ics", "This file has no events between last month and a year from now.");
    }
    const fileStem = body.file_name?.replace(/\.ics$/i, "").trim();
    const name = body.name || parsed.name || fileStem || "Imported calendar";
    const source = await db.$transaction(async (tx) => {
      const created = await tx.calendarSource.create({
        data: { userId, name: name.slice(0, 100), fileName: body.file_name || null },
      });
      await tx.calendarEvent.createMany({
        data: parsed.events.map((event) => ({ userId, sourceId: created.id, ...event })),
      });
      return created;
    });
    res.status(201).json({ ...presentSource(source, parsed.events.length), truncated: parsed.truncated });
  });

  router.delete("/sources/:id", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const id = idParam(req.params.id, sourceNotFound());
    const { count } = await db.calendarSource.deleteMany({ where: { id, userId } });
    if (!count) throw sourceNotFound();
    res.status(204).end();
  });

  return router;
}

/** True for the one request whose body may exceed the global JSON limit. */
export function isIcsUpload(method: string, path: string): boolean {
  return method === "POST" && path === "/api/calendar/sources";
}
