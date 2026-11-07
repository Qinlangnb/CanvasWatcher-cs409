// Calendar events as the API returns them, and the range query both Calendar and Today use.
import { DateTime } from "luxon";
import type { Db } from "../db.js";
import type { CalendarEvent, CalendarSource, Prisma } from "../generated/prisma/client.js";

export type EventWithSource = CalendarEvent & { source: Pick<CalendarSource, "id" | "name"> | null };

export const eventInclude = { source: { select: { id: true, name: true } } } satisfies Prisma.CalendarEventInclude;

/** "YYYY-MM-DD" of an all-day boundary, which is stored as UTC midnight. */
export const dateOf = (date: Date) => date.toISOString().slice(0, 10);

export function presentEvent(event: EventWithSource) {
  return {
    id: event.id,
    title: event.title,
    location: event.location,
    all_day: event.allDay,
    /** A date ("2026-11-06") for all-day events, otherwise an instant. */
    start: event.allDay ? dateOf(event.startAt) : event.startAt.toISOString(),
    /** Exclusive: the day after the last day, or the instant the event ends. */
    end: event.allDay ? dateOf(event.endAt) : event.endAt.toISOString(),
    busy: event.busy,
    source: event.source ? { id: event.source.id, name: event.source.name } : null,
    editable: event.sourceId === null,
  };
}

/**
 * Events overlapping [from, to). All-day events belong to dates, not instants, so they are
 * matched against the local dates the range covers in `timeZone`.
 */
export function eventsBetween(db: Db, userId: string, from: Date, to: Date, timeZone: string) {
  const firstDay = DateTime.fromJSDate(from, { zone: timeZone }).startOf("day");
  const lastDay = DateTime.fromJSDate(new Date(to.getTime() - 1), { zone: timeZone }).startOf("day");
  const dayStart = new Date(`${firstDay.toISODate()}T00:00:00.000Z`);
  const dayEnd = new Date(Date.parse(`${lastDay.toISODate()}T00:00:00.000Z`) + 86_400_000);
  return db.calendarEvent.findMany({
    where: {
      userId,
      OR: [
        {
          allDay: false,
          startAt: { lt: to },
          OR: [{ endAt: { gt: from } }, { startAt: { gte: from } }],
        },
        { allDay: true, startAt: { lt: dayEnd }, endAt: { gt: dayStart } },
      ],
    },
    include: eventInclude,
    orderBy: [{ startAt: "asc" }, { id: "asc" }],
    take: 2000,
  });
}
