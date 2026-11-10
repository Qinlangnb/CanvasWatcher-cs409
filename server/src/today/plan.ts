// Today's plan: which open tasks to work on today, in what order, and for how long.
// Pure: everything it needs is passed in, so the rules can be tested without a database.
//
// Each task gets a score from four factors (weights sum to 1):
//   urgency           how close the due date is (overdue 1, due today 0.96, then decays over ~3 days)
//   importance        points possible / 100, 0.4 when Canvas gives none
//   schedule pressure how little free study time is left before the due date, after the work left
//   quick finish      30 minutes or less left on something due within a week
// A task makes the plan when it is overdue (by up to a week), due today, short on slack, a quick
// finish, or the student started it today ahead of the plan. Today's study capacity is then handed
// out in score order; capacity left over goes to the next tasks due within two weeks ("get ahead").
import { DateTime } from "luxon";
import type { PlanSettings } from "../routes/settings.js";
import { remainingMinutes } from "../tasks/effort.js";

export const WEIGHTS = { urgency: 0.38, importance: 0.24, pressure: 0.3, quickFinish: 0.08 } as const;
export const HORIZON_DAYS = 14;
export const OVERDUE_LOOKBACK_DAYS = 7;
const MINUTE = 60_000;
const DAY_MINUTES = 1440;

export type Reason = "overdue" | "due_today" | "low_slack" | "quick_finish" | "started" | "get_ahead";

export interface PlanTask {
  id: number;
  taskType: string;
  dueAt: Date | null;
  pointsPossible: number | null;
  progress: number;
  estimatedMinutes: number | null;
  /** Local date the student started the task ahead of the plan, if any. */
  startedOn?: string | null;
}

export interface Interval {
  start: Date;
  end: Date;
}

export interface PlanInput {
  now: Date;
  settings: PlanSettings;
  /** Open tasks only: not done, ignored or removed. */
  tasks: PlanTask[];
  /** Busy calendar time from the start of today to at least the planning horizon. */
  busy: Interval[];
}

export interface PlanItem {
  taskId: number;
  score: number;
  remainingMinutes: number;
  /** Minutes of today's capacity given to this task; 0 when it doesn't fit today. */
  plannedMinutes: number;
  /** Free study minutes before the due date minus the work left; null without a due date. */
  slackMinutes: number | null;
  reasons: Reason[];
}

export interface Plan {
  /** Today's local date, YYYY-MM-DD. */
  date: string;
  dayStart: Date;
  dayEnd: Date;
  studyWindow: Interval;
  goalMinutes: number;
  /** Study-window minutes still free today: after now, outside busy events. */
  freeMinutes: number;
  /** What today's plan hands out: the daily goal, or less when less time is free. */
  capacityMinutes: number;
  plannedMinutes: number;
  /** Work left on tasks that are overdue or due today. */
  dueTodayMinutes: number;
  items: PlanItem[];
}

type Span = [number, number];

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Wall-clock time on a local day; minute 1440 is the next midnight. DST-safe. */
function atMinute(day: DateTime, minute: number): DateTime {
  if (minute >= DAY_MINUTES) return day.plus({ days: 1 }).startOf("day");
  return day.set({ hour: Math.floor(minute / 60), minute: minute % 60, second: 0, millisecond: 0 });
}

function merge(intervals: Interval[]): Span[] {
  const spans = intervals
    .map((interval): Span => [interval.start.getTime(), interval.end.getTime()])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

/** The parts of [start, end) not covered by any busy span. */
function freeSpans(start: number, end: number, busy: Span[]): Span[] {
  const free: Span[] = [];
  let cursor = start;
  for (const [busyStart, busyEnd] of busy) {
    if (busyEnd <= cursor) continue;
    if (busyStart >= end) break;
    if (busyStart > cursor) free.push([cursor, busyStart]);
    cursor = Math.max(cursor, busyEnd);
    if (cursor >= end) break;
  }
  if (cursor < end) free.push([cursor, end]);
  return free;
}

function minutesBefore(spans: Span[], limit: number): number {
  let total = 0;
  for (const [start, end] of spans) total += Math.max(0, Math.min(end, limit) - start);
  return total / MINUTE;
}

export function buildPlan({ now, settings, tasks, busy }: PlanInput): Plan {
  const nowMs = now.getTime();
  const today = DateTime.fromJSDate(now, { zone: settings.timeZone }).startOf("day");
  const todayDate = today.toISODate() as string;
  const dayEnd = today.plus({ days: 1 }).startOf("day");
  const daily = settings.dailyStudyMinutes;
  const busySpans = merge(busy);

  // Free study time for each of the next HORIZON_DAYS days, starting now.
  const days = Array.from({ length: HORIZON_DAYS }, (_, index) => {
    const day = today.plus({ days: index });
    const start = Math.max(nowMs, atMinute(day, settings.studyStartMinute).toMillis());
    const end = atMinute(day, settings.studyEndMinute).toMillis();
    return { start, free: end > start ? freeSpans(start, end, busySpans) : [] };
  });
  const horizonEnd = today.plus({ days: HORIZON_DAYS }).toMillis();

  /** Study minutes available from now until `deadline`, each day capped at the daily goal. */
  const availableUntil = (deadline: number): number => {
    let total = 0;
    for (const day of days) {
      if (day.start >= deadline) break;
      total += Math.min(daily, minutesBefore(day.free, deadline));
    }
    if (deadline > horizonEnd) total += Math.floor((deadline - horizonEnd) / (DAY_MINUTES * MINUTE)) * daily;
    return total;
  };

  const freeMinutes = Math.round(minutesBefore(days[0]?.free ?? [], Number.POSITIVE_INFINITY));
  const capacityMinutes = Math.min(daily, freeMinutes);
  const lookback = nowMs - OVERDUE_LOOKBACK_DAYS * DAY_MINUTES * MINUTE;
  const aheadLimit = nowMs + HORIZON_DAYS * DAY_MINUTES * MINUTE;

  const scored = tasks.flatMap((task) => {
    const remaining = remainingMinutes(task);
    if (remaining <= 0) return [];
    const due = task.dueAt?.getTime() ?? null;
    if (due !== null && due < lookback) return [];
    const minutesUntil = due === null ? null : (due - nowMs) / MINUTE;
    const overdue = due !== null && due < nowMs;
    const dueToday = due !== null && !overdue && due < dayEnd.toMillis();
    const slack = due === null ? null : overdue ? -remaining : Math.round(availableUntil(due) - remaining);
    const quickFinish = !overdue && remaining <= 30 && minutesUntil !== null && minutesUntil <= 7 * DAY_MINUTES;
    const urgency = overdue ? 1 : dueToday ? 0.96 : minutesUntil === null ? 0 : clamp(Math.exp(-minutesUntil / (3 * DAY_MINUTES)));
    const importance = clamp((task.pointsPossible ?? 40) / 100);
    const pressure = slack === null ? 0.2 : slack <= 0 ? 1 : clamp(1 - slack / (2 * daily));
    const score =
      Math.round(
        (WEIGHTS.urgency * urgency +
          WEIGHTS.importance * importance +
          WEIGHTS.pressure * pressure +
          WEIGHTS.quickFinish * (quickFinish ? 1 : 0)) *
          10_000,
      ) / 10_000;
    const reasons: Reason[] = [];
    if (overdue) reasons.push("overdue");
    else if (dueToday) reasons.push("due_today");
    else if (slack !== null && slack <= daily) reasons.push("low_slack");
    if (quickFinish) reasons.push("quick_finish");
    if (task.startedOn === todayDate) reasons.push("started");
    return [{ task, due, remaining, slack, score, reasons }];
  });

  const byPriority = (a: (typeof scored)[number], b: (typeof scored)[number]) =>
    b.score - a.score || (a.due ?? Infinity) - (b.due ?? Infinity) || a.task.id - b.task.id;

  let left = capacityMinutes;
  const items: PlanItem[] = [];
  const add = (entry: (typeof scored)[number], reasons: Reason[]) => {
    const planned = Math.min(entry.remaining, left);
    left -= planned;
    items.push({
      taskId: entry.task.id,
      score: entry.score,
      remainingMinutes: entry.remaining,
      plannedMinutes: planned,
      slackMinutes: entry.slack,
      reasons,
    });
  };

  for (const entry of scored.filter((entry) => entry.reasons.length).sort(byPriority)) add(entry, entry.reasons);
  const ahead = scored.filter((entry) => !entry.reasons.length && entry.due !== null && entry.due <= aheadLimit).sort(byPriority);
  for (const entry of ahead) {
    if (left <= 0) break;
    add(entry, ["get_ahead"]);
  }

  const dueTodayMinutes = items
    .filter((item) => item.reasons.includes("overdue") || item.reasons.includes("due_today"))
    .reduce((sum, item) => sum + item.remainingMinutes, 0);

  return {
    date: todayDate,
    dayStart: today.toJSDate(),
    dayEnd: dayEnd.toJSDate(),
    studyWindow: {
      start: atMinute(today, settings.studyStartMinute).toJSDate(),
      end: atMinute(today, settings.studyEndMinute).toJSDate(),
    },
    goalMinutes: daily,
    freeMinutes,
    capacityMinutes,
    plannedMinutes: capacityMinutes - left,
    dueTodayMinutes,
    items,
  };
}
