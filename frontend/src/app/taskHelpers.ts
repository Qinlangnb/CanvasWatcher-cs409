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

export interface ProgressSaveResult {
  applied: boolean;
  /** The task's revision after this request, applied or not. */
  state_revision: number;
  /** The saved progress after this request. */
  progress: number;
}

/**
 * One progress control's saves, one request at a time. Each request carries the revision the last
 * answer returned (the earlier TodayView's revision ref), so quick successive commits (a held arrow
 * key, keyup then blur) don't refuse each other; a value changed while a save runs is saved right
 * after it. Only a refused save (`applied: false`) is a real conflict: the control then takes the
 * saved value. A failed request stops the run; the next commit tries again.
 */
export function progressSaver(options: {
  progress: number;
  revision: number;
  send: (progress: number, expectedRevision: number) => Promise<ProgressSaveResult>;
  onResult?: (result: ProgressSaveResult, target: number) => void;
  onError?: (error: unknown, target: number) => void;
}) {
  let saved = { progress: options.progress, revision: options.revision };
  let latest = options.progress;
  let busy = false;
  let current: Promise<void> = Promise.resolve();
  const run = async () => {
    busy = true;
    try {
      while (latest !== saved.progress) {
        const target = latest;
        let result: ProgressSaveResult;
        try {
          result = await options.send(target, saved.revision);
        } catch (error) {
          options.onError?.(error, target);
          return;
        }
        if (result.state_revision >= saved.revision) saved = { progress: result.progress, revision: result.state_revision };
        options.onResult?.(result, target);
        if (!result.applied) {
          latest = saved.progress;
          return;
        }
      }
    } finally {
      busy = false;
    }
  };
  return {
    /** Saves `value` after any save already running. */
    commit(value: number): Promise<void> {
      latest = value;
      if (!busy) current = run();
      return current;
    },
    /** The task as last fetched; a fetch older than the last answer is ignored (returns false). */
    sync(progress: number, revision: number): boolean {
      if (revision < saved.revision) return false;
      saved = { progress, revision };
      if (!busy) latest = progress;
      return true;
    },
    get busy() {
      return busy;
    },
    get saved() {
      return saved;
    },
  };
}
