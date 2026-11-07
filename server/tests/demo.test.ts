import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { DEMO_LIFETIME_MS, deleteExpiredDemos } from "../src/demo/accounts.js";
import { fakeCanvas } from "./fakeCanvas.js";
import { Browser, ORIGIN, PASSWORD, config, db, resetDatabase, services, signUp } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
  fakeCanvas.reset();
});
afterAll(() => db.$disconnect());

/** A new browser that has started a demo. */
async function startDemo(): Promise<Browser> {
  const browser = new Browser();
  const res = await browser.send("post", "/api/demo");
  expect(res.status).toBe(201);
  return browser;
}

const twoWeeks = () => {
  const from = new Date();
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + 14 * 24 * 60 * 60_000);
  return `from=${from.toISOString()}&to=${to.toISOString()}`;
};

describe("demo accounts", () => {
  it("says whether demos are offered", async () => {
    const res = await new Browser().send("get", "/api/demo");
    expect(res.body).toEqual({ enabled: true, lifetime_days: 7 });
  });

  it("gives every visitor a separate account with sample data", async () => {
    const before = Date.now();
    const browser = new Browser();
    const created = await browser.send("post", "/api/demo");
    expect(created.status).toBe(201);
    expect(created.body.username).toMatch(/^demo-[0-9a-f]{8}$/);
    expect(created.body.email).toMatch(/@demo\.invalid$/);
    const expires = Date.parse(created.body.demo_expires_at);
    expect(expires).toBeGreaterThanOrEqual(before + DEMO_LIFETIME_MS);
    expect(expires).toBeLessThan(Date.now() + DEMO_LIFETIME_MS + 1000);
    expect((await browser.send("get", "/api/users/me")).body.demo_expires_at).toBe(created.body.demo_expires_at);

    const courses = (await browser.send("get", "/api/courses")).body;
    expect(courses.map((course: { code: string }) => course.code)).toEqual(["CS 409", "MATH 241", "PHYS 212", "RHET 105"]);

    const tasks: { state: string; source: string; due_at: string | null }[] = (await browser.send("get", "/api/tasks?status=all")).body;
    const states = tasks.map((task) => task.state);
    expect(states).toContain("overdue");
    expect(states).toContain("done");
    expect(tasks.some((task) => task.source === "personal")).toBe(true);
    expect(tasks.some((task) => task.due_at === null)).toBe(true);
    const soon = tasks.filter((task) => task.due_at && Date.parse(task.due_at) > Date.now() && Date.parse(task.due_at) < Date.now() + 2 * 86_400_000);
    expect(soon.length).toBeGreaterThanOrEqual(3);

    expect((await browser.send("get", "/api/changes/unread-count")).body.count).toBe(3);
    const changes = (await browser.send("get", "/api/changes")).body.items;
    expect(changes).toHaveLength(8);
    expect(new Set(changes.map((change: { kind: string }) => change.kind))).toEqual(new Set(["assignment", "file", "announcement"]));
    const updated = changes.find((change: { change_type: string }) => change.change_type === "updated");
    const detail = (await browser.send("get", `/api/changes/${updated.id}`)).body;
    expect(detail.before).not.toBeNull();
    expect(detail.after).not.toBeNull();

    expect((await browser.send("get", "/api/files")).body.items.length).toBeGreaterThan(5);
    const events: { source: unknown; editable: boolean }[] = (await browser.send("get", `/api/calendar/events?${twoWeeks()}`)).body;
    expect(events.some((event) => event.source !== null)).toBe(true);
    expect(events.some((event) => event.editable)).toBe(true);
    expect((await browser.send("get", "/api/sync/runs/latest")).body.status).toBe("succeeded");
    expect((await browser.send("get", "/api/canvas/connection")).body.base_url).toBe("https://canvas.demo.invalid");
    expect((await browser.send("get", "/api/settings")).body.time_zone).toBe("America/Chicago");

    // A second visitor gets their own copy.
    const other = await startDemo();
    const otherCourses = (await other.send("get", "/api/courses")).body;
    expect(otherCourses).toHaveLength(4);
    expect(otherCourses.map((course: { id: number }) => course.id)).not.toContain(courses[0].id);
    expect((await other.send("get", `/api/courses/${courses[0].id}`)).status).toBe(404);
    expect(fakeCanvas.requests).toEqual([]);
  });

  it("cannot connect Canvas, change a password, download files or be signed in to", async () => {
    const browser = await startDemo();
    const me = (await browser.send("get", "/api/users/me")).body;
    const connect = await browser.send("put", "/api/canvas/connection", {
      body: { base_url: "https://canvas.illinois.edu", access_token: "token" },
    });
    expect(connect.status).toBe(403);
    expect(connect.body.code).toBe("DEMO_ACCOUNT");
    expect((await browser.send("delete", "/api/canvas/connection")).body.code).toBe("DEMO_ACCOUNT");
    const password = await browser.send("put", "/api/users/me/password", {
      body: { current_password: PASSWORD, new_password: "another-password-1" },
    });
    expect(password.status).toBe(403);
    expect(password.body.code).toBe("DEMO_ACCOUNT");

    const [file] = (await browser.send("get", "/api/files")).body.items;
    const download = await browser.send("get", file.download_url);
    expect(download.status).toBe(409);
    expect(download.body.code).toBe("DEMO_FILE");

    expect((await new Browser().signIn(me.username, PASSWORD)).status).toBe(401);
    expect((await browser.send("post", "/api/demo")).body.code).toBe("ALREADY_SIGNED_IN");
    expect(fakeCanvas.requests).toEqual([]);
  });

  it("syncs at once without contacting Canvas", async () => {
    const browser = await startDemo();
    const before = (await browser.send("get", "/api/canvas/connection")).body.last_synced_at;
    const res = await browser.send("post", "/api/sync");
    expect(res.status).toBe(202);
    expect(res.headers.location).toBe(`/api/sync/runs/${res.body.id}`);
    expect(res.body).toMatchObject({ trigger: "manual", status: "succeeded", courses_synced: 4, changes_detected: 0 });
    const after = (await browser.send("get", "/api/canvas/connection")).body;
    expect(Date.parse(after.last_synced_at)).toBeGreaterThan(Date.parse(before));
    expect(after.syncing).toBe(false);
    expect((await browser.send("get", "/api/changes/unread-count")).body.count).toBe(3);
    expect(fakeCanvas.requests).toEqual([]);
  });

  it("is never picked up by the sync scheduler", async () => {
    await startDemo();
    await db.canvasConnection.updateMany({ data: { lastSyncedAt: new Date(Date.now() - 86_400_000) } });
    expect(await services.sync.startDue(60_000)).toBe(0);
  });

  it("deletes the account and its data on sign-out", async () => {
    const browser = await startDemo();
    const me = (await browser.send("get", "/api/users/me")).body;
    const res = await browser.send("delete", "/api/sessions/current");
    expect(res.status).toBe(204);
    expect(await db.user.count({ where: { id: me.id } })).toBe(0);
    expect(await db.course.count()).toBe(0);
    expect(await db.calendarEvent.count()).toBe(0);
    expect((await browser.send("get", "/api/users/me")).status).toBe(401);
  });

  it("keeps ordinary accounts on sign-out", async () => {
    const ada = await signUp();
    expect((await ada.send("delete", "/api/sessions/current")).status).toBe(204);
    expect(await db.user.count()).toBe(1);
  });

  it("resets the sample data", async () => {
    const browser = await startDemo();
    const me = (await browser.send("get", "/api/users/me")).body;
    const tasks = (await browser.send("get", "/api/tasks?status=all")).body;
    const personal = tasks.find((task: { source: string }) => task.source === "personal");
    expect((await browser.send("delete", `/api/tasks/${personal.id}`)).status).toBe(204);
    expect((await browser.send("post", "/api/changes/mark-all-read", { body: {} })).status).toBeLessThan(300);
    expect((await browser.send("get", "/api/changes/unread-count")).body.count).toBe(0);

    expect((await browser.send("post", "/api/demo/reset")).status).toBe(204);
    expect((await browser.send("get", "/api/changes/unread-count")).body.count).toBe(3);
    expect((await browser.send("get", "/api/tasks?status=all")).body).toHaveLength(tasks.length);
    expect((await browser.send("get", "/api/courses")).body).toHaveLength(4);
    // Same account, same expiry; only the data is new.
    expect((await browser.send("get", "/api/users/me")).body).toEqual(me);
  });

  it("only resets demo accounts", async () => {
    const ada = await signUp();
    const res = await ada.send("post", "/api/demo/reset");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_A_DEMO");
    expect((await new Browser().send("post", "/api/demo/reset")).status).toBe(401);
  });

  it("stops working when it expires and is then deleted", async () => {
    const browser = await startDemo();
    const ada = await signUp();
    await db.user.updateMany({ where: { demoExpiresAt: { not: null } }, data: { demoExpiresAt: new Date(Date.now() - 1000) } });
    expect((await browser.send("get", "/api/users/me")).status).toBe(401);
    expect(await deleteExpiredDemos(db)).toBe(1);
    expect(await db.user.count()).toBe(1);
    expect((await ada.send("get", "/api/users/me")).status).toBe(200);
  });

  it("limits how many demos one network starts", async () => {
    for (let index = 0; index < 10; index += 1) await startDemo();
    const res = await new Browser().send("post", "/api/demo");
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("TOO_MANY_ATTEMPTS");
  });

  it("is off unless DEMO_ACCOUNTS is true", async () => {
    const logger = pino({ level: "silent" });
    const app = createApp({ config: { ...config, demoAccounts: false }, db, logger, services });
    expect((await request(app).get("/api/demo")).body.enabled).toBe(false);
    const res = await request(app).post("/api/demo").set("Origin", ORIGIN);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("DEMO_DISABLED");
    expect(await db.user.count()).toBe(0);
  });
});
