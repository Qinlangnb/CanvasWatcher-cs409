// Recurrence rules (RRULE) for events added by hand: the original app's allow-list, and expansion
// into occurrences. Expansion walks wall-clock times in the event's own zone, so a 9:00 class stays
// at 9:00 across daylight-saving changes. Pure: no I/O.
import ICAL from "ical.js";
import { DateTime } from "luxon";

type IcalTime = InstanceType<typeof ICAL.Time>;

export class RecurrenceError extends Error {}

const FIELDS = ["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS", "WKST"];
const FREQUENCIES = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const WEEKDAYS = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
/** Bounds the work one expansion may do, whatever the rule asks for. */
const MAX_STEPS = 20_000;

function list(value: string, check: (item: string) => boolean, message: string): void {
  if (!value.split(",").every((item) => item !== "" && check(item))) throw new RecurrenceError(message);
}

const inRange = (item: string, min: number, max: number, signed = false) => {
  if (!(signed ? /^[+-]?\d{1,3}$/ : /^\d{1,3}$/).test(item)) return false;
  const value = Math.abs(Number(item));
  return value >= min && value <= max;
};

/** The rule's parts in a fixed order, checked against the allow-list. Throws RecurrenceError. */
export function parseRule(value: string): Map<string, string> {
  const text = value.trim().toUpperCase().replace(/^RRULE:/, "");
  const parts = new Map<string, string>();
  for (const part of text.split(";")) {
    const [key = "", item = "", ...rest] = part.split("=");
    if (rest.length > 0 || !item || !FIELDS.includes(key) || parts.has(key)) {
      throw new RecurrenceError("Use only FREQ, INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, BYSETPOS and WKST, each once.");
    }
    parts.set(key, item);
  }
  if (!FREQUENCIES.has(parts.get("FREQ") ?? "")) throw new RecurrenceError("Set FREQ to DAILY, WEEKLY, MONTHLY or YEARLY.");
  for (const key of ["INTERVAL", "COUNT"]) {
    const item = parts.get(key);
    if (item !== undefined && (!/^\d{1,4}$/.test(item) || Number(item) < 1)) throw new RecurrenceError(`${key} must be a whole number from 1 to 9999.`);
  }
  if (parts.has("COUNT") && parts.has("UNTIL")) throw new RecurrenceError("Use COUNT or UNTIL, not both.");
  const until = parts.get("UNTIL");
  if (until !== undefined && (!/^\d{8}(T\d{6}Z?)?$/.test(until) || !DateTime.fromFormat(until.slice(0, 8), "yyyyLLdd").isValid)) {
    throw new RecurrenceError("Write UNTIL as a date like 20261211 or a time like 20261211T235959Z.");
  }
  const byDay = parts.get("BYDAY");
  if (byDay !== undefined) {
    list(
      byDay,
      (item) => {
        const match = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(item);
        return !!match && WEEKDAYS.has(match[2] ?? "") && (match[1] === undefined || inRange(match[1], 1, 53, true));
      },
      "List BYDAY days like MO,WE or 1MO,-1FR.",
    );
  }
  const byMonthDay = parts.get("BYMONTHDAY");
  if (byMonthDay !== undefined) list(byMonthDay, (item) => inRange(item, 1, 31, true), "BYMONTHDAY takes days from 1 to 31 or -1 to -31.");
  const byMonth = parts.get("BYMONTH");
  if (byMonth !== undefined) list(byMonth, (item) => inRange(item, 1, 12), "BYMONTH takes months from 1 to 12.");
  const bySetPos = parts.get("BYSETPOS");
  if (bySetPos !== undefined) list(bySetPos, (item) => inRange(item, 1, 366, true), "BYSETPOS takes positions from 1 to 366 or -1 to -366.");
  const weekStart = parts.get("WKST");
  if (weekStart !== undefined && !WEEKDAYS.has(weekStart)) throw new RecurrenceError("WKST takes a day like MO.");
  if (weekStart === undefined) parts.set("WKST", "MO");
  const ordered = new Map(FIELDS.filter((key) => parts.has(key)).map((key) => [key, parts.get(key) as string]));
  try {
    ICAL.Recur.fromString(serialize(ordered));
  } catch {
    throw new RecurrenceError("This recurrence rule is not valid.");
  }
  return ordered;
}

const serialize = (parts: Map<string, string>) => [...parts].map(([key, item]) => `${key}=${item}`).join(";");

/** The rule as it is stored: upper case, fixed field order, WKST filled in. */
export const normalizeRule = (value: string): string => serialize(parseRule(value));

export interface SeriesEvent {
  /** The first occurrence. All-day events use UTC midnight of their first day and of the day after the last. */
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  recurrenceRule: string;
}

export interface Occurrence {
  start: Date;
  end: Date;
}

/**
 * Occurrences of a recurring event that overlap [from, to). `zone` is the IANA zone of its wall-clock
 * times. Throws RecurrenceError for a rule that is no longer valid.
 */
export function expandSeries(event: SeriesEvent, zone: string, from: Date, to: Date): Occurrence[] {
  const parts = parseRule(event.recurrenceRule);
  const until = parts.get("UNTIL");
  // UNTIL is applied below in the event's zone; ical.js would compare it with floating times.
  parts.delete("UNTIL");
  const duration = event.endAt.getTime() - event.startAt.getTime();
  const first = DateTime.fromJSDate(event.startAt, { zone: event.allDay ? "UTC" : zone });
  if (!first.isValid) throw new RecurrenceError("The event's time zone is not valid.");
  const dtstart = ICAL.Time.fromData(
    event.allDay
      ? { year: first.year, month: first.month, day: first.day, isDate: true }
      : { year: first.year, month: first.month, day: first.day, hour: first.hour, minute: first.minute, second: first.second },
  );
  const startOf = (time: IcalTime): number =>
    event.allDay
      ? Date.UTC(time.year, time.month - 1, time.day)
      : DateTime.fromObject(
          { year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute, second: time.second },
          { zone },
        ).toMillis();

  let last = Number.POSITIVE_INFINITY;
  if (until) {
    const date = { year: Number(until.slice(0, 4)), month: Number(until.slice(4, 6)), day: Number(until.slice(6, 8)) };
    if (until.length === 8) {
      // A date-only UNTIL includes that whole day.
      last = event.allDay
        ? Date.UTC(date.year, date.month - 1, date.day)
        : DateTime.fromObject({ ...date, hour: 23, minute: 59, second: 59 }, { zone }).toMillis();
    } else {
      const clock = { hour: Number(until.slice(9, 11)), minute: Number(until.slice(11, 13)), second: Number(until.slice(13, 15)) };
      last = DateTime.fromObject({ ...date, ...clock }, { zone: until.endsWith("Z") ? "UTC" : zone }).toMillis();
    }
  }

  const months = parts.get("BYMONTH")?.split(",").map(Number);
  const monthDays = parts.get("BYMONTHDAY")?.split(",").map(Number);
  // ical.js can return dates the rule doesn't allow (BYMONTHDAY=31 in a short month); skip those.
  const allowed = (time: IcalTime) => {
    if (months && !months.includes(time.month)) return false;
    if (!monthDays) return true;
    const length = ICAL.Time.daysInMonth(time.month, time.year);
    return monthDays.some((day) => (day > 0 ? day : length + day + 1) === time.day);
  };

  const iterator = ICAL.Recur.fromString(serialize(parts)).iterator(dtstart);
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const occurrences: Occurrence[] = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    const next = iterator.next();
    if (!next) break;
    if (!allowed(next)) continue;
    const start = startOf(next);
    if (start > last || start >= toMs) break;
    const end = start + duration;
    if (end > fromMs || (end === start && start >= fromMs)) occurrences.push({ start: new Date(start), end: new Date(end) });
  }
  return occurrences;
}
