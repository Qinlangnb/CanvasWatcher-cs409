// Small pure helpers for timers, task links, priorities and file types. No imports, so the tests can
// load this file on its own.

/** The page a task card opens: the server validates it, and this checks again before opening. */
export function taskTarget(task: { source_url?: string | null }): string | null {
  const value = task.source_url?.trim();
  if (!value || /[\x00-\x1f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return value;
  } catch {
    return null;
  }
}

/** Clicks on these do their own thing; the card around them doesn't open the task. */
export const CONTROL_SELECTOR =
  'a,button,input,label,select,textarea,summary,details,dialog,[role="button"],[role="slider"],[role="menu"],[contenteditable="true"],[data-task-control]';

/** How far a pointer may move before a press counts as a drag, not a click. */
export const DRAG_THRESHOLD_PX = 6;

/** "0:04:09", "1:20:00". */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** Seconds a timer has run at `nowMs`. */
export function elapsedSince(startedAt: string | null, nowMs: number): number {
  if (!startedAt) return 0;
  return Math.max(0, Math.floor((nowMs - Date.parse(startedAt)) / 1000));
}

export const PRIORITY_TONES = {
  Critical: "danger",
  High: "warning",
  Medium: "accent",
  Low: "neutral",
} as const;

export const FILE_TYPES = ["lecture", "homework", "discussion", "reading", "exam", "solution", "other"] as const;

export const FILE_TYPE_LABELS: Record<string, string> = {
  lecture: "Lecture",
  homework: "Homework",
  discussion: "Discussion",
  reading: "Reading",
  exam: "Exam",
  solution: "Solution",
  other: "Other",
};

export const DATE_ONLY_NOTE = "Time not specified by source";

/** A due label without its time: "Today, 11:59 PM" → "Today", "Fri, Nov 7, 11:59 PM" → "Fri, Nov 7". */
export function withoutTime(label: string): string {
  return label.replace(/, [^,]*\d:\d\d[^,]*$/, "");
}

/** The heartbeat's message after `failures` failed tries in a row, or null while quiet. */
export function connectionMessage(failures: number, warned: boolean): "lost" | "restored" | null {
  if (failures >= 3 && !warned) return "lost";
  if (failures === 0 && warned) return "restored";
  return null;
}
