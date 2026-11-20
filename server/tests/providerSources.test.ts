import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fetchGradescopeAssignments,
  parseAssignments,
  parseCourses,
  parsePrairieLearnCourses,
} from "../src/sources/provider/gradescope.js";
import {
  decideProviderTask,
  gradescopeIdentity,
  normalizedTaskTitle,
  providerFact,
  stronglyBoundTask,
  terminalState,
  weakTaskCandidates,
  type ProviderFactRow,
} from "../src/sources/provider/taskMatching.js";
import { authenticatedPage, cookieHeader, providerBase, ProviderWeb, verifySession } from "../src/sources/provider/web.js";
import { chooseSchedule, isSchedulePageUrl, parseScheduleTable } from "../src/sources/website/schedule.js";
import { fakeSite, type FakeReply } from "./sourcesFakes.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/sources/${name}`, import.meta.url), "utf8");
const BASE = "https://www.gradescope.com";
const ASSIGNMENTS = fixture("gradescope_assignments.html");
const html = (body: string): FakeReply => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body });

describe("provider web", () => {
  it("accepts only HTTPS instance roots", () => {
    expect(providerBase("prairielearn", "https://institution.example/pl/")).toBe("https://institution.example/pl");
    expect(providerBase("gradescope", "https://www.gradescope.com/")).toBe(BASE);
    for (const [provider, value] of [
      ["prairielearn", "http://school.example/pl"],
      ["prairielearn", "https://school.example/pl?token=x"],
      ["prairielearn", "https://user:password@school.example/pl"],
      ["prairielearn", "https://school.example/other"],
      ["gradescope", "https://www.gradescope.com/pl"],
      ["gradescope", "https://www.gradescope.com/#x"],
      ["canvas", "https://canvas.example"],
    ] as const) {
      expect(() => providerBase(provider, value)).toThrow("PROVIDER_BASE_INVALID");
    }
  });

  it("checks the logged-in dashboard markers strictly", () => {
    expect(authenticatedPage("prairielearn", '<h1>PrairieLearn Homepage</h1><a href="/pl/logout">Log out</a>')).toBe(true);
    expect(authenticatedPage("gradescope", "<h1>Course Dashboard</h1>")).toBe(false);
    expect(authenticatedPage("gradescope", '<h1>Course Dashboard</h1><a href="/logout">Log out</a>')).toBe(true);
    expect(authenticatedPage("gradescope", '<h1>Course Dashboard</h1><a href="/logout">x</a><input type="password">')).toBe(false);
  });

  it("builds a cookie header and refuses header injection", () => {
    expect(cookieHeader({ session: "abc", other: "1" })).toBe("session=abc; other=1");
    expect(cookieHeader([{ name: "s", value: "v" }])).toBe("s=v");
    const jars: Record<string, string>[] = [{}, { "a b": "x" }, { s: "x;y" }, { s: "x\r\nSet: y" }];
    for (const jar of jars) expect(() => cookieHeader(jar)).toThrow("PROVIDER_COOKIES_INVALID");
  });

  it("never follows redirects or sends other methods, and maps status codes", async () => {
    const replies: Record<string, FakeReply> = {
      [BASE + "/"]: { status: 302, headers: { location: "https://attacker.example/" } },
      [BASE + "/forbidden"]: { status: 403 },
      [BASE + "/json"]: { status: 200, headers: { "content-type": "application/json" }, body: "{}" },
      [BASE + "/big"]: html("x".repeat(8_000_001)),
    };
    const site = fakeSite({ pages: replies });
    const client = new ProviderWeb("gradescope", BASE, { session: "secret-fixture" }, site.transport);
    await expect(client.get("/")).rejects.toThrow("AUTH_REQUIRED");
    await expect(client.get("/forbidden")).rejects.toThrow("PROVIDER_PERMISSION_DENIED");
    await expect(client.get("/json")).rejects.toThrow("PROVIDER_RESPONSE_CHANGED");
    await expect(client.get("/big")).rejects.toThrow("PROVIDER_RESPONSE_TOO_LARGE");
    for (const path of ["//attacker.example", "/../private", "/path?token=secret", "/a#b", "/a\\b", "relative"]) {
      await expect(client.get(path)).rejects.toThrow("PROVIDER_PATH_INVALID");
    }
    expect(site.requests.map((request) => request.url)).toEqual([BASE + "/", BASE + "/forbidden", BASE + "/json", BASE + "/big"]);
  });

  it("verifies a session against the dashboard", async () => {
    const good = fakeSite({ pages: { [BASE + "/"]: html('<h1>Course Dashboard</h1><a href="/logout">Log out</a>') } });
    expect(await verifySession("gradescope", BASE, { session: "x" }, good.transport)).toEqual({ verified: true, code: null });
    const login = fakeSite({ pages: { [BASE + "/"]: html('<h1>Log in</h1><input type="password">') } });
    expect(await verifySession("gradescope", BASE, { session: "x" }, login.transport)).toEqual({ verified: false, code: "AUTH_REQUIRED" });
    const pl = fakeSite({ pages: { "https://pl.example/pl": html('<h1>PrairieLearn Homepage</h1><a href="/pl/logout">Out</a>') } });
    expect((await verifySession("prairielearn", "https://pl.example/pl", { pl_authn: "x" }, pl.transport)).verified).toBe(true);
    expect(await verifySession("gradescope", "http://x", { s: "x" }, good.transport)).toEqual({ verified: false, code: "PROVIDER_BASE_INVALID" });
  });
});

describe("gradescope parser", () => {
  it("keeps student fields separate and nullable", () => {
    const result = parseAssignments(ASSIGNMENTS, BASE, "10");
    expect(result.assignments).toHaveLength(3);
    expect(result.unidentifiedRows).toBe(1);
    expect(result.deletionAuthoritative).toBe(false);
    const first = result.assignments[0]?.facts;
    expect(first).toMatchObject({
      due_at: "2026-09-24T23:59:00-05:00",
      late_due_at: "2026-10-01T23:59:00-05:00",
      release_at: "2026-09-17T08:00:00-05:00",
      personal_due_at: null,
      // Never invent a GET route from a submit button.
      direct_assignment_url: null,
      submission_state: "unsubmitted",
    });
    expect(result.assignments[1]?.facts.submission_state).toBe("submitted");
    expect(result.assignments[1]?.url).toBe(BASE + "/courses/10/assignments/102/submissions/900");
    const graded = result.assignments[2]?.facts;
    expect([graded?.score, graded?.max_score, graded?.grade_published, graded?.submitted_at]).toEqual([8, 10, true, null]);
  });

  it.each([
    "<h1>Log in</h1>",
    ASSIGNMENTS.replace("assignments-student-table", "new-table"),
    ASSIGNMENTS.replace("2026-09-24 23:59:00 -0500", "tomorrow"),
    ASSIGNMENTS.replace("/courses/10/assignments/102/submissions/900", "https://other.example/courses/10/assignments/102/submissions/900"),
    ASSIGNMENTS.replace("/courses/10/assignments/102/submissions/900", "/courses/11/assignments/102/submissions/900"),
    ASSIGNMENTS.replace('data-assignment-id="101"', 'data-assignment-id="102"').replace("Homework A</button>", 'Homework A</button><a href="/courses/10/assignments/103/submissions/1">x</a>'),
  ])("fails closed on changed or unsafe markup %#", (page) => {
    expect(() => parseAssignments(page, BASE, "10")).toThrow("PROVIDER_RESPONSE_CHANGED");
  });

  it("preserves identity across renames and keeps unknown states unknown", () => {
    const before = parseAssignments(ASSIGNMENTS, BASE, "10");
    const after = parseAssignments(ASSIGNMENTS.replace("Homework A", "Renamed work").replace("No Submission", "New provider state"), BASE, "10");
    expect(after.assignments[0]?.externalId).toBe(before.assignments[0]?.externalId);
    expect(after.assignments[0]?.facts.submission_state).toBe("unknown");
  });

  it("never lets an empty table authorize deletions", () => {
    const empty = parseAssignments('<table id="assignments-student-table"><tbody><tr><td class="dataTables_empty">None</td></tr></tbody></table>', BASE, "10");
    expect(empty).toEqual({ assignments: [], unidentifiedRows: 0, deletionAuthoritative: false });
    expect(() => parseAssignments(ASSIGNMENTS, BASE, "1x")).toThrow("PROVIDER_RESPONSE_CHANGED");
  });

  it("reads the course dashboard", () => {
    const page =
      '<h1>Course Dashboard</h1><a class="courseBox" href="/courses/10"><h3 class="courseBox--shortname">TEST 101</h3><div class="courseBox--name">Example course</div></a>';
    expect(parseCourses(page, BASE)).toEqual([
      { provider: "gradescope", externalId: "10", courseCode: "TEST 101", name: "Example course", term: null, url: BASE + "/courses/10", identityEvidence: "student_course_link" },
    ]);
    expect(() => parseCourses("<h1>Login</h1>", BASE)).toThrow("PROVIDER_RESPONSE_CHANGED");
    expect(() => parseCourses(page.replace("/courses/10", "https://evil.example/courses/10"), BASE)).toThrow("PROVIDER_RESPONSE_CHANGED");
    expect(() => parsePrairieLearnCourses("<h1>PrairieLearn Homepage</h1>")).toThrow("PRAIRIELEARN_COURSE_PARSER_NOT_VERIFIED");
  });

  it("applies bindings and never uses the late due date", async () => {
    const site = fakeSite({ pages: { [BASE + "/courses/10"]: html(ASSIGNMENTS) } });
    const client = new ProviderWeb("gradescope", BASE, { session: "x" }, site.transport);
    const { items, errors } = await fetchGradescopeAssignments(client, "10", { "101": 7, "102": "separate" });
    expect(items[0]).toMatchObject({ confirmedTaskId: 7, dueAt: "2026-09-24T23:59:00-05:00", deadlinePrecision: "EXACT_DATETIME" });
    expect(items[1]).toMatchObject({ confirmedSeparate: true, confirmedTaskId: null });
    expect(items[2]).toMatchObject({ dueAt: null, dueAtState: "unknown", deadlinePrecision: null, pointsPossible: 10 });
    expect(errors).toEqual({ unidentified_rows: "1" });
  });
});

describe("task matching", () => {
  const tasks = [
    { id: 1, title: "HW 03", dueAt: "2026-09-24T22:00:00Z" },
    { id: 2, title: "Homework 3", dueAt: "2026-10-24T22:00:00Z" },
    { id: 3, title: "Homework 3", dueAt: null },
    { id: 4, title: "Homework 30", dueAt: null },
  ];

  it("finds weak title candidates within a day", () => {
    expect(normalizedTaskTitle("HW 03: Kinematics!")).toBe("homework3kinematics");
    expect(weakTaskCandidates(tasks, "Homework 3", "2026-09-25T04:59:00Z").map((task) => task.id)).toEqual([1, 3]);
    expect(weakTaskCandidates(tasks, "hw3", null).map((task) => task.id)).toEqual([1, 2, 3]);
  });

  it("binds strongly only through one same-origin provider identity", () => {
    const gradescope = {
      sourceType: "gradescope" as const,
      url: "https://www.gradescope.com/courses/10/assignments/102/submissions/900",
      structured: { provider_facts: { provider_course_id: "10", provider_assignment_id: "102" } },
    };
    const canvas = (taskId: number, url: string, isDeleted = false) => ({
      taskId,
      sourceType: "canvas" as const,
      url: "https://canvas.example/courses/1/assignments/5",
      isDeleted,
      structured: { external_tool_tag_attributes: { url } },
    });
    const same = "https://www.gradescope.com/courses/10/assignments/102";
    expect(stronglyBoundTask(gradescope, [canvas(5, same)])).toBe(5);
    expect(stronglyBoundTask(gradescope, [canvas(5, same), canvas(6, same)])).toBeNull();
    expect(stronglyBoundTask(gradescope, [canvas(5, same, true)])).toBeNull();
    expect(stronglyBoundTask(gradescope, [canvas(5, "https://gradescope.example/courses/10/assignments/102")])).toBeNull();
    expect(stronglyBoundTask(gradescope, [canvas(5, same + "?x=1")])).toBeNull();
    expect(stronglyBoundTask(canvas(0, same), [{ ...gradescope, taskId: 9 }])).toBe(9);
    expect(gradescopeIdentity("http://www.gradescope.com/courses/1/assignments/2")).toBeNull();
  });

  it("asks the user when only titles match", () => {
    const base = { linkedTaskId: null, strongTaskId: null, confirmedTaskId: null, confirmedSeparate: false, courseTaskIds: new Set([1, 3]) };
    expect(decideProviderTask({ ...base, weakCandidates: tasks.slice(0, 1) })).toEqual({ kind: "mapping_required", candidates: [1] });
    expect(decideProviderTask({ ...base, confirmedSeparate: true, weakCandidates: tasks })).toEqual({ kind: "new" });
    expect(decideProviderTask({ ...base, confirmedTaskId: 3, weakCandidates: [] })).toEqual({ kind: "bound", taskId: 3 });
    expect(decideProviderTask({ ...base, confirmedTaskId: 99, weakCandidates: [] })).toEqual({ kind: "mapping_invalid" });
    expect(decideProviderTask({ ...base, strongTaskId: 4, weakCandidates: tasks })).toEqual({ kind: "bound", taskId: 4 });
  });

  it("allow-lists provider facts and derives terminal states", () => {
    const item = { id: 1, sourceType: "gradescope" as const, url: "https://www.gradescope.com/courses/10", isDeleted: false };
    const fact = providerFact(item, { provider_facts: { provider: "gradescope", submission_state: "submitted", html: "<b>x</b>", token: "s" } });
    expect(fact).not.toHaveProperty("html");
    expect(fact).not.toHaveProperty("token");
    expect(fact).toMatchObject({ provider: "gradescope", submission_state: "submitted", source_item_id: 1 });
    const canvasItem = { ...item, id: 2, sourceType: "canvas" as const };
    expect(providerFact(canvasItem, { points_possible: 10, submission: { workflow_state: "unsubmitted" } })).toMatchObject({
      provider: "canvas",
      submission_state: "unsubmitted",
      grade_published: null,
      max_score: 10,
    });
    expect(providerFact(canvasItem, { submission: { graded_at: "2026-09-01", posted_at: null, score: null } })).toMatchObject({
      submission_state: "graded",
      grade_published: false,
    });
    expect(providerFact(canvasItem, { submission: { score: 9 } })?.grade_published).toBe(true);
    expect(providerFact({ ...item, sourceType: "website" }, {})).toBeNull();
    const rows = [fact, { ...fact, provider: "prairielearn", submission_state: "graded" }] as ProviderFactRow[];
    expect(terminalState(rows)).toBe("submitted");
    expect(terminalState([{ ...rows[0]!, submission_state: "graded", is_deleted: true }])).toBeNull();
  });
});

describe("schedule table", () => {
  const SCHEDULE = fixture("schedule_table.html");
  const URL = "https://courses.example.edu/test101/fa26/schedule.html";

  it("turns week and weekday into date-only homework deadlines", () => {
    const rows = parseScheduleTable(SCHEDULE, { week1Monday: "2026-08-24", scheduleUrl: URL });
    expect(Object.fromEntries(rows.map((row) => [row.number, row.dueDate]))).toEqual({
      1: "2026-09-03", 2: "2026-09-10", 3: "2026-09-17", 4: "2026-09-24", 5: "2026-10-01", 6: "2026-10-08", 7: "2026-10-12",
      8: "2026-10-29", 9: "2026-11-05", 10: "2026-11-12", 11: "2026-11-19", 12: "2026-12-03", 13: "2026-12-09",
    });
    const byNumber = new Map(rows.map((row) => [row.number, row]));
    expect(byNumber.get(1)?.assignedDate).toBe("2026-08-27");
    expect(byNumber.get(8)?.assignedDate).toBe("2026-10-22");
    expect(byNumber.get(13)?.assignedDate).toBe("2026-12-03");
    expect(byNumber.get(3)).toMatchObject({
      sourceKey: "homework:3",
      assignmentResourceUrl: "https://courses.example.edu/test101/fa26/secure/homework/HW-03.pdf",
      solutionResourceUrl: "https://courses.example.edu/test101/fa26/secure/homework/HW-03-solutions.pdf",
      dueText: "Week 4, Thursday: HW 3 due",
    });
  });

  it("keeps keyword evidence and refuses invalid anchors", () => {
    const rows = parseScheduleTable(SCHEDULE.replace("HW 3 due", "Homework 3 due"), { week1Monday: "2026-08-24", scheduleUrl: URL });
    expect(rows.find((row) => row.number === 3)).toMatchObject({ dueDate: "2026-09-17", dueText: "Week 4, Thursday: Homework 3 due" });
    for (const anchor of ["invalid", "2026-08-25", "", "2026-02-30"]) {
      expect(parseScheduleTable(SCHEDULE, { week1Monday: anchor, scheduleUrl: URL })).toEqual([]);
    }
    expect(parseScheduleTable("<table><tr><th>Week</th><th>Topic</th></tr></table>", { week1Monday: "2026-08-24", scheduleUrl: URL })).toEqual([]);
  });

  it("takes deadlines from one schedule page and reports pages that disagree instead of merging them", () => {
    const SITE = "https://courses.example.edu/test101/fa26";
    const page = (path: string, html: string) => ({ url: `${SITE}${path}`, finalUrl: `${SITE}${path}`, html });
    const shifted = SCHEDULE.replaceAll("Thursday", "Friday");
    const landing = page("/", SCHEDULE);
    const older = page("/old-term.html", shifted);
    const same = page("/readings.html", SCHEDULE);
    // No page named like a schedule: the first one in crawl order (the landing page) decides.
    const first = chooseSchedule([landing, same, older], "2026-08-24");
    expect(first.page).toBe(landing);
    expect(first.rows.find((row) => row.number === 3)?.dueDate).toBe("2026-09-17");
    // A repeated identical table is no conflict; one with other dates is reported.
    expect(first.conflicts).toEqual([older]);
    expect(chooseSchedule([older, landing], "2026-08-24")).toMatchObject({ page: older, conflicts: [landing] });
    // A schedule page wins over earlier pages, as in the earlier app (…/schedule.html).
    const named = page("/schedule.html", SCHEDULE);
    const picked = chooseSchedule([page("/", shifted), named], "2026-08-24");
    expect(picked.page).toBe(named);
    expect(picked.rows.find((row) => row.number === 3)?.dueDate).toBe("2026-09-17");
    expect(picked.conflicts.map((entry) => entry.url)).toEqual([`${SITE}/`]);
    expect(chooseSchedule([page("/", "<p>no table</p>")], "2026-08-24")).toEqual({ page: null, rows: [], conflicts: [] });
    expect(isSchedulePageUrl(`${SITE}/schedule`)).toBe(true);
    expect(isSchedulePageUrl(`${SITE}/old-schedule.html`)).toBe(false);
  });
});
