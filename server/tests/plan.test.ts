import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type PlanSettings } from "../src/routes/settings.js";
import { remainingMinutes } from "../src/tasks/effort.js";
import { buildPlan, type Interval, type PlanTask } from "../src/today/plan.js";

// 2026-11-06 09:00 in Chicago (CST, UTC-6; daylight time ended on 1 November).
const NOW = new Date("2026-11-06T15:00:00Z");
const HOUR = 3_600_000;

let nextId = 1;
function task(fields: Partial<PlanTask> = {}): PlanTask {
  return { id: nextId++, taskType: "homework", dueAt: null, pointsPossible: 50, progress: 0, estimatedMinutes: 60, ...fields };
}
const inHours = (hours: number) => new Date(NOW.getTime() + hours * HOUR);
const plan = (tasks: PlanTask[], options: { now?: Date; busy?: Interval[]; settings?: Partial<PlanSettings> } = {}) =>
  buildPlan({
    now: options.now ?? NOW,
    settings: { ...DEFAULT_SETTINGS, ...options.settings },
    tasks,
    busy: options.busy ?? [],
  });

describe("remaining minutes", () => {
  it("uses the student's estimate or the type default, rounded to 5 minutes", () => {
    expect(remainingMinutes({ taskType: "project", estimatedMinutes: null, progress: 0 })).toBe(240);
    expect(remainingMinutes({ taskType: "unknown", estimatedMinutes: null, progress: 0 })).toBe(60);
    expect(remainingMinutes({ taskType: "homework", estimatedMinutes: 100, progress: 33 })).toBe(65);
    expect(remainingMinutes({ taskType: "homework", estimatedMinutes: 100, progress: 99 })).toBe(5);
    expect(remainingMinutes({ taskType: "homework", estimatedMinutes: 100, progress: 100 })).toBe(0);
  });
});

describe("today's plan", () => {
  it("knows the local date, the study window and today's free time", () => {
    const result = plan([]);
    expect(result.date).toBe("2026-11-06");
    expect(result.dayStart).toEqual(new Date("2026-11-06T06:00:00Z"));
    expect(result.studyWindow).toEqual({
      start: new Date("2026-11-06T15:00:00Z"),
      end: new Date("2026-11-07T04:00:00Z"),
    });
    // 09:00-22:00 is 780 minutes; the plan hands out the daily goal of 180.
    expect(result.freeMinutes).toBe(780);
    expect(result.capacityMinutes).toBe(180);
    expect(result.items).toEqual([]);
  });

  it("subtracts busy events, merging overlaps", () => {
    const busy = [
      { start: inHours(1), end: inHours(3) },
      { start: inHours(2), end: inHours(4) },
      // Outside the study window; doesn't count.
      { start: inHours(14), end: inHours(15) },
    ];
    expect(plan([], { busy }).freeMinutes).toBe(780 - 180);
  });

  it("plans less than the goal late in the day", () => {
    const result = plan([task({ dueAt: inHours(14), estimatedMinutes: 120 })], { now: inHours(12.5) });
    expect(result.freeMinutes).toBe(30);
    expect(result.capacityMinutes).toBe(30);
    expect(result.items[0]).toMatchObject({ plannedMinutes: 30, remainingMinutes: 120, reasons: ["due_today"] });
  });

  it("keeps the study window on wall-clock time across a daylight-saving change", () => {
    // 1 November 2026: clocks fall back at 02:00, so 09:00 is UTC-6 again.
    const result = plan([], { now: new Date("2026-11-01T12:00:00Z") });
    expect(result.studyWindow.start).toEqual(new Date("2026-11-01T15:00:00Z"));
  });

  it("follows the user's time zone and study window", () => {
    const result = plan([], { settings: { timeZone: "Asia/Shanghai", studyStartMinute: 8 * 60, studyEndMinute: 24 * 60 } });
    // 15:00Z is 23:00 in Shanghai; one hour of the window is left.
    expect(result.date).toBe("2026-11-06");
    expect(result.studyWindow.end).toEqual(new Date("2026-11-06T16:00:00Z"));
    expect(result.freeMinutes).toBe(60);
  });

  it("puts overdue and due-today work first and gives each a reason", () => {
    const later = task({ dueAt: inHours(24 * 10) });
    const overdue = task({ dueAt: inHours(-30) });
    const dueToday = task({ dueAt: inHours(8) });
    const result = plan([later, dueToday, overdue]);
    expect(result.items.map((item) => [item.taskId, item.reasons])).toEqual([
      [overdue.id, ["overdue"]],
      [dueToday.id, ["due_today"]],
      [later.id, ["get_ahead"]],
    ]);
    expect(result.dueTodayMinutes).toBe(120);
    expect(result.items[0]?.slackMinutes).toBe(-60);
  });

  it("drops work overdue by more than a week and tasks with nothing left", () => {
    const result = plan([task({ dueAt: inHours(-24 * 8) }), task({ dueAt: inHours(5), progress: 100 })]);
    expect(result.items).toEqual([]);
  });

  it("flags big tasks whose free time before the due date is running out", () => {
    const big = task({ dueAt: inHours(24 * 3), estimatedMinutes: 600 });
    const small = task({ dueAt: inHours(24 * 3), estimatedMinutes: 60 });
    const result = plan([big, small]);
    // Three days of 180 minutes is less than 600: the big task takes all of today.
    expect(result.items).toEqual([expect.objectContaining({ taskId: big.id, reasons: ["low_slack"], plannedMinutes: 180 })]);
    // With room left, the small one (plenty of slack) is only "get ahead" work.
    expect(plan([small]).items).toEqual([expect.objectContaining({ taskId: small.id, reasons: ["get_ahead"] })]);
  });

  it("counts busy time against the slack before a due date", () => {
    const due = task({ dueAt: inHours(24 * 2), estimatedMinutes: 240 });
    const free = plan([due]).items[0];
    const busy = Array.from({ length: 3 }, (_, day) => ({ start: inHours(24 * day), end: inHours(24 * day + 12) }));
    const crowded = plan([due], { busy }).items[0];
    expect(crowded?.slackMinutes).toBeLessThan(free?.slackMinutes ?? 0);
    expect(crowded?.reasons).toContain("low_slack");
  });

  it("marks quick finishes due within a week", () => {
    const quick = task({ dueAt: inHours(24 * 5), estimatedMinutes: 100, progress: 80 });
    expect(plan([quick]).items[0]).toMatchObject({ remainingMinutes: 20, reasons: ["quick_finish"] });
  });

  it("splits today's capacity in priority order and lists what doesn't fit", () => {
    const a = task({ dueAt: inHours(6), estimatedMinutes: 120, pointsPossible: 100 });
    const b = task({ dueAt: inHours(7), estimatedMinutes: 120, pointsPossible: 10 });
    const c = task({ dueAt: inHours(8), estimatedMinutes: 30, pointsPossible: 0 });
    const result = plan([c, b, a]);
    expect(result.items.map((item) => [item.taskId, item.plannedMinutes])).toEqual([
      [a.id, 120],
      [b.id, 60],
      [c.id, 0],
    ]);
    expect(result.plannedMinutes).toBe(180);
    expect(result.dueTodayMinutes).toBe(270);
  });

  it("only gets ahead on dated work within two weeks while capacity is left", () => {
    const soon = task({ dueAt: inHours(24 * 6), estimatedMinutes: 150 });
    const next = task({ dueAt: inHours(24 * 8), estimatedMinutes: 150 });
    const far = task({ dueAt: inHours(24 * 20) });
    const undated = task();
    const result = plan([far, undated, next, soon]);
    expect(result.items.map((item) => [item.taskId, item.plannedMinutes])).toEqual([
      [soon.id, 150],
      [next.id, 30],
    ]);
  });

  it("plans work the student started today ahead of tasks it would only get ahead on", () => {
    const ahead = task({ dueAt: inHours(24 * 5), estimatedMinutes: 150, pointsPossible: 100 });
    const started = task({ dueAt: inHours(24 * 6), estimatedMinutes: 90, pointsPossible: 10, startedOn: "2026-11-06" });
    const yesterday = task({ dueAt: inHours(24 * 6), startedOn: "2026-11-05" });
    const result = plan([ahead, started, yesterday]);
    // Starting it yesterday doesn't count today: it waits like any other get-ahead task, and the time ran out.
    expect(result.items.map((item) => [item.taskId, item.plannedMinutes, item.reasons])).toEqual([
      [started.id, 90, ["started"]],
      [ahead.id, 90, ["get_ahead"]],
    ]);
    expect(result.items.some((item) => item.taskId === yesterday.id)).toBe(false);
    // Starting urgent work early keeps its own reasons first.
    const due = task({ dueAt: inHours(3), startedOn: "2026-11-06" });
    expect(plan([due]).items[0]?.reasons).toEqual(["due_today", "started"]);
  });
});
