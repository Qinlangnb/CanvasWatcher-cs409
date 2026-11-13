import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const courses = read("app/pages/courses.tsx");
const view = read("app/syllabus.tsx");
const css = read("app/app.css");

test("the course page has a Syllabus tab after Files", () => {
  assert.match(courses, /\{ id: "files", label: "Files" \},\r?\n\s*\{ id: "syllabus", label: "Syllabus" \},\r?\n\] as const;/);
  assert.match(courses, /tab === "syllabus" \? <CourseSyllabus courseId=\{data\.id\} \/> : null/);
});

test("syllabus tables render with header cells and scroll sideways on phones", () => {
  assert.match(view, /`\/api\/courses\/\$\{courseId\}\/syllabus`|useSyllabus\(courseId\)/);
  assert.match(view, /<thead>/);
  assert.match(view, /scope="col"/);
  assert.match(view, /block\.row_headers && c === 0/);
  assert.match(css, /\.syllabus-table-wrap \{[^}]*overflow-x: auto/);
});

test("Due next week shows cards side by side on wide screens only", () => {
  assert.match(css, /\.due-soon \{\s*container: due-soon \/ inline-size;/);
  assert.match(css, /@container due-soon \(min-width: 540px\) \{\s*\.due-soon-list \{\s*grid-template-columns: repeat\(auto-fill, minmax\(16rem, 1fr\)\);/);
});
