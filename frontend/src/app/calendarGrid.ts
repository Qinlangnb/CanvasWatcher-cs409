// Pure layout for the Day and Month calendar views: the month grid, where a timed event sits on a
// day's time grid, and side-by-side lanes for overlapping events. Dates are "YYYY-MM-DD" strings.
import { DateTime } from "luxon";
import type { CalendarEvent } from "./types";

const DATE = "yyyy-LL-dd";
const parse = (date: string) => DateTime.fromFormat(date, DATE, { zone: "UTC" });

/** The 42 dates (six weeks, Sunday first) that show the month containing `date`. */
export function monthGrid(date: string): string[] {
  const first = parse(date).startOf("month");
  const start = first.minus({ days: first.weekday % 7 });
  return Array.from({ length: 42 }, (_, index) => start.plus({ days: index }).toFormat(DATE));
}

export function addMonths(date: string, months: number): string {
  return parse(date).plus({ months }).toFormat(DATE);
}

/** "November 2026". */
export function monthLabel(date: string): string {
  return parse(date).toLocaleString({ month: "long", year: "numeric" }, { locale: "en-US" });
}

/** "Wednesday, November 18, 2026". */
export function dayLabel(date: string): string {
  return parse(date).toLocaleString({ weekday: "long", month: "long", day: "numeric", year: "numeric" }, { locale: "en-US" });
}

export const sameMonth = (a: string, b: string) => a.slice(0, 7) === b.slice(0, 7);

/** Minutes after local midnight of `date` at which [start, end) begins and ends, clipped to that day. */
export function minutesOnDay(start: string, end: string, date: string, zone: string): { top: number; bottom: number } | null {
  const dayStart = DateTime.fromFormat(date, DATE, { zone });
  const dayEnd = dayStart.plus({ days: 1 });
  const from = DateTime.fromISO(start).setZone(zone);
  const to = DateTime.fromISO(end).setZone(zone);
  if (to <= dayStart || from >= dayEnd) return null;
  const length = dayEnd.diff(dayStart, "minutes").minutes;
  const top = Math.max(0, from.diff(dayStart, "minutes").minutes);
  const bottom = Math.min(length, to.diff(dayStart, "minutes").minutes);
  return { top, bottom: Math.max(bottom, top + 15) };
}

export interface Placed {
  event: CalendarEvent;
  top: number;
  bottom: number;
  lane: number;
  lanes: number;
}

/** Timed events on `date`, each in the first free lane; overlapping groups share their lane count. */
export function placeEvents(events: CalendarEvent[], date: string, zone: string): Placed[] {
  const items = events
    .filter((event) => !event.all_day)
    .flatMap((event) => {
      const span = minutesOnDay(event.start, event.end, date, zone);
      return span ? [{ event, ...span, lane: 0, lanes: 1 }] : [];
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  let group: Placed[] = [];
  let groupEnd = -1;
  const close = () => {
    const lanes = Math.max(1, ...group.map((item) => item.lane + 1));
    for (const item of group) item.lanes = lanes;
    group = [];
  };
  for (const item of items) {
    if (item.top >= groupEnd) close();
    const taken = new Set(group.filter((other) => other.bottom > item.top).map((other) => other.lane));
    let lane = 0;
    while (taken.has(lane)) lane += 1;
    item.lane = lane;
    group.push(item);
    groupEnd = Math.max(groupEnd, item.bottom);
  }
  close();
  return items;
}

/** "HH:mm" wall-clock value for a datetime-local input: `minute` after midnight on `date`. */
export function slotValue(date: string, minute: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, minute));
  return `${date}T${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

export interface HourRow {
  /** The instant the row starts. */
  at: number;
  /** The wall-clock hour the row shows, e.g. "2026-11-01T01:00". */
  wall: string;
  /** The hour happens twice (clocks go back); `zoneName` ("CDT", "CST") tells the two apart. */
  repeated: boolean;
  zoneName: string;
  /**
   * The datetime-local start and end a click on the row creates, both read back to this row's hour;
   * null when its start is a wall-clock time that happens twice, which the server can't place.
   */
  slot: { start: string; end: string } | null;
}

const WALL = "yyyy-LL-dd'T'HH:mm";

/**
 * The real hours of `date` in `zone`: 23 on the day clocks go forward (the skipped hour has no row),
 * 25 when they go back. Each row starts one hour after the previous one, as the event blocks are
 * placed by elapsed minutes, and its label and slot come from that same instant.
 */
export function dayHours(date: string, zone: string): HourRow[] {
  const dayStart = DateTime.fromFormat(date, DATE, { zone });
  const dayEnd = dayStart.plus({ days: 1 });
  const count = Math.round(dayEnd.diff(dayStart, "hours").hours);
  const twice = (time: DateTime) => DateTime.fromFormat(time.toFormat(WALL), WALL, { zone }).getPossibleOffsets().length > 1;
  return Array.from({ length: count }, (_, index) => {
    const start = DateTime.fromMillis(dayStart.toMillis() + index * 3_600_000, { zone });
    const next = DateTime.fromMillis(start.toMillis() + 3_600_000, { zone });
    // The last row ends at 23:59 (the next hour is tomorrow); an end that happens twice ends a minute early.
    const end = next >= dayEnd ? `${date}T23:59` : (twice(next) ? next.minus({ minutes: 1 }) : next).toFormat(WALL);
    const repeated = twice(start);
    return {
      at: start.toMillis(),
      wall: start.toFormat(WALL),
      repeated,
      zoneName: start.toFormat("ZZZZ"),
      slot: repeated ? null : { start: start.toFormat(WALL), end },
    };
  });
}
