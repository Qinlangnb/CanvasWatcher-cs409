// Calendar events as the API returns them, and the range query Calendar, Today and AI Chat use.
// Recurring events added by hand are stored once and expanded here; imported ones are stored expanded.
import { DateTime, IANAZone } from "luxon";
import type { Db } from "../db.js";
import type { CalendarEvent, CalendarSource, Course, Prisma } from "../generated/prisma/client.js";
import { type Availability, type BusyEvent, busyFromEvents, mergeBusy, minuteOf, type MinuteInterval } from "./capacity.js";
import { RecurrenceError, expandSeries } from "./recurrence.js";

export type EventWithSource = CalendarEvent & {
  source: Pick<CalendarSource, "id" | "name"> | null;
  course: Pick<Course, "id" | "courseCode"> | null;
};

export const eventInclude = {
  source: { select: { id: true, name: true } },
  course: { select: { id: true, courseCode: true } },
} satisfies Prisma.CalendarEventInclude;

export const EVENT_TYPES = ["class", "busy", "personal", "study", "other"] as const;

/** "YYYY-MM-DD" of an all-day boundary, which is stored as UTC midnight. */
export const dateOf = (date: Date) => date.toISOString().slice(0, 10);

/** One occurrence: the stored event, with this occurrence's times. */
export interface Occurrence {
  event: EventWithSource;
  start: Date;
  end: Date;
}

export interface EventWarning {
  event: ReturnType<typeof presentEvent>;
  code: "unsupported_timezone" | "unsupported_recurrence";
  message: string;
}

/** The zone an event's wall-clock times follow. */
export const eventZone = (event: Pick<CalendarEvent, "timeZone">, userZone: string) => event.timeZone ?? userZone;

export function presentEvent(event: EventWithSource, occurrence?: { start: Date; end: Date }) {
  const startAt = occurrence?.start ?? event.startAt;
  const endAt = occurrence?.end ?? event.endAt;
  const start = event.allDay ? dateOf(startAt) : startAt.toISOString();
  return {
    id: event.id,
    /** Unique per occurrence: recurring events share their id. */
    key: event.recurrenceRule ? `${event.id}@${start}` : String(event.id),
    title: event.title,
    location: event.location,
    description: event.description,
    all_day: event.allDay,
    /** A date ("2026-11-06") for all-day events, otherwise an instant. */
    start,
    /** Exclusive: the day after the last day, or the instant the event ends. */
    end: event.allDay ? dateOf(endAt) : endAt.toISOString(),
    busy: event.busy,
    event_type: event.eventType,
    /** Null means the user's own zone. */
    time_zone: event.timeZone,
    course: event.course ? { id: event.course.id, code: event.course.courseCode } : null,
    recurrence_rule: event.recurrenceRule,
    /** The first occurrence of a recurring event; editing changes the whole series from there. */
    series: event.recurrenceRule
      ? {
          start: event.allDay ? dateOf(event.startAt) : event.startAt.toISOString(),
          end: event.allDay ? dateOf(event.endAt) : event.endAt.toISOString(),
        }
      : null,
    source: event.source ? { id: event.source.id, name: event.source.name } : null,
    editable: event.sourceId === null,
  };
}

const DAY_MS = 86_400_000;
/** Rows read per query by occurrencesBetween, which reads every page. */
export const EVENT_PAGE_SIZE = 2000;

/**
 * Occurrences overlapping [from, to), sorted. All-day events belong to dates, not instants, so they
 * are matched against the local dates the range covers in `timeZone`. A stored event whose zone or
 * rule can no longer be read is reported in `warnings` and kept out of `occurrences`.
 */
export async function occurrencesBetween(db: Db, userId: string, from: Date, to: Date, timeZone: string) {
  const firstDay = DateTime.fromJSDate(from, { zone: timeZone }).startOf("day");
  const lastDay = DateTime.fromJSDate(new Date(to.getTime() - 1), { zone: timeZone }).startOf("day");
  const dayStart = new Date(`${firstDay.toISODate()}T00:00:00.000Z`);
  const dayEnd = new Date(Date.parse(`${lastDay.toISODate()}T00:00:00.000Z`) + DAY_MS);
  const where: Prisma.CalendarEventWhereInput = {
    userId,
    OR: [
      {
        recurrenceRule: null,
        allDay: false,
        startAt: { lt: to },
        OR: [{ endAt: { gt: from } }, { startAt: { gte: from } }],
      },
      { recurrenceRule: null, allDay: true, startAt: { lt: dayEnd }, endAt: { gt: dayStart } },
      // Series may start long before the range; they are expanded below. A timed series is matched
      // against the instants [from, to) (the UTC-midnight day bounds end hours early west of UTC), an
      // all-day one against the dates.
      { recurrenceRule: { not: null }, allDay: false, startAt: { lt: to } },
      { recurrenceRule: { not: null }, allDay: true, startAt: { lt: dayEnd } },
    ],
  };
  // Every matching row is read, a page at a time: the calendar and capacity must never work from a
  // silently cut list (imports already bound what is stored: 20 calendars of at most 2,000 events).
  const rows: EventWithSource[] = [];
  for (;;) {
    const last = rows.at(-1);
    const page = await db.calendarEvent.findMany({
      where,
      include: eventInclude,
      orderBy: [{ startAt: "asc" }, { id: "asc" }],
      take: EVENT_PAGE_SIZE,
      ...(last && { cursor: { id: last.id }, skip: 1 }),
    });
    rows.push(...page);
    if (page.length < EVENT_PAGE_SIZE) break;
  }
  const occurrences: Occurrence[] = [];
  const warnings: EventWarning[] = [];
  for (const event of rows) {
    if (!event.recurrenceRule) {
      occurrences.push({ event, start: event.startAt, end: event.endAt });
      continue;
    }
    const zone = eventZone(event, timeZone);
    if (!IANAZone.isValidZone(zone)) {
      warnings.push({
        event: presentEvent(event),
        code: "unsupported_timezone",
        message: "This event's time zone needs repair. Study time is treated as busy until it is fixed.",
      });
      continue;
    }
    try {
      const [rangeStart, rangeEnd] = event.allDay ? [dayStart, dayEnd] : [from, to];
      for (const span of expandSeries({ ...event, recurrenceRule: event.recurrenceRule }, zone, rangeStart, rangeEnd)) {
        occurrences.push({ event, ...span });
      }
    } catch (error) {
      if (!(error instanceof RecurrenceError)) throw error;
      warnings.push({
        event: presentEvent(event),
        code: "unsupported_recurrence",
        message: "This event's repeat rule needs repair. Study time is treated as busy until it is fixed.",
      });
    }
  }
  occurrences.sort((a, b) => a.start.getTime() - b.start.getTime() || a.event.id - b.event.id);
  return { occurrences, warnings };
}

/** Occurrences as the API returns them. */
export const presentOccurrence = (occurrence: Occurrence) => presentEvent(occurrence.event, occurrence);

/**
 * Busy time for planning: opaque timed occurrences with commute around classes. An event that
 * can't be expanded blocks the whole range, so an unknown commitment never looks like free time.
 */
export function busyTime(
  occurrences: Occurrence[],
  warnings: EventWarning[],
  commutes: Map<number, number>,
  range: { from: Date; to: Date },
) {
  const events: BusyEvent[] = occurrences.map(({ event, start, end }) => ({
    start,
    end,
    allDay: event.allDay,
    busy: event.busy,
    eventType: event.eventType,
    courseId: event.courseId,
  }));
  const busy = busyFromEvents(events, commutes);
  if (warnings.some((warning) => warning.event.busy)) busy.push({ start: range.from.getTime(), end: range.to.getTime(), isClass: false });
  return { events, busy };
}

/**
 * What a plan over [from, to) needs: occurrences, busy time (commute and short class gaps merged in)
 * and the availability for those dates. Today and AI Chat share it so their numbers match.
 */
export async function planningInputs(db: Db, userId: string, from: Date, to: Date, timeZone: string, lastDate?: string) {
  const first = DateTime.fromJSDate(from, { zone: timeZone }).toISODate() as string;
  const last = lastDate ?? (DateTime.fromJSDate(to, { zone: timeZone }).toISODate() as string);
  const [calendar, commutes, availability] = await Promise.all([
    occurrencesBetween(db, userId, from, to, timeZone),
    loadCommutes(db, userId),
    loadAvailability(db, userId, first, last),
  ]);
  const { busy } = busyTime(calendar.occurrences, calendar.warnings, commutes, { from, to });
  return {
    ...calendar,
    availability,
    busy: mergeBusy(busy).map((span) => ({ start: new Date(span.start), end: new Date(span.end) })),
  };
}

/** Commute minutes by course id. */
export async function loadCommutes(db: Db, userId: string): Promise<Map<number, number>> {
  const courses = await db.course.findMany({ where: { userId, commuteMinutes: { gt: 0 } }, select: { id: true, commuteMinutes: true } });
  return new Map(courses.map((course) => [course.id, course.commuteMinutes]));
}

/** The user's weekly rules plus the overrides for the local dates [first, last]. */
export async function loadAvailability(db: Db, userId: string, first: string, last: string): Promise<Availability> {
  const [rules, overrides] = await Promise.all([
    db.studyAvailabilityRule.findMany({ where: { userId }, orderBy: [{ weekday: "asc" }, { startMinute: "asc" }] }),
    db.studyAvailabilityOverride.findMany({
      where: { userId, date: { gte: new Date(`${first}T00:00:00.000Z`), lte: new Date(`${last}T00:00:00.000Z`) } },
    }),
  ]);
  return {
    rules,
    overrides: new Map(overrides.map((row) => [dateOf(row.date), intervalsOf(row.intervals)])),
  };
}

/** Stored override intervals ([{start: "HH:MM", end}]) as minutes; anything malformed is dropped. */
export function intervalsOf(value: unknown): MinuteInterval[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    const { start, end } = (item ?? {}) as { start?: unknown; end?: unknown };
    if (typeof start !== "string" || typeof end !== "string" || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return [];
    return [{ startMinute: minuteOf(start), endMinute: minuteOf(end) }];
  });
}
