import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { PREVIEW_LIFETIME_MS, deleteExpiredPreviews, identityScrubber } from "../src/preview/accounts.js";
import { CANVAS_ORIGIN, fakeCanvas, seedCourse } from "./fakeCanvas.js";
import { Browser, ORIGIN, PASSWORD, config, connectCanvas, db, resetDatabase, services, signUp, syncNow } from "./helpers.js";

// The test config names "Ada" as the account previews copy (PREVIEW_SOURCE_USERNAME).
const CANVAS_USER_ID = 3141592;

beforeEach(async () => {
  await resetDatabase();
  fakeCanvas.reset();
});
afterAll(() => db.$disconnect());

const icsTime = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

/** Ada's account: synced from Canvas, with her own task, event and imported calendar. Her name is all over it. */
async function seedTemplate(): Promise<Browser> {
  fakeCanvas.user = { id: CANVAS_USER_ID, name: "Ada Lovelace" };
  seedCourse(fakeCanvas);
  const ada = await signUp();
  await connectCanvas(ada);
  // A new announcement, so the change feed has an unread change with Ada's name in it.
  fakeCanvas.announcements.get("101")?.push({
    id: 101_002,
    title: "Grades for Ada Lovelace",
    message: `<p>Ada, your grade is at <a href="${CANVAS_ORIGIN}/courses/101/grades/${CANVAS_USER_ID}">your grades</a> (Canvas ID ${CANVAS_USER_ID}). Mail ada@example.com.</p>`,
    posted_at: new Date().toISOString(),
    html_url: `${CANVAS_ORIGIN}/courses/101/discussion_topics/101002`,
  });
  await syncNow(ada);
  const [course] = (await ada.send("get", "/api/courses")).body;
  const task = await ada.send("post", "/api/tasks", {
    body: { course_id: course.id, title: "Ask Lovelace's TA about MP1", notes: "Write from ada@example.com, sign as Ada." },
  });
  expect(task.status).toBe(201);
  const start = new Date(Date.now() + 26 * 60 * 60_000);
  const event = await ada.send("post", "/api/calendar/events", {
    body: { title: "Ada's study group", location: "Ada Lovelace's room", start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString() },
  });
  expect(event.status).toBe(201);
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//test//EN",
    "BEGIN:VEVENT",
    "UID:lecture",
    "SUMMARY:CS 409 Lecture",
    `DTSTART:${icsTime(new Date(Date.now() + 2 * 3_600_000))}`,
    "DURATION:PT75M",
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  expect((await ada.send("post", "/api/calendar/sources", { body: { file_name: "lovelace.ics", ics } })).status).toBe(201);
  return ada;
}

/** A new browser that has started a preview. */
async function startPreview(): Promise<Browser> {
  const browser = new Browser();
  const res = await browser.send("post", "/api/preview");
  expect(res.status).toBe(201);
  return browser;
}

const weeks = () => {
  const from = new Date(Date.now() - 7 * 86_400_000);
  const to = new Date(Date.now() + 30 * 86_400_000);
  return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
};

/** Everything a visitor can read in the app, as one string. */
async function everything(browser: Browser): Promise<string> {
  const changes = (await browser.send("get", "/api/changes")).body.items as { id: number }[];
  const details = await Promise.all(changes.map(async (change) => (await browser.send("get", `/api/changes/${change.id}`)).body));
  const parts = await Promise.all(
    ["/api/users/me", "/api/canvas/connection", "/api/courses", "/api/tasks?status=all", "/api/files", "/api/calendar/sources", `/api/calendar/events?${weeks()}`].map(
      async (path) => (await browser.send("get", path)).body,
    ),
  );
  return JSON.stringify([...parts, details]);
}

describe("preview accounts", () => {
  it("is offered only while the template account exists", async () => {
    expect((await new Browser().send("get", "/api/preview")).body).toEqual({ enabled: false, lifetime_days: 7 });
    expect((await new Browser().send("post", "/api/preview")).body.code).toBe("PREVIEW_DISABLED");
    await signUp();
    expect((await new Browser().send("get", "/api/preview")).body).toEqual({ enabled: true, lifetime_days: 7 });
  });

  it("gives every visitor their own copy of the template's data without the template's identity", async () => {
    const ada = await seedTemplate();
    const original = await everything(ada);
    expect(original).toContain("Lovelace");

    const before = Date.now();
    const browser = new Browser();
    const created = await browser.send("post", "/api/preview");
    expect(created.status).toBe(201);
    expect(created.body.username).toMatch(/^preview-[0-9a-f]{8}$/);
    expect(created.body.email).toMatch(/@preview\.invalid$/);
    const expires = Date.parse(created.body.preview_expires_at);
    expect(expires).toBeGreaterThanOrEqual(before + PREVIEW_LIFETIME_MS);
    expect(expires).toBeLessThan(Date.now() + PREVIEW_LIFETIME_MS + 1000);

    // Same courses, tasks, files, changes and calendar...
    const mine = (path: string) => browser.send("get", path).then((res) => res.body);
    const theirs = (path: string) => ada.send("get", path).then((res) => res.body);
    expect((await mine("/api/courses")).map((course: { code: string }) => course.code)).toEqual(
      (await theirs("/api/courses")).map((course: { code: string }) => course.code),
    );
    expect(await mine("/api/tasks?status=all")).toHaveLength((await theirs("/api/tasks?status=all")).length);
    expect((await mine("/api/files")).items).toHaveLength((await theirs("/api/files")).items.length);
    expect((await mine("/api/changes")).items).toHaveLength((await theirs("/api/changes")).items.length);
    expect((await mine("/api/changes/unread-count")).count).toBe((await theirs("/api/changes/unread-count")).count);
    expect(await mine(`/api/calendar/events?${weeks()}`)).toHaveLength((await theirs(`/api/calendar/events?${weeks()}`)).length);
    expect(await mine("/api/calendar/sources")).toEqual([expect.objectContaining({ event_count: 3, file_name: "Student.ics" })]);
    expect(await mine("/api/settings")).toEqual(await theirs("/api/settings"));
    expect((await mine("/api/sync/runs/latest")).status).toBe("succeeded");
    expect(await mine("/api/canvas/connection")).toMatchObject({ base_url: CANVAS_ORIGIN, canvas_user_name: "Preview Student", status: "ok" });

    // ...with Ada's name, username, email and Canvas id taken out.
    const copy = await everything(browser);
    for (const secret of ["Lovelace", "Ada", "ada@example.com", String(CANVAS_USER_ID)]) {
      expect(copy.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    expect(copy).toContain("Preview Student");
    expect(copy).toContain("(Canvas ID self)");

    // A second visitor gets their own copy, and nobody sees anyone else's.
    const other = await startPreview();
    const [course] = await mine("/api/courses");
    expect((await other.send("get", `/api/courses/${course.id}`)).status).toBe(404);
    expect((await ada.send("get", `/api/courses/${course.id}`)).status).toBe(404);
  });

  it("can change its copy like any account, without touching the template", async () => {
    const ada = await seedTemplate();
    const browser = await startPreview();
    const tasks: { id: number; source: string }[] = (await browser.send("get", "/api/tasks?status=all")).body;
    const canvasTask = tasks.find((task) => task.source === "canvas");
    expect((await browser.send("patch", `/api/tasks/${canvasTask?.id}`, { body: { done: true, progress: 100 } })).status).toBe(200);
    const personal = tasks.find((task) => task.source === "personal");
    expect((await browser.send("delete", `/api/tasks/${personal?.id}`)).status).toBe(204);
    expect((await browser.send("post", "/api/changes/mark-all-read", { body: {} })).status).toBeLessThan(300);
    expect((await browser.send("patch", "/api/settings", { body: { daily_study_minutes: 60 } })).status).toBe(200);

    expect((await ada.send("get", "/api/tasks?status=all")).body).toHaveLength(tasks.length);
    expect((await ada.send("get", "/api/changes/unread-count")).body.count).toBeGreaterThan(0);
    expect((await ada.send("get", "/api/settings")).body.daily_study_minutes).not.toBe(60);
  });

  it("answers 'Preview account not available' for everything that needs Canvas or a password", async () => {
    await seedTemplate();
    const requestsBefore = fakeCanvas.requests.length;
    const browser = await startPreview();
    const me = (await browser.send("get", "/api/users/me")).body;
    const unavailable = async (res: request.Response) => {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "PREVIEW_ACCOUNT", detail: "Preview account not available." });
    };
    await unavailable(await browser.send("put", "/api/canvas/connection", { body: { base_url: CANVAS_ORIGIN, access_token: "token" } }));
    await unavailable(await browser.send("delete", "/api/canvas/connection"));
    await unavailable(await browser.send("post", "/api/sync"));
    const [file] = (await browser.send("get", "/api/files")).body.items;
    await unavailable(await browser.send("get", file.download_url));
    const [course] = (await browser.send("get", "/api/courses")).body;
    await unavailable(await browser.send("get", `/api/courses/${course.id}/syllabus`));
    await unavailable(
      await browser.send("put", "/api/users/me/password", { body: { current_password: PASSWORD, new_password: "another-password-1" } }),
    );

    expect((await new Browser().signIn(me.username, PASSWORD)).status).toBe(401);
    expect((await browser.send("post", "/api/preview")).body.code).toBe("ALREADY_SIGNED_IN");
    expect(fakeCanvas.requests).toHaveLength(requestsBefore);
  });

  it("is never picked up by the sync scheduler", async () => {
    await seedTemplate();
    await startPreview();
    await db.canvasConnection.updateMany({ data: { lastSyncedAt: new Date(Date.now() - 86_400_000) } });
    expect(await db.canvasConnection.count()).toBe(2);
    // Only the template account is synced.
    expect(await services.sync.startDue(60_000)).toBe(1);
    await services.sync.whenIdle();
  });

  it("deletes the account and its copy on sign-out, and keeps ordinary accounts", async () => {
    const ada = await seedTemplate();
    const courses = await db.course.count();
    const browser = await startPreview();
    const me = (await browser.send("get", "/api/users/me")).body;
    expect(await db.course.count()).toBe(2 * courses);
    expect((await browser.send("delete", "/api/sessions/current")).status).toBe(204);
    expect(await db.user.count({ where: { id: me.id } })).toBe(0);
    expect(await db.course.count()).toBe(courses);
    expect((await browser.send("get", "/api/users/me")).status).toBe(401);

    expect((await ada.send("delete", "/api/sessions/current")).status).toBe(204);
    expect(await db.user.count()).toBe(1);
  });

  it("resets to a fresh copy of the template", async () => {
    await seedTemplate();
    const browser = await startPreview();
    const me = (await browser.send("get", "/api/users/me")).body;
    const tasks = (await browser.send("get", "/api/tasks?status=all")).body;
    const unread = (await browser.send("get", "/api/changes/unread-count")).body.count;
    const personal = tasks.find((task: { source: string }) => task.source === "personal");
    expect((await browser.send("delete", `/api/tasks/${personal.id}`)).status).toBe(204);
    expect((await browser.send("post", "/api/changes/mark-all-read", { body: {} })).status).toBeLessThan(300);

    expect((await browser.send("post", "/api/preview/reset")).status).toBe(204);
    expect((await browser.send("get", "/api/changes/unread-count")).body.count).toBe(unread);
    expect((await browser.send("get", "/api/tasks?status=all")).body).toHaveLength(tasks.length);
    // Same account, same expiry; only the data is new.
    expect((await browser.send("get", "/api/users/me")).body).toEqual(me);
  });

  it("only resets preview accounts", async () => {
    const ada = await signUp();
    const res = await ada.send("post", "/api/preview/reset");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_A_PREVIEW");
    expect((await new Browser().send("post", "/api/preview/reset")).status).toBe(401);
  });

  it("stops working when it expires and is then deleted", async () => {
    const ada = await signUp();
    const browser = await startPreview();
    await db.user.updateMany({ where: { previewExpiresAt: { not: null } }, data: { previewExpiresAt: new Date(Date.now() - 1000) } });
    expect((await browser.send("get", "/api/users/me")).status).toBe(401);
    expect(await deleteExpiredPreviews(db)).toBe(1);
    expect(await db.user.count()).toBe(1);
    expect((await ada.send("get", "/api/users/me")).status).toBe(200);
  });

  it("limits how many previews one network starts", async () => {
    await signUp();
    for (let index = 0; index < 10; index += 1) await startPreview();
    const res = await new Browser().send("post", "/api/preview");
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("TOO_MANY_ATTEMPTS");
  });

  it("is off when PREVIEW_SOURCE_USERNAME is empty", async () => {
    await signUp();
    const logger = pino({ level: "silent" });
    const app = createApp({ config: { ...config, previewSource: null }, db, logger, services });
    expect((await request(app).get("/api/preview")).body.enabled).toBe(false);
    const res = await request(app).post("/api/preview").set("Origin", ORIGIN);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PREVIEW_DISABLED");
    expect(await db.user.count()).toBe(1);
  });
});

describe("identity scrubber", () => {
  it("replaces names as whole words only, and long Canvas ids", () => {
    const scrub = identityScrubber({ username: "mchen7", email: "mchen7@example.com" }, { displayName: "Mei Chen 陈美", canvasUserId: "1234567" });
    expect(scrub.text("Mei Chen 陈美 wrote from MChen7@example.com")).toBe("Preview Student wrote from student@example.com");
    expect(scrub.text("Chenoweth lab; mchen7; 陈美; /users/1234567/files; 12345678; Mei; Me")).toBe(
      "Chenoweth lab; Student; Student; /users/self/files; 12345678; Student; Me",
    );
    expect(scrub.json({ a: ["Chen", 3, null], b: { c: "CHEN" } })).toEqual({ a: ["Student", 3, null], b: { c: "Student" } });
  });
});
