// Weekly study availability and date overrides (mounted at /api/calendar/availability).
// With any weekly rule saved, Today plans inside these intervals instead of the single study window.
import { Router } from "express";
import { DateTime } from "luxon";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import { clockOf, minuteOf } from "../calendar/capacity.js";
import { dateOf, intervalsOf } from "../calendar/events.js";
import type { Db } from "../db.js";
import { FieldError, HttpError } from "../http/errors.js";

/** Seven days with a handful of intervals each is plenty. */
const MAX_RULES = 70;
const MAX_INTERVALS = 12;
const MAX_OVERRIDES = 400;

const clock = z
  .string({ error: "Use a time like 09:00." })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 09:00.");

const ruleInput = z
  .object({
    weekday: z.number({ error: "Choose a weekday." }).int().min(0, "Choose a weekday.").max(6, "Choose a weekday."),
    start_local_time: clock,
    end_local_time: clock,
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine((rule) => rule.end_local_time > rule.start_local_time, { message: "End after the start time.", path: ["end_local_time"] });

const rulesInput = z.array(ruleInput, { error: "Send a list of intervals." }).max(MAX_RULES, `Use at most ${MAX_RULES} intervals.`);

const intervalInput = z
  .object({ start: clock, end: clock })
  .strict()
  .refine((interval) => interval.end > interval.start, { message: "End after the start time.", path: ["end"] });

const overrideInput = z
  .object({
    date: z.string({ error: "Choose a date." }),
    available_intervals: z.array(intervalInput).max(MAX_INTERVALS, `Use at most ${MAX_INTERVALS} intervals.`).default([]),
  })
  .strict();

const overrideNotFound = () => new HttpError(404, "OVERRIDE_NOT_FOUND", "There is no override for that date.");

/** A real "YYYY-MM-DD" date from the path, or a 404. */
function dayParam(value: string | undefined): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !DateTime.fromISO(value, { zone: "UTC" }).isValid) throw overrideNotFound();
  return value;
}

function presentRule(rule: { id: number; weekday: number; startMinute: number; endMinute: number; enabled: boolean }) {
  return {
    id: rule.id,
    weekday: rule.weekday,
    start_local_time: clockOf(rule.startMinute),
    end_local_time: clockOf(rule.endMinute),
    enabled: rule.enabled,
  };
}

function presentOverride(row: { id: number; date: Date; intervals: unknown }) {
  return {
    id: row.id,
    date: dateOf(row.date),
    available_intervals: intervalsOf(row.intervals).map((interval) => ({
      start: clockOf(interval.startMinute),
      end: clockOf(interval.endMinute),
    })),
  };
}

/** Overlapping intervals would count the same time twice. */
function overlapping(intervals: { start: string; end: string }[]): boolean {
  const sorted = [...intervals].sort((a, b) => a.start.localeCompare(b.start));
  return sorted.some((interval, index) => index > 0 && interval.start < (sorted[index - 1]?.end ?? ""));
}

export function availabilityRouter(db: Db): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const rules = await db.studyAvailabilityRule.findMany({ where: { userId }, orderBy: [{ weekday: "asc" }, { startMinute: "asc" }, { id: "asc" }] });
    res.json(rules.map(presentRule));
  });

  /** Replaces every weekly rule at once; an empty list goes back to the single study window. */
  router.put("/", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const rules = rulesInput.parse(req.body);
    for (let weekday = 0; weekday < 7; weekday++) {
      const day = rules.filter((rule) => rule.weekday === weekday && rule.enabled);
      if (overlapping(day.map((rule) => ({ start: rule.start_local_time, end: rule.end_local_time })))) {
        throw new FieldError("weekday", "Two intervals on the same day overlap. Merge them into one.");
      }
    }
    const saved = await db.$transaction(async (tx) => {
      await tx.studyAvailabilityRule.deleteMany({ where: { userId } });
      await tx.studyAvailabilityRule.createMany({
        data: rules.map((rule) => ({
          userId,
          weekday: rule.weekday,
          startMinute: minuteOf(rule.start_local_time),
          endMinute: minuteOf(rule.end_local_time),
          enabled: rule.enabled,
        })),
      });
      return tx.studyAvailabilityRule.findMany({ where: { userId }, orderBy: [{ weekday: "asc" }, { startMinute: "asc" }, { id: "asc" }] });
    });
    res.json(saved.map(presentRule));
  });

  router.get("/overrides", async (_req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const rows = await db.studyAvailabilityOverride.findMany({ where: { userId }, orderBy: { date: "asc" }, take: MAX_OVERRIDES });
    res.json(rows.map(presentOverride));
  });

  /** Sets one date's intervals; an empty list means not available that day. */
  router.put("/overrides/:date", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const day = dayParam(req.params.date);
    const body = overrideInput.parse(req.body ?? {});
    if (body.date !== day) throw new FieldError("date", "The date in the body must match the address.");
    if (overlapping(body.available_intervals)) throw new FieldError("available_intervals", "Two intervals overlap. Merge them into one.");
    const date = new Date(`${day}T00:00:00.000Z`);
    const existing = await db.studyAvailabilityOverride.findUnique({ where: { userId_date: { userId, date } } });
    if (!existing && (await db.studyAvailabilityOverride.count({ where: { userId } })) >= MAX_OVERRIDES) {
      throw new HttpError(409, "TOO_MANY_OVERRIDES", `You can keep up to ${MAX_OVERRIDES} date overrides. Remove old ones first.`);
    }
    const intervals = body.available_intervals.map(({ start, end }) => ({ start, end }));
    const row = await db.studyAvailabilityOverride.upsert({
      where: { userId_date: { userId, date } },
      create: { userId, date, intervals },
      update: { intervals },
    });
    res.json(presentOverride(row));
  });

  router.delete("/overrides/:date", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const day = dayParam(req.params.date);
    await db.studyAvailabilityOverride.deleteMany({ where: { userId, date: new Date(`${day}T00:00:00.000Z`) } });
    res.status(204).end();
  });

  return router;
}
