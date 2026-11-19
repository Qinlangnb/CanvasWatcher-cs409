import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AiProvider } from "../src/ai/provider.js";
import { EVIDENCE_NEEDED, matches, mutateFromReview, type FilterSpec, type ReviewContext } from "../src/changes/filters.js";
import { gradeChange } from "../src/changes/grades.js";
import { ChangeReviewWorker, parseDecision, saveChanges } from "../src/changes/review.js";
import { classify, eventLabel, semanticKey, transition } from "../src/changes/taxonomy.js";
import { notify } from "../src/notifications/notify.js";
import { daysFromNow, fakeCanvas, seedCourse } from "./fakeCanvas.js";
import { Browser, connectCanvas, db, logger, resetDatabase, signUp, syncNow } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
  fakeCanvas.reset();
});
afterAll(() => db.$disconnect());

/** A provider that answers every review with `reply` (a decision object, or raw text). */
function fakeProvider(reply: object | string): AiProvider & { calls: number } {
  return {
    model: "fake",
    calls: 0,
    async complete() {
      this.calls += 1;
      return { role: "assistant", content: typeof reply === "string" ? reply : JSON.stringify(reply) };
    },
  };
}

async function userId(browser: Browser): Promise<string> {
  return (await browser.send("get", "/api/users/me")).body.id;
}

/** Ada with one synced course; then a new file, a moved deadline and a reworded assignment. */
async function adaWithChanges(): Promise<Browser> {
  seedCourse(fakeCanvas);
  const ada = await signUp();
  await connectCanvas(ada);
  const [assignment] = fakeCanvas.assignments.get("101") ?? [];
  if (assignment) assignment.due_at = daysFromNow(21);
  fakeCanvas.assignments.get("101")?.push({ id: 1012, name: "HW 2", due_at: null });
  fakeCanvas.files.get("101")?.push({ id: 10102, display_name: "lecture-3.pdf", size: 10, "content-type": "application/pdf" });
  await syncNow(ada);
  return ada;
}

describe("change taxonomy", () => {
  it("classifies changes and decides what the Important feed shows", () => {
    expect(classify("FILE", "CREATED", [])).toMatchObject({ category: "file", userFacing: true });
    expect(classify("FILE", "UPDATED", ["size"])).toMatchObject({ category: "file", userFacing: false });
    expect(classify("ANNOUNCEMENT", "CREATED", [])).toMatchObject({ category: "announcement", userFacing: true });
    expect(classify("ASSIGNMENT", "UPDATED", ["due_at", "title"])).toMatchObject({ category: "deadline", importance: "important", requiresAction: true, userFacing: true });
    expect(classify("ASSIGNMENT", "UPDATED", ["score"])).toMatchObject({ category: "grade", importance: "important", userFacing: true });
    expect(classify("ASSIGNMENT", "UPDATED", ["description"])).toMatchObject({ category: "assignment", userFacing: false });
    expect(classify("ASSIGNMENT", "CREATED", [])).toMatchObject({ category: "assignment", userFacing: false });
    expect(eventLabel(transition("ASSIGNMENT", "UPDATED", "grade", { score: null, grade: null, excused: 0 }))).toBe("Grade released");
    expect(eventLabel(transition("ASSIGNMENT", "UPDATED", "grade", { score: 0, grade: "0", excused: 0 }))).toBe("Grade updated");
    expect(eventLabel(transition("FILE", "CREATED", "file", undefined))).toBe("New file");
  });

  it("gives the same transition the same semantic key, and others a different one", () => {
    const key = semanticKey(1, "deadline_changed", { due_at: "a" }, { due_at: "b" });
    expect(semanticKey(1, "deadline_changed", { due_at: "a" }, { due_at: "b" })).toBe(key);
    expect(semanticKey(1, "deadline_changed", { due_at: "b" }, { due_at: "a" })).not.toBe(key);
    expect(semanticKey(2, "deadline_changed", { due_at: "a" }, { due_at: "b" })).not.toBe(key);
  });

  it("detects a grade release, counting a zero, and ignores a grade hidden again", () => {
    const none = { score: null, grade: null, excused: false };
    expect(gradeChange("1", "HW", none, { score: 0, grade: "0", excused: false })?.fields).toEqual(["score", "grade"]);
    expect(gradeChange("1", "HW", { score: 8, grade: "8", excused: false }, none)).toBeNull();
    expect(gradeChange("1", "HW", undefined, { score: 8, grade: "8", excused: false })).toBeNull();
    expect(gradeChange("1", "HW", none, none)).toBeNull();
  });
});

describe("changes feed", () => {
  it("adds taxonomy to changes and filters the Important set", async () => {
    const ada = await adaWithChanges();
    const all = (await ada.send("get", "/api/changes")).body.items as Record<string, unknown>[];
    expect(all).toHaveLength(3);
    const deadline = all.find((item) => item.category === "deadline");
    expect(deadline).toMatchObject({ event_label: "Deadline changed", importance: "important", requires_action: true, course_code: "CS 409" });
    expect(deadline?.primary_text).toMatch(/^CS 409: Due date changed/);
    const important = (await ada.send("get", "/api/changes?important=true")).body.items as { event_label: string }[];
    expect(important.map((item) => item.event_label).sort()).toEqual(["Deadline changed", "New file"]);
    expect((await ada.send("get", "/api/changes/unread-count?important=true")).body.count).toBe(2);
    expect((await ada.send("get", "/api/changes/unread-count")).body.count).toBe(3);

    const detail = await ada.send("get", `/api/changes/${deadline?.id}`);
    expect(detail.body.before_text).toMatch(/^Title: MP 1: Layout\nDue: /);
    expect(detail.body.after_text).toMatch(/Build a responsive page\./);
    expect(detail.body.internals.deduplicated).toBe(true);
    expect(detail.body.review).toMatchObject({ status: "pending" });
  });

  it("reports a grade release once, then a later change of the grade", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    const [assignment] = fakeCanvas.assignments.get("101") ?? [];
    if (!assignment) throw new Error("seed");
    assignment.submission = { workflow_state: "graded", submitted_at: daysFromNow(-1), score: 92, grade: "92" };
    expect(await syncNow(ada)).toMatchObject({ changes_detected: 1 });
    expect(await syncNow(ada)).toMatchObject({ changes_detected: 0 });
    assignment.submission = { ...assignment.submission, score: 95, grade: "95" };
    await syncNow(ada);
    const items = (await ada.send("get", "/api/changes?important=true")).body.items as Record<string, unknown>[];
    expect(items.map((item) => [item.category, item.event_label, item.summary])).toEqual([
      ["grade", "Grade updated", 'Grade updated for "MP 1: Layout"'],
      ["grade", "Grade released", 'Grade released for "MP 1: Layout"'],
    ]);
    const detail = await ada.send("get", `/api/changes/${items[1]?.id}`);
    expect(detail.body.after).toEqual({ score: 92, grade: "92", excused: 0 });
  });

  it("never saves the same transition twice", async () => {
    const ada = await adaWithChanges();
    const change = await db.changeEvent.findFirstOrThrow({ where: { category: "deadline" }, include: { sourceItem: true } });
    const again = {
      userId: await userId(ada),
      courseId: change.courseId,
      sourceItemId: change.sourceItemId,
      kind: change.sourceItem.kind,
      title: change.sourceItem.title,
      changeType: change.changeType,
      fields: change.fields,
      summary: change.summary,
      before: change.before as Record<string, string>,
      after: change.after as Record<string, string>,
      detectedAt: new Date(),
    };
    expect(await db.$transaction((tx) => saveChanges(tx, [again]))).toBe(0);
    expect(await db.changeEvent.count({ where: { category: "deadline" } })).toBe(1);
  });
});

describe("change review", () => {
  it("prefilters in the sync: only Important changes wait for the AI", async () => {
    await adaWithChanges();
    const reviews = await db.changeReview.findMany({ include: { changeEvent: true }, orderBy: { id: "asc" } });
    const byCategory = Object.fromEntries(reviews.map((review) => [review.changeEvent.category, [review.status, review.stage1Reason]]));
    expect(byCategory).toEqual({
      deadline: ["PENDING", "academic_candidate"],
      assignment: ["SUPPRESSED", "system_or_nonsemantic"],
      file: ["PENDING", "academic_candidate"],
    });
  });

  it("parks reviews without an AI, then notifies once one approves", async () => {
    const ada = await adaWithChanges();
    let provider: AiProvider | null = null;
    const worker = new ChangeReviewWorker(db, logger, async () => provider);
    expect(await worker.runOnce()).toBe(0);
    expect(await db.changeReview.count({ where: { status: "WAITING_AI" } })).toBe(2);

    const ai = fakeProvider({ notify_user: true, importance: "critical", reason: "The due date moved a week later." });
    provider = ai;
    expect(await worker.runOnce()).toBe(2);
    expect(ai.calls).toBe(2);
    const banners = (await ada.send("get", "/api/notifications")).body as { id: number; level: string; title: string }[];
    expect(banners).toHaveLength(2);
    expect(banners[0]).toMatchObject({ level: "critical", body: "The due date moved a week later." });
    expect(banners.map((banner) => banner.title).sort()[0]).toMatch(/^CS 409: Deadline changed · MP 1: Layout$/);

    const attention = (await ada.send("get", "/api/changes/attention")).body.items;
    expect(attention).toHaveLength(2);
    expect(attention[0]).toMatchObject({ severity: "critical", recommended_action: "Review this change.", change: { importance: "critical", ai_summary: "The due date moved a week later." } });

    // Nothing is reviewed or notified twice.
    expect(await worker.runOnce()).toBe(0);
    expect(await db.notification.count()).toBe(2);
    expect((await ada.send("post", `/api/notifications/${banners[0]?.id}/dismiss`)).status).toBe(204);
    expect((await ada.send("get", "/api/notifications")).body).toHaveLength(1);
    await ada.send("patch", `/api/changes/${attention[0].change.id}`, { body: { read: true } });
    expect((await ada.send("get", "/api/changes/attention")).body.items).toHaveLength(1);
  });

  it("retries a bad answer once, then gives up without a notification", async () => {
    await adaWithChanges();
    const ai = fakeProvider("Sure! I think the student should know.");
    const worker = new ChangeReviewWorker(db, logger, async () => ai);
    expect(await worker.runOnce()).toBe(0);
    expect(await db.changeReview.count({ where: { status: "PENDING", attempts: 1 } })).toBe(2);
    expect(await worker.runOnce()).toBe(0);
    const failed = await db.changeReview.findMany({ where: { status: "FAILED" } });
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ attempts: 2, error: "bad_reply", notifyUser: false });
    expect(await db.notification.count()).toBe(0);
  });

  it("takes back a review stuck in REVIEWING", async () => {
    await adaWithChanges();
    const old = new Date(Date.now() - 10 * 60_000);
    await db.$executeRaw`UPDATE change_reviews SET status = 'REVIEWING', attempts = 1, updated_at = ${old} WHERE status = 'PENDING'`;
    const worker = new ChangeReviewWorker(db, logger, async () => fakeProvider({ notify_user: false, importance: "low", reason: "Routine." }));
    expect(await worker.runOnce()).toBe(2);
    expect(await db.changeReview.count({ where: { status: "READY", notifyUser: false } })).toBe(2);
  });

  it("accepts only the strict decision format", () => {
    expect(parseDecision('```json\n{"notify_user": false, "importance": "low", "reason": "Noise."}\n```')).toMatchObject({ notify_user: false });
    expect(() => parseDecision('{"notify_user": "yes", "importance": "low", "reason": "x"}')).toThrow();
    expect(() => parseDecision('{"notify_user": true, "importance": "low", "reason": "x", "extra": 1}')).toThrow();
  });
});

describe("noise filters", () => {
  const context = (name: string, courseId = 5): ReviewContext => ({
    course_id: courseId,
    source_type: "canvas",
    source_name: "file",
    change_type: "file_created",
    title: name,
    fields: ["display_name"],
    before: {},
    after: { display_name: name },
    old_text: "",
    new_text: "",
  });
  const spec: FilterSpec = {
    action: "SUPPRESS_FROM_AI_REVIEW",
    course_id: 5,
    source_type: "canvas",
    source_name: "file",
    change_type: "file_created",
    field: "display_name",
    operator: "suffix",
    pattern: ".ZIP",
  };

  it("matches literal patterns, case-insensitively, within the rule's scope only", () => {
    expect(matches(spec, context("lab-3.zip"))).toBe(true);
    expect(matches(spec, context("lab-3.pdf"))).toBe(false);
    expect(matches(spec, context("lab-3.zip", 6))).toBe(false);
    expect(matches({ ...spec, operator: "contains", pattern: "lab" }, context("Lab-3.zip"))).toBe(true);
    // An update must change only the rule's field.
    const update = { ...context("x.zip"), change_type: "file_updated", fields: ["display_name", "due_at"] };
    expect(matches({ ...spec, change_type: "file_updated" }, update)).toBe(false);
    expect(matches({ ...spec, change_type: "file_updated" }, { ...update, fields: ["display_name"] })).toBe(true);
  });

  it("lets the AI add a rule only after three rejected matches, and audits every change", async () => {
    const ada = await signUp();
    const owner = await userId(ada);
    const course = await db.course.create({
      data: { userId: owner, canvasId: "5", courseCode: "CS 409", name: "Web", htmlUrl: "https://canvas.example.edu/courses/5", lastSeenAt: new Date() },
    });
    const item = await db.sourceItem.create({
      data: { userId: owner, courseId: course.id, kind: "FILE", canvasId: "1", title: "x", contentHash: "x", content: {} },
    });
    const rule = { ...spec, course_id: course.id };
    const feedback = { operation: "create", reason: "Lab archives are noise.", rule };
    const rejected = async (name: string) => {
      const change = await db.changeEvent.create({ data: { userId: owner, courseId: course.id, sourceItemId: item.id, changeType: "CREATED", fields: [], summary: name } });
      await db.changeReview.create({
        data: { userId: owner, changeEventId: change.id, status: "READY", stage1: "AI_REVIEW", stage1Reason: "academic_candidate", notifyUser: false, context: { ...context(name, course.id) } },
      });
    };
    for (let index = 1; index < EVIDENCE_NEEDED; index += 1) await rejected(`lab-${index}.zip`);
    await expect(mutateFromReview(db, owner, feedback, context("lab-9.zip", course.id))).rejects.toThrow("three_rejected_candidates_required");
    await rejected("lab-3.zip");
    const created = await mutateFromReview(db, owner, feedback, context("lab-9.zip", course.id));
    expect(created).toMatchObject({ createdBy: "AI", enabled: true, version: 1 });
    // A wider family (another field) is a new rule, never a change to this one.
    await expect(
      mutateFromReview(db, owner, { operation: "update", rule_id: created.id, reason: "wider", rule: { ...rule, change_type: "file_updated" } }, context("lab-9.zip", course.id)),
    ).rejects.toThrow();

    const disabled = await ada.send("patch", `/api/settings/change-filters/${created.id}`, { body: { enabled: false } });
    expect(disabled.body).toEqual({ id: created.id, enabled: false, removed: false, version: 2 });
    // A rule the student disabled is theirs: the AI may not touch it.
    await expect(mutateFromReview(db, owner, feedback, context("lab-9.zip", course.id))).rejects.toThrow("user_controlled_rule");
    expect((await ada.send("delete", `/api/settings/change-filters/${created.id}`)).body).toEqual({ id: created.id, removed: true });
    expect((await ada.send("patch", `/api/settings/change-filters/${created.id}`, { body: { enabled: "yes" } })).status).toBe(422);

    const listed = (await ada.send("get", "/api/settings/change-filters")).body;
    expect(listed.rules[0]).toMatchObject({ id: created.id, removed: true, enabled: false, course_code: "CS 409", created_by: "AI", version: 3 });
    expect(listed.rules[0].audit.map((entry: { action: string }) => entry.action)).toEqual(["remove", "disable", "create"]);
    expect(listed.recent_reviews).toHaveLength(EVIDENCE_NEEDED);

    const bob = await signUp({ username: "bob", email: "bob@example.com" });
    expect((await bob.send("patch", `/api/settings/change-filters/${created.id}`, { body: { enabled: true } })).status).toBe(404);
    expect((await bob.send("get", "/api/settings/change-filters")).body.rules).toEqual([]);
  });

  it("suppresses matching changes before review and counts the match", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    const owner = await userId(ada);
    const course = await db.course.findFirstOrThrow({ where: { userId: owner } });
    const created = await db.changeFilterRule.create({
      data: { userId: owner, identityKey: "k", createdBy: "USER", reason: "Archives", rule: { ...spec, course_id: course.id } },
    });
    fakeCanvas.files.get("101")?.push({ id: 10103, display_name: "lab-4.zip", size: 1 });
    await syncNow(ada);
    const review = await db.changeReview.findFirstOrThrow({ where: { userId: owner } });
    expect(review).toMatchObject({ status: "SUPPRESSED", stage1Reason: "learned_suppression_rule", matchedRule: { id: created.id } });
    expect(await db.changeFilterRule.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ matchCount: 1 });
  });
});

describe("notifications", () => {
  it("dedupes by key, orders critical first and keeps users apart", async () => {
    const ada = await signUp();
    const owner = await userId(ada);
    expect(await notify(db, owner, { key: "auth-required:canvas", level: "important", title: "Sign in again", body: "Canvas signed you out." })).toBe(true);
    expect(await notify(db, owner, { key: "auth-required:canvas", level: "important", title: "Sign in again", body: "Again." })).toBe(false);
    await notify(db, owner, { key: "canvas-expiration:1:pat:soon", level: "critical", title: "Token expires", body: "In 2 days." });
    const banners = (await ada.send("get", "/api/notifications")).body;
    expect(banners.map((banner: { level: string }) => banner.level)).toEqual(["critical", "important"]);

    const bob = await signUp({ username: "bob", email: "bob@example.com" });
    expect((await bob.send("get", "/api/notifications")).body).toEqual([]);
    expect((await bob.send("post", `/api/notifications/${banners[0].id}/dismiss`)).status).toBe(404);
    expect((await ada.send("post", `/api/notifications/${banners[0].id}/dismiss`)).status).toBe(204);
    // A dismissed notice is not raised again.
    expect(await notify(db, owner, { key: "canvas-expiration:1:pat:soon", level: "critical", title: "Token expires", body: "In 2 days." })).toBe(false);
    expect((await ada.send("get", "/api/notifications")).body).toHaveLength(1);
  });
});

describe("course grading policy", () => {
  it("stores Canvas assignment groups with weights and drop rules", async () => {
    seedCourse(fakeCanvas);
    fakeCanvas.courses[0] = { ...fakeCanvas.courses[0], id: 101, apply_assignment_group_weights: true };
    fakeCanvas.assignmentGroups.set("101", [
      { id: 2, name: "Exams", position: 2, group_weight: 60, rules: {} },
      { id: 1, name: "MPs", position: 1, group_weight: 40, rules: { drop_lowest: 1, never_drop: [1011] } },
    ]);
    const ada = await signUp();
    await connectCanvas(ada);
    const [course] = (await ada.send("get", "/api/courses")).body;
    const policy = await ada.send("get", `/api/courses/${course.id}/policy`);
    expect(policy.status).toBe(200);
    expect(policy.body).toMatchObject({ source: "canvas", weighted: true, confidence: 1 });
    expect(policy.body.grading_categories).toEqual([
      { id: "1", name: "MPs", weight: 40, drop_lowest: 1, drop_highest: 0, never_drop: [{ canvas_id: "1011", title: "MP 1: Layout" }] },
      { id: "2", name: "Exams", weight: 60, drop_lowest: 0, drop_highest: 0, never_drop: [] },
    ]);
    const bob = await signUp({ username: "bob", email: "bob@example.com" });
    expect((await bob.send("get", `/api/courses/${course.id}/policy`)).status).toBe(404);
  });

  it("answers 404 when Canvas shared no policy", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    const [course] = (await ada.send("get", "/api/courses")).body;
    expect((await ada.send("get", `/api/courses/${course.id}/policy`)).body.code).toBe("POLICY_NOT_FOUND");
  });
});
