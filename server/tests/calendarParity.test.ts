// Calendar parity endpoints: availability and overrides, commute, recurring and zoned events,
// the calendar view, capacity, and .ics preview / re-import.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fakeCanvas, seedCourse } from "./fakeCanvas.js";
import { type Browser, connectCanvas, db, resetDatabase, signUp } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
  fakeCanvas.reset();
});
afterAll(() => db.$disconnect());

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString();
const range = (fromMs: number, toMs: number) => `from=${encodeURIComponent(fromNow(fromMs))}&to=${encodeURIComponent(fromNow(toMs))}`;
const bob = () => signUp({ username: "bob", email: "bob@example.com" });

async function adaWithCourse(): Promise<{ ada: Browser; courseId: number }> {
  seedCourse(fakeCanvas);
  const ada = await signUp();
  await connectCanvas(ada);
  const [course] = (await ada.send("get", "/api/courses")).body;
  return { ada, courseId: course.id };
}

function ics(...lines: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", "X-WR-CALNAME:Classes", ...lines, "END:VCALENDAR", ""].join("\r\n");
}

/** A UTC timestamp in iCalendar form, `ms` from now. */
const icsTime = (ms: number) => new Date(Date.now() + ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const vevent = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");

describe("study availability", () => {
  it("replaces weekly rules, validates them and keeps them per user", async () => {
    const ada = await signUp();
    expect((await ada.send("get", "/api/calendar/availability")).body).toEqual([]);
    const saved = await ada.send("put", "/api/calendar/availability", {
      body: [
        { weekday: 0, start_local_time: "13:00", end_local_time: "17:00" },
        { weekday: 0, start_local_time: "09:00", end_local_time: "12:00", enabled: true },
        { weekday: 6, start_local_time: "10:00", end_local_time: "11:00", enabled: false },
      ],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.map((rule: { start_local_time: string }) => rule.start_local_time)).toEqual(["09:00", "13:00", "10:00"]);
    expect(saved.body[2]).toMatchObject({ weekday: 6, enabled: false });

    const backwards = await ada.send("put", "/api/calendar/availability", { body: [{ weekday: 1, start_local_time: "12:00", end_local_time: "09:00" }] });
    expect(backwards.status).toBe(422);
    const overlap = await ada.send("put", "/api/calendar/availability", {
      body: [
        { weekday: 1, start_local_time: "09:00", end_local_time: "12:00" },
        { weekday: 1, start_local_time: "11:00", end_local_time: "13:00" },
      ],
    });
    expect(overlap.status).toBe(422);
    expect((await ada.send("put", "/api/calendar/availability", { body: [{ weekday: 7, start_local_time: "09:00", end_local_time: "10:00" }] })).status).toBe(422);
    expect((await ada.send("get", "/api/calendar/availability")).body).toHaveLength(3);
    expect((await (await bob()).send("get", "/api/calendar/availability")).body).toEqual([]);
  });

  it("sets, lists and removes date overrides; an empty one means unavailable", async () => {
    const ada = await signUp();
    const put = await ada.send("put", "/api/calendar/availability/overrides/2026-12-24", { body: { date: "2026-12-24", available_intervals: [] } });
    expect(put.body).toMatchObject({ date: "2026-12-24", available_intervals: [] });
    await ada.send("put", "/api/calendar/availability/overrides/2026-12-20", {
      body: { date: "2026-12-20", available_intervals: [{ start: "10:00", end: "12:00" }] },
    });
    const again = await ada.send("put", "/api/calendar/availability/overrides/2026-12-20", {
      body: { date: "2026-12-20", available_intervals: [{ start: "14:00", end: "15:30" }] },
    });
    expect(again.body.available_intervals).toEqual([{ start: "14:00", end: "15:30" }]);
    const mismatch = await ada.send("put", "/api/calendar/availability/overrides/2026-12-21", { body: { date: "2026-12-22" } });
    expect(mismatch.status).toBe(422);
    expect((await ada.send("put", "/api/calendar/availability/overrides/2026-02-30", { body: { date: "2026-02-30" } })).status).toBe(404);

    const list = (await ada.send("get", "/api/calendar/availability/overrides")).body;
    expect(list.map((row: { date: string }) => row.date)).toEqual(["2026-12-20", "2026-12-24"]);
    expect((await (await bob()).send("get", "/api/calendar/availability/overrides")).body).toEqual([]);
    expect((await ada.send("delete", "/api/calendar/availability/overrides/2026-12-24")).status).toBe(204);
    expect((await ada.send("get", "/api/calendar/availability/overrides")).body).toHaveLength(1);
  });

  it("drives capacity and Today, with commute around class events", async () => {
    const { ada, courseId } = await adaWithCourse();
    await ada.send("patch", "/api/settings", { body: { time_zone: "UTC" } });
    const tomorrow = new Date(Date.now() + DAY).toISOString().slice(0, 10);
    const capacityRange = `from=${tomorrow}T00:00:00Z&to=${tomorrow}T23:59:59Z`;

    expect((await ada.send("get", `/api/calendar/capacity?${capacityRange}`)).body).toEqual({ minutes: null, source: "fallback", time_zone: "UTC" });
    const today = (await ada.send("get", "/api/today")).body;
    expect(today.capacity_source).toBe("fallback");

    await ada.send("put", `/api/calendar/availability/overrides/${tomorrow}`, {
      body: { date: tomorrow, available_intervals: [{ start: "09:00", end: "17:00" }] },
    });
    expect((await ada.send("get", `/api/calendar/capacity?${capacityRange}`)).body).toMatchObject({ minutes: 480, source: "availability" });

    // A class from 12:00 to 13:00 with a 30-minute commute takes two hours.
    const commute = await ada.send("patch", `/api/courses/${courseId}/commute`, { body: { commute_minutes: 30 } });
    expect(commute.body.commute_minutes).toBe(30);
    expect((await ada.send("patch", `/api/courses/${courseId}/commute`, { body: { commute_minutes: 241 } })).status).toBe(422);
    expect((await (await bob()).send("patch", `/api/courses/${courseId}/commute`, { body: { commute_minutes: 5 } })).status).toBe(404);
    const lecture = await ada.send("post", "/api/calendar/events", {
      body: { title: "Lecture", start: `${tomorrow}T12:00:00Z`, end: `${tomorrow}T13:00:00Z`, event_type: "class", course_id: courseId },
    });
    expect(lecture.status).toBe(201);
    expect(lecture.body).toMatchObject({ event_type: "class", course: { id: courseId } });
    expect((await ada.send("get", `/api/calendar/capacity?${capacityRange}`)).body).toMatchObject({ minutes: 360, source: "calendar" });

    const view = (await ada.send("get", `/api/calendar/view?${capacityRange}`)).body;
    expect(view.events.map((event: { title: string }) => event.title)).toEqual(["Lecture"]);
    expect(view.layers.map((layer: { kind: string }) => layer.kind).sort()).toEqual(["availability", "commute", "commute"]);
    expect(view.warnings).toEqual([]);

    // Weekly rules switch Today to availability for every configured day.
    await ada.send("put", "/api/calendar/availability", {
      body: Array.from({ length: 7 }, (_, weekday) => ({ weekday, start_local_time: "00:00", end_local_time: "23:59" })),
    });
    expect(["availability", "calendar"]).toContain((await ada.send("get", "/api/today")).body.capacity_source);
  });
});

describe("manual events", () => {
  it("stores recurring, zoned events and expands them in every range", async () => {
    const ada = await signUp();
    const created = await ada.send("post", "/api/calendar/events", {
      body: {
        title: "Study group",
        description: "Bring the problem set.",
        start: "2026-10-26T09:00",
        end: "2026-10-26T10:00",
        time_zone: "America/New_York",
        event_type: "study",
        recurrence_rule: "freq=weekly;byday=mo;count=4",
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      start: "2026-10-26T13:00:00.000Z",
      time_zone: "America/New_York",
      recurrence_rule: "FREQ=WEEKLY;COUNT=4;BYDAY=MO;WKST=MO",
      description: "Bring the problem set.",
      series: { start: "2026-10-26T13:00:00.000Z" },
    });
    const listed = (await ada.send("get", "/api/calendar/events?from=2026-10-25T00:00:00Z&to=2026-12-01T00:00:00Z")).body;
    // 9:00 in New York stays 9:00 after DST ends on 1 November.
    expect(listed.map((event: { start: string }) => event.start)).toEqual([
      "2026-10-26T13:00:00.000Z",
      "2026-11-02T14:00:00.000Z",
      "2026-11-09T14:00:00.000Z",
      "2026-11-16T14:00:00.000Z",
    ]);
    expect(new Set(listed.map((event: { key: string }) => event.key)).size).toBe(4);
    expect(listed.every((event: { id: number }) => event.id === created.body.id)).toBe(true);

    // Editing the series changes every occurrence; deleting removes them all.
    await ada.send("patch", `/api/calendar/events/${created.body.id}`, { body: { recurrence_rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=2" } });
    expect((await ada.send("get", "/api/calendar/events?from=2026-10-25T00:00:00Z&to=2026-12-01T00:00:00Z")).body).toHaveLength(2);
    expect((await (await bob()).send("patch", `/api/calendar/events/${created.body.id}`, { body: { title: "x" } })).status).toBe(404);
    expect((await ada.send("delete", `/api/calendar/events/${created.body.id}`)).status).toBe(204);
    expect((await ada.send("get", "/api/calendar/events?from=2026-10-25T00:00:00Z&to=2026-12-01T00:00:00Z")).body).toEqual([]);
  });

  it("refuses bad rules, zones, courses and daylight-saving gaps or overlaps", async () => {
    const ada = await signUp();
    const send = (body: object) =>
      ada.send("post", "/api/calendar/events", { body: { title: "Event", start: "2026-11-10T09:00", end: "2026-11-10T10:00", ...body } });
    const field = async (body: object) => {
      const res = await send(body);
      expect(res.status).toBe(422);
      return { field: res.body.detail[0].loc[1], message: res.body.detail[0].msg as string };
    };
    expect(await field({ recurrence_rule: "FREQ=DAILY;COUNT=2;UNTIL=20261201" })).toMatchObject({ field: "recurrence_rule" });
    expect(await field({ recurrence_rule: "FREQ=SECONDLY" })).toMatchObject({ field: "recurrence_rule" });
    expect(await field({ time_zone: "Mars/Olympus" })).toMatchObject({ field: "time_zone" });
    expect(await field({ event_type: "party" })).toMatchObject({ field: "event_type" });
    expect(await field({ course_id: 999999 })).toMatchObject({ field: "course_id" });
    // 2:30 on 8 March 2026 doesn't exist in Chicago; 1:30 on 1 November 2026 happens twice.
    expect(await field({ time_zone: "America/Chicago", start: "2026-03-08T02:30", end: "2026-03-08T04:00" })).toMatchObject({
      field: "start",
      message: expect.stringMatching(/daylight-saving time gap/),
    });
    expect(await field({ time_zone: "America/Chicago", start: "2026-11-01T01:30", end: "2026-11-01T03:00" })).toMatchObject({
      field: "start",
      message: expect.stringMatching(/occurs twice/),
    });
    expect((await send({ time_zone: "America/Chicago" })).body.start).toBe("2026-11-10T15:00:00.000Z");
  });
});

describe("ics import", () => {
  it("previews, asks for a zone for floating times, and imports with it", async () => {
    const ada = await signUp();
    const floating = ics(vevent("UID:float", "SUMMARY:Office hours", `DTSTART:${icsTime(DAY).replace("Z", "")}`, "DURATION:PT1H"));
    const preview = await ada.send("post", "/api/calendar/sources/preview", { body: { ics: floating, file_name: "office.ics" } });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      time_zone_confirmation_required: true,
      event_count: 1,
      reconciliation: { new: 1, updated: 0, removed: 0, unchanged: 0 },
      no_op: false,
    });
    const refused = await ada.send("post", "/api/calendar/sources", { body: { ics: floating } });
    expect(refused.status).toBe(422);
    expect(refused.body.detail[0].loc).toEqual(["body", "time_zone"]);
    const confirmed = await ada.send("post", "/api/calendar/sources/preview", { body: { ics: floating, time_zone: "America/Chicago" } });
    expect(confirmed.body).toMatchObject({ time_zone_confirmation_required: false, calendar_time_zone: "America/Chicago" });
    const imported = await ada.send("post", "/api/calendar/sources", { body: { ics: floating, time_zone: "America/Chicago" } });
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({ time_zone: "America/Chicago", event_count: 1, read_only: true });
  });

  it("re-imports by UID, confirms removals and skips the same file", async () => {
    const ada = await signUp();
    const [start, examAt, movedAt, quizAt] = [icsTime(2 * HOUR), icsTime(5 * DAY), icsTime(6 * DAY), icsTime(3 * DAY)];
    const lecture = vevent("UID:lecture", "SUMMARY:Lecture", `DTSTART:${start}`, "DURATION:PT75M", "RRULE:FREQ=WEEKLY;COUNT=3");
    const exam = vevent("UID:exam", "SUMMARY:Exam", `DTSTART:${examAt}`, "DURATION:PT2H");
    const first = ics(lecture, exam);
    const imported = await ada.send("post", "/api/calendar/sources", { body: { ics: first, file_name: "classes.ics" } });
    expect(imported.body).toMatchObject({ event_count: 4, recurring_series_count: 1 });
    const id = imported.body.id;

    // Same file: nothing to do.
    const same = await ada.send("post", `/api/calendar/sources/${id}/reimport`, { body: { ics: first } });
    expect(same.body.preview).toMatchObject({ no_op: true, reconciliation: { unchanged: 4 } });

    // The exam moved, a quiz was added, and the lecture series lost its last week.
    const second = ics(
      vevent("UID:lecture", "SUMMARY:Lecture", `DTSTART:${start}`, "DURATION:PT75M", "RRULE:FREQ=WEEKLY;COUNT=2"),
      vevent("UID:exam", "SUMMARY:Exam", `DTSTART:${movedAt}`, "DURATION:PT2H"),
      vevent("UID:quiz", "SUMMARY:Quiz", `DTSTART:${quizAt}`, "DURATION:PT30M"),
    );
    const preview = await ada.send("post", "/api/calendar/sources/preview", { body: { ics: second, source_id: id } });
    expect(preview.body.reconciliation).toEqual({ new: 1, updated: 1, removed: 1, unchanged: 2 });
    expect((await (await bob()).send("post", "/api/calendar/sources/preview", { body: { ics: second, source_id: id } })).status).toBe(404);

    const unconfirmed = await ada.send("post", `/api/calendar/sources/${id}/reimport`, { body: { ics: second } });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body).toMatchObject({ code: "REMOVALS_NEED_CONFIRMATION", requires_confirmation: true, reconciliation: { removed: 1 } });
    const done = await ada.send("post", `/api/calendar/sources/${id}/reimport`, { body: { ics: second, confirm_removals: true } });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ event_count: 4, last_reimported_at: expect.any(String) });

    const titles = (await ada.send("get", `/api/calendar/events?${range(0, 20 * DAY)}`)).body.map((event: { title: string }) => event.title);
    expect(titles.sort()).toEqual(["Exam", "Lecture", "Lecture", "Quiz"]);
    const sources = (await ada.send("get", "/api/calendar/sources")).body;
    expect(sources).toEqual([expect.objectContaining({ id, event_count: 4, read_only: true })]);
  });
});

describe("providers", () => {
  it("lists manual, .ics and the Google placeholder", async () => {
    const ada = await signUp();
    const providers = (await ada.send("get", "/api/calendar/providers")).body;
    expect(providers.map((row: { provider: string; status: string }) => `${row.provider}:${row.status}`)).toEqual([
      "manual:active",
      "ics:not_configured",
      "google:coming_soon",
    ]);
  });
});
