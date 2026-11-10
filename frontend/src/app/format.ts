// Dates, sizes and labels as students read them. Every function takes `now` so tests can pin time.

const DAY = 24 * 60 * 60_000;

// The interface is written in English, so dates are too. Times use the student's planning time zone
// where a function takes `zone`, and the browser's otherwise.
const LOCALE = "en-US";
const longDate = new Intl.DateTimeFormat(LOCALE, { weekday: "long", month: "long", day: "numeric" });
const shortDate = new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric" });
const fullDate = new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric", year: "numeric" });
const dateTime = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short" });
const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

const formatters = new Map<string, Intl.DateTimeFormat>();
/** A cached formatter for `options` in `zone` (the browser's zone when undefined). */
function formatter(options: Intl.DateTimeFormatOptions, zone?: string, locale = LOCALE): Intl.DateTimeFormat {
  const key = `${locale}|${zone ?? ""}|${JSON.stringify(options)}`;
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone });
    formatters.set(key, cached);
  }
  return cached;
}

/** "2026-11-06": the calendar date of `date` in `zone`. */
export function dayKey(date: Date, zone?: string): string {
  const parts = formatter({ year: "numeric", month: "2-digit", day: "2-digit" }, zone, "en-CA").formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Whole calendar days from today to `date` in `zone`: 0 today, 1 tomorrow, -1 yesterday. */
export function dayOffset(date: Date, now = new Date(), zone?: string): number {
  return Math.round((Date.parse(dayKey(date, zone)) - Date.parse(dayKey(now, zone))) / DAY);
}

/** The hour (0-23) of `date` in `zone`. */
export function hourOf(date: Date, zone?: string): number {
  return Number(formatter({ hour: "numeric", hourCycle: "h23" }, zone).format(date)) % 24;
}

/** "9:00 AM" in `zone`. */
export function formatTime(date: Date, zone?: string): string {
  return formatter({ hour: "numeric", minute: "2-digit" }, zone).format(date);
}

/** "Today, 11:59 PM", "Tomorrow, 9:00 AM", "Fri, Nov 7, 11:59 PM" or "No due date". */
export function formatDue(iso: string | null, now = new Date(), zone?: string): string {
  if (!iso) return "No due date";
  const date = new Date(iso);
  const offset = dayOffset(date, now, zone);
  const at = formatTime(date, zone);
  if (offset === 0) return `Today, ${at}`;
  if (offset === 1) return `Tomorrow, ${at}`;
  if (offset === -1) return `Yesterday, ${at}`;
  const sameYear = dayKey(date, zone).slice(0, 4) === dayKey(now, zone).slice(0, 4);
  const day = formatter(sameYear ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" }, zone);
  return `${day.format(date)}, ${at}`;
}

/** Short urgency hint shown next to a due date. */
export function dueHint(
  iso: string | null,
  now = new Date(),
  zone?: string,
): { label: string; tone: "danger" | "warning" | "neutral" } | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (date < now) {
    const days = -dayOffset(date, now, zone);
    return { label: days <= 0 ? "Overdue" : `Overdue by ${days} day${days === 1 ? "" : "s"}`, tone: "danger" };
  }
  const offset = dayOffset(date, now, zone);
  if (offset === 0) return { label: "Due today", tone: "warning" };
  if (offset === 1) return { label: "Due tomorrow", tone: "warning" };
  if (offset < 7) return { label: `In ${offset} days`, tone: "neutral" };
  return null;
}

/** "Today", "Tomorrow" or "Wed, Nov 11": the local day something is due, for lists grouped by day. */
export function dueDayLabel(iso: string, now = new Date(), zone?: string): string {
  const date = new Date(iso);
  const offset = dayOffset(date, now, zone);
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  return formatter({ weekday: "short", month: "short", day: "numeric" }, zone).format(date);
}

/** "just now", "5 minutes ago", "yesterday", "3 days ago". */
export function timeAgo(iso: string | null, now = new Date()): string {
  if (!iso) return "never";
  const seconds = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < DAY / 1000) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < (30 * DAY) / 1000) return relative.format(Math.round(seconds / (DAY / 1000)), "day");
  return fullDate.format(new Date(iso));
}

/** "Sunday, November 1". */
export function formatLongDate(date: Date, zone?: string): string {
  return zone ? formatter({ weekday: "long", month: "long", day: "numeric" }, zone).format(date) : longDate.format(date);
}

/** "45 min", "2 h", "2 h 30 min". */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** A minute after local midnight as a clock time: 540 is "9:00 AM", 1440 is "Midnight". */
export function formatMinuteOfDay(minute: number): string {
  if (minute === 0 || minute === 1440) return "Midnight";
  if (minute === 720) return "Noon";
  const hour = Math.floor(minute / 60);
  const rest = String(minute % 60).padStart(2, "0");
  return `${hour % 12 === 0 ? 12 : hour % 12}:${rest} ${hour < 12 ? "AM" : "PM"}`;
}

/** "Nov 1" this year, "Sep 2, 2025" otherwise. */
export function formatShortDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  return date.getFullYear() === now.getFullYear() ? shortDate.format(date) : fullDate.format(date);
}

export function formatDateTime(iso: string | null): string {
  return iso ? dateTime.format(new Date(iso)) : "—";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  due_at: "Due date",
  lock_at: "Lock date",
  points_possible: "Points",
  description: "Description",
  name: "Name",
  size: "Size",
  content_type: "File type",
  updated_at: "Last modified",
  message: "Message",
  posted_at: "Posted",
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field.replaceAll("_", " ");
}

/** Renders a stored content value for the change detail view. */
export function formatFieldValue(field: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (field.endsWith("_at") && typeof value === "string") return formatDateTime(value);
  if (field === "size" && typeof value === "number") return formatBytes(value);
  return String(value);
}

export const TASK_TYPE_LABELS: Record<string, string> = {
  assignment: "Assignment",
  homework: "Homework",
  exam: "Exam",
  project: "Project",
  reading: "Reading",
  other: "Other",
};

export interface SyncOutcome {
  label: string;
  detail: string;
  tone: "success" | "warning" | "danger";
}

/** What a finished sync did: for the sidebar status, the Sync button and the toast. */
export function syncOutcome(run: { status: string; changes_detected: number; error: string | null }): SyncOutcome {
  const found = run.changes_detected === 0 ? "Nothing new" : `${plural(run.changes_detected, "change")} found`;
  if (run.status === "succeeded") return { label: "Sync finished", detail: found, tone: "success" };
  if (run.status === "partial") return { label: "Sync finished with gaps", detail: run.error ?? found, tone: "warning" };
  return { label: "Sync failed", detail: run.error ?? "Canvas could not be reached. Try again in a moment.", tone: "danger" };
}

/** Why the Today plan picked a task, as a short badge. */
export const REASON_LABELS = {
  overdue: { label: "Overdue", tone: "danger" },
  due_today: { label: "Due today", tone: "warning" },
  low_slack: { label: "Running out of time", tone: "warning" },
  quick_finish: { label: "Quick finish", tone: "success" },
  started: { label: "Started early", tone: "accent" },
  get_ahead: { label: "Get ahead", tone: "accent" },
} as const;
