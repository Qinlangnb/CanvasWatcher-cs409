// Calendar arithmetic in the student's planning time zone. Pure: every function takes the zone, and
// local dates travel as "YYYY-MM-DD" strings so they never pick up the browser's zone by accident.
import { DateTime } from "luxon";
import type { CalendarEvent, Task } from "./types";

const DATE = "yyyy-LL-dd";

const parseDate = (date: string) => DateTime.fromFormat(date, DATE, { zone: "UTC" });

/** The local date of `instant` in `zone`. */
export function localDate(instant: Date | string, zone: string): string {
  const time = typeof instant === "string" ? DateTime.fromISO(instant) : DateTime.fromJSDate(instant);
  return time.setZone(zone).toFormat(DATE);
}

export function addDays(date: string, days: number): string {
  return parseDate(date).plus({ days }).toFormat(DATE);
}

/** Whole days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  return Math.round(parseDate(to).diff(parseDate(from), "days").days);
}

/** The seven dates of the week (Sunday first) that contains `date`. */
export function weekOf(date: string): string[] {
  const day = parseDate(date);
  const sunday = day.minus({ days: day.weekday % 7 });
  return Array.from({ length: 7 }, (_, index) => sunday.plus({ days: index }).toFormat(DATE));
}

/** The instants [from, to) that cover the local dates `first` through `last`. */
export function rangeOf(first: string, last: string, zone: string): { from: string; to: string } {
  const start = DateTime.fromFormat(first, DATE, { zone });
  const end = DateTime.fromFormat(last, DATE, { zone }).plus({ days: 1 });
  return { from: start.toUTC().toISO() ?? "", to: end.toUTC().toISO() ?? "" };
}

/** The local dates an event shows on. A timed event that ends at midnight doesn't spill into the next day. */
export function eventDates(event: CalendarEvent, zone: string): string[] {
  let first: string;
  let last: string;
  if (event.all_day) {
    first = event.start;
    last = addDays(event.end, -1);
  } else {
    const start = DateTime.fromISO(event.start).setZone(zone);
    const end = DateTime.fromISO(event.end).setZone(zone);
    first = start.toFormat(DATE);
    last = end > start ? end.minus({ milliseconds: 1 }).toFormat(DATE) : first;
  }
  const dates: string[] = [];
  // Bounded: the server keeps all-day events to 31 days and timed ones to 7.
  for (let date = first; date <= last && dates.length < 62; date = addDays(date, 1)) dates.push(date);
  return dates.length > 0 ? dates : [first];
}

/** Items by local date, for the dates asked for only. */
export function groupByDate<T>(dates: string[], items: T[], datesOf: (item: T) => string[]): Map<string, T[]> {
  const groups = new Map(dates.map((date) => [date, [] as T[]]));
  for (const item of items) for (const date of datesOf(item)) groups.get(date)?.push(item);
  return groups;
}

const clock = (time: DateTime) => time.toLocaleString(DateTime.TIME_SIMPLE, { locale: "en-US" });

/** "9:00 AM – 10:15 AM" on `date`, or "All day", "Until 10:00 AM", "From 9:00 PM" for the edges. */
export function eventTimeLabel(event: CalendarEvent, date: string, zone: string): string {
  if (event.all_day) return "All day";
  const start = DateTime.fromISO(event.start).setZone(zone);
  const end = DateTime.fromISO(event.end).setZone(zone);
  const startsBefore = start.toFormat(DATE) < date;
  const endsAfter = end.toFormat(DATE) > date && !(end.toFormat(DATE) === addDays(date, 1) && end.hour === 0 && end.minute === 0);
  if (startsBefore && endsAfter) return "All day";
  if (startsBefore) return `Until ${clock(end)}`;
  if (endsAfter) return `From ${clock(start)}`;
  return end > start ? `${clock(start)} – ${clock(end)}` : clock(start);
}

/** Sort key: all-day first, then by start. */
export function eventOrder(a: CalendarEvent, b: CalendarEvent): number {
  if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
  return a.start.localeCompare(b.start) || a.title.localeCompare(b.title);
}

/** A value for <input type="datetime-local"> showing `iso` in `zone`. */
export function toLocalInput(iso: string | null, zone: string): string {
  if (!iso) return "";
  const time = DateTime.fromISO(iso).setZone(zone);
  return time.isValid ? time.toFormat("yyyy-LL-dd'T'HH:mm") : "";
}

/** An ISO instant with offset from a datetime-local value read in `zone`; null when empty or invalid. */
export function fromLocalInput(value: string, zone: string): string | null {
  if (!value) return null;
  const time = DateTime.fromISO(value, { zone });
  return time.isValid ? time.toISO({ suppressMilliseconds: true }) : null;
}

/** "Today", "Tomorrow", "Yesterday" or "Sat, Nov 7". */
export function dateLabel(date: string, today: string): string {
  const offset = daysBetween(today, date);
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  if (offset === -1) return "Yesterday";
  return parseDate(date).toLocaleString({ weekday: "short", month: "short", day: "numeric" }, { locale: "en-US" });
}

/** "Sun 1" for a week column. */
export function weekdayLabel(date: string): { weekday: string; day: string; full: string } {
  const day = parseDate(date);
  return {
    weekday: day.toLocaleString({ weekday: "short" }, { locale: "en-US" }),
    day: String(day.day),
    full: day.toLocaleString({ weekday: "long", month: "long", day: "numeric" }, { locale: "en-US" }),
  };
}

/** "Nov 1 – 7, 2026", "Oct 26 – Nov 1, 2026" or across years in full. */
export function weekRangeLabel(dates: string[]): string {
  const first = parseDate(dates[0] ?? "");
  const last = parseDate(dates.at(-1) ?? "");
  const month = (time: DateTime) => time.toLocaleString({ month: "short" }, { locale: "en-US" });
  if (first.year !== last.year) return `${month(first)} ${first.day}, ${first.year} – ${month(last)} ${last.day}, ${last.year}`;
  if (first.month !== last.month) return `${month(first)} ${first.day} – ${month(last)} ${last.day}, ${last.year}`;
  return `${month(first)} ${first.day} – ${last.day}, ${last.year}`;
}

// --- Timeline ---

export interface TimelineDay {
  date: string;
  tasks: Task[];
  /** Work still left on the tasks due this day. */
  minutes: number;
  /**
   * Minutes of work due by the end of this day that the daily goal can't cover, counting from today.
   * Positive means the student falls behind unless they study more or start earlier.
   */
  shortfall: number;
}

export interface Timeline {
  overdue: Task[];
  days: TimelineDay[];
  /** Open work due after the window, and work without a due date. */
  later: Task[];
  undated: Task[];
}

const byDue = (a: Task, b: Task) => (a.due_at ?? "").localeCompare(b.due_at ?? "") || a.id - b.id;

/**
 * Open work along the next `length` days. Days without work are left out; a running total compares
 * the work due so far with what `dailyMinutes` a day gets done.
 */
export function buildTimeline(tasks: Task[], options: { today: string; zone: string; length: number; dailyMinutes: number }): Timeline {
  const { today, zone, length, dailyMinutes } = options;
  const end = addDays(today, length);
  const open = tasks.filter((task) => task.state === "open" || task.state === "overdue").sort(byDue);
  const overdue: Task[] = [];
  const later: Task[] = [];
  const undated: Task[] = [];
  const byDate = new Map<string, Task[]>();
  for (const task of open) {
    if (!task.due_at) {
      undated.push(task);
      continue;
    }
    const date = localDate(task.due_at, zone);
    if (task.state === "overdue" || date < today) overdue.push(task);
    else if (date >= end) later.push(task);
    else byDate.set(date, [...(byDate.get(date) ?? []), task]);
  }
  // Overdue work competes for the same hours, so it starts the running total.
  let due = overdue.reduce((sum, task) => sum + task.remaining_minutes, 0);
  const days: TimelineDay[] = [];
  for (const [date, list] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const minutes = list.reduce((sum, task) => sum + task.remaining_minutes, 0);
    due += minutes;
    const capacity = (daysBetween(today, date) + 1) * dailyMinutes;
    days.push({ date, tasks: list, minutes, shortfall: Math.max(0, due - capacity) });
  }
  return { overdue, days, later, undated };
}
