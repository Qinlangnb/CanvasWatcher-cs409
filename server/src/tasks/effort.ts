// How much work a task is, and how much of it is left.

export const TASK_TYPES = ["assignment", "homework", "exam", "project", "reading", "other"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Typical total effort per task type, used until the student gives an estimate. */
export const DEFAULT_MINUTES: Record<TaskType, number> = {
  assignment: 120,
  homework: 120,
  exam: 180,
  project: 240,
  reading: 45,
  other: 60,
};

export function defaultMinutes(taskType: string): number {
  return DEFAULT_MINUTES[taskType as TaskType] ?? DEFAULT_MINUTES.other;
}

export interface EffortInput {
  taskType: string;
  estimatedMinutes: number | null;
  progress: number;
  /** Minutes the student reports having spent; 0 when they haven't said. */
  spentMinutes?: number;
  /** The AI's estimate of the total (ai/insights.ts), when one was made. */
  aiEstimate?: { minutes: number | null } | null;
}

const aiMinutes = (task: EffortInput) => task.aiEstimate?.minutes ?? null;

export function totalMinutes(task: EffortInput): number {
  return task.estimatedMinutes ?? aiMinutes(task) ?? defaultMinutes(task.taskType);
}

/**
 * Where the remaining time comes from: the pace so far (time used and progress both given), the
 * student's own estimate, the AI's estimate, or the usual time for the task type.
 */
export type RemainingBasis = "pace" | "estimate" | "ai" | "default";

export function remainingBasis(task: EffortInput): RemainingBasis {
  const progress = Math.min(100, Math.max(0, task.progress));
  if ((task.spentMinutes ?? 0) > 0 && progress > 0 && progress < 100) return "pace";
  if (task.estimatedMinutes !== null) return "estimate";
  return aiMinutes(task) !== null ? "ai" : "default";
}

/** Rounds to 5 minutes; anything left at all is at least 5 minutes. */
function roundFive(minutes: number): number {
  if (minutes <= 0) return 0;
  return Math.max(5, Math.round(minutes / 5) * 5);
}

/**
 * Work left. With time used and progress both given, the pace so far decides it: 90 minutes for
 * 30% means about 210 minutes for the other 70%. Otherwise the total estimate less the progress.
 */
export function remainingMinutes(task: EffortInput): number {
  const progress = Math.min(100, Math.max(0, task.progress));
  if (progress >= 100) return 0;
  if (remainingBasis(task) === "pace") {
    return roundFive(((task.spentMinutes ?? 0) * (100 - progress)) / progress);
  }
  return roundFive(totalMinutes(task) * (1 - progress / 100));
}
