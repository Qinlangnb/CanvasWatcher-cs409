// Week 3 endpoints: settings, task writes, the calendar and Today.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fakeCanvas, seedCourse } from "./fakeCanvas.js";
import { Browser, connectCanvas, db, resetDatabase, signUp, syncNow } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
  fakeCanvas.reset();
});
afterAll(() => db.$disconnect());

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString();

/** Ada with the synced CS 409 course; returns her browser and the course id. */
async function adaWithCourse(): Promise<{ ada: Browser; courseId: number }> {
  seedCourse(fakeCanvas);
  const ada = await signUp();
  await connectCanvas(ada);
  const [course] = (await ada.send("get", "/api/courses")).body;
  return { ada, courseId: course.id };
}

async function bob(): Promise<Browser> {
  return signUp({ username: "bob", email: "bob@example.com" });
}

function ics(...events: string[][]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", "X-WR-CALNAME:Classes", ...events.flat(), "END:VCALENDAR", ""].join(
    "\r\n",
  );
}

/** A UTC timestamp in iCalendar form, `ms` from now. */
const icsTime = (ms: number) => new Date(Date.now() + ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

describe("settings", () => {
  it("returns the defaults until the user saves", async () => {
    const ada = await signUp();
    const res = await ada.send("get", "/api/settings");
    expect(res.body).toEqual({
      time_zone: "America/Chicago",
      daily_study_minutes: 180,
      study_start_minute: 540,
      study_end_minute: 1320,
    });
    expect(await db.userSettings.count()).toBe(0);
  });

  it("saves changes and validates them", async () => {
    const ada = await signUp();
    const saved = await ada.send("patch", "/api/settings", { body: { time_zone: "Asia/Shanghai", daily_study_minutes: 240 } });
    expect(saved.body).toMatchObject({ time_zone: "Asia/Shanghai", daily_study_minutes: 240, study_start_minute: 540 });
    expect((await ada.send("get", "/api/settings")).body.time_zone).toBe("Asia/Shanghai");

    const zone = await ada.send("patch", "/api/settings", { body: { time_zone: "Mars/Olympus" } });
    expect(zone.status).toBe(422);
    expect(zone.body.detail[0].loc).toEqual(["body", "time_zone"]);
    const window = await ada.send("patch", "/api/settings", { body: { study_start_minute: 600, study_end_minute: 610 } });
    expect(window.status).toBe(422);
    expect(window.body.detail[0].loc).toEqual(["body", "study_end_minute"]);
    const unknown = await ada.send("patch", "/api/settings", { body: { theme: "dark" } });
    expect(unknown.status).toBe(422);
  });
});

describe("task writes", () => {
  it("adds personal tasks to the user's own courses only", async () => {
    const { ada, courseId } = await adaWithCourse();
    const created = await ada.send("post", "/api/tasks", {
      body: { course_id: courseId, title: "  Review lecture 9 ", type: "reading", due_at: fromNow(DAY), estimated_minutes: 50 },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      source: "personal",
      title: "Review lecture 9",
      type: "reading",
      progress: 0,
      estimated_minutes: 50,
      total_minutes: 50,
      remaining_minutes: 50,
      state: "open",
      course: { id: courseId },
    });

    const other = await bob();
    const foreign = await other.send("post", "/api/tasks", { body: { course_id: courseId, title: "Sneaky" } });
    expect(foreign.status).toBe(422);
    expect(foreign.body.detail[0].loc).toEqual(["body", "course_id"]);
    expect((await other.send("get", `/api/tasks/${created.body.id}`)).status).toBe(404);
    expect((await other.send("patch", `/api/tasks/${created.body.id}`, { body: { done: true } })).status).toBe(404);
    expect((await other.send("delete", `/api/tasks/${created.body.id}`)).status).toBe(404);
  });

  it("tracks progress, estimates, notes, done and ignored", async () => {
    const { ada } = await adaWithCourse();
    const [mp] = (await ada.send("get", "/api/tasks")).body;
    expect(mp).toMatchObject({ source: "canvas", type: "assignment", estimated_minutes: null, total_minutes: 120 });

    const progress = await ada.send("patch", `/api/tasks/${mp.id}`, {
      body: { progress: 40, estimated_minutes: 300, notes: "Grid first" },
    });
    expect(progress.body).toMatchObject({ progress: 40, estimated_minutes: 300, remaining_minutes: 180, notes: "Grid first" });

    const done = await ada.send("patch", `/api/tasks/${mp.id}`, { body: { done: true } });
    expect(done.body).toMatchObject({ state: "done", remaining_minutes: 0 });
    expect(done.body.completed_at).not.toBeNull();
    expect((await ada.send("get", "/api/tasks")).body).toEqual([]);
    const undone = await ada.send("patch", `/api/tasks/${mp.id}`, { body: { done: false } });
    expect(undone.body).toMatchObject({ completed_at: null, remaining_minutes: 180 });

    const ignored = await ada.send("patch", `/api/tasks/${mp.id}`, { body: { ignored: true } });
    expect(ignored.body.state).toBe("ignored");

    const bad = await ada.send("patch", `/api/tasks/${mp.id}`, { body: { progress: 120, estimated_minutes: 2 } });
    expect(bad.status).toBe(422);
    expect(bad.body.detail.map((issue: { loc: string[] }) => issue.loc[1])).toEqual(["progress", "estimated_minutes"]);
  });

  it("leaves Canvas-owned fields and Canvas tasks to Canvas", async () => {
    const { ada } = await adaWithCourse();
    const [mp] = (await ada.send("get", "/api/tasks")).body;
    const rename = await ada.send("patch", `/api/tasks/${mp.id}`, { body: { title: "Renamed" } });
    expect(rename.status).toBe(409);
    expect(rename.body.code).toBe("TASK_FROM_CANVAS");
    expect((await ada.send("delete", `/api/tasks/${mp.id}`)).status).toBe(409);
  });

  it("edits and deletes personal tasks", async () => {
    const { ada, courseId } = await adaWithCourse();
    const { body: task } = await ada.send("post", "/api/tasks", { body: { course_id: courseId, title: "Study group" } });
    expect(task).toMatchObject({ type: "other", due_at: null, total_minutes: 60 });
    const due = fromNow(2 * DAY);
    const edited = await ada.send("patch", `/api/tasks/${task.id}`, { body: { title: "Study group prep", type: "exam", due_at: due } });
    expect(edited.body).toMatchObject({ title: "Study group prep", type: "exam", due_at: due, total_minutes: 180 });
    expect((await ada.send("delete", `/api/tasks/${task.id}`)).status).toBe(204);
    expect((await ada.send("get", `/api/tasks/${task.id}`)).status).toBe(404);
  });

  it("keeps personal tasks and progress through later syncs", async () => {
    const { ada, courseId } = await adaWithCourse();
    const [mp] = (await ada.send("get", "/api/tasks")).body;
    await ada.send("patch", `/api/tasks/${mp.id}`, { body: { progress: 60 } });
    const { body: personal } = await ada.send("post", "/api/tasks", { body: { course_id: courseId, title: "Flashcards" } });
    // The assignment list Canvas returns no longer includes anything.
    fakeCanvas.assignments.set("101", []);
    await syncNow(ada);
    const all = (await ada.send("get", "/api/tasks?status=all")).body;
    expect(all.map((task: { title: string }) => task.title)).toEqual(["Flashcards"]);
    fakeCanvas.reset();
    seedCourse(fakeCanvas);
    await syncNow(ada);
    const back = (await ada.send("get", "/api/tasks")).body;
    expect(back.map((task: { id: number; progress: number }) => [task.id, task.progress])).toEqual([
      [mp.id, 60],
      [personal.id, 0],
    ]);
  });

  it("filters by due date", async () => {
    const { ada, courseId } = await adaWithCourse();
    for (const [title, due] of [
      ["Tomorrow", fromNow(DAY)],
      ["Next week", fromNow(7 * DAY)],
    ] as const) {
      await ada.send("post", "/api/tasks", { body: { course_id: courseId, title, due_at: due } });
    }
    const range = `due_after=${encodeURIComponent(fromNow(0))}&due_before=${encodeURIComponent(fromNow(3 * DAY))}`;
    const res = await ada.send("get", `/api/tasks?status=all&${range}`);
    expect(res.body.map((task: { title: string }) => task.title)).toEqual(["Tomorrow"]);
    expect((await ada.send("get", "/api/tasks?due_after=yesterday")).status).toBe(400);
  });
});

describe("calendar", () => {
  it("adds, lists, edits and deletes the user's own events", async () => {
    const ada = await signUp();
    const start = fromNow(HOUR);
    const end = fromNow(2 * HOUR);
    const created = await ada.send("post", "/api/calendar/events", { body: { title: "Shift at the library", start, end } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: "Shift at the library", all_day: false, start, end, busy: true, editable: true, source: null });

    const allDay = await ada.send("post", "/api/calendar/events", {
      body: { title: "Career fair", all_day: true, start: "2026-11-12", end: "2026-11-13" },
    });
    expect(allDay.body).toMatchObject({ start: "2026-11-12", end: "2026-11-13", busy: false });

    const range = `from=${encodeURIComponent(fromNow(-DAY))}&to=${encodeURIComponent(fromNow(DAY))}`;
    const listed = await ada.send("get", `/api/calendar/events?${range}`);
    expect(listed.body.map((event: { title: string }) => event.title)).toEqual(["Shift at the library"]);

    const moved = await ada.send("patch", `/api/calendar/events/${created.body.id}`, {
      body: { end: fromNow(3 * HOUR), busy: false, location: "Grainger" },
    });
    expect(moved.body).toMatchObject({ start, busy: false, location: "Grainger" });
    expect((await ada.send("delete", `/api/calendar/events/${created.body.id}`)).status).toBe(204);

    const other = await bob();
    expect((await other.send("get", `/api/calendar/events?${range}`)).body).toEqual([]);
    expect((await other.send("delete", `/api/calendar/events/${allDay.body.id}`)).status).toBe(404);
  });

  it("validates event times and ranges", async () => {
    const ada = await signUp();
    const backwards = await ada.send("post", "/api/calendar/events", {
      body: { title: "Oops", start: fromNow(2 * HOUR), end: fromNow(HOUR) },
    });
    expect(backwards.status).toBe(422);
    expect(backwards.body.detail[0].loc).toEqual(["body", "end"]);
    const naive = await ada.send("post", "/api/calendar/events", {
      body: { title: "No zone", start: "2026-11-06T09:00:00", end: "2026-11-06T10:00:00" },
    });
    expect(naive.body.detail[0].loc).toEqual(["body", "start"]);
    const wide = await ada.send("get", `/api/calendar/events?from=${encodeURIComponent(fromNow(0))}&to=${encodeURIComponent(fromNow(90 * DAY))}`);
    expect(wide.status).toBe(400);
  });

  it("imports an .ics file, lists its events and removes them with it", async () => {
    const ada = await signUp();
    const file = ics(
      [
        "BEGIN:VEVENT",
        "UID:lecture",
        "SUMMARY:CS 409 Lecture",
        `DTSTART:${icsTime(2 * HOUR)}`,
        "DURATION:PT75M",
        "RRULE:FREQ=WEEKLY;COUNT=3",
        "END:VEVENT",
      ],
      // Far in the past: outside the import window.
      ["BEGIN:VEVENT", "UID:old", "SUMMARY:Old", "DTSTART:20200101T150000Z", "DURATION:PT1H", "END:VEVENT"],
    );
    const imported = await ada.send("post", "/api/calendar/sources", { body: { file_name: "cs409.ics", ics: file } });
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({ name: "Classes", file_name: "cs409.ics", event_count: 3, truncated: false });
    expect((await ada.send("get", "/api/calendar/sources")).body).toEqual([expect.objectContaining({ event_count: 3 })]);

    const range = `from=${encodeURIComponent(fromNow(0))}&to=${encodeURIComponent(fromNow(20 * DAY))}`;
    const events = (await ada.send("get", `/api/calendar/events?${range}`)).body;
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ title: "CS 409 Lecture", editable: false, source: { name: "Classes" } });
    const edit = await ada.send("patch", `/api/calendar/events/${events[0].id}`, { body: { title: "Mine now" } });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("EVENT_IMPORTED");

    expect((await (await bob()).send("delete", `/api/calendar/sources/${imported.body.id}`)).status).toBe(404);
    expect((await ada.send("delete", `/api/calendar/sources/${imported.body.id}`)).status).toBe(204);
    expect((await ada.send("get", `/api/calendar/events?${range}`)).body).toEqual([]);
  });

  it("rejects files that aren't calendars or have nothing to import", async () => {
    const ada = await signUp();
    const junk = await ada.send("post", "/api/calendar/sources", { body: { ics: "not a calendar" } });
    expect(junk.status).toBe(422);
    expect(junk.body.detail[0].loc).toEqual(["body", "ics"]);
    const empty = await ada.send("post", "/api/calendar/sources", { body: { ics: ics() } });
    expect(empty.status).toBe(422);
    expect(empty.body.detail[0].msg).toMatch(/no events/);
  });

  it("accepts large .ics uploads only there, and only when signed in", async () => {
    const padding = Array.from({ length: 4000 }, (_, i) => `X-PAD-${i}:${"x".repeat(60)}`);
    const big = ics(["BEGIN:VEVENT", "UID:big", "SUMMARY:Big", `DTSTART:${icsTime(HOUR)}`, "DURATION:PT1H", ...padding, "END:VEVENT"]);
    expect(big.length).toBeGreaterThan(200_000);
    const stranger = new Browser();
    expect((await stranger.send("post", "/api/calendar/sources", { body: { ics: big } })).status).toBe(401);
    const ada = await signUp();
    expect((await ada.send("post", "/api/calendar/sources", { body: { ics: big } })).status).toBe(201);
    const tooBigElsewhere = await ada.send("post", "/api/calendar/events", { body: { title: big, start: fromNow(0), end: fromNow(HOUR) } });
    expect(tooBigElsewhere.status).toBe(413);
  });
});

describe("today", () => {
  it("plans due work around busy events and lists today's events and finished work", async () => {
    const { ada, courseId } = await adaWithCourse();
    // A study window covering the whole day keeps the numbers independent of when the test runs.
    await ada.send("patch", "/api/settings", { body: { time_zone: "UTC", study_start_minute: 0, study_end_minute: 1440 } });
    const add = (title: string, dueMs: number | null, minutes = 60) =>
      ada.send("post", "/api/tasks", {
        body: { course_id: courseId, title, due_at: dueMs === null ? null : fromNow(dueMs), estimated_minutes: minutes },
      });
    const overdue = (await add("Late lab", -HOUR)).body;
    await add("Essay", 9 * DAY, 120);
    await add("Old", -10 * DAY);
    const finished = (await add("Done already", DAY)).body;
    await ada.send("patch", `/api/tasks/${finished.id}`, { body: { done: true } });

    const res = await ada.send("get", "/api/today");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ time_zone: "UTC", goal_minutes: 180, date: new Date().toISOString().slice(0, 10) });
    const titles = res.body.items.map((item: { task: { title: string } }) => item.task.title);
    expect(titles[0]).toBe("Late lab");
    expect(titles).not.toContain("Old");
    expect(res.body.items[0]).toMatchObject({ reasons: ["overdue"], remaining_minutes: 60, task: { id: overdue.id } });
    expect(res.body.due_today_minutes).toBeGreaterThanOrEqual(60);
    expect(res.body.done_today.map((task: { id: number }) => task.id)).toEqual([finished.id]);
    expect(res.body.planned_minutes).toBe(
      res.body.items.reduce((sum: number, item: { planned_minutes: number }) => sum + item.planned_minutes, 0),
    );
    // Work due later only fills capacity that is left, so it always gets some time.
    for (const item of res.body.items.filter((item: { reasons: string[] }) => item.reasons.includes("get_ahead"))) {
      expect(item.planned_minutes).toBeGreaterThan(0);
    }

    // A busy event right now takes free time away.
    const before = res.body.free_minutes;
    await ada.send("post", "/api/calendar/events", { body: { title: "Lecture", start: fromNow(-HOUR), end: fromNow(HOUR) } });
    const after = (await ada.send("get", "/api/today")).body;
    expect(after.free_minutes).toBeLessThan(before);
    expect(after.events.map((event: { title: string }) => event.title)).toContain("Lecture");
  });

  it("only plans the signed-in user's tasks", async () => {
    const { ada, courseId } = await adaWithCourse();
    await ada.send("post", "/api/tasks", { body: { course_id: courseId, title: "Ada's", due_at: fromNow(HOUR) } });
    const other = await bob();
    const res = await other.send("get", "/api/today");
    expect(res.body.items).toEqual([]);
    expect(res.body.events).toEqual([]);
  });
});
