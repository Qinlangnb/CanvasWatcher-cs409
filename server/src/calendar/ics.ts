// Reads an iCalendar (.ics) file into a flat list of event occurrences.
// Pure and synchronous: no I/O, and nothing global is changed. Time zones defined in the file
// (VTIMEZONE) are resolved by ical.js inside the parsed tree.
import { createHash } from "node:crypto";
import ICAL from "ical.js";
import { DateTime, IANAZone } from "luxon";

type IcalTime = InstanceType<typeof ICAL.Time>;
type IcalComponent = InstanceType<typeof ICAL.Component>;

export interface ParsedEvent {
  /** Identity inside the file: the UID, plus the original start for an occurrence of a recurring event. */
  externalId: string;
  title: string;
  location: string | null;
  description: string | null;
  startAt: Date;
  endAt: Date;
  /** All-day events use UTC midnight of the first day and of the day after the last. */
  allDay: boolean;
  busy: boolean;
}

export interface ParsedCalendar {
  /** X-WR-CALNAME, when the file names itself. */
  name: string | null;
  events: ParsedEvent[];
  /** True when the file had more occurrences than one import keeps. */
  truncated: boolean;
  /** The zone floating times were read in, when the file names one or the user confirmed one. */
  timeZone: string | null;
  /** Some times have no zone, and neither the file nor the user said which they are in. */
  timeZoneConfirmationRequired: boolean;
  /** Events with RRULE or RDATE. */
  recurringSeriesCount: number;
}

export interface ParseOptions {
  /** Floating times (no time zone in the file) are read in this IANA zone unless the file names one. */
  timeZone: string;
  /** A zone the user confirmed for floating times; it wins over the file's own. */
  override?: string | null;
  /** Occurrences outside [windowStart, windowEnd) are dropped. */
  windowStart: Date;
  windowEnd: Date;
  maxEvents?: number;
  /** Bounds the work spent expanding recurrence rules, whatever the file asks for. */
  maxSteps?: number;
}

export class IcsError extends Error {}

const MAX_TEXT = 200;
const MAX_DESCRIPTION = 5000;
const MAX_ID = 1024;
const DAY_MS = 86_400_000;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, MAX_TEXT) : null;
}

/** Keeps line breaks, unlike `text`. */
function longText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replaceAll("\0", "").replace(/[ \t]+/g, " ").trim();
  return cleaned ? cleaned.slice(0, MAX_DESCRIPTION) : null;
}

function upper(component: IcalComponent, name: string): string {
  const value = component.getFirstPropertyValue(name);
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function tzidOf(component: IcalComponent, name: string): string | null {
  const value = component.getFirstProperty(name)?.getParameter("tzid");
  return typeof value === "string" ? value.trim() : null;
}

/** Outlook and some exporters prefix IANA names, e.g. "/mozilla.org/20070129_1/America/Chicago". */
function ianaName(tzid: string | null): string | null {
  if (!tzid) return null;
  if (IANAZone.isValidZone(tzid)) return tzid;
  const match = /([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(tzid);
  return match?.[1] && IANAZone.isValidZone(match[1]) ? match[1] : null;
}

function allDayDate(time: IcalTime): Date {
  return new Date(Date.UTC(time.year, time.month - 1, time.day));
}

/** Where floating times are read, and whether any were seen. */
interface Floating {
  zone: string;
  seen: boolean;
}

function instant(time: IcalTime, tzid: string | null, floating: Floating): Date {
  if (time.zone?.tzid === "UTC") return new Date(time.toUnixTime() * 1000);
  const wall = {
    year: time.year,
    month: time.month,
    day: time.day,
    hour: time.hour,
    minute: time.minute,
    second: time.second,
  };
  // An IANA name is resolved with the full tz database, which is more accurate than the
  // VTIMEZONE rules exporters embed (often only the current year's).
  const iana = ianaName(tzid);
  if (iana) return DateTime.fromObject(wall, { zone: iana }).toJSDate();
  // A zone the file defines itself, e.g. Outlook's "Central Standard Time".
  if (time.zone && time.zone.tzid !== "floating") return new Date(time.toUnixTime() * 1000);
  floating.seen = true;
  return DateTime.fromObject(wall, { zone: floating.zone }).toJSDate();
}

interface Span {
  start: IcalTime;
  end: IcalTime;
  startZone: string | null;
  endZone: string | null;
}

function toEvent(item: IcalComponent, span: Span, floating: Floating, externalId: string): ParsedEvent | null {
  if (upper(item, "status") === "CANCELLED") return null;
  const allDay = span.start.isDate;
  let startAt: Date;
  let endAt: Date;
  if (allDay) {
    startAt = allDayDate(span.start);
    endAt = span.end.isDate ? allDayDate(span.end) : new Date(startAt.getTime() + DAY_MS);
    if (endAt <= startAt) endAt = new Date(startAt.getTime() + DAY_MS);
  } else {
    startAt = instant(span.start, span.startZone, floating);
    endAt = span.end.isDate ? startAt : instant(span.end, span.endZone, floating);
    if (endAt < startAt) endAt = startAt;
  }
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) return null;
  return {
    externalId,
    title: text(item.getFirstPropertyValue("summary")) ?? "Busy",
    location: text(item.getFirstPropertyValue("location")),
    description: longText(item.getFirstPropertyValue("description")),
    startAt,
    endAt,
    allDay,
    // All-day entries (holidays, deadlines) and "show as free" events don't block study time.
    busy: !allDay && upper(item, "transp") !== "TRANSPARENT",
  };
}

function roots(input: string): IcalComponent[] {
  let parsed: unknown;
  try {
    parsed = ICAL.parse(input);
  } catch {
    throw new IcsError("This file isn't a valid calendar (.ics) file.");
  }
  const list = (Array.isArray(parsed) && typeof parsed[0] !== "string" ? parsed : [parsed]) as unknown[];
  const calendars = list.map((jcal) => new ICAL.Component(jcal as []));
  if (!calendars.length || calendars.some((root) => root.name !== "vcalendar")) {
    throw new IcsError("This file isn't a valid calendar (.ics) file.");
  }
  return calendars;
}

/** The calendar's own zone: X-WR-TIMEZONE, else the first VTIMEZONE with an IANA name. */
function calendarZone(root: IcalComponent): string | null {
  const named = ianaName(text(root.getFirstPropertyValue("x-wr-timezone")));
  if (named) return named;
  for (const zone of root.getAllSubcomponents("vtimezone")) {
    const iana = ianaName(text(zone.getFirstPropertyValue("tzid")));
    if (iana) return iana;
  }
  return null;
}

const idPart = (value: unknown) => (value && typeof value === "object" ? String(value) : "");

export function parseIcs(input: string, options: ParseOptions): ParsedCalendar {
  const { windowStart, windowEnd } = options;
  const override = options.override ?? null;
  const maxEvents = options.maxEvents ?? 2000;
  let stepsLeft = options.maxSteps ?? 10_000;
  const events: ParsedEvent[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let name: string | null = null;
  let fileZone: string | null = null;
  let recurringSeriesCount = 0;
  let floatingSeen = false;

  const keep = (event: ParsedEvent | null) => {
    if (!event || event.endAt <= windowStart || event.startAt >= windowEnd) return true;
    // A file may repeat an event (an exception listed twice); the first one counts.
    if (seen.has(event.externalId)) return true;
    if (events.length >= maxEvents) {
      truncated = true;
      return false;
    }
    seen.add(event.externalId);
    events.push(event);
    return true;
  };

  outer: for (const root of roots(input)) {
    name ??= text(root.getFirstPropertyValue("x-wr-calname"));
    const ownZone = calendarZone(root);
    fileZone ??= ownZone;
    const floating: Floating = { zone: override ?? ownZone ?? options.timeZone, seen: false };
    const vevents = root.getAllSubcomponents("vevent");
    const uidOf = (component: IcalComponent) => text(component.getFirstPropertyValue("uid"));
    // Moved or cancelled occurrences, by the UID of the recurring event they belong to.
    const exceptions = new Map<string, IcalComponent[]>();
    for (const component of vevents) {
      const uid = uidOf(component);
      if (uid && component.hasProperty("recurrence-id") && component.hasProperty("dtstart")) {
        exceptions.set(uid, [...(exceptions.get(uid) ?? []), component]);
      }
    }
    const masters = new Set(vevents.filter((component) => !component.hasProperty("recurrence-id")).map(uidOf));
    recurringSeriesCount += vevents.filter(
      (component) => !component.hasProperty("recurrence-id") && (component.hasProperty("rrule") || component.hasProperty("rdate")),
    ).length;
    for (const component of vevents) {
      if (!component.hasProperty("dtstart")) continue;
      const uid = uidOf(component);
      const isException = component.hasProperty("recurrence-id");
      // Files without UIDs still re-import: the title and start stand in for one.
      const identity =
        uid ??
        `nouid:${createHash("sha256")
          .update(`${String(component.getFirstPropertyValue("summary"))}|${idPart(component.getFirstPropertyValue("dtstart"))}`)
          .digest("hex")
          .slice(0, 32)}`;
      // Exceptions are applied through their recurring event; only orphans stand alone.
      if (isException && uid && masters.has(uid)) continue;
      let event: InstanceType<typeof ICAL.Event>;
      try {
        // Passing the exceptions explicitly stops ical.js from attaching every exception in the
        // file to every event, whatever its UID.
        event = new ICAL.Event(component, { exceptions: isException || !uid ? [] : (exceptions.get(uid) ?? []) });
      } catch {
        continue;
      }
      const startZone = tzidOf(component, "dtstart");
      const endZone = tzidOf(component, "dtend") ?? startZone;
      try {
        if (!event.isRecurring() || isException) {
          const externalId = isException ? `${identity}::${idPart(component.getFirstPropertyValue("recurrence-id"))}` : identity;
          const parsed = toEvent(component, { start: event.startDate, end: event.endDate, startZone, endZone }, floating, externalId.slice(0, MAX_ID));
          if (!keep(parsed)) break outer;
          continue;
        }
        const iterator = event.iterator();
        for (let occurrence = iterator.next(); occurrence; occurrence = iterator.next()) {
          if (--stepsLeft < 0) {
            truncated = true;
            break outer;
          }
          if (instant(occurrence, startZone, floating) >= windowEnd && !occurrence.isDate) break;
          if (occurrence.isDate && allDayDate(occurrence) >= windowEnd) break;
          const details = event.getOccurrenceDetails(occurrence);
          const item = details.item.component;
          const exception = item !== component;
          const span: Span = {
            start: details.startDate,
            end: details.endDate,
            startZone: exception ? tzidOf(item, "dtstart") : startZone,
            endZone: exception ? (tzidOf(item, "dtend") ?? tzidOf(item, "dtstart")) : startZone,
          };
          const externalId = `${identity}::${idPart(details.recurrenceId)}`.slice(0, MAX_ID);
          if (!keep(toEvent(item, span, floating, externalId))) break outer;
        }
      } catch {
        // One malformed event (a bad RRULE, an unknown zone) must not sink the whole import.
        continue;
      }
    }
    if (floating.seen && !override && !ownZone) floatingSeen = true;
  }

  events.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  return {
    name,
    events,
    truncated,
    timeZone: override ?? fileZone,
    timeZoneConfirmationRequired: floatingSeen,
    recurringSeriesCount,
  };
}
