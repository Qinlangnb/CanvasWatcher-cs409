// Dates, sizes and labels as students read them. Every function takes `now` so tests can pin time.

const DAY = 24 * 60 * 60_000;

// The interface is written in English, so dates are too; times still use the browser's time zone.
const LOCALE = "en-US";
const time = new Intl.DateTimeFormat(LOCALE, { hour: "numeric", minute: "2-digit" });
const weekdayDate = new Intl.DateTimeFormat(LOCALE, { weekday: "short", month: "short", day: "numeric" });
const longDate = new Intl.DateTimeFormat(LOCALE, { weekday: "long", month: "long", day: "numeric" });
const shortDate = new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric" });
const fullDate = new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric", year: "numeric" });
const dateTime = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short" });
const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole calendar days from today to `date` in local time: 0 today, 1 tomorrow, -1 yesterday. */
export function dayOffset(date: Date, now = new Date()): number {
  return Math.round((startOfDay(date) - startOfDay(now)) / DAY);
}

/** "Today, 11:59 PM", "Tomorrow, 9:00 AM", "Fri, Nov 7, 11:59 PM" or "No due date". */
export function formatDue(iso: string | null, now = new Date()): string {
  if (!iso) return "No due date";
  const date = new Date(iso);
  const offset = dayOffset(date, now);
  if (offset === 0) return `Today, ${time.format(date)}`;
  if (offset === 1) return `Tomorrow, ${time.format(date)}`;
  if (offset === -1) return `Yesterday, ${time.format(date)}`;
  const day = date.getFullYear() === now.getFullYear() ? weekdayDate.format(date) : fullDate.format(date);
  return `${day}, ${time.format(date)}`;
}

/** Short urgency hint shown next to a due date. */
export function dueHint(iso: string | null, now = new Date()): { label: string; tone: "danger" | "warning" | "neutral" } | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (date < now) {
    const days = -dayOffset(date, now);
    return { label: days <= 0 ? "Overdue" : `Overdue by ${days} day${days === 1 ? "" : "s"}`, tone: "danger" };
  }
  const offset = dayOffset(date, now);
  if (offset === 0) return { label: "Due today", tone: "warning" };
  if (offset === 1) return { label: "Due tomorrow", tone: "warning" };
  if (offset < 7) return { label: `In ${offset} days`, tone: "neutral" };
  return null;
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
export function formatLongDate(date: Date): string {
  return longDate.format(date);
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
};
