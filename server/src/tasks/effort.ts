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
}

export function totalMinutes(task: EffortInput): number {
  return task.estimatedMinutes ?? defaultMinutes(task.taskType);
}

/** Work left, rounded to 5 minutes; anything left at all is at least 5 minutes. */
export function remainingMinutes(task: EffortInput): number {
  const progress = Math.min(100, Math.max(0, task.progress));
  const left = totalMinutes(task) * (1 - progress / 100);
  if (left <= 0) return 0;
  return Math.max(5, Math.round(left / 5) * 5);
}
