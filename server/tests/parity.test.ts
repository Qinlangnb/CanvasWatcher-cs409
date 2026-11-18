import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { canvasFileId, linkedFileIds } from "../src/canvas/attachments.js";
import { chooseDefaultTerm, normalizeCourseDisplay, normalizeTerm, shouldArchiveNewCourse } from "../src/courses/terms.js";
import { classifyFile, detectFileType } from "../src/files/types.js";
import { safeTaskUrl } from "../src/tasks/links.js";
import { CANVAS_ORIGIN, daysFromNow, fakeCanvas, seedCourse } from "./fakeCanvas.js";
import { type Browser, connectCanvas, db, resetDatabase, signUp, syncNow } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
  fakeCanvas.reset();
});
afterAll(() => db.$disconnect());

describe("file types", () => {
  it.each([
    ["Lecture 3 slides.pdf", "lecture"],
    ["HW3.pdf", "homework"],
    ["HW 3 solutions.pdf", "solution"],
    ["sol_2.pdf", "solution"],
    ["Midterm review.pdf", "exam"],
    ["dis 4 worksheet.pdf", "discussion"],
    ["optional reading - chapter 2.pdf", "reading"],
    ["期末试卷.pdf", "exam"],
    ["第三次作业.docx", "homework"],
    ["课件 01.pptx", "lecture"],
    ["photo.png", "other"],
    ["https://canvas.example.edu/files/1/notes.pdf?answers=1", "other"],
  ])("classifies %s as %s", (name, type) => {
    expect(classifyFile(name)).toBe(type);
  });

  it("falls back to the titles of the assignments that link a file", () => {
    expect(detectFileType("scan_0042.pdf", ["Homework 5"])).toBe("homework");
    expect(detectFileType("lec1.pdf", ["Homework 5"])).toBe("lecture");
  });
});

describe("assignment attachment links", () => {
  it("takes exact file links of the same Canvas and course only", () => {
    const html = `<a href="/courses/101/files/555/download?wrap=1">hw</a>
      <a href="${CANVAS_ORIGIN}/courses/101/files/556">x</a>
      <iframe src="/files/557/preview"></iframe>
      <a href="/courses/999/files/558">other course</a>
      <a href="https://elsewhere.example.com/courses/101/files/559">other host</a>
      <a data-api-endpoint="${CANVAS_ORIGIN}/api/v1/courses/101/files/555" data-api-returntype="File">dup</a>`;
    expect(linkedFileIds(html, "101", CANVAS_ORIGIN)).toEqual(["555", "556", "557"]);
    expect(canvasFileId("/courses/101/assignments/3", "101", CANVAS_ORIGIN)).toBeNull();
  });
});

describe("terms and course display", () => {
  it("normalizes season and year, in either order", () => {
    expect(normalizeTerm("2026 fall")).toMatchObject({ id: "fall-2026", displayName: "Fall 2026", sortKey: "2026-4" });
    expect(normalizeTerm("Spring 2027 - Main")).toMatchObject({ id: "spring-2027", sortKey: "2027-2" });
    expect(normalizeTerm(null)).toMatchObject({ id: "none" });
    expect(normalizeTerm("Default Term", null, new Date("2026-05-10T05:00:00Z")).sortKey).toBe("20260510-0");
  });

  it("extracts DEPT 123 and the section", () => {
    expect(normalizeCourseDisplay("CS 409 AL1 FA26", "CS 409 - The Art of Web Programming - Section AL1 - Fall 2026", "Fall 2026")).toEqual({
      code: "CS 409",
      name: "The Art of Web Programming",
      section: "Section AL1",
    });
    expect(normalizeCourseDisplay("Fall 2026 MATH 241", "Calculus III").code).toBe("MATH 241");
  });

  it("defaults to the term containing today, else the newest", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    const fall = normalizeTerm("Fall 2026", new Date("2026-08-24T05:00:00Z"), new Date("2026-12-18T05:00:00Z"));
    const spring = normalizeTerm("Spring 2027", new Date("2027-01-19T06:00:00Z"), new Date("2027-05-14T05:00:00Z"));
    expect(chooseDefaultTerm([spring, fall], now)).toBe("fall-2026");
    expect(chooseDefaultTerm([spring, fall], new Date("2026-12-30T00:00:00Z"))).toBe("spring-2027");
    expect(shouldArchiveNewCourse(new Date("2026-05-01T00:00:00Z"), now)).toBe(true);
    expect(shouldArchiveNewCourse(null, now)).toBe(false);
  });

  it("opens only stable http(s) task links", () => {
    expect(safeTaskUrl(`${CANVAS_ORIGIN}/courses/1/assignments/2`)).toBe(`${CANVAS_ORIGIN}/courses/1/assignments/2`);
    expect(safeTaskUrl(`${CANVAS_ORIGIN}/courses/1/files/2/download`)).toBeNull();
    expect(safeTaskUrl(`${CANVAS_ORIGIN}/courses/1?verifier=x`)).toBeNull();
    expect(safeTaskUrl("javascript:alert(1)")).toBeNull();
    expect(safeTaskUrl("https://user:pw@example.com/a")).toBeNull();
  });
});

async function adaWithTasks(): Promise<{ ada: Browser; first: number; second: number }> {
  seedCourse(fakeCanvas);
  fakeCanvas.assignments.get("101")?.push({ id: 1012, name: "HW 2", due_at: daysFromNow(5), points_possible: 10 });
  const ada = await signUp();
  await connectCanvas(ada);
  const tasks = (await ada.send("get", "/api/tasks")).body as { id: number; title: string }[];
  const id = (title: string) => tasks.find((task) => task.title === title)?.id as number;
  return { ada, first: id("MP 1: Layout"), second: id("HW 2") };
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe("work timers", () => {
  it("keeps one running timer and reports the switch", async () => {
    const { ada, first, second } = await adaWithTasks();
    const started = await ada.send("post", `/api/tasks/${first}/work/start`);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ task_id: first, switched_from_task_id: null });
    expect(started.body.active_started_at).toEqual(expect.any(String));
    const again = await ada.send("post", `/api/tasks/${first}/work/start`);
    expect(again.body.active_session_id).toBe(started.body.active_session_id);

    const switched = await ada.send("post", `/api/tasks/${second}/work/start`);
    expect(switched.body.switched_from_task_id).toBe(first);
    expect(await db.workSession.count({ where: { endedAt: null } })).toBe(1);
    const active = await ada.send("get", "/api/work/active");
    expect(active.body.active).toMatchObject({ task_id: second, task_title: "HW 2", course: { code: "CS 409" } });

    // The partial unique index refuses a second open session outright.
    const user = await db.user.findFirstOrThrow();
    await expect(db.workSession.create({ data: { userId: user.id, taskId: first, startedAt: new Date() } })).rejects.toThrow();

    await ada.send("post", `/api/tasks/${second}/work/stop`);
    expect((await ada.send("get", "/api/work/active")).body.active).toBeNull();
    const history = await ada.send("get", `/api/tasks/${first}/work`);
    expect(history.body.sessions).toHaveLength(1);
    expect(history.body.sessions[0].ended_at).toEqual(expect.any(String));
  });

  it("checks heartbeats: running timer, time window, monotonic stamps, progress", async () => {
    const { ada, first, second } = await adaWithTasks();
    const idle = await ada.send("post", `/api/tasks/${first}/work/heartbeat`, { body: { client_timestamp: iso(0) } });
    expect(idle.status).toBe(409);
    expect(idle.body.code).toBe("WORK_NOT_ACTIVE");

    await ada.send("post", `/api/tasks/${first}/work/start`);
    const future = await ada.send("post", `/api/tasks/${first}/work/heartbeat`, { body: { client_timestamp: iso(10 * 60_000) } });
    expect(future.status).toBe(422);
    const old = await ada.send("post", `/api/tasks/${first}/work/heartbeat`, { body: { client_timestamp: iso(-25 * 3600_000) } });
    expect(old.status).toBe(422);
    const noZone = await ada.send("post", `/api/tasks/${first}/work/heartbeat`, { body: { client_timestamp: "2026-11-17T10:00:00" } });
    expect(noZone.status).toBe(422);

    const beat = await ada.send("post", `/api/tasks/${first}/work/heartbeat`, {
      body: { client_timestamp: iso(0), expected_revision: 0, progress_percent: 40 },
    });
    expect(beat.status).toBe(200);
    expect(beat.body.state_revision).toBe(1);
    const stale = await ada.send("post", `/api/tasks/${first}/work/heartbeat`, {
      body: { client_timestamp: iso(-60_000), expected_revision: 1, progress_percent: 10 },
    });
    expect(stale.body.state_revision).toBe(1);
    expect((await db.task.findUniqueOrThrow({ where: { id: first } })).progress).toBe(40);

    const other = await ada.send("post", `/api/tasks/${second}/work/heartbeat`, { body: { client_timestamp: iso(0) } });
    expect(other.status).toBe(409);
  });

  it("stops the timer when the task is ignored or completed", async () => {
    const { ada, first, second } = await adaWithTasks();
    await ada.send("post", `/api/tasks/${first}/work/start`);
    await db.workSession.updateMany({ data: { startedAt: new Date(Date.now() - 30 * 60_000) } });
    const ignored = await ada.send("patch", `/api/tasks/${first}`, { body: { ignored: true } });
    expect(ignored.status).toBe(200);
    expect(ignored.body).toMatchObject({ tracked_minutes: 30, spent_minutes: 30 });
    expect((await ada.send("get", "/api/work/active")).body.active).toBeNull();
    const blocked = await ada.send("post", `/api/tasks/${first}/work/start`);
    expect(blocked.status).toBe(409);

    await ada.send("post", `/api/tasks/${second}/work/start`);
    const done = await ada.send("post", `/api/tasks/${second}/progress`, { body: { progress_percent: 100, expected_revision: 0 } });
    expect(done.body).toMatchObject({ applied: true, task: { state: "done", progress: 100 } });
    expect((await ada.send("get", "/api/work/active")).body.active).toBeNull();
    const restart = await ada.send("post", `/api/tasks/${second}/work/start`);
    expect(restart.body.code).toBe("TASK_COMPLETED");
  });

  it("corrects time used without rewriting sessions", async () => {
    const { ada, first } = await adaWithTasks();
    await ada.send("post", `/api/tasks/${first}/work/start`);
    await db.workSession.updateMany({ data: { startedAt: new Date(Date.now() - 20 * 60_000) } });
    await ada.send("post", `/api/tasks/${first}/work/stop`);
    const corrected = await ada.send("patch", `/api/tasks/${first}`, { body: { spent_minutes: 50 } });
    expect(corrected.body).toMatchObject({ spent_minutes: 50, tracked_minutes: 20, manual_adjustment_minutes: 30 });
    const lowered = await ada.send("patch", `/api/tasks/${first}`, { body: { spent_minutes: 5 } });
    expect(lowered.body).toMatchObject({ spent_minutes: 5, tracked_minutes: 20, manual_adjustment_minutes: -15 });
    expect(await db.workSession.count()).toBe(1);
  });
});

describe("progress revisions", () => {
  it("refuses stale revisions and reopens completed work explicitly", async () => {
    const { ada, first } = await adaWithTasks();
    const saved = await ada.send("post", `/api/tasks/${first}/progress`, { body: { progress_percent: 30, expected_revision: 0 } });
    expect(saved.body).toMatchObject({ applied: true, state_revision: 1 });
    const stale = await ada.send("post", `/api/tasks/${first}/progress`, { body: { progress_percent: 50, expected_revision: 0 } });
    expect(stale.body).toMatchObject({ applied: false, state_revision: 1, task: { progress: 30 } });
    const patchStale = await ada.send("patch", `/api/tasks/${first}`, { body: { done: true, expected_revision: 0 } });
    expect(patchStale.status).toBe(409);
    expect(patchStale.body.detail).toBe("Task changed elsewhere; refreshed the saved state.");

    const done = await ada.send("post", `/api/tasks/${first}/progress`, { body: { progress_percent: 100, expected_revision: 1 } });
    expect(done.body.task.state).toBe("done");
    const lower = await ada.send("post", `/api/tasks/${first}/progress`, { body: { progress_percent: 60, expected_revision: 2 } });
    expect(lower.body.applied).toBe(false);
    const noRevision = await ada.send("post", `/api/tasks/${first}/progress`, { body: { progress_percent: 99, reopen: true } });
    expect(noRevision.status).toBe(422);
    const reopened = await ada.send("post", `/api/tasks/${first}/progress`, { body: { progress_percent: 99, reopen: true, expected_revision: 2 } });
    expect(reopened.body).toMatchObject({ applied: true, state_revision: 3, task: { state: "open", progress: 99, completed_at: null } });

    const history = await db.taskProgress.findMany({ where: { taskId: first }, orderBy: { id: "asc" } });
    expect(history.map((row) => [row.progress, row.completed, row.origin])).toEqual([
      [30, false, "user"],
      [100, true, "user"],
      [99, false, "reopen"],
    ]);
  });

  it("ignores actions older than the last one and keeps Canvas submissions", async () => {
    const { ada, first } = await adaWithTasks();
    await ada.send("post", `/api/tasks/${first}/progress`, { body: { progress_percent: 30, action_at: iso(0) } });
    const older = await ada.send("post", `/api/tasks/${first}/progress`, { body: { progress_percent: 20, action_at: iso(-60_000) } });
    expect(older.body.applied).toBe(false);
    const late = await ada.send("post", `/api/tasks/${first}/progress`, { body: { progress_percent: 20, action_at: iso(-2 * 86_400_000) } });
    expect(late.status).toBe(422);

    await db.task.update({ where: { id: first }, data: { submissionState: "submitted" } });
    await ada.send("post", `/api/tasks/${first}/progress`, { body: { progress_percent: 50 } });
    const task = await db.task.findUniqueOrThrow({ where: { id: first } });
    expect(task.submissionState).toBe("submitted");
  });

  it("keeps a date-only deadline at the end of its local day", async () => {
    const { ada } = await adaWithTasks();
    const [course] = (await ada.send("get", "/api/courses")).body;
    const created = await ada.send("post", "/api/tasks", {
      body: { course_id: course.id, title: "Read chapter 4", due_at: "2026-12-02T09:00:00-06:00", due_date_only: true },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ deadline_precision: "date_only", due_at: "2026-12-03T05:59:00.000Z" });
    const exact = await ada.send("patch", `/api/tasks/${created.body.id}`, { body: { due_at: "2026-12-04T10:00:00-06:00" } });
    expect(exact.body.deadline_precision).toBe("exact");
  });
});

describe("files, attachments and terms after sync", () => {
  it("links description files to tasks and classifies files, with overrides", async () => {
    seedCourse(fakeCanvas);
    fakeCanvas.files.get("101")?.push(
      { id: 10102, display_name: "scan_0042.pdf", "content-type": "application/pdf", size: 10 },
      { id: 10103, display_name: "Lecture 1.pdf", "content-type": "application/pdf", size: 10 },
    );
    const assignment = fakeCanvas.assignments.get("101")?.[0];
    if (assignment) assignment.description = `<p>Read <a href="/courses/101/files/10102/download">the handout</a> and <a href="/courses/101/files/10103">slides</a>.</p>`;
    assignment!.name = "Homework 1";
    const ada = await signUp();
    await connectCanvas(ada);

    const [task] = (await ada.send("get", "/api/tasks")).body;
    const detail = await ada.send("get", `/api/tasks/${task.id}`);
    expect(detail.body.attachments.map((file: { filename: string }) => file.filename)).toEqual(["Lecture 1.pdf", "scan_0042.pdf"]);
    expect(detail.body.source_url).toBe(`${CANVAS_ORIGIN}/courses/101/assignments/1011`);

    const files = (await ada.send("get", "/api/files")).body.items as { id: number; name: string; type: string }[];
    const byName = Object.fromEntries(files.map((file) => [file.name, file]));
    expect(byName["scan_0042.pdf"]?.type).toBe("homework");
    expect(byName["Lecture 1.pdf"]?.type).toBe("lecture");
    expect(byName["syllabus.pdf"]?.type).toBe("reading");

    const moved = await ada.send("patch", `/api/files/${byName["scan_0042.pdf"]?.id}/classification`, { body: { type: "solution" } });
    expect(moved.body).toMatchObject({ type: "solution", user_override_type: "solution" });
    expect((await ada.send("patch", `/api/files/${byName["scan_0042.pdf"]?.id}/classification`, { body: { type: "slides" } })).status).toBe(422);
    await syncNow(ada);
    const solutions = (await ada.send("get", "/api/files?type=solution")).body.items;
    expect(solutions.map((file: { name: string }) => file.name)).toEqual(["scan_0042.pdf"]);

    // The description drops one link: the next sync drops that attachment.
    if (assignment) assignment.description = `<a href="/courses/101/files/10103">slides</a>`;
    await syncNow(ada);
    const after = await ada.send("get", `/api/tasks/${task.id}`);
    expect(after.body.attachments.map((file: { filename: string }) => file.filename)).toEqual(["Lecture 1.pdf"]);
    const link = await ada.send("get", `/api/files/${after.body.attachments[0].file_id}/download?link=1`);
    expect(link.body.url).toContain(`${CANVAS_ORIGIN}/files/10103/download`);
  });

  it("lists terms, filters by term, archives past-term courses on first sight and restores with a sync", async () => {
    seedCourse(fakeCanvas);
    seedCourse(fakeCanvas, 102, "MATH 241");
    const old = fakeCanvas.courses.at(-1);
    if (old) old.term = { name: "Spring 2026", start_at: "2026-01-20T06:00:00Z", end_at: "2026-05-15T05:00:00Z" };
    const ada = await signUp();
    await connectCanvas(ada);

    const active = (await ada.send("get", "/api/courses")).body;
    expect(active.map((course: { code: string }) => course.code)).toEqual(["CS 409"]);
    expect(active[0]).toMatchObject({ display_code: "CS 409", term: { id: "fall-2026", display_name: "Fall 2026" } });
    const terms = (await ada.send("get", "/api/courses/terms")).body;
    expect(terms).toEqual([
      expect.objectContaining({ term_id: "fall-2026", active_course_count: 1, archived_course_count: 0, is_default: true }),
      expect.objectContaining({ term_id: "spring-2026", active_course_count: 0, archived_course_count: 1, is_default: false }),
    ]);
    expect((await ada.send("get", "/api/courses?term_id=spring-2026")).body).toEqual([]);
    expect((await ada.send("get", "/api/courses?term_id=fall-2026")).body).toHaveLength(1);

    const [archived] = (await ada.send("get", "/api/courses?archived=true")).body;
    const restored = await ada.send("post", `/api/courses/${archived.id}/restore`);
    expect(restored.body).toMatchObject({ archived: false, reconciliation_queued: true });
    const { services } = await import("./helpers.js");
    await services.sync.whenIdle();
    // A known course stays where the student put it.
    expect((await ada.send("get", "/api/courses")).body).toHaveLength(2);
    const again = await ada.send("post", `/api/courses/${archived.id}/archive`);
    expect(again.body.archived).toBe(true);
  });

  it("gives Today items a priority bucket", async () => {
    seedCourse(fakeCanvas);
    fakeCanvas.assignments.get("101")?.push({ id: 1019, name: "Due soon", due_at: daysFromNow(0.2), points_possible: 100 });
    const ada = await signUp();
    await connectCanvas(ada);
    const today = (await ada.send("get", "/api/today")).body;
    const item = today.items.find((row: { task: { title: string } }) => row.task.title === "Due soon");
    expect(["Low", "Medium", "High", "Critical"]).toContain(item.priority_bucket);
  });
});
