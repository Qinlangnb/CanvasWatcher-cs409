import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const preview = read("app/preview.tsx");
const auth = read("app/pages/auth.tsx");
const shell = read("app/shell.tsx");
const settings = read("app/pages/settings.tsx");
const lists = read("app/lists.tsx");
const syllabus = read("app/syllabus.tsx");
const css = read("app/app.css");

test("the sign-in page offers a Preview button instead of a demo", () => {
  assert.match(auth, /<StartPreview \/>/);
  assert.doesNotMatch(auth, /TryDemo/);
  assert.match(preview, /request<User>\("\/api\/preview", \{ method: "POST" \}\)|useStartPreview\(\)/);
  assert.match(preview, /: "Preview"\}/);
});

test("everything that needs Canvas is greyed out with 'Preview account not available'", () => {
  assert.match(preview, /export const PREVIEW_UNAVAILABLE = "Preview account not available";/);
  assert.match(preview, /aria-disabled="true" title=\{PREVIEW_UNAVAILABLE\}/);
  // Settings' Canvas section, the Sync buttons, file downloads and the syllabus.
  assert.match(settings, /useIsPreview\(\) \? <PreviewCanvasSection \/> : <CanvasConnectionSection \/>/);
  assert.match(settings, /className="card settings-section preview-greyed" id="canvas"/);
  assert.match(shell, /preview \? <PreviewSyncControl compact=\{compact\} \/> : <CanvasSyncControl compact=\{compact\} \/>/);
  assert.match(lists, /if \(preview\) return <UnavailableButton className="button small secondary">\{label\}<\/UnavailableButton>;/);
  assert.match(syllabus, /if \(useIsPreview\(\)\) \{\s*return \(\s*<PreviewUnavailable>/);
  assert.match(css, /\.preview-unavailable\[aria-disabled="true"\] \{[^}]*filter: grayscale\(1\);/);
});

test("Canvas links open for real in a preview", () => {
  assert.match(preview, /export function CanvasLink[^]*?<a className=\{className\} href=\{href\} target="_blank" rel="noreferrer">/);
  assert.doesNotMatch(preview, /have no Canvas page/);
});
