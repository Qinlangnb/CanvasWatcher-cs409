import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import ts from "typescript";

// Calendar parity: the Day and Month grid helpers, event forms with recurrence and time zones, and
// the calendar, Settings and Today wiring. Modules are transpiled and loaded as data URLs.
const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText,
  ).toString("base64")}`;
const luxon = JSON.stringify(import.meta.resolve("luxon"));

const grid = await import(moduleUrl(read("app/calendarGrid.ts").replace('"luxon"', luxon)));
const zonedUrl = moduleUrl(read("app/zoned.ts").replace('"luxon"', luxon));
const apiUrl = moduleUrl(read("app/api.ts").replace('"../publicPath"', JSON.stringify(moduleUrl(read("publicPath.ts")))));
const forms = await import(moduleUrl(read("app/forms.ts").replace('"./api"', JSON.stringify(apiUrl)).replace('"./zoned"', JSON.stringify(zonedUrl))));
const css = postcss.parse(read("app/app.css"));

const CHICAGO = "America/Chicago";
const event = (fields) => ({
  id: 1,
  key: "1",
  title: "Lab",
  location: null,
  description: null,
  all_day: false,
  busy: true,
  event_type: "other",
  time_zone: null,
  course: null,
  recurrence_rule: null,
  series: null,
  source: null,
  editable: true,
  ...fields,
});

test("the month grid is six Sunday-first weeks around the month", () => {
  const dates = grid.monthGrid("2026-11-18");
  assert.equal(dates.length, 42);
  assert.equal(dates[0], "2026-11-01");
  assert.equal(grid.monthGrid("2026-12-05")[0], "2026-11-29");
  assert.equal(grid.addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(grid.monthLabel("2026-11-18"), "November 2026");
  assert.equal(grid.dayLabel("2026-11-18"), "Wednesday, November 18, 2026");
});

test("timed events sit on the day grid in lanes, clipped to the day", () => {
  const a = event({ key: "a", start: "2026-11-18T15:00:00Z", end: "2026-11-18T16:00:00Z" });
  const b = event({ key: "b", start: "2026-11-18T15:30:00Z", end: "2026-11-18T16:30:00Z" });
  const c = event({ key: "c", start: "2026-11-18T18:00:00Z", end: "2026-11-18T19:00:00Z" });
  const late = event({ key: "late", start: "2026-11-19T05:00:00Z", end: "2026-11-19T07:00:00Z" });
  const placed = grid.placeEvents([a, b, c, late], "2026-11-18", CHICAGO);
  const byKey = Object.fromEntries(placed.map((item) => [item.event.key, item]));
  assert.deepEqual([byKey.a.top, byKey.a.lane, byKey.a.lanes], [540, 0, 2]);
  assert.deepEqual([byKey.b.lane, byKey.b.lanes], [1, 2]);
  assert.deepEqual([byKey.c.lane, byKey.c.lanes], [0, 1]);
  // 23:00 to 01:00 next day: clipped at midnight.
  assert.deepEqual([byKey.late.top, byKey.late.bottom], [1380, 1440]);
  assert.equal(grid.slotValue("2026-11-18", 9 * 60), "2026-11-18T09:00");
  assert.equal(grid.slotValue("2026-11-18", 24 * 60), "2026-11-18T23:59");
});

test("Day view rows follow the zone's real hours on daylight-saving days", async () => {
  const { DateTime } = await import(JSON.parse(luxon));
  const wall = (value) => DateTime.fromFormat(value, "yyyy-LL-dd'T'HH:mm", { zone: CHICAGO });
  for (const [date, count] of [["2026-03-08", 23], ["2026-11-01", 25], ["2026-11-18", 24]]) {
    const rows = grid.dayHours(date, CHICAGO);
    assert.equal(rows.length, count, date);
    rows.forEach((row, index) => {
      // Rows sit one real hour apart, like the event blocks placed by elapsed minutes.
      if (index > 0) assert.equal(row.at - rows[index - 1].at, 3_600_000);
      // The hour shown is the hour of the row's instant.
      assert.equal(DateTime.fromMillis(row.at, { zone: CHICAGO }).toFormat("yyyy-LL-dd'T'HH:mm"), row.wall);
      if (!row.slot) {
        assert.equal(row.repeated, true);
        return;
      }
      // A click creates the event at the labelled hour; neither end is in a gap or happens twice.
      assert.equal(row.slot.start, row.wall);
      for (const value of [row.slot.start, row.slot.end]) {
        const time = wall(value);
        assert.ok(time.isValid && time.toFormat("yyyy-LL-dd'T'HH:mm") === value, `${value} exists`);
        assert.equal(time.getPossibleOffsets().length, 1, `${value} happens once`);
      }
      assert.equal(wall(row.slot.start).toMillis(), row.at);
      assert.ok(row.slot.end > row.slot.start);
    });
  }
  const spring = grid.dayHours("2026-03-08", CHICAGO);
  assert.deepEqual(spring.slice(1, 3).map((row) => row.slot), [
    { start: "2026-03-08T01:00", end: "2026-03-08T03:00" },
    { start: "2026-03-08T03:00", end: "2026-03-08T04:00" },
  ]);
  assert.ok(spring.every((row) => !row.wall.endsWith("T02:00")));
  const fall = grid.dayHours("2026-11-01", CHICAGO);
  assert.deepEqual(fall.slice(1, 3).map((row) => [row.wall, row.repeated, row.slot]), [
    ["2026-11-01T01:00", true, null],
    ["2026-11-01T01:00", true, null],
  ]);
  assert.notEqual(fall[1].zoneName, fall[2].zoneName);
  assert.deepEqual(fall.at(-1).slot, { start: "2026-11-01T23:00", end: "2026-11-01T23:59" });
  assert.deepEqual(fall[22].slot, { start: "2026-11-01T21:00", end: "2026-11-01T22:00" });
  // The Day view builds its rows this way, not as 24 fixed hours.
  const page = read("app/pages/calendar.tsx");
  assert.match(page, /dayHours\(date, zone\)/);
  assert.doesNotMatch(page, /length: 24/);
});

test("event forms send wall-clock times, zone, type, course and recurrence", () => {
  const fresh = forms.eventDraft(undefined, "2026-11-10", CHICAGO, new Date("2026-11-06T18:00:00Z"));
  const draft = {
    ...fresh,
    title: " Lecture ",
    description: " Bring notes ",
    timeZone: "America/New_York",
    eventType: "class",
    courseId: "7",
    recurrence: " FREQ=WEEKLY;BYDAY=MO,WE ",
  };
  assert.deepEqual(forms.eventBody(draft, CHICAGO), {
    errors: {},
    body: {
      title: "Lecture",
      location: null,
      all_day: false,
      start: "2026-11-10T09:00",
      end: "2026-11-10T10:00",
      busy: true,
      description: "Bring notes",
      time_zone: "America/New_York",
      event_type: "class",
      course_id: 7,
      recurrence_rule: "FREQ=WEEKLY;BYDAY=MO,WE",
    },
  });
  assert.deepEqual(forms.eventBody({ ...draft, end: "2026-11-10T08:00" }, CHICAGO).errors, { end: "It has to end after it starts." });

  // A recurring event is edited from its first occurrence, in its own zone.
  const occurrence = event({
    start: "2026-11-16T14:00:00.000Z",
    end: "2026-11-16T15:00:00.000Z",
    time_zone: "America/New_York",
    recurrence_rule: "FREQ=WEEKLY;BYDAY=MO;WKST=MO",
    series: { start: "2026-10-26T13:00:00.000Z", end: "2026-10-26T14:00:00.000Z" },
    course: { id: 3, code: "CS 409" },
    event_type: "class",
  });
  const editing = forms.eventDraft(occurrence, "2026-11-16", CHICAGO, new Date());
  assert.deepEqual([editing.start, editing.end, editing.timeZone, editing.courseId, editing.recurrence], [
    "2026-10-26T09:00",
    "2026-10-26T10:00",
    "America/New_York",
    "3",
    "FREQ=WEEKLY;BYDAY=MO;WKST=MO",
  ]);
});

test("the event editor shows a linked course even after it was archived", () => {
  const active = [{ id: 1, code: "CS 409" }, { id: 2, code: "MATH 241" }];
  const lab = event({ course: { id: 7, code: "PHYS 211" }, event_type: "class", start: "2026-11-18T15:00:00Z", end: "2026-11-18T16:00:00Z" });
  const draft = forms.eventDraft(lab, "2026-11-18", CHICAGO, new Date());
  const options = forms.eventCourseOptions(active, lab.course);
  // The draft's course is among the options, so the select shows it instead of a blank.
  assert.ok(options.some((option) => String(option.id) === draft.courseId));
  assert.deepEqual(options.at(-1), { id: 7, label: "PHYS 211 (archived)", archived: true });
  assert.deepEqual(forms.eventCourseOptions(active, { id: 2, code: "MATH 241" }).map((option) => option.label), ["CS 409", "MATH 241"]);
  assert.equal(forms.eventCourseOptions(active, null).length, 2);
  assert.match(read("app/events.tsx"), /eventCourseOptions\(courses\.data \?\? \[\], event\?\.course\)/);
});

test("the calendar page has Day, Week, Month and Timeline, go to date, filters, layers and warnings", () => {
  const page = read("app/pages/calendar.tsx");
  for (const view of ["day", "week", "month", "timeline"]) assert.match(page, new RegExp(`aria-pressed=\\{view === "${view}"\\}`));
  assert.match(page, /<span>Go to date<\/span>/);
  assert.match(page, /Display only\. Hidden events still affect study capacity\./);
  assert.match(page, /Study windows, commute and short class gaps/);
  assert.match(page, /Repair event/);
  assert.match(page, /Add an event at \{label\}/);
  assert.match(page, /useCalendarView\(range\.from, range\.to\)/);
  const api = read("app/calendarApi.ts");
  assert.match(api, /FILTERS_KEY = "aw-calendar-filters"/);
  assert.match(api, /localStorage\.setItem\(FILTERS_KEY/);
  const events = read("app/events.tsx");
  assert.match(events, /Edit entire series/);
  assert.match(events, /Delete this entire recurring series\?/);
  assert.match(events, /Read-only · manage through import source/);
  assert.match(events, /multiple/);
  assert.match(events, /Confirm time zone/);
});

test("Settings has availability, overrides, commute, re-import, the agenda and the Google placeholder", () => {
  const settings = read("app/pages/settings.tsx");
  for (const section of ["<AvailabilitySection />", "<CommuteSection />", "<CalendarsSection />", "<AgendaSection />"]) assert.ok(settings.includes(section), section);
  const panel = read("app/calendarSettings.tsx");
  assert.match(panel, /Add interval/);
  assert.match(panel, /Save availability/);
  assert.match(panel, /Unavailable all day/);
  assert.match(panel, /Save override/);
  assert.match(panel, /max=\{240\}\s+step=\{5\}/);
  assert.match(panel, /Re-import<span/);
  assert.match(panel, /This re-import removes/);
  assert.match(panel, /Coming soon/);
  assert.match(panel, /AGENDA_DAYS = 31/);
});

test("Today names where its capacity comes from", () => {
  const today = read("app/pages/today.tsx");
  assert.match(today, /plan\.capacity_source/);
  for (const source of ["calendar", "availability", "fallback"]) assert.match(today, new RegExp(`${source}: "Capacity:`));
});

test("calendar layouts wrap on phones and use seven columns from tablet width", () => {
  let month = false;
  css.walkAtRules("media", (rule) => {
    if (rule.params.includes("min-width: 768px")) rule.walkRules(".month-grid", (inner) => (month = inner.toString().includes("repeat(7")));
  });
  assert.ok(month);
  let rows = false;
  css.walkRules(".availability-row", (rule) => (rows = rule.toString().includes("auto-fit")));
  assert.ok(rows);
});
