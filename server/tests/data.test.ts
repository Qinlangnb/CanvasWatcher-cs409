import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CANVAS_ORIGIN, fakeCanvas, seedCourse } from "./fakeCanvas.js";
import { Browser, connectCanvas, db, resetDatabase, signUp, syncNow } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
  fakeCanvas.reset();
});
afterAll(() => db.$disconnect());

/** Ada with one synced course, then three assignment changes detected by a second sync. */
async function adaWithChanges(): Promise<Browser> {
  seedCourse(fakeCanvas);
  const ada = await signUp();
  await connectCanvas(ada);
  fakeCanvas.assignments.get("101")?.push(
    { id: 1012, name: "HW 2", due_at: "2026-11-20T05:59:00Z", points_possible: 10 },
    { id: 1013, name: "Reading 1", due_at: null },
    {
      id: 1014,
      name: "Quiz 1",
      due_at: "2026-09-01T05:59:00Z",
      submission: { workflow_state: "graded", submitted_at: "2026-08-31T20:00:00Z" },
    },
  );
  await syncNow(ada);
  return ada;
}

describe("courses", () => {
  it("lists courses with open task, unread change and file counts", async () => {
    await adaWithChanges();
    const ada = new Browser();
    await ada.signIn();
    const res = await ada.send("get", "/api/courses");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        code: "CS 409",
        html_url: `${CANVAS_ORIGIN}/courses/101`,
        archived: false,
        term: expect.objectContaining({ name: "Fall 2026" }),
        counts: { open_tasks: 3, unread_changes: 3, files: 1 },
      }),
    ]);
    const one = await ada.send("get", `/api/courses/${res.body[0].id}`);
    expect(one.body.counts.open_tasks).toBe(3);
  });

  it("archives a course and hides it, its tasks and its changes from overall lists", async () => {
    const ada = await adaWithChanges();
    const [course] = (await ada.send("get", "/api/courses")).body;
    const archived = await ada.send("patch", `/api/courses/${course.id}`, { body: { archived: true } });
    expect(archived.body.archived).toBe(true);
    expect((await ada.send("get", "/api/courses")).body).toEqual([]);
    expect((await ada.send("get", "/api/courses?archived=true")).body).toHaveLength(1);
    expect((await ada.send("get", "/api/tasks")).body).toEqual([]);
    expect((await ada.send("get", "/api/changes/unread-count")).body.count).toBe(0);
    expect((await ada.send("get", `/api/tasks?course_id=${course.id}`)).body).toHaveLength(3);
  });

  it("answers 404 for a missing or malformed id and 400 for a bad query", async () => {
    const ada = await signUp();
    expect((await ada.send("get", "/api/courses/999")).body.code).toBe("COURSE_NOT_FOUND");
    expect((await ada.send("get", "/api/courses/abc")).status).toBe(404);
    const bad = await ada.send("get", "/api/courses?archived=maybe");
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_QUERY");
  });
});

describe("tasks", () => {
  it("lists open tasks by due date with undated ones last", async () => {
    const ada = await adaWithChanges();
    const open = await ada.send("get", "/api/tasks");
    expect(open.body.map((task: { title: string }) => task.title)).toEqual(["MP 1: Layout", "HW 2", "Reading 1"]);
    expect(open.body[0]).toMatchObject({ type: "assignment", points_possible: 100, course: { code: "CS 409" } });
    expect(open.body[2]).toMatchObject({ type: "reading", due_at: null, state: "open" });

    const all = await ada.send("get", "/api/tasks?status=all");
    const quiz = all.body.find((task: { title: string }) => task.title === "Quiz 1");
    expect(quiz).toMatchObject({ type: "exam", state: "done", submission_state: "graded" });
  });
});

describe("files", () => {
  it("lists and searches files", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    const files = await ada.send("get", "/api/files");
    expect(files.body).toEqual({
      items: [expect.objectContaining({ name: "syllabus.pdf", content_type: "application/pdf", size_bytes: 12_345 })],
      next_cursor: null,
    });
    expect((await ada.send("get", "/api/files?q=SYLL")).body.items).toHaveLength(1);
    expect((await ada.send("get", "/api/files?q=lecture")).body.items).toHaveLength(0);
  });

  it("pages through files newest first, undated last, with a stable cursor", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    const course = await db.course.findFirstOrThrow();
    const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12));
    // Ties on the update time and several undated files, so the id tie-break and the null case are both crossed.
    const dates = [day(3), day(5), day(5), day(5), null, day(1), null, day(9), day(2), null, day(5)];
    await db.courseFile.createMany({
      data: dates.map((canvasUpdatedAt, index) => ({
        userId: course.userId,
        courseId: course.id,
        canvasId: `extra-${index}`,
        displayName: `Lecture ${index}.pdf`,
        sizeBytes: 100,
        canvasUpdatedAt,
      })),
    });
    const all = await db.courseFile.findMany({ where: { removedAt: null } });
    const expected = all
      .sort((a, b) => {
        const left = a.canvasUpdatedAt?.getTime() ?? -Infinity;
        const right = b.canvasUpdatedAt?.getTime() ?? -Infinity;
        return right - left || b.id - a.id;
      })
      .map((file) => file.id);

    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await ada.send("get", `/api/files?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(3);
      seen.push(...res.body.items.map((file: { id: number }) => file.id));
      cursor = res.body.next_cursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual(expected);
    expect(pages).toBe(Math.ceil(expected.length / 3));

    const searched = await ada.send("get", "/api/files?q=lecture&limit=4");
    expect(searched.body.items).toHaveLength(4);
    const rest = await ada.send("get", `/api/files?q=lecture&limit=100&cursor=${encodeURIComponent(searched.body.next_cursor)}`);
    expect(rest.body).toEqual({ items: expect.any(Array), next_cursor: null });
    expect(rest.body.items).toHaveLength(dates.length - 4);

    for (const bad of ["nonsense", Buffer.from('["yesterday", 1]').toString("base64url")]) {
      const res = await ada.send("get", `/api/files?cursor=${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_QUERY");
    }
  });

  it("redirects a download to a fresh Canvas link", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    const [file] = (await ada.send("get", "/api/files")).body.items;
    const res = await ada.send("get", file.download_url);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${CANVAS_ORIGIN}/files/10101/download?download_frd=1&verifier=fake`);
  });
});

describe("changes", () => {
  it("pages through changes newest first", async () => {
    const ada = await adaWithChanges();
    const first = await ada.send("get", "/api/changes?limit=2");
    expect(first.body.items).toHaveLength(2);
    expect(first.body.next_before).toBe(first.body.items[1].id);
    const second = await ada.send("get", `/api/changes?limit=2&before=${first.body.next_before}`);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.next_before).toBeNull();
    const ids = [...first.body.items, ...second.body.items].map((item: { id: number }) => item.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it("shows one change with its versions and task, and tracks read state", async () => {
    const ada = await adaWithChanges();
    const [change] = (await ada.send("get", "/api/changes?limit=1")).body.items;
    const detail = await ada.send("get", `/api/changes/${change.id}`);
    expect(detail.body).toMatchObject({ kind: "assignment", change_type: "created", read: false, before: null });
    expect(detail.body.after.title).toBe(detail.body.title);
    expect(detail.body.related_task.title).toBe(detail.body.title);

    const read = await ada.send("patch", `/api/changes/${change.id}`, { body: { read: true } });
    expect(read.body.read).toBe(true);
    expect((await ada.send("get", "/api/changes/unread-count")).body.count).toBe(2);
    expect((await ada.send("get", "/api/changes?unread=true")).body.items).toHaveLength(2);

    const all = await ada.send("post", "/api/changes/mark-all-read", { body: {} });
    expect(all.body.updated).toBe(2);
    expect((await ada.send("get", "/api/changes/unread-count")).body.count).toBe(0);
  });

  it("validates the read flag", async () => {
    const ada = await adaWithChanges();
    const [change] = (await ada.send("get", "/api/changes?limit=1")).body.items;
    const res = await ada.send("patch", `/api/changes/${change.id}`, { body: { read: "yes" } });
    expect(res.status).toBe(422);
  });
});

describe("isolation between users", () => {
  it("never shows or changes another user's data", async () => {
    const ada = await adaWithChanges();
    const [course] = (await ada.send("get", "/api/courses")).body;
    const [change] = (await ada.send("get", "/api/changes?limit=1")).body.items;
    const [file] = (await ada.send("get", "/api/files")).body.items;
    const { id: runId } = (await ada.send("get", "/api/sync/runs/latest")).body;

    const bob = await signUp({ username: "bob", email: "bob@example.com" });
    expect((await bob.send("get", "/api/courses")).body).toEqual([]);
    expect((await bob.send("get", "/api/tasks")).body).toEqual([]);
    expect((await bob.send("get", "/api/files")).body.items).toEqual([]);
    expect((await bob.send("get", "/api/changes")).body.items).toEqual([]);
    expect((await bob.send("get", `/api/courses/${course.id}`)).status).toBe(404);
    expect((await bob.send("get", `/api/tasks?course_id=${course.id}`)).body).toEqual([]);
    expect((await bob.send("get", `/api/changes/${change.id}`)).status).toBe(404);
    expect((await bob.send("patch", `/api/changes/${change.id}`, { body: { read: true } })).status).toBe(404);
    expect((await bob.send("patch", `/api/courses/${course.id}`, { body: { archived: true } })).status).toBe(404);
    expect((await bob.send("get", file.download_url)).status).toBe(404);
    expect((await bob.send("get", `/api/sync/runs/${runId}`)).status).toBe(404);
    expect((await bob.send("post", "/api/changes/mark-all-read", { body: { course_id: course.id } })).body.updated).toBe(0);
    expect((await ada.send("get", "/api/changes/unread-count")).body.count).toBe(3);
  });
});
