// Pure calendar rules: RRULE validation and expansion, availability capacity, commute and class gaps.
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { type Availability, availabilityOn, busyFromEvents, capacityBetween, layersBetween, mergeBusy } from "../src/calendar/capacity.js";
import { RecurrenceError, expandSeries, normalizeRule } from "../src/calendar/recurrence.js";
import { buildPlan } from "../src/today/plan.js";

const ZONE = "America/Chicago";
const at = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).toJSDate();
const iso = (date: Date) => DateTime.fromJSDate(date, { zone: ZONE }).toFormat("yyyy-LL-dd HH:mm");

describe("recurrence rules", () => {
  it("normalizes allowed rules and fills in WKST", () => {
    expect(normalizeRule("rrule:byday=MO,WE;freq=weekly")).toBe("FREQ=WEEKLY;BYDAY=MO,WE;WKST=MO");
    expect(normalizeRule("FREQ=MONTHLY;BYDAY=-1FR;BYSETPOS=1;COUNT=3")).toBe("FREQ=MONTHLY;COUNT=3;BYDAY=-1FR;BYSETPOS=1;WKST=MO");
  });

  it.each([
    ["FREQ=HOURLY", /FREQ/],
    ["FREQ=WEEKLY;BYHOUR=9", /Use only/],
    ["FREQ=WEEKLY;FREQ=DAILY", /Use only/],
    ["FREQ=DAILY;COUNT=0", /COUNT/],
    ["FREQ=DAILY;INTERVAL=-2", /INTERVAL/],
    ["FREQ=DAILY;COUNT=3;UNTIL=20261211", /not both/],
    ["FREQ=DAILY;UNTIL=2026-12-11", /UNTIL/],
    ["FREQ=WEEKLY;BYDAY=XX", /BYDAY/],
    ["FREQ=MONTHLY;BYMONTHDAY=32", /BYMONTHDAY/],
    ["FREQ=YEARLY;BYMONTH=13", /BYMONTH/],
    ["FREQ=WEEKLY;WKST=XX", /WKST/],
  ])("rejects %s", (rule, message) => {
    expect(() => normalizeRule(rule)).toThrow(RecurrenceError);
    expect(() => normalizeRule(rule)).toThrow(message);
  });

  it("keeps wall-clock times across a DST change and includes a date-only UNTIL day", () => {
    // Mondays and Wednesdays at 9:00 from 26 Oct; DST ends 1 Nov 2026 in Chicago.
    const series = {
      startAt: at("2026-10-26T09:00"),
      endAt: at("2026-10-26T10:15"),
      allDay: false,
      recurrenceRule: "FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261104",
    };
    const occurrences = expandSeries(series, ZONE, at("2026-10-01T00:00"), at("2026-12-01T00:00"));
    expect(occurrences.map((item) => iso(item.start))).toEqual([
      "2026-10-26 09:00",
      "2026-10-28 09:00",
      "2026-11-02 09:00",
      "2026-11-04 09:00",
    ]);
    expect(occurrences.every((item) => item.end.getTime() - item.start.getTime() === 75 * 60_000)).toBe(true);
  });

  it("returns only occurrences overlapping the range and skips impossible dates", () => {
    const daily = { startAt: at("2026-01-01T08:00"), endAt: at("2026-01-01T09:00"), allDay: false, recurrenceRule: "FREQ=DAILY" };
    const week = expandSeries(daily, ZONE, at("2026-11-02T00:00"), at("2026-11-09T00:00"));
    expect(week).toHaveLength(7);
    const counted = { ...daily, recurrenceRule: "FREQ=DAILY;COUNT=5" };
    expect(expandSeries(counted, ZONE, at("2026-11-02T00:00"), at("2026-11-09T00:00"))).toEqual([]);
    // 31 February never happens; ical.js would otherwise hand back March dates.
    const never = { ...daily, recurrenceRule: "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=31" };
    expect(expandSeries(never, ZONE, at("2026-01-01T00:00"), at("2027-12-31T00:00"))).toEqual([]);
  });

  it("expands all-day series by date", () => {
    const allDay = {
      startAt: new Date("2026-11-02T00:00:00Z"),
      endAt: new Date("2026-11-03T00:00:00Z"),
      allDay: true,
      recurrenceRule: "FREQ=WEEKLY;COUNT=3",
    };
    const dates = expandSeries(allDay, ZONE, new Date("2026-11-01T00:00:00Z"), new Date("2026-12-01T00:00:00Z"));
    expect(dates.map((item) => item.start.toISOString().slice(0, 10))).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
  });
});

describe("capacity", () => {
  const monday = DateTime.fromISO("2026-11-02", { zone: ZONE });
  const availability: Availability = {
    rules: [
      { weekday: 0, startMinute: 9 * 60, endMinute: 12 * 60, enabled: true },
      { weekday: 0, startMinute: 13 * 60, endMinute: 17 * 60, enabled: true },
      { weekday: 1, startMinute: 9 * 60, endMinute: 17 * 60, enabled: false },
    ],
    overrides: new Map([["2026-11-04", []]]),
  };

  it("reads weekly rules, overrides and the unconfigured state", () => {
    expect(availabilityOn(availability, monday)?.map((span) => iso(new Date(span.start)))).toEqual(["2026-11-02 09:00", "2026-11-02 13:00"]);
    // A disabled rule leaves Tuesday unavailable; an empty override does the same for Wednesday.
    expect(availabilityOn(availability, monday.plus({ days: 1 }))).toEqual([]);
    expect(availabilityOn(availability, monday.plus({ days: 2 }))).toEqual([]);
    expect(availabilityOn({ rules: [], overrides: new Map() }, monday)).toBeNull();
    expect(availabilityOn(null, monday)).toBeNull();
  });

  it("subtracts busy time with commute, and bridges short gaps between classes", () => {
    const lecture = { start: at("2026-11-02T10:00"), end: at("2026-11-02T10:50"), allDay: false, busy: true, eventType: "class", courseId: 1 };
    const lab = { start: at("2026-11-02T11:10"), end: at("2026-11-02T11:30"), allDay: false, busy: true, eventType: "class", courseId: 2 };
    const free = { start: at("2026-11-02T14:00"), end: at("2026-11-02T15:00"), allDay: false, busy: false, eventType: "other", courseId: null };
    const commutes = new Map([[1, 15]]);
    const busy = busyFromEvents([lecture, lab, free], commutes);
    // 9:45-11:05 (commute), then the lab 11:10: a 5-minute gap between classes is bridged.
    expect(mergeBusy(busy).map((span) => [iso(new Date(span.start)), iso(new Date(span.end))])).toEqual([
      ["2026-11-02 09:45", "2026-11-02 11:30"],
    ]);
    const result = capacityBetween({ from: monday.toJSDate(), to: monday.plus({ days: 1 }).toJSDate(), zone: ZONE, availability, busy });
    // 7 hours available, 105 minutes of it busy (9:45-11:30).
    expect(result).toEqual({ minutes: 7 * 60 - 105, source: "calendar" });
    expect(capacityBetween({ from: monday.toJSDate(), to: monday.plus({ days: 1 }).toJSDate(), zone: ZONE, availability, busy: [] })).toEqual({
      minutes: 420,
      source: "availability",
    });
    expect(capacityBetween({ from: monday.toJSDate(), to: monday.plus({ days: 1 }).toJSDate(), zone: ZONE, availability: null, busy })).toEqual({
      minutes: null,
      source: "fallback",
    });

    const layers = layersBetween({
      from: monday.toJSDate(),
      to: monday.plus({ days: 1 }).toJSDate(),
      zone: ZONE,
      availability,
      events: [lecture, lab, free],
      commutes,
    });
    const kinds = layers.map((layer) => `${layer.kind} ${iso(layer.start)}-${iso(layer.end).slice(11)}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "commute 2026-11-02 09:45-10:00",
        "commute 2026-11-02 10:50-11:05",
        "short_gap 2026-11-02 11:05-11:10",
        "availability 2026-11-02 09:00-12:00",
      ]),
    );
  });
});

describe("plan with availability", () => {
  const settings = { timeZone: ZONE, dailyStudyMinutes: 60, studyStartMinute: 9 * 60, studyEndMinute: 22 * 60 };
  const now = at("2026-11-02T08:00");
  const task = { id: 1, taskType: "assignment", dueAt: at("2026-11-02T23:00"), pointsPossible: 100, progress: 0, estimatedMinutes: 300 };

  it("falls back to the study window and daily goal without rules", () => {
    const plan = buildPlan({ now, settings, tasks: [task], busy: [] });
    expect(plan.capacitySource).toBe("fallback");
    expect(plan.capacityMinutes).toBe(60);
  });

  it("plans inside the availability, uncapped, and reports busy time cutting into it", () => {
    const availability: Availability = { rules: [{ weekday: 0, startMinute: 10 * 60, endMinute: 14 * 60, enabled: true }], overrides: new Map() };
    const plan = buildPlan({ now, settings, tasks: [task], busy: [], availability });
    expect(plan).toMatchObject({ capacitySource: "availability", capacityMinutes: 240, plannedMinutes: 240 });
    expect(plan.studyWindows.map((window) => iso(window.start))).toEqual(["2026-11-02 10:00"]);

    const busy = [{ start: at("2026-11-02T11:00"), end: at("2026-11-02T12:00") }];
    expect(buildPlan({ now, settings, tasks: [task], busy, availability })).toMatchObject({ capacitySource: "calendar", capacityMinutes: 180 });

    const away = { ...availability, overrides: new Map([["2026-11-02", []]]) };
    expect(buildPlan({ now, settings, tasks: [task], busy: [], availability: away })).toMatchObject({ capacityMinutes: 0, studyWindows: [] });
  });
});
