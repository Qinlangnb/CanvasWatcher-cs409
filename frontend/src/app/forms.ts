// The pure side of the task and event forms: defaults, drafts, validation and the API bodies.
// Kept free of React so tests can load it directly.
import { ApiError } from "./api";
import type { CalendarEvent, EventFields, Task, TaskChanges, TaskType } from "./types";
import { addDays, fromLocalInput, localDate, toLocalInput } from "./zoned";

/** Field messages from a 422, plus one sentence for anything else. */
export function problemsOf(error: Error | null): { fields: Record<string, string>; general: string | null } {
  if (!error) return { fields: {}, general: null };
  const fields = error instanceof ApiError ? error.fields : {};
  return { fields, general: Object.keys(fields).length > 0 ? null : error.message };
}

// --- Tasks ---

export const TASK_TYPES: TaskType[] = ["assignment", "homework", "exam", "project", "reading", "other"];

/** The server's estimates when the student gives none (server/src/tasks/effort.ts). */
const DEFAULT_MINUTES: Record<string, number> = { assignment: 120, homework: 120, exam: 180, project: 240, reading: 45, other: 60 };
const SUBMITTED_STATES = ["submitted", "graded", "pending_review"];

/** Handed in on Canvas: done whatever the checkbox says, so the checkbox is locked. */
export const isSubmitted = (task: Task) => task.source === "canvas" && SUBMITTED_STATES.includes(task.submission_state ?? "");

export function defaultMinutes(type: string): number {
  return DEFAULT_MINUTES[type] ?? DEFAULT_MINUTES.other ?? 60;
}

/** Work left at `progress` percent of `total` minutes, rounded like the server: to 5, at least 5 until done. */
export function remainingOf(total: number, progress: number): number {
  if (progress >= 100) return 0;
  return Math.max(5, Math.round((total * (100 - progress)) / 100 / 5) * 5);
}

/** Whole minutes from a form field: null when empty, an error when out of the server's range. */
export function parseEstimate(value: string): { minutes: number | null; error?: string } {
  const text = value.trim();
  if (!text) return { minutes: null };
  const minutes = Number(text);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 6000) {
    return { minutes: null, error: "Enter whole minutes from 5 to 6000, or leave it empty for the default." };
  }
  return { minutes };
}

export type TaskStatus = "open" | "done" | "ignored";

export interface TaskDraft {
  title: string;
  type: string;
  due: string;
  status: TaskStatus;
  progress: number;
  estimate: string;
  notes: string;
}

export function taskDraft(task: Task, zone: string): TaskDraft {
  return {
    title: task.title,
    type: task.type,
    due: toLocalInput(task.due_at, zone),
    status: task.completed_at ? "done" : task.ignored_at ? "ignored" : "open",
    progress: task.progress,
    estimate: task.estimated_minutes?.toString() ?? "",
    notes: task.notes ?? "",
  };
}

/** Only what the student changed, so a save never touches fields Canvas owns. */
export function taskChanges(task: Task, initial: TaskDraft, draft: TaskDraft, zone: string): { changes: TaskChanges; errors: Record<string, string> } {
  const changes: TaskChanges = {};
  const errors: Record<string, string> = {};
  if (draft.status !== initial.status) {
    changes.done = draft.status === "done";
    changes.ignored = draft.status === "ignored";
  }
  if (draft.progress !== initial.progress) changes.progress = draft.progress;
  if (draft.estimate.trim() !== initial.estimate) {
    const estimate = parseEstimate(draft.estimate);
    if (estimate.error) errors.estimated_minutes = estimate.error;
    else changes.estimated_minutes = estimate.minutes;
  }
  if (draft.notes.trim() !== initial.notes.trim()) changes.notes = draft.notes.trim() || null;
  if (task.source === "personal") {
    if (draft.title.trim() !== initial.title) {
      if (!draft.title.trim()) errors.title = "Give the task a title.";
      else changes.title = draft.title.trim();
    }
    if (draft.type !== initial.type) changes.type = draft.type as TaskType;
    if (draft.due !== initial.due) {
      const due = fromLocalInput(draft.due, zone);
      if (draft.due && !due) errors.due_at = "Enter a valid date and time.";
      else changes.due_at = due;
    }
  }
  return { changes, errors };
}

// --- Events ---

/** Below the server's 1.5 MB limit, leaving room for the JSON escaping of line breaks. */
export const MAX_ICS_BYTES = 1_400_000;

export interface EventDraft {
  title: string;
  location: string;
  allDay: boolean;
  /** "YYYY-MM-DD" when all day, otherwise a datetime-local value. */
  start: string;
  /** All day: the last day, inclusive (the API's end is the day after). */
  end: string;
  busy: boolean;
}

export function eventDraft(event: CalendarEvent | undefined, date: string, zone: string, now: Date): EventDraft {
  if (event) {
    return event.all_day
      ? { title: event.title, location: event.location ?? "", allDay: true, start: event.start, end: addDays(event.end, -1), busy: event.busy }
      : {
          title: event.title,
          location: event.location ?? "",
          allDay: false,
          start: toLocalInput(event.start, zone),
          end: toLocalInput(event.end, zone),
          busy: event.busy,
        };
  }
  // Today: the next whole hour. Another day: 9 AM.
  const hour = date === localDate(now, zone) ? Math.min(23, Number(toLocalInput(now.toISOString(), zone).slice(11, 13)) + 1) : 9;
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    title: "",
    location: "",
    allDay: false,
    start: `${date}T${pad(hour)}:00`,
    end: hour < 23 ? `${date}T${pad(hour + 1)}:00` : `${date}T23:59`,
    busy: true,
  };
}

/** The API body for a draft, or the fields to fix first. */
export function eventBody(draft: EventDraft, zone: string): { body?: EventFields; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!draft.title.trim()) errors.title = "Give the event a title.";
  let start: string | null;
  let end: string | null;
  if (draft.allDay) {
    start = /^\d{4}-\d{2}-\d{2}$/.test(draft.start) ? draft.start : null;
    end = /^\d{4}-\d{2}-\d{2}$/.test(draft.end) ? addDays(draft.end, 1) : null;
    if (!start) errors.start = "Choose the first day.";
    if (!end) errors.end = "Choose the last day.";
    else if (start && end <= start) errors.end = "The last day can't be before the first.";
  } else {
    start = fromLocalInput(draft.start, zone);
    end = fromLocalInput(draft.end, zone);
    if (!start) errors.start = "Enter when it starts.";
    if (!end) errors.end = "Enter when it ends.";
    else if (start && Date.parse(end) <= Date.parse(start)) errors.end = "It has to end after it starts.";
  }
  if (Object.keys(errors).length > 0 || !start || !end) return { errors };
  return {
    errors,
    body: { title: draft.title.trim(), location: draft.location.trim() || null, all_day: draft.allDay, start, end, busy: draft.busy },
  };
}
