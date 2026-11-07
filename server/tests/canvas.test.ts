import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CANVAS_ORIGIN, CANVAS_TOKEN, fakeCanvas, seedCourse } from "./fakeCanvas.js";
import { Browser, connectCanvas, db, resetDatabase, services, signUp, syncNow } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
  fakeCanvas.reset();
});
afterAll(() => db.$disconnect());

describe("Canvas connection", () => {
  it("requires a signed-in user for every Canvas and data route", async () => {
    const browser = new Browser();
    for (const path of ["/api/canvas/connection", "/api/courses", "/api/tasks", "/api/files", "/api/changes", "/api/sync/runs/latest"]) {
      const res = await browser.send("get", path);
      expect(res.status, path).toBe(401);
      expect(res.body.code).toBe("AUTH_REQUIRED");
    }
  });

  it("reports when Canvas is not connected yet", async () => {
    const ada = await signUp();
    const res = await ada.send("get", "/api/canvas/connection");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("CANVAS_NOT_CONNECTED");
    expect((await ada.send("post", "/api/sync")).status).toBe(404);
  });

  it.each([
    ["http://canvas.example.edu", "must start with https"],
    ["https://canvas.example.edu:8443", "without a user name or port"],
    ["https://intranet.local", "not a supported Canvas site"],
  ])("refuses the address %s without contacting it", async (baseUrl, message) => {
    const ada = await signUp();
    const res = await ada.send("put", "/api/canvas/connection", { body: { base_url: baseUrl, access_token: CANVAS_TOKEN } });
    expect(res.status).toBe(422);
    expect(res.body.detail[0].loc).toEqual(["body", "base_url"]);
    expect(res.body.detail[0].msg).toContain(message);
    expect(fakeCanvas.requests).toEqual([]);
  });

  it("does not store a token Canvas rejects", async () => {
    const ada = await signUp();
    const res = await ada.send("put", "/api/canvas/connection", {
      body: { base_url: CANVAS_ORIGIN, access_token: "wrong-token" },
    });
    expect(res.status).toBe(422);
    expect(res.body.detail[0].loc).toEqual(["body", "access_token"]);
    expect(await db.canvasConnection.count()).toBe(0);
  });

  it("connects, stores the token encrypted and runs the first sync", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    const res = await ada.send("put", "/api/canvas/connection", {
      body: { base_url: `${CANVAS_ORIGIN}/courses/101`, access_token: CANVAS_TOKEN },
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(CANVAS_TOKEN);
    expect(res.body.connection).toMatchObject({ base_url: CANVAS_ORIGIN, canvas_user_name: "Ada Lovelace", status: "ok" });
    expect(res.body.sync_run).toMatchObject({ trigger: "connect", status: "running" });

    const stored = await db.canvasConnection.findFirstOrThrow();
    expect(stored.tokenCiphertext).not.toContain(CANVAS_TOKEN);
    expect(services.secrets.open(stored.tokenCiphertext, stored.userId)).toBe(CANVAS_TOKEN);

    await services.sync.whenIdle();
    const latest = await ada.send("get", "/api/sync/runs/latest");
    expect(latest.body).toMatchObject({ status: "succeeded", courses_synced: 1, changes_detected: 0, error: null });
    const connection = await ada.send("get", "/api/canvas/connection");
    expect(connection.body).toMatchObject({ syncing: false });
    expect(connection.body.last_synced_at).not.toBeNull();
  });

  it("disconnecting deletes the token and everything synced", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    expect(await db.task.count()).toBe(1);
    expect((await ada.send("delete", "/api/canvas/connection")).status).toBe(204);
    expect(await db.canvasConnection.count()).toBe(0);
    expect(await db.course.count()).toBe(0);
    expect(await db.task.count()).toBe(0);
    expect((await ada.send("get", "/api/courses")).body).toEqual([]);
  });

  it("starts over when a different Canvas account is connected", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    fakeCanvas.user = { id: 99, name: "Someone Else" };
    fakeCanvas.courses = [];
    await connectCanvas(ada);
    expect((await ada.send("get", "/api/courses")).body).toEqual([]);
  });
});

describe("sync", () => {
  it("records a baseline first, then reports what changed", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    expect((await ada.send("get", "/api/changes")).body.items).toEqual([]);

    const assignments = fakeCanvas.assignments.get("101") ?? [];
    assignments[0] = { ...assignments[0], id: 1011, due_at: "2026-11-12T05:59:00Z" };
    assignments.push({ id: 1012, name: "HW 2", due_at: null, points_possible: 10 });
    fakeCanvas.files.set("101", []);
    fakeCanvas.announcements.get("101")?.push({ id: 101_002, title: "Room change", message: "<p>Now in 1404 Siebel.</p>" });

    const run = await syncNow(ada);
    expect(run).toMatchObject({ trigger: "manual", status: "succeeded", changes_detected: 4 });
    const changes = await ada.send("get", "/api/changes");
    const summaries = changes.body.items.map((item: { summary: string }) => item.summary).sort();
    expect(summaries).toEqual([
      'Due date changed for "MP 1: Layout"',
      "File removed: syllabus.pdf",
      'New announcement: "Room change"',
      'New assignment: "HW 2"',
    ]);
    expect((await ada.send("get", "/api/changes/unread-count")).body).toEqual({ count: 4 });

    // A second sync with nothing new reports nothing.
    expect(await syncNow(ada)).toMatchObject({ status: "succeeded", changes_detected: 0 });
  });

  it("does not report a newly added course's items as changes", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    seedCourse(fakeCanvas, 202, "CS 411");
    expect(await syncNow(ada)).toMatchObject({ courses_synced: 2, changes_detected: 0 });
    expect((await ada.send("get", "/api/courses")).body).toHaveLength(2);
  });

  it("skips pages a student may not open, and reports other failures as partial", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    fakeCanvas.failures.set("/api/v1/courses/101/files", 403);
    expect(await syncNow(ada)).toMatchObject({ status: "succeeded", changes_detected: 0 });
    expect(await db.courseFile.count({ where: { removedAt: null } })).toBe(1);

    fakeCanvas.failures.set("/api/v1/announcements", 500);
    const run = await syncNow(ada);
    expect(run.status).toBe("partial");
    expect(run.error).toContain("CS 409 Announcements");
  });

  it("marks the connection when Canvas rejects the token and asks for a reconnect", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    fakeCanvas.token = "rotated-token";
    const run = await syncNow(ada);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("rejected the access token");
    expect((await ada.send("get", "/api/canvas/connection")).body.status).toBe("token_rejected");
    const retry = await ada.send("post", "/api/sync");
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe("CANVAS_RECONNECT_REQUIRED");
  });

  it("asks for a reconnect when the saved token can no longer be decrypted", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    const [file] = (await ada.send("get", "/api/files")).body.items;
    // What a changed CREDENTIALS_KEY looks like: the stored token no longer opens.
    await db.canvasConnection.updateMany({ data: { tokenCiphertext: "v1.AAAA.AAAA.AAAA" } });

    const download = await ada.send("get", file.download_url);
    expect(download.status).toBe(409);
    expect(download.body.code).toBe("CANVAS_RECONNECT_REQUIRED");

    await db.canvasConnection.updateMany({ data: { status: "OK" } });
    const run = await syncNow(ada);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("can no longer be read");
    expect((await ada.send("get", "/api/canvas/connection")).body.status).toBe("token_rejected");
  });

  it("runs one sync per user at a time", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    let release = () => {};
    fakeCanvas.gate = new Promise((resolve) => (release = resolve));
    const first = await ada.send("post", "/api/sync");
    const second = await ada.send("post", "/api/sync");
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.id).toBe(first.body.id);
    expect((await ada.send("get", "/api/canvas/connection")).body.syncing).toBe(true);
    release();
    await services.sync.whenIdle();
    expect(await db.syncRun.count({ where: { trigger: "MANUAL" } })).toBe(1);
  });

  it("scheduled syncs pick up connections that are due", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    expect(await services.sync.startDue(60 * 60_000)).toBe(0);
    expect(await services.sync.startDue(0)).toBe(1);
    await services.sync.whenIdle();
    expect(await db.syncRun.count({ where: { trigger: "SCHEDULED", status: "SUCCEEDED" } })).toBe(1);
  });
});
