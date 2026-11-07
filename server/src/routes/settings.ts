import { Router } from "express";
import { IANAZone } from "luxon";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";
import { FieldError } from "../http/errors.js";

export interface PlanSettings {
  timeZone: string;
  dailyStudyMinutes: number;
  studyStartMinute: number;
  studyEndMinute: number;
}

export const DEFAULT_SETTINGS: PlanSettings = {
  timeZone: "America/Chicago",
  dailyStudyMinutes: 180,
  studyStartMinute: 9 * 60,
  studyEndMinute: 22 * 60,
};

/** The user's settings, or the defaults when they never saved any. Reading never writes. */
export async function getSettings(db: Db, userId: string): Promise<PlanSettings> {
  const row = await db.userSettings.findUnique({ where: { userId } });
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    timeZone: IANAZone.isValidZone(row.timeZone) ? row.timeZone : DEFAULT_SETTINGS.timeZone,
    dailyStudyMinutes: row.dailyStudyMinutes,
    studyStartMinute: row.studyStartMinute,
    studyEndMinute: row.studyEndMinute,
  };
}

export function presentSettings(settings: PlanSettings) {
  return {
    time_zone: settings.timeZone,
    daily_study_minutes: settings.dailyStudyMinutes,
    study_start_minute: settings.studyStartMinute,
    study_end_minute: settings.studyEndMinute,
  };
}

const minuteOfDay = (max: number) =>
  z
    .number({ error: "Send a whole number of minutes." })
    .int("Send a whole number of minutes.")
    .min(0, "Use a time of day.")
    .max(max, "Use a time of day.");

const changes = z
  .object({
    time_zone: z.string().trim().max(64).refine((zone) => IANAZone.isValidZone(zone), "Choose a time zone from the list."),
    daily_study_minutes: z
      .number({ error: "Send a whole number of minutes." })
      .int("Send a whole number of minutes.")
      .min(15, "Plan at least 15 minutes a day.")
      .max(16 * 60, "Plan at most 16 hours a day."),
    study_start_minute: minuteOfDay(24 * 60 - 15),
    study_end_minute: minuteOfDay(24 * 60),
  })
  .partial()
  .strict();

export function settingsRouter(db: Db): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    res.json(presentSettings(await getSettings(db, currentAuth(res.locals).user.id)));
  });

  router.patch("/", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const body = changes.parse(req.body ?? {});
    const current = await getSettings(db, userId);
    const next: PlanSettings = {
      timeZone: body.time_zone ?? current.timeZone,
      dailyStudyMinutes: body.daily_study_minutes ?? current.dailyStudyMinutes,
      studyStartMinute: body.study_start_minute ?? current.studyStartMinute,
      studyEndMinute: body.study_end_minute ?? current.studyEndMinute,
    };
    if (next.studyEndMinute - next.studyStartMinute < 15) {
      throw new FieldError("study_end_minute", "End the study window at least 15 minutes after it starts.");
    }
    await db.userSettings.upsert({ where: { userId }, create: { userId, ...next }, update: next });
    res.json(presentSettings(next));
  });

  return router;
}
