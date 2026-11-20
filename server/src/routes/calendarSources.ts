// Imported .ics calendars (mounted at /api/calendar/sources): preview, import, re-import, remove.
// A re-import matches events by their identity in the file (UID plus occurrence), so unchanged events
// stay as they are and removals need the user's confirmation.
import { createHash } from "node:crypto";
import express, { Router } from "express";
import { DateTime, IANAZone } from "luxon";
import { z } from "zod";
import { currentAuth } from "../auth/middleware.js";
import { dateOf } from "../calendar/events.js";
import { IcsError, parseIcs, type ParsedCalendar, type ParsedEvent } from "../calendar/ics.js";
import type { Db } from "../db.js";
import type { CalendarSource } from "../generated/prisma/client.js";
import { FieldError, HttpError } from "../http/errors.js";
import { idParam } from "../http/params.js";
import { getSettings } from "./settings.js";

/** An .ics file of a full semester with recurring classes is typically well under 1 MB. */
export const ICS_BODY_LIMIT = "1.5mb";
const MAX_SOURCES = 20;
const DAY_MS = 86_400_000;
/** Imports keep events from a month back to a year ahead. */
const IMPORT_PAST_DAYS = 31;
const IMPORT_FUTURE_DAYS = 366;

const zone = z
  .string()
  .trim()
  .max(64)
  .refine((value) => IANAZone.isValidZone(value), "Use a time zone like America/Chicago.");

const fileFields = {
  file_name: z.string().trim().max(255).optional(),
  ics: z.string({ error: "Choose an .ics file." }).min(1, "Choose an .ics file."),
  /** Confirms the zone of times the file gives without one. */
  time_zone: zone.nullish(),
};

const previewInput = z.object({ ...fileFields, source_id: z.number().int().positive().nullish() }).strict();
const importInput = z.object({ ...fileFields, name: z.string().trim().max(100, "Use at most 100 characters.").optional() }).strict();
const reimportInput = z.object({ ...fileFields, confirm_removals: z.boolean().default(false) }).strict();

const sourceNotFound = () => new HttpError(404, "CALENDAR_NOT_FOUND", "That calendar could not be found.");
const json = express.json({ limit: ICS_BODY_LIMIT });

interface Reconciliation {
  new: number;
  updated: number;
  removed: number;
  unchanged: number;
}

type ExistingEvent = Pick<ParsedEvent, "title" | "location" | "description" | "startAt" | "endAt" | "allDay" | "busy"> & {
  id: number;
  externalId: string | null;
};

const sameEvent = (a: ExistingEvent, b: ParsedEvent) =>
  a.title === b.title &&
  a.location === b.location &&
  a.description === b.description &&
  a.startAt.getTime() === b.startAt.getTime() &&
  a.endAt.getTime() === b.endAt.getTime() &&
  a.allDay === b.allDay &&
  a.busy === b.busy;

/** What a re-import would change, plus the rows to delete and the events to create. */
function reconcile(existing: ExistingEvent[], incoming: ParsedEvent[]) {
  const byId = new Map(existing.filter((row) => row.externalId).map((row) => [row.externalId as string, row]));
  const incomingIds = new Set(incoming.map((event) => event.externalId));
  const counts: Reconciliation = { new: 0, updated: 0, removed: 0, unchanged: 0 };
  const deleteIds: number[] = [];
  const create: ParsedEvent[] = [];
  for (const event of incoming) {
    const row = byId.get(event.externalId);
    if (!row) {
      counts.new += 1;
      create.push(event);
    } else if (sameEvent(row, event)) counts.unchanged += 1;
    else {
      counts.updated += 1;
      deleteIds.push(row.id);
      create.push(event);
    }
  }
  // Rows from before identities were kept have none; a re-import replaces them.
  for (const row of existing) {
    if (!row.externalId || !incomingIds.has(row.externalId)) {
      counts.removed += 1;
      deleteIds.push(row.id);
    }
  }
  return { counts, deleteIds, create };
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The local date an event starts on. All-day events are stored as UTC midnights of their dates, so
 * they are read in UTC; only timed events are converted into the calendar's zone.
 */
const eventDay = (start: Date, allDay: boolean, zone: string): string =>
  allDay ? dateOf(start) : (DateTime.fromJSDate(start, { zone }).toISODate() as string);

/** The first and last of some local dates ("YYYY-MM-DD" sorts as text). */
function dateRange(days: string[]): { first: string | null; last: string | null } {
  const sorted = [...days].sort();
  return { first: sorted[0] ?? null, last: sorted.at(-1) ?? null };
}

interface SourceStats {
  count: number;
  /** Earliest and latest start of the source's events, apart for all-day and timed events. */
  starts: { start: Date; allDay: boolean }[];
}

function presentSource(source: CalendarSource, stats: SourceStats, userZone: string) {
  const zone = source.timeZone ?? userZone;
  const range = dateRange(stats.starts.map(({ start, allDay }) => eventDay(start, allDay, zone)));
  return {
    id: source.id,
    name: source.name,
    file_name: source.fileName,
    imported_at: source.importedAt.toISOString(),
    last_reimported_at: source.lastReimportedAt?.toISOString() ?? null,
    event_count: stats.count,
    recurring_series_count: source.recurringSeriesCount,
    /** The zone floating times were read in; null when every time named its own. */
    time_zone: source.timeZone,
    range_start: range.first,
    range_end: range.last,
    /** Imported events follow their file. */
    read_only: true,
  };
}

function presentPreview(input: { fileName: string | null; sha: string; parsed: ParsedCalendar; reconciliation: Reconciliation; noOp: boolean; userZone: string }) {
  const { parsed } = input;
  const zone = parsed.timeZone ?? input.userZone;
  const range = dateRange(parsed.events.map((event) => eventDay(event.startAt, event.allDay, zone)));
  return {
    file_name: input.fileName,
    file_sha256: input.sha,
    calendar_name: parsed.name,
    calendar_time_zone: parsed.timeZone,
    time_zone_confirmation_required: parsed.timeZoneConfirmationRequired,
    event_count: parsed.events.length,
    recurring_series_count: parsed.recurringSeriesCount,
    range_start: range.first,
    range_end: range.last,
    reconciliation: input.reconciliation,
    no_op: input.noOp,
    truncated: parsed.truncated,
    warnings: [
      ...(parsed.timeZoneConfirmationRequired ? ["Some times have no time zone. Confirm which zone they are in."] : []),
      ...(parsed.truncated ? ["The file has more events than one import keeps; only the first 2,000 are imported."] : []),
    ],
  };
}

export function calendarSourcesRouter(db: Db): Router {
  const router = Router();

  function parse(ics: string, userZone: string, override: string | null | undefined) {
    const now = Date.now();
    const window = { windowStart: new Date(now - IMPORT_PAST_DAYS * DAY_MS), windowEnd: new Date(now + IMPORT_FUTURE_DAYS * DAY_MS) };
    let parsed: ParsedCalendar;
    try {
      parsed = parseIcs(ics, { timeZone: userZone, override: override ?? null, ...window });
    } catch (error) {
      if (error instanceof IcsError) throw new FieldError("ics", error.message);
      throw error;
    }
    if (!parsed.events.length) throw new FieldError("ics", "This file has no events between last month and a year from now.");
    return { parsed, windowStart: window.windowStart };
  }

  async function findSource(userId: string, id: number) {
    const source = await db.calendarSource.findFirst({ where: { id, userId } });
    if (!source) throw sourceNotFound();
    return source;
  }

  /** The source's events that a re-import may change; older ones stay as history unless the file still has them. */
  const currentEvents = (sourceId: number, windowStart: Date, incoming: ParsedEvent[]): Promise<ExistingEvent[]> =>
    db.calendarEvent.findMany({
      where: { sourceId, OR: [{ endAt: { gt: windowStart } }, { externalId: { in: incoming.map((event) => event.externalId) } }] },
      select: { id: true, externalId: true, title: true, location: true, description: true, startAt: true, endAt: true, allDay: true, busy: true },
    });

  async function stats(userId: string, sourceIds: number[]) {
    const rows = await db.calendarEvent.groupBy({
      by: ["sourceId", "allDay"],
      where: { userId, sourceId: { in: sourceIds } },
      _count: { _all: true },
      _min: { startAt: true },
      _max: { startAt: true },
    });
    const byId = new Map<number | null, SourceStats>();
    for (const row of rows) {
      const entry = byId.get(row.sourceId) ?? { count: 0, starts: [] };
      entry.count += row._count._all;
      for (const start of [row._min.startAt, row._max.startAt]) if (start) entry.starts.push({ start, allDay: row.allDay });
      byId.set(row.sourceId, entry);
    }
    return (id: number): SourceStats => byId.get(id) ?? { count: 0, starts: [] };
  }

  const eventRows = (userId: string, sourceId: number, events: ParsedEvent[]) =>
    events.map((event) => ({ userId, sourceId, eventType: "busy", ...event }));

  router.get("/", async (_req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const settings = await getSettings(db, userId);
    const sources = await db.calendarSource.findMany({ where: { userId }, orderBy: [{ importedAt: "desc" }, { id: "desc" }] });
    const statsOf = await stats(userId, sources.map((source) => source.id));
    res.json(sources.map((source) => presentSource(source, statsOf(source.id), settings.timeZone)));
  });

  /** What importing (or re-importing, with source_id) this file would do. Changes nothing. */
  router.post("/preview", json, async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const body = previewInput.parse(req.body ?? {});
    const settings = await getSettings(db, userId);
    const source = body.source_id ? await findSource(userId, body.source_id) : null;
    const { parsed, windowStart } = parse(body.ics, settings.timeZone, body.time_zone ?? source?.timeZone);
    const sha = sha256(body.ics);
    let reconciliation: Reconciliation = { new: parsed.events.length, updated: 0, removed: 0, unchanged: 0 };
    let noOp = false;
    if (source) {
      reconciliation = reconcile(await currentEvents(source.id, windowStart, parsed.events), parsed.events).counts;
      noOp = source.fileSha256 === sha && source.timeZone === parsed.timeZone;
    }
    res.json(presentPreview({ fileName: body.file_name ?? null, sha, parsed, reconciliation, noOp, userZone: settings.timeZone }));
  });

  /** Imports a new calendar. Its own larger body limit is applied here, after sign-in is checked. */
  router.post("/", json, async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const body = importInput.parse(req.body ?? {});
    if ((await db.calendarSource.count({ where: { userId } })) >= MAX_SOURCES) {
      throw new HttpError(409, "TOO_MANY_CALENDARS", `You can import up to ${MAX_SOURCES} calendars. Remove one first.`);
    }
    const settings = await getSettings(db, userId);
    const { parsed } = parse(body.ics, settings.timeZone, body.time_zone);
    if (parsed.timeZoneConfirmationRequired) {
      throw new FieldError("time_zone", "Some times in this file have no time zone. Confirm which zone they are in.");
    }
    const fileStem = body.file_name?.replace(/\.ics$/i, "").trim();
    const name = body.name || parsed.name || fileStem || "Imported calendar";
    const sha = sha256(body.ics);
    const source = await db.$transaction(
      async (tx) => {
        const created = await tx.calendarSource.create({
          data: {
            userId,
            name: name.slice(0, 100),
            fileName: body.file_name || null,
            fileSha256: sha,
            timeZone: parsed.timeZone,
            recurringSeriesCount: parsed.recurringSeriesCount,
          },
        });
        await tx.calendarEvent.createMany({ data: eventRows(userId, created.id, parsed.events) });
        return created;
      },
      { timeout: 30_000 },
    );
    const statsOf = await stats(userId, [source.id]);
    const reconciliation = { new: parsed.events.length, updated: 0, removed: 0, unchanged: 0 };
    res.status(201).json({
      ...presentSource(source, statsOf(source.id), settings.timeZone),
      truncated: parsed.truncated,
      preview: presentPreview({ fileName: body.file_name ?? null, sha, parsed, reconciliation, noOp: false, userZone: settings.timeZone }),
    });
  });

  /** Brings an imported calendar up to date with a newer export of the same file. */
  router.post("/:id/reimport", json, async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const id = idParam(req.params.id, sourceNotFound());
    const body = reimportInput.parse(req.body ?? {});
    const settings = await getSettings(db, userId);
    const source = await findSource(userId, id);
    const { parsed, windowStart } = parse(body.ics, settings.timeZone, body.time_zone ?? source.timeZone);
    if (parsed.timeZoneConfirmationRequired) {
      throw new FieldError("time_zone", "Some times in this file have no time zone. Confirm which zone they are in.");
    }
    const sha = sha256(body.ics);
    const existing = await currentEvents(source.id, windowStart, parsed.events);
    const plan = reconcile(existing, parsed.events);
    const answer = async (updated: CalendarSource, counts: Reconciliation, noOp: boolean) => {
      const statsOf = await stats(userId, [updated.id]);
      res.json({
        ...presentSource(updated, statsOf(updated.id), settings.timeZone),
        truncated: parsed.truncated,
        preview: presentPreview({ fileName: body.file_name ?? null, sha, parsed, reconciliation: counts, noOp, userZone: settings.timeZone }),
      });
    };
    if (source.fileSha256 === sha && source.timeZone === parsed.timeZone) {
      await answer(source, { new: 0, updated: 0, removed: 0, unchanged: existing.length }, true);
      return;
    }
    if (plan.counts.removed > 0 && !body.confirm_removals) {
      res.status(409).json({
        detail: `This re-import removes ${plan.counts.removed} ${plan.counts.removed === 1 ? "event" : "events"}. Confirm to continue.`,
        code: "REMOVALS_NEED_CONFIRMATION",
        requires_confirmation: true,
        reconciliation: plan.counts,
      });
      return;
    }
    const [, , updated] = await db.$transaction([
      db.calendarEvent.deleteMany({ where: { userId, sourceId: source.id, id: { in: plan.deleteIds } } }),
      db.calendarEvent.createMany({ data: eventRows(userId, source.id, plan.create) }),
      db.calendarSource.update({
        where: { id: source.id },
        data: {
          fileSha256: sha,
          timeZone: parsed.timeZone,
          recurringSeriesCount: parsed.recurringSeriesCount,
          lastReimportedAt: new Date(),
          ...(body.file_name ? { fileName: body.file_name } : {}),
        },
      }),
    ]);
    await answer(updated, plan.counts, false);
  });

  router.delete("/:id", async (req, res) => {
    const userId = currentAuth(res.locals).user.id;
    const id = idParam(req.params.id, sourceNotFound());
    const { count } = await db.calendarSource.deleteMany({ where: { id, userId } });
    if (!count) throw sourceNotFound();
    res.status(204).end();
  });

  return router;
}

/** True for the requests whose body may exceed the global JSON limit: they carry a whole .ics file. */
export function isIcsUpload(method: string, path: string): boolean {
  return method === "POST" && /^\/api\/calendar\/sources(\/preview|\/\d+\/reimport)?\/?$/.test(path);
}
