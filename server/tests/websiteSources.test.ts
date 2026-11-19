import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeProviderSession } from "../src/sources/providerSessions.js";
import { pruneWebsiteBlobs, storeWebsiteBlob } from "../src/sources/website/service.js";
import { CANVAS_ORIGIN, fakeCanvas, seedCourse } from "./fakeCanvas.js";
import { connectCanvas, db, resetDatabase, services, signUp, type Browser } from "./helpers.js";
import { fakeSite, type FakeReply } from "./sourcesFakes.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/sources/${name}`, import.meta.url));
const BASE = "https://courses.example.edu/test101/fa26";
const ACCOUNT = { username: "SCHOOL\\student", password: "test-only-secret" };
const html = (body: string | Buffer): FakeReply => ({ status: 200, headers: { "content-type": "text/html" }, body });
const pdf: FakeReply = { status: 200, headers: { "content-type": "application/pdf" }, body: fixture("fake_protected.pdf") };

const realTransport = services.sourceTransport;
let pages: Record<string, FakeReply>;
let site: ReturnType<typeof fakeSite>;

function useSite(account = ACCOUNT) {
  site = fakeSite({
    account,
    protectedUrl: (url) => url.includes("/secure/"),
    protectedReply: (url) => (url.endsWith(".pdf") ? pdf : html(fixture("protected_office_hours.html"))),
    pages,
  });
  services.sourceTransport = site.transport;
}

beforeEach(async () => {
  await resetDatabase();
  fakeCanvas.reset();
  pages = {
    [BASE]: { status: 301, headers: { location: `${BASE}/` } },
    [`${BASE}/`]: html(fixture("public_schedule.html")),
    [`${BASE}/course-description.html`]: html("<html><head><title>Syllabus</title></head><body><h2>Grading policy</h2><p>Homework 30%, midterm 30%, final exam 40%. Late work loses 10%. Office hours Tuesday.</p></body></html>"),
  };
  useSite();
});
afterEach(() => {
  services.sourceTransport = realTransport;
});
afterAll(resetDatabase);

const ADD = {
  course_code: "TEST 101",
  course_name: "Example course",
  term: "Fall 2026",
  base_url: BASE,
  authentication_method: "ntlm",
  ntlm: ACCOUNT,
};

async function addWebsite(browser: Browser, body: Record<string, unknown> = ADD) {
  const res = await browser.send("post", "/api/sources/website", { body });
  expect(res.status).toBe(201);
  return res.body as { source: { id: string; course_id: number }; verification: { verified: boolean } };
}

async function sync(browser: Browser, id: string) {
  const res = await browser.send("post", `/api/sources/${id}/sync`);
  expect(res.status).toBe(200);
  return res.body;
}

describe("course websites", () => {
  it("tests without saving, then saves a verified NTLM website with its own course", async () => {
    const ada = await signUp();
    const test = await ada.send("post", "/api/sources/website/test", { body: ADD });
    expect(test.body).toEqual({ verified: true, message: "Protected access verified.", public_only: false });
    expect(await db.sourceConnection.count()).toBe(0);

    const { source, verification } = await addWebsite(ada);
    expect(verification.verified).toBe(true);
    const courses = (await ada.send("get", "/api/courses")).body;
    expect(JSON.stringify(courses)).toContain("TEST 101");
    const row = await db.websiteCredential.findUniqueOrThrow({ where: { connectionId: source.id } });
    expect(row).toMatchObject({ username: ACCOUNT.username, state: "VALID", generation: 1 });
    expect(row.passwordCiphertext).not.toContain(ACCOUNT.password);
    const details = (await ada.send("get", `/api/sources/${source.id}/website`)).body;
    expect(details).toMatchObject({ course: { code: "TEST 101", term: "Fall 2026", owned: true }, credential: { present: true, state: "VALID" } });
    expect(details.config.probe_url).toContain("/secure/");
    expect(JSON.stringify(details)).not.toContain(ACCOUNT.password);
  });

  it("creates nothing when the password is wrong, and keeps a working password on a public-only result", async () => {
    const ada = await signUp();
    useSite({ ...ACCOUNT, password: "different" });
    const wrong = await ada.send("post", "/api/sources/website", { body: ADD });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe("WEBSITE_VERIFICATION_FAILED");
    expect(await db.course.count()).toBe(0);

    useSite();
    const { source } = await addWebsite(ada);
    const before = await db.websiteCredential.findUniqueOrThrow({ where: { connectionId: source.id } });
    // The site no longer links a protected page: a new password can't be verified, so it isn't stored.
    pages[`${BASE}/`] = html("<p>public only</p>");
    useSite();
    const replace = await ada.send("put", `/api/sources/website/${source.id}`, {
      body: { ...ADD, probe_url: null, ntlm: { username: ACCOUNT.username, password: "another-test-secret" } },
    });
    expect(replace.status).toBe(422);
    expect(replace.body.detail).toContain("existing credential kept");
    const after = await db.websiteCredential.findUniqueOrThrow({ where: { connectionId: source.id } });
    expect(after.passwordCiphertext).toBe(before.passwordCiphertext);
  });

  it("needs a password for a blank-password edit by another user name or another origin", async () => {
    const ada = await signUp();
    const { source } = await addWebsite(ada);
    const other = await ada.send("put", `/api/sources/website/${source.id}`, { body: { ...ADD, ntlm: { username: "someone-else", password: "" } } });
    expect(other.status).toBe(422);
    const origin = await ada.send("put", `/api/sources/website/${source.id}`, {
      body: { ...ADD, base_url: "https://other.example.edu/test101/fa26", ntlm: { username: ACCOUNT.username, password: "" } },
    });
    expect(origin.status).toBe(422);
    expect(JSON.stringify(origin.body)).toContain("different website origin");
    // A label-only edit works offline without a password.
    services.sourceTransport = fakeSite({}).transport;
    const label = await ada.send("put", `/api/sources/website/${source.id}`, { body: { ...ADD, name: "Renamed site", ntlm: undefined } });
    expect(label.status).toBe(200);
    expect(label.body.source.name).toBe("Renamed site");
  });

  it("syncs pages and checked files, reports new files after the first sync, and serves the bytes", async () => {
    const ada = await signUp();
    const { source } = await addWebsite(ada);
    const first = await sync(ada, source.id);
    expect(first).toMatchObject({ state: "READY", errors: [] });
    expect(await db.changeEvent.count()).toBe(0);
    const files = (await ada.send("get", "/api/files")).body.items;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: "lecture-01.pdf", source: "website", integrity_status: "VALID", type: "lecture" });
    const download = await ada.send("get", `/api/files/${files[0].id}/download`);
    expect(download.status).toBe(200);
    expect(download.headers["content-disposition"]).toContain("lecture-01.pdf");
    expect(Buffer.from(download.body).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await ada.send("get", `/api/files/${files[0].id}/download?link=1`)).body.url).toBe(`/api/files/${files[0].id}/download`);

    pages[`${BASE}/`] = html(`${fixture("public_schedule.html")}<a href="secure/hw-02.pdf">HW 2</a>`);
    useSite();
    await sync(ada, source.id);
    const changes = await db.changeEvent.findMany({ where: { userFacing: true } });
    expect(changes).toEqual([expect.objectContaining({ category: "file", userFacing: true, summary: "New file: hw-02.pdf" })]);
    const sources = (await ada.send("get", "/api/sources")).body;
    expect(sources[0]).toMatchObject({ source_type: "website", health: "HEALTHY", authentication_method: "ntlm" });
    // The website's syllabus page is found for its course.
    const syllabus = (await ada.send("get", `/api/courses/${source.course_id}/syllabus`)).body;
    expect(syllabus.found).toBe(true);
    expect(syllabus.sources[0].html_url).toBe(`${BASE}/course-description.html`);
  });

  it("keeps website file bytes under each user's quota, atomically, and lets removed bytes go", async () => {
    const ada = await signUp();
    const { source } = await addWebsite(ada);
    const limits = services.websiteLimits;
    services.websiteLimits = { quotaBytes: 50, maxFileBytes: limits.maxFileBytes };
    try {
      const result = await sync(ada, source.id);
      expect(result.errors).toEqual([expect.objectContaining({ resource: "website_file", code: "storage_quota_exceeded" })]);
      expect(await db.websiteBlob.count()).toBe(0);
      // The file is still listed, but there are no bytes to hand out.
      const [file] = (await ada.send("get", "/api/files")).body.items;
      const download = await ada.send("get", `/api/files/${file.id}/download`);
      expect(download.status).toBe(404);
      expect(download.body.code).toBe("FILE_UNAVAILABLE");

      // Two stores racing for the last room: only one fits.
      const user = await db.user.findFirstOrThrow();
      const tight = { quotaBytes: 150, maxFileBytes: 1_000 };
      const stored = await Promise.all(
        ["a", "b", "c"].map((name) => storeWebsiteBlob(db, user.id, name.repeat(64), Buffer.alloc(100, name), tight)),
      );
      expect(stored.filter((id) => id !== null)).toHaveLength(1);
      expect(await storeWebsiteBlob(db, user.id, "d".repeat(64), Buffer.alloc(2_000), { quotaBytes: 10_000, maxFileBytes: 1_000 })).toBeNull();
      // Unlinked bytes are pruned once they are old enough not to belong to a running sync.
      expect(await pruneWebsiteBlobs(db, user.id, new Date(Date.now() - 60_000))).toBe(0);
      expect(await pruneWebsiteBlobs(db, user.id, new Date(Date.now() + 1_000))).toBe(1);
    } finally {
      services.websiteLimits = limits;
    }
    await sync(ada, source.id);
    expect(await db.websiteBlob.count()).toBe(1);
    // Another user's storage is separate.
    const bob = await signUp({ username: "bob", email: "bob@example.com" });
    const [file] = (await ada.send("get", "/api/files")).body.items;
    expect((await bob.send("get", `/api/files/${file.id}/download`)).status).toBe(404);
  });

  it("keeps protected URLs pending, asks to sign in again, and retries them after re-authentication", async () => {
    const ada = await signUp();
    const { source } = await addWebsite(ada);
    await ada.send("delete", `/api/sources/${source.id}/website/credential`);
    const result = await sync(ada, source.id);
    expect(result.state).toBe("AUTH_REQUIRED");
    const listed = (await ada.send("get", "/api/sources")).body[0];
    expect(listed.health).toBe("AUTH_REQUIRED");
    const details = (await ada.send("get", `/api/sources/${source.id}/website`)).body;
    expect(details.pending.map((row: { state: string }) => row.state)).toEqual(["AUTH_REQUIRED", "AUTH_REQUIRED"]);
    const banners = (await ada.send("get", "/api/notifications")).body;
    expect(JSON.stringify(banners)).toContain("needs signing in");

    const again = await ada.send("post", `/api/sources/${source.id}/website/credential`, { body: ACCOUNT });
    expect(again.status).toBe(200);
    expect(again.body.verification.verified).toBe(true);
    expect(again.body.sync.state).toBe("READY");
    expect((await ada.send("get", `/api/sources/${source.id}/website`)).body.pending).toEqual([]);
    expect(JSON.stringify((await ada.send("get", "/api/notifications")).body)).not.toContain("needs signing in");
  });

  it("drops a stored password the site rejects during a sync, so later syncs can't lock the account", async () => {
    const ada = await signUp();
    const { source } = await addWebsite(ada);
    useSite({ ...ACCOUNT, password: "rotated-test-secret" });
    const result = await sync(ada, source.id);
    expect(result.state).toBe("AUTH_REQUIRED");
    const row = await db.websiteCredential.findUniqueOrThrow({ where: { connectionId: source.id } });
    expect(row).toMatchObject({ passwordCiphertext: null, state: "INVALID", lastErrorCode: "auth_failed", generation: 2 });
    const details = (await ada.send("get", `/api/sources/${source.id}/website`)).body;
    expect(details.credential).toMatchObject({ username: ACCOUNT.username, present: false });
  });

  it("turns a homework schedule table into date-only tasks once week 1 is set", async () => {
    const ada = await signUp();
    pages[`${BASE}/`] = html(fixture("schedule_table.html"));
    useSite();
    const { source } = await addWebsite(ada, { ...ADD, authentication_method: "none", ntlm: undefined, week_1_monday: "2026-08-24" });
    await sync(ada, source.id);
    const tasks = await db.task.findMany({ where: { source: "WEBSITE" }, orderBy: { dueAt: "asc" } });
    expect(tasks).toHaveLength(13);
    const third = tasks.find((task) => task.title === "HW 3");
    expect(third).toMatchObject({ dueDateOnly: true, sourceId: source.id });
    expect(third?.htmlUrl).toBe(`${BASE}/secure/homework/HW-03.pdf`);
    // The next sync rewrites these, so their title and deadline can't be edited and they can't be deleted.
    const edit = await ada.send("patch", `/api/tasks/${third?.id}`, { body: { title: "Renamed" } });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("TASK_FROM_SOURCE");
    expect((await ada.send("delete", `/api/tasks/${third?.id}`)).status).toBe(409);
    expect((await ada.send("patch", `/api/tasks/${third?.id}`, { body: { progress: 50 } })).status).toBe(200);
    const bad = await ada.send("put", `/api/sources/website/${source.id}`, { body: { ...ADD, authentication_method: "none", ntlm: undefined, week_1_monday: "2026-08-25" } });
    expect(bad.status).toBe(422);
  });

  it("refuses private addresses on the real transport", async () => {
    const ada = await signUp();
    services.sourceTransport = realTransport;
    const res = await ada.send("post", "/api/sources/website/test", {
      body: { ...ADD, base_url: "http://127.0.0.1:9/course", authentication_method: "none", ntlm: undefined },
    });
    expect(res.status).toBe(422);
  });

  it("keeps each user's websites apart and survives a Canvas disconnect", async () => {
    const ada = await signUp();
    seedCourse(fakeCanvas);
    await connectCanvas(ada);
    const { source } = await addWebsite(ada);
    const bob = await signUp({ username: "bob", email: "bob@example.com" });
    expect((await bob.send("get", `/api/sources/${source.id}/website`)).status).toBe(404);
    expect((await bob.send("post", `/api/sources/${source.id}/sync`)).status).toBe(404);
    expect((await bob.send("put", `/api/sources/website/${source.id}`, { body: ADD })).status).toBe(404);
    await ada.send("delete", "/api/canvas/connection");
    expect(await db.course.count({ where: { source: "WEBSITE" } })).toBe(1);
    // Removing the website removes the course it created.
    expect((await ada.send("delete", `/api/sources/${source.id}`)).status).toBe(204);
    expect(await db.course.count({ where: { source: "WEBSITE" } })).toBe(0);
    expect(CANVAS_ORIGIN).toContain("https://");
  });
});

// --- Gradescope / PrairieLearn ---

const GS = "https://www.gradescope.com";
const DASHBOARD =
  '<h1>Course Dashboard</h1><a href="/logout">Log out</a><a class="courseBox" href="/courses/10"><h3 class="courseBox--shortname">TEST 101</h3><div class="courseBox--name">Example course</div></a>';

async function gradescope(browser: Browser) {
  const res = await browser.send("post", "/api/sources", { body: { type: "gradescope", base_url: "https://www.gradescope.com/" } });
  expect(res.status).toBe(201);
  const user = await db.user.findFirstOrThrow({ where: { usernameKey: "ada" } });
  await storeProviderSession(db, services.secrets, user.id, res.body.id, new Map([["signed_token", "test-only"]]), 0);
  return { id: res.body.id as string, userId: user.id };
}

describe("gradescope", () => {
  beforeEach(() => {
    services.sourceTransport = fakeSite({
      pages: { [`${GS}/`]: html(DASHBOARD), [`${GS}/courses/10`]: html(fixture("gradescope_assignments.html")) },
    }).transport;
  });

  it("discovers and maps courses, asks before matching by title, and shows facts on the task", async () => {
    const ada = await signUp();
    const { id, userId } = await gradescope(ada);
    const course = await db.course.create({
      data: { userId, canvasId: "77", courseCode: "TEST 101", name: "Example", htmlUrl: "https://canvas.example/courses/77", lastSeenAt: new Date() },
    });
    const task = await db.task.create({ data: { userId, courseId: course.id, canvasId: "5", title: "Homework A", taskType: "homework", dueAt: new Date("2026-09-25T04:59:00Z") } });

    const discovered = (await ada.send("get", `/api/sources/${id}/provider-courses`)).body;
    expect(discovered).toEqual([expect.objectContaining({ external_id: "10", course_code: "TEST 101", mapped_course_id: null })]);
    expect((await ada.send("post", `/api/sources/${id}/course-mappings`, { body: { provider_course_id: "10", course_id: course.id } })).status).toBe(201);
    const twice = await ada.send("post", `/api/sources/${id}/course-mappings`, { body: { provider_course_id: "10", course_id: course.id } });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe("PROVIDER_COURSE_ALREADY_MAPPED");

    const first = (await ada.send("post", `/api/sources/${id}/sync`)).body;
    expect(first.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PROVIDER_TASK_MAPPING_REQUIRED" })]));
    const pending = (await ada.send("get", `/api/sources/${id}/assignments?pending=1`)).body;
    expect(pending).toEqual([expect.objectContaining({ assignment_id: "101", candidates: [expect.objectContaining({ id: task.id })] })]);
    // The two other assignments had no look-alike and became their own tasks.
    expect(await db.task.count({ where: { source: "GRADESCOPE" } })).toBe(2);

    expect((await ada.send("post", `/api/sources/${id}/task-mappings`, { body: { provider_course_id: "10", assignment_id: "101", task_id: task.id } })).body).toEqual({ confirmed: true });
    const second = (await ada.send("post", `/api/sources/${id}/sync`)).body;
    expect(second.errors).toEqual([expect.objectContaining({ code: "unidentified_rows" })]);
    const facts = (await ada.send("get", `/api/tasks/${task.id}/provider-facts`)).body;
    expect(facts.provider_facts.map((row: { provider: string }) => row.provider)).toEqual(["canvas", "gradescope"]);
    expect(facts.provider_facts[1]).toMatchObject({ due_at: "2026-09-24T23:59:00-05:00", late_due_at: "2026-10-01T23:59:00-05:00" });
    expect(facts.provider_facts[1]).not.toHaveProperty("release_at");
    expect(facts.deadlines_differ).toBe(false);
    const bob = await signUp({ username: "bob", email: "bob@example.com" });
    expect((await bob.send("get", `/api/tasks/${task.id}/provider-facts`)).status).toBe(404);
    expect((await bob.send("get", `/api/sources/${id}/assignments`)).status).toBe(404);
  });

  it("asks to sign in again when the session ended, and keeps PrairieLearn behind its guard", async () => {
    const ada = await signUp();
    const { id, userId } = await gradescope(ada);
    const course = await db.course.create({ data: { userId, canvasId: "78", courseCode: "X", name: "X", htmlUrl: "https://canvas.example/courses/78", lastSeenAt: new Date() } });
    await ada.send("post", `/api/sources/${id}/course-mappings`, { body: { provider_course_id: "10", course_id: course.id } });
    services.sourceTransport = fakeSite({ pages: { [`${GS}/courses/10`]: { status: 302, headers: { location: `${GS}/login` } } } }).transport;
    const result = (await ada.send("post", `/api/sources/${id}/sync`)).body;
    expect(result.state).toBe("AUTH_REQUIRED");
    expect((await db.providerSession.findUniqueOrThrow({ where: { connectionId: id } })).cookieCiphertext).toBeNull();

    const pl = await ada.send("post", "/api/sources", { body: { type: "prairielearn", base_url: "https://us.prairielearn.com/pl" } });
    expect(pl.status).toBe(201);
    const blocked = await ada.send("post", `/api/sources/${pl.body.id}/sync`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("PRAIRIELEARN_COURSE_PARSER_NOT_VERIFIED");
    expect((await ada.send("post", "/api/sources", { body: { type: "gradescope", base_url: "http://www.gradescope.com" } })).status).toBe(422);
  });
});
