import { Router } from "express";
import { DateTime } from "luxon";
import { currentAuth } from "../auth/middleware.js";
import { dateOf, eventsBetween, presentEvent } from "../calendar/events.js";
import type { Db } from "../db.js";
import { remainingMinutes } from "../tasks/effort.js";
import { HORIZON_DAYS, OVERDUE_LOOKBACK_DAYS, buildPlan } from "../today/plan.js";
import { openTaskWhere, presentTask, taskInclude } from "./present.js";
import { getSettings } from "./settings.js";

const DAY_MS = 86_400_000;
/** "Due next week" runs from now through the end of the 7th local day after today. */
export const UPCOMING_DAYS = 7;

export function todayRouter(db: Db): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const settings = await getSettings(db, userId);
    const now = new Date();
    const today = DateTime.fromJSDate(now, { zone: settings.timeZone }).startOf("day");
    const dayStart = today.toJSDate();
    const dayEnd = today.plus({ days: 1 }).toJSDate();
    const activeCourse = { course: { archivedAt: null } };

    const [tasks, doneToday, events] = await Promise.all([
      db.task.findMany({
        where: {
          userId,
          ...activeCourse,
          ...openTaskWhere,
          AND: [{ OR: [{ dueAt: null }, { dueAt: { gte: new Date(now.getTime() - OVERDUE_LOOKBACK_DAYS * DAY_MS) } }] }],
        },
        include: taskInclude,
        take: 1000,
      }),
      db.task.findMany({
        where: {
          userId,
          ...activeCourse,
          removedAt: null,
          OR: [
            { completedAt: { gte: dayStart, lt: dayEnd } },
            { completedAt: null, submittedAt: { gte: dayStart, lt: dayEnd } },
          ],
        },
        include: taskInclude,
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 100,
      }),
      eventsBetween(db, userId, dayStart, today.plus({ days: HORIZON_DAYS + 1 }).toJSDate(), settings.timeZone),
    ]);

    const plan = buildPlan({
      now,
      settings,
      tasks,
      busy: events.filter((event) => event.busy && !event.allDay).map((event) => ({ start: event.startAt, end: event.endAt })),
    });
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const planned = new Map(plan.items.map((item) => [item.taskId, item]));
    const upcomingEnd = today.plus({ days: UPCOMING_DAYS + 1 }).toJSDate();
    const upcoming = tasks
      .filter((task) => task.dueAt !== null && task.dueAt >= now && task.dueAt < upcomingEnd)
      .sort((a, b) => (a.dueAt as Date).getTime() - (b.dueAt as Date).getTime() || a.id - b.id);
    const date = plan.date;
    const todaysEvents = events.filter((event) =>
      event.allDay
        ? dateOf(event.startAt) <= date && dateOf(event.endAt) > date
        : event.startAt < dayEnd && (event.endAt > dayStart || event.startAt >= dayStart),
    );

    res.json({
      date,
      time_zone: settings.timeZone,
      study_window: { start: plan.studyWindow.start.toISOString(), end: plan.studyWindow.end.toISOString() },
      goal_minutes: plan.goalMinutes,
      free_minutes: plan.freeMinutes,
      capacity_minutes: plan.capacityMinutes,
      planned_minutes: plan.plannedMinutes,
      due_today_minutes: plan.dueTodayMinutes,
      items: plan.items.map((item) => ({
        task: presentTask(byId.get(item.taskId) as (typeof tasks)[number], now),
        score: item.score,
        remaining_minutes: item.remainingMinutes,
        planned_minutes: item.plannedMinutes,
        slack_minutes: item.slackMinutes,
        reasons: item.reasons,
      })),
      // Open work due soon, planned or not, so the student can start on it before the plan gets there.
      upcoming: upcoming.map((task) => {
        const item = planned.get(task.id);
        return {
          task: presentTask(task, now),
          remaining_minutes: item?.remainingMinutes ?? remainingMinutes(task),
          planned_minutes: item?.plannedMinutes ?? 0,
          reasons: item?.reasons ?? [],
        };
      }),
      upcoming_through: new Date(upcomingEnd.getTime() - 1).toISOString(),
      done_today: doneToday.map((task) => presentTask(task, now)),
      events: todaysEvents.map(presentEvent),
    });
  });

  return router;
}
