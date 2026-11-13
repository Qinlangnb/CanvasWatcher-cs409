import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { blocksText, htmlBlocks } from "../src/canvas/richText.js";
import { htmlToText } from "../src/canvas/normalize.js";
import { CANVAS_ORIGIN, fakeCanvas, seedCourse } from "./fakeCanvas.js";
import { Browser, connectCanvas, db, resetDatabase, signUp } from "./helpers.js";

const EXAMS = `
<h2>Exam schedule</h2>
<table>
  <tbody>
    <tr><td><strong>Exam</strong></td><td><strong>Date</strong></td><td><strong>Room</strong></td></tr>
    <tr><td>Midterm 1</td><td>Oct 8, 7&ndash;9 pm</td><td>Room 1404</td></tr>
    <tr><td>Final</td><td>Dec 15</td><td></td></tr>
  </tbody>
</table>`;

describe("rich text blocks", () => {
  it("keeps each exam name next to its date", () => {
    const blocks = htmlBlocks(EXAMS);
    expect(blocks[0]).toEqual({ type: "heading", level: 2, text: "Exam schedule" });
    expect(blocks[1]).toEqual({
      type: "table",
      rows: [
        ["Exam", "Date", "Room"],
        ["Midterm 1", "Oct 8, 7–9 pm", "Room 1404"],
        ["Final", "Dec 15", ""],
      ],
      header_rows: 1,
      row_headers: false,
    });
    expect(blocksText(blocks)).toContain("Exam: Midterm 1 | Date: Oct 8, 7–9 pm | Room: Room 1404");
    expect(blocksText(blocks)).toContain("Exam: Final | Date: Dec 15");
    // The flat text the change detector hashes is unchanged by this.
    expect(htmlToText(EXAMS)).toContain("Midterm 1Oct 8");
  });

  it("fills rowspan and colspan and reads row headers", () => {
    const blocks = htmlBlocks(`
      <table><caption>Weights</caption>
        <thead><tr><th>Part</th><th colspan="2">Weight</th></tr></thead>
        <tr><th scope="row">Exams</th><td>Midterm</td><td>20%</td></tr>
        <tr><th rowspan="2">Work</th><td>MPs</td><td>40%</td></tr>
        <tr><td>Project</td><td>40%</td></tr>
      </table>`);
    expect(blocks).toEqual([
      {
        type: "table",
        caption: "Weights",
        rows: [
          ["Part", "Weight", "Weight"],
          ["Exams", "Midterm", "20%"],
          ["Work", "MPs", "40%"],
          ["Work", "Project", "40%"],
        ],
        header_rows: 1,
        row_headers: true,
      },
    ]);
    expect(blocksText(blocks).split("\n")).toEqual(["Weights", "Exams: Weight: Midterm | Weight: 20%", "Work: Weight: MPs | Weight: 40%", "Work: Weight: Project | Weight: 40%"]);
  });

  it("splits paragraphs, line breaks and lists and skips scripts", () => {
    const blocks = htmlBlocks("<p>Office hours<br>Mon 2&nbsp;pm</p><script>alert(1)</script><ul><li>Quizzes</li><li>Labs</li></ul>");
    expect(blocks).toEqual([
      { type: "text", text: "Office hours" },
      { type: "text", text: "Mon 2 pm" },
      { type: "text", text: "• Quizzes" },
      { type: "text", text: "• Labs" },
    ]);
  });
});

beforeEach(async () => {
  await resetDatabase();
  fakeCanvas.reset();
});
afterAll(() => db.$disconnect());

async function syllabusFor(browser: Browser) {
  const [course] = (await browser.send("get", "/api/courses")).body;
  return browser.send("get", `/api/courses/${course.id}/syllabus`);
}

describe("GET /api/courses/:id/syllabus", () => {
  it("follows a short Syllabus tab to the syllabus page and file it links", async () => {
    seedCourse(fakeCanvas);
    fakeCanvas.syllabusBodies.set(
      "101",
      `<p>See the <a href="${CANVAS_ORIGIN}/courses/101/pages/course-information">course information</a> page
       and <a href="/courses/101/files/10101/download">syllabus.pdf</a>.</p>`,
    );
    fakeCanvas.pages.set("101", [
      {
        url: "course-information",
        title: "Course Information",
        html_url: `${CANVAS_ORIGIN}/courses/101/pages/course-information`,
        body: `<h2>Grading</h2><table><tr><th>Part</th><th>Weight</th></tr><tr><td>MPs</td><td>40%</td></tr>
               <tr><td>Midterm</td><td>25%</td></tr><tr><td>Final</td><td>35%</td></tr></table>
               <p>Late policy: 10% off per day.</p>${EXAMS}`,
      },
      { url: "week-1", title: "Week 1", body: "<p>Read chapter 1.</p>" },
    ]);
    const ada = await signUp();
    await connectCanvas(ada);

    const res = await syllabusFor(ada);
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    const [first, second] = res.body.sources;
    expect(first).toMatchObject({ kind: "page", title: "Course Information", html_url: `${CANVAS_ORIGIN}/courses/101/pages/course-information` });
    expect(first.reasons).toEqual(expect.arrayContaining(["linked from the Canvas Syllabus tab", "named like a syllabus", "grading or policy section"]));
    expect(first.blocks).toContainEqual(expect.objectContaining({ type: "table", rows: expect.arrayContaining([["Midterm 1", "Oct 8, 7–9 pm", "Room 1404"]]) }));
    expect(second).toMatchObject({ kind: "file", title: "syllabus.pdf", download_url: expect.stringMatching(/^\/api\/files\/\d+\/download$/) });
    // The one-line Syllabus tab is only a pointer, so it is not offered on its own.
    expect(res.body.sources.map((source: { kind: string }) => source.kind)).not.toContain("syllabus");
    // The unrelated page was never read.
    expect(fakeCanvas.requests.some((path) => path.includes("/pages/week-1"))).toBe(false);
  });

  it("uses a full Syllabus tab and syllabus entries in Modules", async () => {
    seedCourse(fakeCanvas);
    fakeCanvas.files.set("101", []);
    fakeCanvas.syllabusBodies.set("101", `<h2>Course grade</h2><p>Final grades: A 90, B 80, C 70, D 60.</p>${EXAMS}<p>${"Read the policies. ".repeat(20)}</p>`);
    fakeCanvas.pages.set("101", [{ url: "policies", title: "Policies & Due Dates", body: "<p>Attendance is required.</p>" }]);
    fakeCanvas.modules.set("101", [
      { id: 1, name: "Start here", items: [{ id: 11, title: "Course syllabus (website)", type: "ExternalUrl", external_url: "https://cs.example.com/409/syllabus" }] },
      { id: 2, name: "Week 1", items: [{ id: 21, title: "Policies & Due Dates", type: "Page", page_url: "policies" }] },
    ]);
    const ada = await signUp();
    await connectCanvas(ada);

    const res = await syllabusFor(ada);
    expect(res.status).toBe(200);
    const kinds = res.body.sources.map((source: { kind: string; title: string }) => `${source.kind}:${source.title}`);
    expect(kinds[0]).toBe("syllabus:Syllabus");
    expect(kinds).toContain("link:Course syllabus (website)");
    expect(blocksText(res.body.sources[0].blocks)).toContain("Exam: Final | Date: Dec 15");
  });

  it("says when nothing looks like a syllabus and survives a course with Pages turned off", async () => {
    seedCourse(fakeCanvas);
    fakeCanvas.files.set("101", []);
    fakeCanvas.failures.set("/api/v1/courses/101/pages", 404);
    fakeCanvas.failures.set("/api/v1/courses/101/modules", 403);
    const ada = await signUp();
    await connectCanvas(ada);
    const res = await syllabusFor(ada);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ found: false, sources: [] });
  });

  it("asks to reconnect when Canvas rejects the token, and hides other users' courses", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    const [course] = (await ada.send("get", "/api/courses")).body;
    fakeCanvas.token = "rotated";
    const res = await ada.send("get", `/api/courses/${course.id}/syllabus`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CANVAS_RECONNECT_REQUIRED");

    const bob = await signUp({ username: "bob", email: "bob@example.com" });
    expect((await bob.send("get", `/api/courses/${course.id}/syllabus`)).status).toBe(404);
  });
});
