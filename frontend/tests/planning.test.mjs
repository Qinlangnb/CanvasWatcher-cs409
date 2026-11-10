import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Week 3: calendar arithmetic (zoned.ts), task and event forms (forms.ts) and the planning labels in
// format.ts. Modules are transpiled and loaded as data URLs; their imports are rewritten to match.
const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText,
  ).toString("base64")}`;

const zonedUrl = moduleUrl(read("app/zoned.ts").replace('"luxon"', JSON.stringify(import.meta.resolve("luxon"))));
const apiUrl = moduleUrl(read("app/api.ts").replace('"../publicPath"', JSON.stringify(moduleUrl(read("publicPath.ts")))));
const zoned = await import(zonedUrl);
const forms = await import(moduleUrl(read("app/forms.ts").replace('"./api"', JSON.stringify(apiUrl)).replace('"./zoned"', JSON.stringify(zonedUrl))));
const format = await import(moduleUrl(read("app/format.ts")));

const CHICAGO = "America/Chicago";
const SHANGHAI = "Asia/Shanghai";

const event = (fields) => ({ id: 1, title: "Lab", location: null, all_day: false, busy: true, source: null, editable: true, ...fields });
const task = (fields) => ({
  id: 1,
  title: "Problem set",
  type: "homework",
  source: "canvas",
  state: "open",
  due_at: null,
  completed_at: null,
  ignored_at: null,
  submission_state: null,
  progress: 0,
  estimated_minutes: null,
  remaining_minutes: 120,
  notes: null,
  ...fields,
});

// --- zoned.ts ---

test("local dates follow the planning zone, not the browser's", () => {
  // 04:30 UTC on Nov 7 is still the evening of Nov 6 in Chicago.
  assert.equal(zoned.localDate("2026-11-07T04:30:00Z", CHICAGO), "2026-11-06");
  assert.equal(zoned.localDate(new Date("2026-11-07T04:30:00Z"), SHANGHAI), "2026-11-07");
  assert.equal(zoned.addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(zoned.addDays("2026-11-01", -1), "2026-10-31");
  assert.equal(zoned.daysBetween("2026-11-06", "2026-11-20"), 14);
  assert.equal(zoned.daysBetween("2026-11-06", "2026-11-05"), -1);
});

test("weeks start on Sunday and their range covers whole local days across a DST change", () => {
  const week = zoned.weekOf("2026-11-06");
  assert.deepEqual(week, ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"]);
  assert.deepEqual(zoned.weekOf("2026-11-01"), week);
  // Chicago leaves daylight time at 2 AM on Nov 1: midnight is UTC-5, a week later UTC-6.
  assert.deepEqual(zoned.rangeOf(week[0], week[6], CHICAGO), { from: "2026-11-01T05:00:00.000Z", to: "2026-11-08T06:00:00.000Z" });
});

test("events land on the local days they cover", () => {
  // All-day ends are exclusive.
  assert.deepEqual(zoned.eventDates(event({ all_day: true, start: "2026-11-06", end: "2026-11-08" }), CHICAGO), ["2026-11-06", "2026-11-07"]);
  // 10 PM to midnight stays on one day; 10 PM to 2 AM spills over.
  const toMidnight = event({ start: "2026-11-07T04:00:00Z", end: "2026-11-07T06:00:00Z" });
  const overnight = event({ start: "2026-11-07T04:00:00Z", end: "2026-11-07T08:00:00Z" });
  assert.deepEqual(zoned.eventDates(toMidnight, CHICAGO), ["2026-11-06"]);
  assert.deepEqual(zoned.eventDates(overnight, CHICAGO), ["2026-11-06", "2026-11-07"]);
  assert.match(zoned.eventTimeLabel(overnight, "2026-11-06", CHICAGO), /^From 10:00\sPM$/);
  assert.match(zoned.eventTimeLabel(overnight, "2026-11-07", CHICAGO), /^Until 2:00\sAM$/);
  assert.match(zoned.eventTimeLabel(toMidnight, "2026-11-06", CHICAGO), /^10:00\sPM – 12:00\sAM$/);
  assert.equal(zoned.eventTimeLabel(event({ all_day: true, start: "2026-11-06", end: "2026-11-07" }), "2026-11-06", CHICAGO), "All day");

  const groups = zoned.groupByDate(["2026-11-06", "2026-11-07"], [overnight, toMidnight], (item) => zoned.eventDates(item, CHICAGO));
  assert.equal(groups.get("2026-11-06").length, 2);
  assert.equal(groups.get("2026-11-07").length, 1);
  assert.equal(groups.has("2026-11-05"), false);

  const allDay = event({ all_day: true, start: "2026-11-06", end: "2026-11-07", title: "Holiday" });
  assert.deepEqual([toMidnight, allDay].sort(zoned.eventOrder), [allDay, toMidnight]);
});

test("datetime-local values round-trip through the planning zone", () => {
  assert.equal(zoned.toLocalInput("2026-11-07T04:30:00Z", CHICAGO), "2026-11-06T22:30");
  assert.equal(zoned.toLocalInput(null, CHICAGO), "");
  assert.equal(zoned.fromLocalInput("2026-11-06T22:30", CHICAGO), "2026-11-06T22:30:00-06:00");
  assert.equal(zoned.fromLocalInput("", CHICAGO), null);
  assert.equal(zoned.fromLocalInput("not a date", CHICAGO), null);
});

test("day and week labels read naturally", () => {
  assert.equal(zoned.dateLabel("2026-11-06", "2026-11-06"), "Today");
  assert.equal(zoned.dateLabel("2026-11-07", "2026-11-06"), "Tomorrow");
  assert.equal(zoned.dateLabel("2026-11-05", "2026-11-06"), "Yesterday");
  assert.equal(zoned.dateLabel("2026-11-10", "2026-11-06"), "Tue, Nov 10");
  assert.deepEqual(zoned.weekdayLabel("2026-11-06"), { weekday: "Fri", day: "6", full: "Friday, November 6" });
  assert.equal(zoned.weekRangeLabel(zoned.weekOf("2026-11-06")), "Nov 1 – 7, 2026");
  assert.equal(zoned.weekRangeLabel(zoned.weekOf("2026-09-30")), "Sep 27 – Oct 3, 2026");
  assert.equal(zoned.weekRangeLabel(zoned.weekOf("2026-12-31")), "Dec 27, 2026 – Jan 2, 2027");
});

test("the timeline groups open work by due date and shows when the daily goal falls short", () => {
  const tasks = [
    task({ id: 1, state: "overdue", due_at: "2026-11-05T12:00:00Z", remaining_minutes: 60 }),
    task({ id: 2, due_at: "2026-11-06T20:00:00Z", remaining_minutes: 120 }),
    task({ id: 3, due_at: "2026-11-07T20:00:00Z", remaining_minutes: 200 }),
    task({ id: 4, due_at: "2026-12-20T20:00:00Z" }),
    task({ id: 5 }),
    task({ id: 6, state: "done", due_at: "2026-11-07T10:00:00Z" }),
    task({ id: 7, due_at: "2026-11-20T10:00:00Z", remaining_minutes: 30 }),
  ];
  const timeline = zoned.buildTimeline(tasks, { today: "2026-11-06", zone: "UTC", length: 28, dailyMinutes: 120 });
  assert.deepEqual(timeline.overdue.map((item) => item.id), [1]);
  assert.deepEqual(timeline.later.map((item) => item.id), [4]);
  assert.deepEqual(timeline.undated.map((item) => item.id), [5]);
  assert.deepEqual(
    timeline.days.map((day) => [day.date, day.tasks.map((item) => item.id), day.minutes, day.shortfall]),
    [
      // Overdue work counts first: 60 + 120 due by tonight against 120 minutes of study.
      ["2026-11-06", [2], 120, 60],
      ["2026-11-07", [3], 200, 140],
      // Two weeks of study time catch up.
      ["2026-11-20", [7], 30, 0],
    ],
  );
});

// --- forms.ts ---

test("estimates default like the server and shrink with progress", () => {
  assert.equal(forms.defaultMinutes("exam"), 180);
  assert.equal(forms.defaultMinutes("something new"), 60);
  assert.equal(forms.remainingOf(120, 0), 120);
  assert.equal(forms.remainingOf(120, 50), 60);
  assert.equal(forms.remainingOf(120, 99), 5);
  assert.equal(forms.remainingOf(120, 100), 0);
  assert.equal(forms.remainingOf(45, 33), 30);
  assert.deepEqual(forms.parseEstimate(""), { minutes: null });
  assert.deepEqual(forms.parseEstimate(" 90 "), { minutes: 90 });
  for (const bad of ["4", "6001", "1.5", "an hour"]) assert.ok(forms.parseEstimate(bad).error, bad);
});

test("work handed in on Canvas is locked as done", () => {
  assert.equal(forms.isSubmitted(task({ submission_state: "graded" })), true);
  assert.equal(forms.isSubmitted(task({ submission_state: "unsubmitted" })), false);
  assert.equal(forms.isSubmitted(task({ source: "personal", submission_state: "graded" })), false);
});

test("a task save sends only what changed, and never Canvas-owned fields", () => {
  const canvas = task({ due_at: "2026-11-07T20:00:00Z", notes: "Read ch. 3" });
  const initial = forms.taskDraft(canvas, CHICAGO);
  assert.deepEqual(initial, {
    title: "Problem set",
    type: "homework",
    due: "2026-11-07T14:00",
    status: "open",
    progress: 0,
    estimate: "",
    notes: "Read ch. 3",
  });
  assert.deepEqual(forms.taskChanges(canvas, initial, initial, CHICAGO), { changes: {}, errors: {} });

  const edited = { ...initial, title: "Renamed", due: "2026-11-08T09:00", status: "done", progress: 40, estimate: "90", notes: "  " };
  assert.deepEqual(forms.taskChanges(canvas, initial, edited, CHICAGO), {
    changes: { done: true, ignored: false, progress: 40, estimated_minutes: 90, notes: null },
    errors: {},
  });
  assert.deepEqual(forms.taskChanges(canvas, initial, { ...initial, estimate: "2" }, CHICAGO).errors, {
    estimated_minutes: "Enter whole minutes from 5 to 6000, or leave it empty for the default.",
  });

  const personal = task({ source: "personal", due_at: "2026-11-07T20:00:00Z", completed_at: "2026-11-06T10:00:00Z" });
  const mine = forms.taskDraft(personal, CHICAGO);
  assert.equal(mine.status, "done");
  assert.deepEqual(forms.taskChanges(personal, mine, { ...mine, title: " Essay ", type: "project", due: "2026-11-08T09:00" }, CHICAGO).changes, {
    title: "Essay",
    type: "project",
    due_at: "2026-11-08T09:00:00-06:00",
  });
  assert.deepEqual(forms.taskChanges(personal, mine, { ...mine, due: "" }, CHICAGO).changes, { due_at: null });
  assert.deepEqual(forms.taskChanges(personal, mine, { ...mine, title: "  " }, CHICAGO).errors, { title: "Give the task a title." });
});

test("event forms turn inclusive last days into exclusive ends and check the order", () => {
  const allDay = { title: " Fall break ", location: "", allDay: true, start: "2026-11-25", end: "2026-11-27", busy: false };
  assert.deepEqual(forms.eventBody(allDay, CHICAGO), {
    errors: {},
    body: { title: "Fall break", location: null, all_day: true, start: "2026-11-25", end: "2026-11-28", busy: false },
  });
  assert.deepEqual(forms.eventBody({ ...allDay, end: "2026-11-24" }, CHICAGO).errors, { end: "The last day can't be before the first." });

  const timed = { title: "Office hours", location: "Siebel 0216", allDay: false, start: "2026-11-06T15:00", end: "2026-11-06T16:30", busy: true };
  assert.deepEqual(forms.eventBody(timed, CHICAGO).body, {
    title: "Office hours",
    location: "Siebel 0216",
    all_day: false,
    start: "2026-11-06T15:00:00-06:00",
    end: "2026-11-06T16:30:00-06:00",
    busy: true,
  });
  const backwards = forms.eventBody({ ...timed, title: "", end: "2026-11-06T14:00" }, CHICAGO);
  assert.equal(backwards.body, undefined);
  assert.deepEqual(backwards.errors, { title: "Give the event a title.", end: "It has to end after it starts." });

  // Editing shows the inclusive last day; a new event on another day starts at 9 AM.
  const stored = event({ all_day: true, start: "2026-11-25", end: "2026-11-28", busy: false });
  assert.equal(forms.eventDraft(stored, "2026-11-25", CHICAGO, new Date("2026-11-06T18:00:00Z")).end, "2026-11-27");
  const fresh = forms.eventDraft(undefined, "2026-11-10", CHICAGO, new Date("2026-11-06T18:00:00Z"));
  assert.deepEqual([fresh.start, fresh.end, fresh.busy], ["2026-11-10T09:00", "2026-11-10T10:00", true]);
  // Today: the next whole hour (noon in Chicago → 1 PM).
  const today = forms.eventDraft(undefined, "2026-11-06", CHICAGO, new Date("2026-11-06T18:20:00Z"));
  assert.deepEqual([today.start, today.end], ["2026-11-06T13:00", "2026-11-06T14:00"]);
});

test("server problems become field messages or one sentence", () => {
  assert.deepEqual(forms.problemsOf(null), { fields: {}, general: null });
  assert.deepEqual(forms.problemsOf(new Error("The server had a problem.")), { fields: {}, general: "The server had a problem." });
});

// --- format.ts ---

test("planning labels: minutes, clock times, reasons and zoned days", () => {
  assert.equal(format.formatMinutes(45), "45 min");
  assert.equal(format.formatMinutes(120), "2 h");
  assert.equal(format.formatMinutes(150), "2 h 30 min");
  assert.equal(format.formatMinutes(-5), "0 min");
  assert.equal(format.formatMinuteOfDay(0), "Midnight");
  assert.equal(format.formatMinuteOfDay(30), "12:30 AM");
  assert.equal(format.formatMinuteOfDay(540), "9:00 AM");
  assert.equal(format.formatMinuteOfDay(720), "Noon");
  assert.equal(format.formatMinuteOfDay(750), "12:30 PM");
  assert.equal(format.formatMinuteOfDay(1410), "11:30 PM");
  assert.equal(format.formatMinuteOfDay(1440), "Midnight");
  assert.deepEqual(Object.keys(format.REASON_LABELS).sort(), ["due_today", "get_ahead", "low_slack", "overdue", "quick_finish", "started"]);
  assert.equal(format.TASK_TYPE_LABELS.other, "Other");

  const instant = new Date("2026-11-07T04:30:00Z");
  assert.equal(format.dayKey(instant, CHICAGO), "2026-11-06");
  assert.equal(format.dayKey(instant, SHANGHAI), "2026-11-07");
  assert.equal(format.hourOf(instant, CHICAGO), 22);
  assert.equal(format.hourOf(instant, SHANGHAI), 12);
  const now = new Date("2026-11-06T18:00:00Z");
  assert.match(format.formatDue(instant.toISOString(), now, CHICAGO), /^Today, 10:30\sPM$/);
  assert.match(format.formatDue(instant.toISOString(), now, SHANGHAI), /^Today, 12:30\sPM$/);
  assert.equal(format.formatLongDate(instant, CHICAGO), "Friday, November 6");
});

test("due next week labels each day relative to today in the planning zone", () => {
  const now = new Date("2026-11-06T18:00:00Z"); // Friday noon in Chicago
  assert.equal(format.dueDayLabel("2026-11-07T05:59:00Z", now, CHICAGO), "Today");
  assert.equal(format.dueDayLabel("2026-11-07T06:00:00Z", now, CHICAGO), "Tomorrow");
  assert.equal(format.dueDayLabel("2026-11-11T05:59:00Z", now, CHICAGO), "Tue, Nov 10");
  // 9 AM Saturday in Chicago is still Saturday, today, in Shanghai.
  assert.equal(format.dueDayLabel("2026-11-07T15:00:00Z", now, CHICAGO), "Tomorrow");
  assert.equal(format.dueDayLabel("2026-11-07T15:00:00Z", now, SHANGHAI), "Today");
  assert.deepEqual(format.REASON_LABELS.started, { label: "Started early", tone: "accent" });
});

test("a finished sync reads as success, gaps or failure", () => {
  const run = (fields) => ({ status: "succeeded", changes_detected: 0, error: null, ...fields });
  assert.deepEqual(format.syncOutcome(run()), { label: "Sync finished", detail: "Nothing new", tone: "success" });
  assert.deepEqual(format.syncOutcome(run({ changes_detected: 3 })), { label: "Sync finished", detail: "3 changes found", tone: "success" });
  assert.deepEqual(format.syncOutcome(run({ status: "partial", changes_detected: 1 })), {
    label: "Sync finished with gaps",
    detail: "1 change found",
    tone: "warning",
  });
  assert.equal(format.syncOutcome(run({ status: "partial", error: "CS 409 files could not be read." })).detail, "CS 409 files could not be read.");
  assert.deepEqual(format.syncOutcome(run({ status: "failed", error: "Canvas rejected the token." })), {
    label: "Sync failed",
    detail: "Canvas rejected the token.",
    tone: "danger",
  });
  assert.match(format.syncOutcome(run({ status: "failed" })).detail, /could not be reached/);
});
