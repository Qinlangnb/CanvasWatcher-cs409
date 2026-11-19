import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Important Changes parity: banners, Today's attention cards, change rows and dialog, noise filters, grading policy.
const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const important = read("app/important.tsx");
const lists = read("app/lists.tsx");
const changes = read("app/pages/changes.tsx");
const shell = read("app/shell.tsx");
const today = read("app/pages/today.tsx");
const settings = read("app/pages/settings.tsx");
const courses = read("app/pages/courses.tsx");
const queries = read("app/queries.ts");
const css = read("app/app.css");

test("banners sit at the top of the app, critical ones as alerts, each with a Dismiss button", () => {
  assert.match(shell, /<PreviewBanner \/>\r?\n\s*<NotificationBanners \/>/);
  assert.match(important, /role=\{notice\.level === "critical" \? "alert" : "status"\}/);
  assert.match(important, /aria-label=\{`Dismiss \$\{notice\.title\}`\}/);
  assert.match(important, /`\/api\/notifications\/\$\{id\}\/dismiss`, \{ method: "POST" \}/);
});

test("the Changes feed and unread count default to the Important set, with a switch to Everything", () => {
  assert.match(changes, /const important = params\.get\("scope"\) !== "all";/);
  assert.match(changes, /useUnreadCount\(true, important\)/);
  assert.match(changes, />\s*Everything\s*</);
  assert.match(queries, /export function useUnreadCount\(enabled = true, important = true\)/);
  assert.match(queries, /important: filters\.important \|\| undefined/);
  assert.match(today, /useChanges\(\{ unread: true, important: true, pages: 1 \}\)/);
});

test("change rows carry a category stripe, the event label and an inline read toggle", () => {
  assert.match(lists, /className=\{`change-row category-\$\{change\.category\}/);
  assert.match(lists, /\{change\.event_label\}/);
  assert.match(lists, /\{change\.read \? "Mark unread" : "Mark read"\}/);
  assert.match(css, /\.change-read-toggle \{[^}]*z-index: 1;/);
  assert.match(css, /\.change-row\.category-deadline,\s*\.attention-card\.category-deadline \{\s*border-left-color: var\(--warning\);/);
});

test("the change dialog shows before and after text with collapsible raw and internal metadata", () => {
  assert.match(lists, /<h3>Before<\/h3>/);
  assert.match(lists, /<h3>After<\/h3>/);
  assert.match(lists, /<summary>Raw metadata<\/summary>/);
  assert.match(lists, /<summary>Internal metadata<\/summary>/);
  assert.match(css, /@media \(min-width: 760px\) \{\s*\.snapshot-grid \{/);
});

test("Today lists AI-reviewed changes that need attention, each with a Review button", () => {
  assert.match(today, /<AttentionSection now=\{now\} onOpen=\{setOpenChange\} \/>/);
  assert.match(important, /"\/api\/changes\/attention"/);
  assert.match(important, /No actionable changes\./);
  assert.match(important, /onClick=\{\(\) => onOpen\(item\.change\.id\)\}/);
  assert.match(important, /Review<span className="visually-hidden">/);
});

test("Settings has the noise filter panel with rule cards, audit history and review diagnostics", () => {
  assert.match(settings, /<ChangeFiltersSection \/>/);
  assert.match(important, /Advanced · Important Changes review and noise filters/);
  assert.match(important, /\{rule\.enabled \? "Disable" : "Enable \/ restore"\}/);
  assert.match(important, /<summary>Audit history<\/summary>/);
  assert.match(important, /Recent review diagnostics/);
  assert.match(important, /Rule removed; its audit history is preserved\./);
});

test("the course page shows the Canvas grading policy, scrolling sideways on phones", () => {
  assert.match(courses, /<GradingPolicy courseId=\{data\.id\} \/>/);
  assert.match(important, /`\/api\/courses\/\$\{courseId\}\/policy`/);
  assert.match(css, /\.table-scroll \{\s*overflow-x: auto;/);
});
