import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import ts from "typescript";

// Tests for the router-based app in src/app (week 2). Modules are transpiled and loaded as data URLs.
const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText,
  ).toString("base64")}`;

const format = await import(moduleUrl(read("app/format.ts")));
const publicPathUrl = moduleUrl(read("publicPath.ts"));
const api = await import(moduleUrl(read("app/api.ts").replace('"../publicPath"', JSON.stringify(publicPathUrl))));

// --- format.ts ---

const now = new Date(2026, 10, 4, 12, 0); // Wed, Nov 4 2026, noon local time

test("due dates read relative to today", () => {
  assert.equal(format.formatDue(null, now), "No due date");
  assert.match(format.formatDue(new Date(2026, 10, 4, 23, 59).toISOString(), now), /^Today, /);
  assert.match(format.formatDue(new Date(2026, 10, 5, 9, 0).toISOString(), now), /^Tomorrow, /);
  assert.match(format.formatDue(new Date(2026, 10, 3, 9, 0).toISOString(), now), /^Yesterday, /);
  assert.match(format.formatDue(new Date(2027, 0, 15, 9, 0).toISOString(), now), /2027/);
});

test("due hints flag overdue and imminent work", () => {
  assert.equal(format.dueHint(null, now), null);
  assert.deepEqual(format.dueHint(new Date(2026, 10, 4, 8, 0).toISOString(), now), { label: "Overdue", tone: "danger" });
  assert.deepEqual(format.dueHint(new Date(2026, 10, 1, 8, 0).toISOString(), now), { label: "Overdue by 3 days", tone: "danger" });
  assert.deepEqual(format.dueHint(new Date(2026, 10, 4, 18, 0).toISOString(), now), { label: "Due today", tone: "warning" });
  assert.deepEqual(format.dueHint(new Date(2026, 10, 5, 18, 0).toISOString(), now), { label: "Due tomorrow", tone: "warning" });
  assert.deepEqual(format.dueHint(new Date(2026, 10, 8, 18, 0).toISOString(), now), { label: "In 4 days", tone: "neutral" });
  assert.equal(format.dueHint(new Date(2026, 10, 20, 18, 0).toISOString(), now), null);
});

test("relative times, sizes and plurals", () => {
  assert.equal(format.timeAgo(null, now), "never");
  assert.equal(format.timeAgo(new Date(now.getTime() - 20_000).toISOString(), now), "just now");
  // Dates are English like the rest of the interface, whatever the browser's language.
  assert.equal(format.timeAgo(new Date(now.getTime() - 5 * 60_000).toISOString(), now), "5 minutes ago");
  assert.equal(format.timeAgo(new Date(now.getTime() - 3 * 86_400_000).toISOString(), now), "3 days ago");
  assert.equal(format.formatLongDate(now), "Wednesday, November 4");
  assert.match(format.formatDue(new Date(2026, 10, 4, 18, 0).toISOString(), now), /^Today, 6:00\sPM$/);
  assert.equal(format.formatBytes(512), "512 B");
  assert.equal(format.formatBytes(1536), "1.5 KB");
  assert.equal(format.formatBytes(25 * 1024 * 1024), "25 MB");
  assert.equal(format.plural(1, "change"), "1 change");
  assert.equal(format.plural(3, "change"), "3 changes");
  assert.equal(format.fieldLabel("due_at"), "Due date");
  assert.equal(format.fieldLabel("some_field"), "some field");
  assert.equal(format.formatFieldValue("points_possible", null), "—");
  assert.equal(format.formatFieldValue("size", 2048), "2.0 KB");
});

// --- api.ts ---

async function withFetch(response, run) {
  const original = globalThis.fetch;
  const originalDocument = globalThis.document;
  const calls = [];
  globalThis.document = { cookie: "aw_session=x; aw_csrf=token%2Fvalue" };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return {
      ok: response.status < 400,
      status: response.status,
      json: async () => response.body ?? null,
    };
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
    globalThis.document = originalDocument;
  }
}

test("the CSRF cookie is read and decoded", () => {
  assert.equal(api.readCsrfCookie("a=1; aw_csrf=abc%3D%3D; b=2"), "abc==");
  assert.equal(api.readCsrfCookie("a=1"), null);
});

test("changes send the CSRF header and JSON body; reads do not", async () => {
  await withFetch({ status: 200, body: { ok: true } }, async (calls) => {
    await api.request("/api/changes/1", { method: "PATCH", body: { read: true } });
    await api.request("/api/courses");
    assert.equal(calls[0].init.headers.get("X-AW-CSRF"), "token/value");
    assert.equal(calls[0].init.headers.get("Content-Type"), "application/json");
    assert.equal(calls[0].init.body, JSON.stringify({ read: true }));
    assert.equal(calls[0].init.credentials, "same-origin");
    assert.equal(calls[1].init.headers.get("X-AW-CSRF"), null);
  });
});

test("204 responses resolve to undefined", async () => {
  await withFetch({ status: 204 }, async () => {
    assert.equal(await api.request("/api/canvas/connection", { method: "DELETE" }), undefined);
  });
});

test("validation errors become per-field messages", async () => {
  const body = {
    detail: [
      { loc: ["body", "base_url"], msg: "Use the https address of your Canvas site." },
      { loc: ["body", "access_token"], msg: "Paste your token." },
    ],
    code: "VALIDATION_ERROR",
  };
  await withFetch({ status: 422, body }, async () => {
    const error = await api.request("/api/canvas/connection", { method: "PUT", body: {} }).catch((caught) => caught);
    assert.ok(api.isApiError(error, 422, "VALIDATION_ERROR"));
    assert.deepEqual(error.fields, { base_url: "Use the https address of your Canvas site.", access_token: "Paste your token." });
    assert.equal(error.message, "Use the https address of your Canvas site.");
  });
});

test("server sentences, server failures and network failures are told apart", async () => {
  await withFetch({ status: 409, body: { detail: "Reconnect Canvas first.", code: "CANVAS_RECONNECT_REQUIRED" } }, async () => {
    const error = await api.request("/api/sync", { method: "POST" }).catch((caught) => caught);
    assert.ok(api.isApiError(error, 409, "CANVAS_RECONNECT_REQUIRED"));
    assert.equal(error.message, "Reconnect Canvas first.");
  });
  await withFetch({ status: 502, body: null }, async () => {
    const error = await api.request("/api/courses").catch((caught) => caught);
    assert.equal(error.status, 502);
    assert.match(error.message, /server had a problem/);
  });
  await withFetch(new TypeError("Failed to fetch"), async () => {
    const error = await api.request("/api/courses").catch((caught) => caught);
    assert.ok(api.isApiError(error, 0, "NETWORK_ERROR"));
  });
});

// --- Entry and routes ---

test("the entry renders the router inside the query client and toasts, with only the new stylesheet", () => {
  const entry = read("main.tsx");
  assert.match(entry, /<QueryClientProvider client=\{client\}>\s*<ToastProvider>\s*<RouterProvider router=\{router\} \/>/);
  assert.deepEqual([...entry.matchAll(/import "(.+\.css)"/g)].map((match) => match[1]), ["./app/app.css"]);
  // An expired session signs the browser out; a wrong sign-in password does not.
  assert.match(entry, /isApiError\(error, 401, "AUTH_REQUIRED"\)/);
  assert.match(entry, /queryCache: new QueryCache\(\{ onError: signOutWhenSessionEnds \}\)/);
  assert.match(entry, /mutationCache: new MutationCache\(\{ onError: signOutWhenSessionEnds \}\)/);
});

test("public, onboarding and signed-in routes are wired with their guards", () => {
  const router = read("app/router.tsx");
  assert.match(router, /path: "\/signin", element: <PublicOnly><SignInPage \/><\/PublicOnly>/);
  assert.match(router, /path: "\/signup", element: <PublicOnly><SignUpPage \/><\/PublicOnly>/);
  assert.match(router, /element: <RequireAuth \/>,\s*children: \[\s*\{ path: "\/welcome", element: <WelcomePage \/> \}/);
  for (const path of ['index: true', 'path: "calendar"', 'path: "courses"', 'path: "courses/:courseId"', 'path: "changes"', 'path: "files"', 'path: "settings"', 'path: "*"']) {
    assert.ok(router.includes(path), path);
  }
  assert.match(router, /errorElement: <RouteErrorPage \/>/);
  assert.match(router, /basename: PUBLIC_BASE_PATH \|\| undefined/);
});

// --- Stylesheet ---

const css = postcss.parse(read("app/app.css"));

test("every design token the stylesheet uses is defined, in light and dark mode", () => {
  const defined = { light: new Set(), dark: new Set() };
  css.walkRules(":root", (rule) => {
    const mode = rule.parent.type === "atrule" && /prefers-color-scheme: dark/.test(rule.parent.params) ? "dark" : "light";
    rule.walkDecls(/^--/, (decl) => defined[mode].add(decl.prop));
  });
  const used = new Set([...read("app/app.css").matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1]));
  for (const token of used) assert.ok(defined.light.has(token), `${token} is not defined`);
  const colors = [...defined.light].filter((token) => !/radius|font|mono|width|height/.test(token));
  for (const token of colors) assert.ok(defined.dark.has(token), `${token} has no dark-mode value`);
});

test("layout switches to the sidebar at 900px and motion respects the user's setting", () => {
  const media = [];
  css.walkAtRules("media", (rule) => media.push(rule.params));
  assert.ok(media.includes("(min-width: 900px)"));
  assert.ok(media.includes("(prefers-reduced-motion: reduce)"));
  let sidebarHidden = false;
  css.walkRules(".sidebar", (rule) => {
    if (rule.parent.type === "root") rule.walkDecls("display", (decl) => (sidebarHidden = decl.value === "none"));
  });
  assert.ok(sidebarHidden, "the sidebar is hidden on phones");
});

test("touch targets for buttons and inputs are at least 44px", () => {
  const minHeight = (selector) => {
    let value;
    css.walkRules((rule) => {
      if (rule.parent.type === "root" && rule.selectors.includes(selector)) rule.walkDecls("min-height", (decl) => (value = decl.value));
    });
    return value;
  };
  assert.equal(minHeight(".button"), "44px");
  assert.equal(minHeight(".input-box input"), "44px");
});

// --- Today: due next week, and sync results ---

test("due next week is a compact list under today's plan whose rows open into the task's details", () => {
  const today = read("app/pages/today.tsx");
  const card = read("app/taskCard.tsx");
  assert.match(today, /<PlanSection plan=\{plan\} now=\{now\} \/> : null\}\s*\{plan \? <DueNextWeek plan=\{plan\} now=\{now\} \/> : null\}/);
  // One button per line; every task opens in place, a planned one with a way to its row in the plan.
  assert.match(today, /className="due-soon-row" onClick=\{onToggle\} aria-expanded=\{expanded\}/);
  assert.match(today, /<TaskCard task=\{task\} now=\{now\} zone=\{zone\} actions=\{<PlanChoice item=\{item\} \/>\} \/>/);
  assert.match(today, /onClick=\{\(\) => showPlanRow\(item\.task\.id\)\}/);
  // The card shows time left and its basis, takes the time used, and saves progress when the slider is let go.
  assert.match(card, /<dt>Time left<\/dt>/);
  assert.match(card, /changes: \{ spent_minutes: parsed\.minutes \}/);
  assert.match(card, /aria-label="Save time used"/);
  // Progress now saves with the task's revision (taskExtras.tsx).
  assert.match(card, /<RevisionProgress task=\{task\} \/>/);
  assert.match(read("app/taskExtras.tsx"), /onPointerUp=\{commit\}/);
  assert.match(card, /Assignment description/);
  assert.match(today, /changes: \{ start_today: start \}/);
  assert.match(today, /prefers-reduced-motion: reduce/);
});

test("the due list fits a phone: rows shrink, titles wrap and nothing sets a fixed width", () => {
  const declsOf = (selector, inMedia) => {
    const found = {};
    css.walkRules((rule) => {
      const media = rule.parent.type === "atrule" ? rule.parent.params : null;
      if (media === inMedia && rule.selectors.includes(selector)) rule.walkDecls((decl) => (found[decl.prop] = decl.value));
    });
    return found;
  };
  assert.equal(declsOf(".due-soon-list", null)["grid-template-columns"], "minmax(0, 1fr)");
  assert.equal(declsOf(".due-soon-item", null)["min-width"], "0");
  assert.equal(declsOf(".due-soon-main", null)["min-width"], "0");
  const phone = declsOf(".due-soon-row", "(max-width: 639px)");
  assert.equal(phone["grid-template-columns"], "max-content minmax(0, 1fr) 20px");
  assert.equal(declsOf(".due-soon-title", "(max-width: 639px)")["white-space"], "normal");
});

test("sync shows its result: a toast, the button, the status line and a dot on the phone icon", () => {
  const shell = read("app/shell.tsx");
  assert.match(shell, /useSync\(compact \? undefined : \(run\) => report\(syncOutcome\(run\)\)\)/);
  // A request that never started a sync is a failure too.
  assert.match(shell, /onError: \(error\) => report\(\{ label: "Sync failed", detail: error\.message, tone: "danger" \}\)/);
  assert.match(shell, /setTimeout\(\(\) => setResult\(null\), RESULT_MS\)/);
  assert.match(shell, /dot === "warn" \|\| dot === "bad" \? <span className=\{`status-dot \$\{dot\}`\}/);
  assert.match(read("app/toast.tsx"), /toast\.tone === "success" \? <CheckIcon size=\{18\} \/> : <AlertIcon size=\{18\} \/>/);
  const settings = read("app/pages/settings.tsx");
  assert.match(settings, /<dt>Latest sync<\/dt>/);
  let warnDot = false;
  css.walkRules(".status-dot.warn", () => (warnDot = true));
  assert.ok(warnDot, "partial syncs have their own dot colour");
});

test("AI Chat shows only when AI is available, loads its drawer lazily and keeps the conversation on the server", () => {
  const chat = read("app/aiChat.tsx");
  const drawer = read("app/aiChatDrawer.tsx");
  const shell = read("app/shell.tsx");
  assert.match(shell, /<AiChat \/>/);
  assert.match(chat, /if \(!status\.data\?\.enabled\) return null;/);
  assert.match(chat, /lazy\(\(\) => import\("\.\/aiChatDrawer"\)\)/);
  assert.match(chat, /Loading AI Chat…/);
  assert.match(drawer, /event\.key === "Enter" && !event\.shiftKey && !event\.nativeEvent\.isComposing/);
  // Only the id is kept in the browser; the messages come from the server.
  assert.match(drawer, /localStorage\.setItem\(storageKey\(userId\), id\)/);
  assert.match(drawer, /conversation_id: conversationId, message: content/);
  assert.doesNotMatch(drawer, /sessionStorage/);
});

test("AI Chat renders math safely, never loads images or HTML, and asks before any change", () => {
  const markdown = read("app/chatMarkdown.tsx");
  const drawer = read("app/aiChatDrawer.tsx");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  // Exact versions, so a renderer update is a deliberate change.
  for (const name of ["katex", "rehype-katex", "remark-math"]) assert.match(pkg.dependencies[name], /^\d+\.\d+\.\d+$/);
  assert.match(markdown, /trust: false/);
  assert.match(markdown, /maxExpand: 200, maxSize: 20/);
  assert.match(markdown, /skipHtml/);
  assert.match(markdown, /\[Image omitted\{alt \? `: \$\{alt\}` : ""\}\]/);
  assert.match(drawer, /Confirmation required/);
  assert.match(drawer, /act\("confirm"\)/);
  assert.match(drawer, /act\("cancel"\)/);
  assert.match(drawer, /className="ai-evidence-open"/);
});

test("Settings has an AI API section, and task cards show the AI summary and estimate", () => {
  const settings = read("app/pages/settings.tsx");
  const ai = read("app/aiSettings.tsx");
  const card = read("app/taskCard.tsx");
  assert.match(settings, /<AiSettingsSection \/>/);
  assert.match(ai, /Base URL \(fixed\)/);
  assert.match(ai, /Fetch models/);
  assert.match(ai, /Test selected model/);
  assert.match(ai, /Connection verified in \$\{result\.latency_ms\} ms\. AI Chat is ready\./);
  assert.match(ai, /PasswordField/);
  assert.match(card, /<AiSummary task=\{task\} \/>/);
  assert.match(card, /if \(!data \|\| data\.status === "unavailable"\) return null;/);
  assert.match(card, /return "AI estimate";/);
});

test("nginx makes browsers check the page on every visit and keep hashed assets", () => {
  const nginx = readFileSync(new URL("../nginx.conf", import.meta.url), "utf8");
  assert.match(nginx, /location = \/index\.html \{\s*add_header Cache-Control "no-cache";\s*\}/);
  assert.match(nginx, /alias \/usr\/share\/nginx\/html\/assets\/\$1;\s*add_header Cache-Control "public, max-age=31536000, immutable";/);
});

test("Today's plan, the rows that don't fit and Done today open the task card in place", () => {
  const today = read("app/pages/today.tsx");
  const lists = read("app/lists.tsx");
  assert.equal((today.match(/<ExpandableTaskRow/g) ?? []).length, 2);
  assert.match(today, /<TaskList tasks=\{plan\.done_today\} now=\{now\} expandable \/>/);
  assert.match(lists, /onClick=\{details\.onToggle\}\s*aria-expanded=\{details\.open\}/);
  assert.match(lists, /content: <TaskCard task=\{row\.task\} now=\{row\.now\} zone=\{zone\} actions=\{actions\} \/>/);
});
