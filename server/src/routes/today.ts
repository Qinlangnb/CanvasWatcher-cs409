import { Router } from "express";
import { DateTime } from "luxon";
import { currentAuth } from "../auth/middleware.js";
import { dateOf, eventsBetween, presentEvent } from "../calendar/events.js";
import type { Db } from "../db.js";
import { HORIZON_DAYS, OVERDUE_LOOKBACK_DAYS, buildPlan } from "../today/plan.js";
import { openTaskWhere, presentTask, taskInclude } from "./present.js";
import { getSettings } from "./settings.js";

const DAY_MS = 86_400_000;

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
      done_today: doneToday.map((task) => presentTask(task, now)),
      events: todaysEvents.map(presentEvent),
    });
  });

  return router;
}
