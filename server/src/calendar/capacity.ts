// Study capacity: availability (weekly rules and date overrides) minus busy time, where busy time
// includes the commute around class events and short gaps between classes. Pure: the callers load
// the rows. Ported from the original app's calendar_capacity.py.
import { DateTime } from "luxon";

export const CLASS_GAP_MINUTES = 30;
const MINUTE = 60_000;

export interface Span {
  start: number;
  end: number;
}

export interface Busy extends Span {
  /** Class time (with its commute); short gaps between two classes count as busy too. */
  isClass: boolean;
}

export interface AvailabilityRuleRow {
  /** 0 = Monday ... 6 = Sunday. */
  weekday: number;
  startMinute: number;
  endMinute: number;
  enabled: boolean;
}

export interface MinuteInterval {
  startMinute: number;
  endMinute: number;
}

export interface Availability {
  rules: AvailabilityRuleRow[];
  /** Local date "YYYY-MM-DD" to that day's intervals; an empty list means unavailable. */
  overrides: Map<string, MinuteInterval[]>;
}

export type CapacitySource = "calendar" | "availability" | "fallback";

/** "13:05" to 785. */
export const minuteOf = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** 785 to "13:05". */
export const clockOf = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** Wall-clock time on a local day; minute 1440 is the next midnight. DST-safe. */
export function atMinute(day: DateTime, minute: number): DateTime {
  if (minute >= 1440) return day.plus({ days: 1 }).startOf("day");
  return day.set({ hour: Math.floor(minute / 60), minute: minute % 60, second: 0, millisecond: 0 });
}

/**
 * The study intervals on the local `day` (start of day in the user's zone), or null when nothing is
 * configured for it: no override for the date and no weekly rules at all.
 */
export function availabilityOn(availability: Availability | null, day: DateTime): Span[] | null {
  if (!availability) return null;
  const date = day.toISODate() as string;
  const override = availability.overrides.get(date);
  let intervals: MinuteInterval[];
  if (override) intervals = override;
  else if (availability.rules.length === 0) return null;
  else intervals = availability.rules.filter((rule) => rule.enabled && rule.weekday === day.weekday - 1);
  return intervals
    .filter((interval) => interval.endMinute > interval.startMinute)
    .map((interval) => ({ start: atMinute(day, interval.startMinute).toMillis(), end: atMinute(day, interval.endMinute).toMillis() }))
    .sort((a, b) => a.start - b.start);
}

/** Merges overlapping busy time, and bridges gaps under 30 minutes between two classes. */
export function mergeBusy(items: Busy[]): Busy[] {
  const sorted = [...items].filter((item) => item.end > item.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Busy[] = [];
  for (const item of sorted) {
    const previous = merged.at(-1);
    if (!previous) {
      merged.push({ ...item });
      continue;
    }
    const gap = (item.start - previous.end) / MINUTE;
    const bridge = previous.isClass && item.isClass && gap < CLASS_GAP_MINUTES;
    if (item.start <= previous.end || bridge) {
      previous.end = Math.max(previous.end, item.end);
      previous.isClass = previous.isClass && item.isClass;
    } else merged.push({ ...item });
  }
  return merged;
}

/** The parts of `available` not covered by `busy` (already merged). */
export function subtract(available: Span[], busy: Span[]): Span[] {
  let remaining = available.map((span) => ({ ...span }));
  for (const block of busy) {
    const next: Span[] = [];
    for (const slot of remaining) {
      if (block.end <= slot.start || block.start >= slot.end) {
        next.push(slot);
        continue;
      }
      if (block.start > slot.start) next.push({ start: slot.start, end: Math.min(block.start, slot.end) });
      if (block.end < slot.end) next.push({ start: Math.max(block.end, slot.start), end: slot.end });
    }
    remaining = next;
  }
  return remaining.filter((span) => span.end > span.start);
}

export const minutesIn = (spans: Span[]): number => spans.reduce((sum, span) => sum + (span.end - span.start), 0) / MINUTE;

export interface BusyEvent {
  start: Date;
  end: Date;
  allDay: boolean;
  busy: boolean;
  eventType: string;
  courseId: number | null;
}

/**
 * Busy time from event occurrences: opaque timed events, with class events stretched by their
 * course's commute. All-day events (holidays, deadlines) never block study time.
 */
export function busyFromEvents(events: BusyEvent[], commutes: Map<number, number>): Busy[] {
  return events
    .filter((event) => event.busy && !event.allDay)
    .map((event) => {
      const isClass = event.eventType === "class";
      const commute = isClass && event.courseId !== null ? (commutes.get(event.courseId) ?? 0) * MINUTE : 0;
      return { start: event.start.getTime() - commute, end: event.end.getTime() + commute, isClass };
    });
}

/**
 * Free study minutes in [from, to): availability minus busy time, day by day in `zone`. Null minutes
 * mean availability is not configured for any of those days, so callers fall back to their default.
 */
export function capacityBetween(input: {
  from: Date;
  to: Date;
  zone: string;
  availability: Availability | null;
  busy: Busy[];
}): { minutes: number | null; source: CapacitySource } {
  const from = input.from.getTime();
  const to = input.to.getTime();
  if (to <= from) return { minutes: 0, source: "calendar" };
  const merged = mergeBusy(input.busy);
  let day = DateTime.fromMillis(from, { zone: input.zone }).startOf("day");
  let total = 0;
  let configured = false;
  let overlapped = false;
  for (; day.toMillis() < to; day = day.plus({ days: 1 }).startOf("day")) {
    const windows = availabilityOn(input.availability, day);
    if (!windows) continue;
    configured = true;
    const clipped = windows
      .map((span) => ({ start: Math.max(span.start, from), end: Math.min(span.end, to) }))
      .filter((span) => span.end > span.start);
    const free = subtract(clipped, merged);
    if (minutesIn(free) < minutesIn(clipped)) overlapped = true;
    total += minutesIn(free);
  }
  if (!configured) return { minutes: null, source: "fallback" };
  return { minutes: Math.max(0, Math.round(total)), source: overlapped ? "calendar" : "availability" };
}

export interface Layer {
  kind: "availability" | "commute" | "short_gap";
  start: Date;
  end: Date;
}

/** Background layers for the calendar view: study windows, commute around classes, bridged class gaps. */
export function layersBetween(input: {
  from: Date;
  to: Date;
  zone: string;
  availability: Availability | null;
  events: BusyEvent[];
  commutes: Map<number, number>;
}): Layer[] {
  const from = input.from.getTime();
  const to = input.to.getTime();
  const layers: Layer[] = [];
  const classes: Busy[] = [];
  const plain: Span[] = [];
  for (const event of input.events) {
    if (!event.busy || event.allDay || event.eventType !== "class") continue;
    const [stretched] = busyFromEvents([event], input.commutes);
    if (!stretched) continue;
    classes.push(stretched);
    const own = { start: event.start.getTime(), end: event.end.getTime() };
    plain.push(stretched);
    for (const fragment of subtract([stretched], [own])) layers.push({ kind: "commute", start: new Date(fragment.start), end: new Date(fragment.end) });
  }
  // Only the gaps the capacity rule adds, not the classes themselves.
  for (const fragment of subtract(mergeBusy(classes), mergeBusy(plain.map((span) => ({ ...span, isClass: false }))))) {
    layers.push({ kind: "short_gap", start: new Date(fragment.start), end: new Date(fragment.end) });
  }
  for (let day = DateTime.fromMillis(from, { zone: input.zone }).startOf("day"); day.toMillis() < to; day = day.plus({ days: 1 }).startOf("day")) {
    for (const span of availabilityOn(input.availability, day) ?? []) {
      if (span.start < to && span.end > from) layers.push({ kind: "availability", start: new Date(span.start), end: new Date(span.end) });
    }
  }
  return layers.filter((layer) => layer.end.getTime() > from && layer.start.getTime() < to);
}
