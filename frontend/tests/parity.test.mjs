import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import ts from "typescript";

// Tasks parity: timers, revisions, attachments, file types, terms and the swimlane timeline.
const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const load = (path) =>
  import(
    `data:text/javascript;base64,${Buffer.from(
      ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText,
    ).toString("base64")}`
  );

const helpers = await load("app/taskHelpers.ts");
const layout = await load("app/timelineLayout.ts");
const css = postcss.parse(read("app/app.css"));

test("task targets open only plain http(s) pages", () => {
  assert.equal(helpers.taskTarget({ source_url: "https://canvas.example.edu/courses/1/assignments/2" }), "https://canvas.example.edu/courses/1/assignments/2");
  assert.equal(helpers.taskTarget({ source_url: "https://canvas.example.edu/a?verifier=x" }), null);
  assert.equal(helpers.taskTarget({ source_url: "https://u:p@example.com/a" }), null);
  assert.equal(helpers.taskTarget({ source_url: "javascript:alert(1)" }), null);
  assert.equal(helpers.taskTarget({ source_url: null }), null);
});

test("timers read h:mm:ss and date-only deadlines drop their time", () => {
  assert.equal(helpers.formatElapsed(0), "0:00:00");
  assert.equal(helpers.formatElapsed(249), "0:04:09");
  assert.equal(helpers.formatElapsed(4800), "1:20:00");
  assert.equal(helpers.elapsedSince("2026-11-17T10:00:00Z", Date.parse("2026-11-17T10:01:05Z")), 65);
  assert.equal(helpers.withoutTime("Today, 11:59 PM"), "Today");
  assert.equal(helpers.withoutTime("Fri, Nov 7, 11:59 PM"), "Fri, Nov 7");
  assert.equal(helpers.DATE_ONLY_NOTE, "Time not specified by source");
  assert.deepEqual(Object.keys(helpers.PRIORITY_TONES), ["Critical", "High", "Medium", "Low"]);
});

test("the swimlane window, scale, ticks and label tracks follow the original", () => {
  const now = new Date("2026-11-17T18:00:00Z");
  const zone = "America/Chicago";
  const due = (days) => new Date(now.getTime() + days * 86_400_000).toISOString();
  const tasks = [
    { id: 1, title: "MP 1", due_at: due(1), course: { id: 10 } },
    { id: 2, title: "HW 2", due_at: due(1.01), course: { id: 10 } },
    { id: 3, title: "A very long assignment title indeed", due_at: due(40), course: { id: 11 } },
    { id: 4, title: "No date", due_at: null, course: { id: 10 } },
  ];
  const result = layout.layoutTimeline(tasks, [{ id: 10, label: "CS 409" }, { id: 11, label: "MATH 241" }], now, zone);
  // Window: local midnight 7 days back, stretched to 5 days past the last deadline.
  assert.equal(result.window.start.toISOString(), "2026-11-10T06:00:00.000Z");
  assert.equal(result.window.end.toISOString(), due(45));
  assert.equal(result.nodes.length, 3);
  assert.equal(layout.timelineX(result.window.start, result.window), layout.AXIS_START);
  assert.equal(layout.DAY_WIDTH, 58);
  // Two neighbours on one lane get different label offsets.
  const [first, second] = result.nodes.filter((node) => node.lane === 0);
  assert.notEqual(first.labelY, second.labelY);
  for (let index = 1; index < result.ticks.length; index += 1) assert.ok(result.ticks[index].x - result.ticks[index - 1].x >= layout.MIN_TICK_SPACING);
  assert.ok(result.nowX > layout.AXIS_START);
  assert.equal(result.height, 110 + 2 * 96);
  assert.equal(layout.shortTitle("A very long assignment title indeed"), "A very long assignment…");
  assert.equal(layout.compactDate(new Date("2026-11-17T18:00:00Z"), zone), "Nov.17");
});

test("work timers live outside task cards and report connection trouble", () => {
  const timer = read("app/workTimer.tsx");
  const shell = read("app/shell.tsx");
  assert.match(shell, /<WorkHeartbeat \/>/);
  assert.match(timer, /HEARTBEAT_MS = 5_000/);
  assert.match(timer, /client_timestamp: new Date\(\)\.toISOString\(\)/);
  assert.match(timer, /expected_revision: current\.state_revision/);
  assert.match(timer, /Connection interrupted\. Your timer and edits remain active locally; synchronization will keep retrying\./);
  assert.match(timer, /Connection restored\. Work progress is synchronized\./);
  assert.match(timer, /Previous timer stopped; this task is now active\./);
  assert.match(timer, /Work timer stopped and saved\./);
  assert.match(timer, /Working on/);
  assert.match(read("app/pages/today.tsx"), /<WorkingBanner \/>/);
  assert.match(read("app/pages/today.tsx"), /<WorkControl task=\{item\.task\} compact \/>/);
  assert.match(read("app/taskCard.tsx"), /<WorkControl task=\{task\} \/>/);
  assert.match(read("app/taskCard.tsx"), /Used time corrected without rewriting session history\./);
});

test("progress saves with the revision, and conflicts, reopen and downloads read like the original", () => {
  const extras = read("app/taskExtras.tsx");
  assert.match(extras, /Task changed elsewhere; refreshed the saved state\./);
  assert.match(extras, /step=\{1\}/);
  assert.match(extras, /progress: 99, reopen: true/);
  assert.match(extras, /Completion not saved; please retry\./);
  assert.match(extras, /Assignment file is no longer available\. Sync and try again\./);
  assert.match(extras, /Download started: \$\{chosen\.filename\}/);
  assert.match(extras, /Local completion does not submit to any provider\./);
  assert.match(extras, /DRAG_THRESHOLD_PX/);
  assert.match(extras, /window\.getSelection\(\)\?\.toString\(\)/);
  assert.match(extras, /noopener,noreferrer/);
  assert.match(read("app/parityQueries.ts"), /expected_revision: task\.state_revision/);
  assert.match(read("app/tasks.tsx"), /No specific time/);
});

test("quick progress commits save in order with the latest revision; only a real conflict refuses", async () => {
  // A server with applyProgress's revision check.
  const server = { progress: 0, revision: 3 };
  const sent = [];
  const send = async (progress, expected) => {
    sent.push({ progress, expected });
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (expected !== server.revision) return { applied: false, state_revision: server.revision, progress: server.progress };
    server.progress = progress;
    server.revision += 1;
    return { applied: true, state_revision: server.revision, progress };
  };
  const results = [];
  const saver = helpers.progressSaver({ progress: 0, revision: 3, send, onResult: (result) => results.push(result.applied) });
  // Keyup then blur, and a held arrow key: three commits before the first answer.
  const first = saver.commit(10);
  assert.equal(saver.busy, true);
  saver.commit(11);
  saver.commit(12);
  await first;
  assert.deepEqual(sent, [
    { progress: 10, expected: 3 },
    { progress: 12, expected: 4 },
  ]);
  assert.deepEqual(results, [true, true]);
  assert.deepEqual(saver.saved, { progress: 12, revision: 5 });
  // A refetch older than the last answer doesn't roll the revision back.
  assert.equal(saver.sync(10, 4), false);
  assert.deepEqual(saver.saved, { progress: 12, revision: 5 });

  // Another tab changes the task: the next save is refused once and the control takes the saved value.
  server.progress = 40;
  server.revision = 9;
  await saver.commit(20);
  assert.deepEqual(results, [true, true, false]);
  assert.deepEqual(saver.saved, { progress: 40, revision: 9 });
  // The following save uses the revision the refusal returned and applies.
  await saver.commit(50);
  assert.deepEqual(sent.at(-1), { progress: 50, expected: 9 });
  assert.deepEqual(results, [true, true, false, true]);

  // A failed request stops the run; the next commit tries again with the same revision.
  const failing = helpers.progressSaver({
    progress: 0,
    revision: 1,
    send: async (progress, expected) => {
      sent.push({ progress, expected, failed: true });
      throw new Error("offline");
    },
    onError: (error, target) => results.push(`${error.message}:${target}`),
  });
  await failing.commit(30);
  assert.equal(results.at(-1), "offline:30");
  assert.equal(failing.busy, false);
  assert.deepEqual(failing.saved, { progress: 0, revision: 1 });
  // The slider saves through it.
  assert.match(read("app/taskExtras.tsx"), /progressSaver\(\{/);
});

test("files have type tabs in the URL and a menu to move them", () => {
  const files = read("app/fileTypes.tsx");
  assert.match(files, /role="tablist" aria-label="File type"/);
  assert.match(files, /params\.set\("type", next\)/);
  assert.match(files, /Move to…/);
  assert.match(files, /event\.key === "Escape"/);
  assert.match(read("app/pages/files.tsx"), /<FileTypeTabs value=\{type\} onChange=\{setType\} \/>/);
  assert.match(read("app/pages/courses.tsx"), /<FileTypeTabs value=\{type\} onChange=\{setType\} \/>/);
});

test("courses filter by term in the URL, confirm archiving and queue reconciliation on restore", () => {
  const terms = read("app/courseTerms.tsx");
  assert.match(terms, /next\.set\("term", fallback\)/);
  assert.match(terms, /All active terms/);
  assert.match(terms, /Archive this course\?/);
  assert.match(terms, /restored\. Reconciliation queued\./);
  assert.match(terms, /Course archived\. Local history and files were preserved\./);
  assert.match(read("app/pages/courses.tsx"), /No active courses match this term/);
  assert.match(read("app/lists.tsx"), /Section not specified/);
});

test("course tasks have Active, Completed and Ignored scopes and a Timeline tab", () => {
  const views = read("app/courseViews.tsx");
  assert.match(views, /\{ id: "active", label: "Active" \}/);
  assert.match(views, /\{ id: "completed", label: "Completed" \}/);
  assert.match(views, /\{ id: "ignored", label: "Ignored" \}/);
  assert.match(views, /<IgnoreButton task=\{task\} \/>/);
  assert.match(views, /<ReopenButton task=\{task\} \/>/);
  assert.match(read("app/pages/courses.tsx"), /\{ id: "timeline", label: "Timeline" \}/);
  const calendar = read("app/pages/calendar.tsx");
  assert.match(calendar, /<CalendarSwimlane now=\{now\} zone=\{zone\} \/>/);
  assert.match(calendar, /Workload/);
  const swimlane = read("app/swimlane.tsx");
  assert.match(swimlane, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(swimlane, /setPointerCapture/);
  assert.match(swimlane, /<title>/);
});

test("new pieces fit a phone and use the theme tokens", () => {
  const decls = (selector, inMedia = null) => {
    const found = {};
    css.walkRules((rule) => {
      const media = rule.parent.type === "atrule" ? rule.parent.params : null;
      if (media === inMedia && rule.selectors.includes(selector)) rule.walkDecls((decl) => (found[decl.prop] = decl.value));
    });
    return found;
  };
  assert.equal(decls(".swimlane-viewport")["max-width"], "100%");
  assert.equal(decls(".swimlane-viewport")["overflow"], "auto");
  // As tall as the lanes need, never more than most of the screen.
  assert.equal(decls(".swimlane-viewport")["max-height"], "min(650px, 65vh)");
  assert.equal(decls(".swimlane-viewport", "(pointer: fine)")["touch-action"], "none");
  assert.equal(decls(".working-banner")["flex-wrap"], "wrap");
  assert.equal(decls(".assignment-files select")["min-width"], "0");
  assert.equal(decls(".file-menu-list", "(max-width: 719px)")["left"], "0");
  // Colours come from tokens, so dark mode follows.
  for (const selector of [".working-banner", ".file-menu-list", ".swimlane-viewport"]) {
    for (const [prop, value] of Object.entries(decls(selector))) {
      if (/color|background|border$/.test(prop)) assert.doesNotMatch(value, /#[0-9a-f]{3,6}\b/i, `${selector} ${prop}`);
    }
  }
});
