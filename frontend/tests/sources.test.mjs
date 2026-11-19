import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import ts from "typescript";

// Settings → Sources, the Auth Broker handshake and the sidebar's SOURCES list.
const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText,
  ).toString("base64")}`;

const model = await import(moduleUrl(read("app/sources/model.ts")));
const publicPathUrl = moduleUrl(read("publicPath.ts"));
const api = await import(moduleUrl(read("app/api.ts").replace('"../publicPath"', JSON.stringify(publicPathUrl))));
const broker = read("app/sources/broker.tsx");
const card = read("app/sources/canvasCard.tsx");
const section = read("app/sources/settingsSources.tsx");
const sidebar = read("app/sources/sidebar.tsx");
const queries = read("app/sources/queries.ts");
const registry = read("app/sources/registry.tsx");
const shell = read("app/shell.tsx");
const settings = read("app/pages/settings.tsx");
const welcome = read("app/pages/welcome.tsx");
const css = read("app/app.css");

const status = (overrides = {}) => ({
  connection_state: "ACTIVE",
  effective_method: "pat",
  days_remaining: 12,
  credentials: { pat: { state: "VALID" }, oauth: { state: "MISSING" }, browser_session: { state: "MISSING" } },
  ...overrides,
});

test("the Canvas row says how it signs in", () => {
  assert.equal(model.canvasSubtitle(status()), "PAT · 12 days left");
  assert.equal(model.canvasSubtitle(status({ days_remaining: 1 })), "PAT · 1 day left");
  assert.equal(model.canvasSubtitle(status({ days_remaining: null })), "PAT · expiry unknown");
  assert.equal(model.canvasSubtitle(status({ effective_method: "oauth" })), "OAuth");
  assert.equal(model.canvasSubtitle(status({ effective_method: "browser_session" })), "Session");
  assert.equal(
    model.canvasSubtitle(status({ effective_method: "browser_session", credentials: { pat: { state: "EXPIRED" } } })),
    "Session · PAT expired",
  );
  assert.equal(model.canvasSubtitle(status({ connection_state: "AUTH_REQUIRED" })), "Authentication required");
  assert.equal(model.canvasSubtitle(undefined), "Authentication required");
});

test("status tones follow the original colours", () => {
  assert.equal(model.sourceTone("HEALTHY"), "active");
  assert.equal(model.sourceTone("VALID"), "active");
  assert.equal(model.sourceTone("COMING_SOON"), "neutral");
  assert.equal(model.sourceTone("AUTH_REQUIRED"), "warning");
  assert.equal(model.sourceTone("DISABLED"), "warning");
  assert.equal(model.sourceTone("ERROR"), "danger");
  assert.equal(model.sourceTone("REVOKED"), "danger");
});

test("the broker is ready only with protocol 1 and a reachable server", () => {
  assert.equal(model.brokerReady({ protocol_version: 1, backend_ready: true }), true);
  assert.equal(model.brokerReady({ protocol_version: 1, backend_ready: false }), false);
  assert.equal(model.brokerReady({ protocol_version: 2, backend_ready: true }), false);
  assert.equal(model.brokerReady(undefined), false);
  for (const code of ["AUTH_LOGIN_TIMEOUT", "TIMED_OUT", "AUTH_USER_CANCELLED", "CANCELLED", "CANVAS_ACCOUNT_MISMATCH", "AUTH_BROKER_UNAVAILABLE", "AUTH_LOGIN_FAILED", "other"]) {
    assert.ok(model.brokerMessage(code).length > 10, code);
  }
  assert.match(model.brokerMessage("CANVAS_ACCOUNT_MISMATCH"), /different Canvas account/);
  assert.deepEqual([...model.TERMINAL_STATES].sort(), ["AUTHENTICATED", "CANCELLED", "FAILED", "TIMED_OUT"]);
});

test("the quick panel sits beside its row above 820px and is a bottom sheet below", () => {
  assert.equal(model.quickPanelPosition({ top: 500, right: 240 }, { width: 360, height: 300 }, { width: 820, height: 900 }), null);
  assert.deepEqual(model.quickPanelPosition({ top: 500, right: 240 }, { width: 360, height: 300 }, { width: 1280, height: 900 }), { left: 250, top: 500 });
  // Clamped into the window.
  assert.deepEqual(model.quickPanelPosition({ top: 800, right: 1700 }, { width: 360, height: 300 }, { width: 1920, height: 900 }), { left: 1548, top: 588 });
  assert.deepEqual(model.quickPanelPosition({ top: 10, right: 0 }, { width: 360, height: 300 }, { width: 900, height: 600 }), { left: 12, top: 12 });
});

test("sync feedback and diagnostics read like the original", () => {
  assert.deepEqual(model.syncFeedback({ state: "READY", errors: [] }), { ok: true, message: "Sync completed successfully." });
  assert.equal(model.syncFeedback({ state: "AUTH_REQUIRED", errors: [] }).ok, false);
  assert.match(model.syncFeedback({ state: "READY", errors: [{ code: "PROVIDER_COURSE_MAPPING_REQUIRED" }] }).message, /Link the discovered courses/);
  assert.equal(model.syncFeedback(null, { message: "Canvas is off." }).message, "Canvas is off.");
  assert.equal(
    model.diagnosticLine({ resource: "file", course: "CS 409", code: "permission_denied", http_status: 403, optional: true }),
    "file (CS 409): permission_denied · HTTP 403 · skipped",
  );
  assert.equal(model.slotDetail("pat", { present: true, expires_at: "2026-12-01T05:59:59Z", expiration_source: "USER_ENTERED" }, () => "Dec 1"), "Expires: Dec 1 (entered by you)");
  assert.equal(model.slotDetail("pat", { present: true, expires_at: null }, () => ""), "Expires: Unknown");
  assert.equal(model.slotDetail("oauth", { present: false, last_verified_at: null }, () => ""), "Not verified");
});

test("api() can send extra headers and an AbortSignal; the broker gets no cookies", async () => {
  const calls = [];
  globalThis.document = { cookie: "aw_csrf=abc" };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const controller = new AbortController();
  await api.request("/api/auth/broker/challenges", { method: "POST", body: {}, headers: { "X-AW-Broker": "1" }, signal: controller.signal });
  assert.equal(calls[0].init.headers.get("X-AW-Broker"), "1");
  assert.equal(calls[0].init.headers.get("X-AW-CSRF"), "abc");
  assert.equal(calls[0].init.signal, controller.signal);
  await api.brokerRequest("http://127.0.0.1:8765/login", { method: "POST", body: { a: 1 }, timeoutMs: 10_000 });
  assert.equal(calls[1].url, "http://127.0.0.1:8765/login");
  assert.equal(calls[1].init.credentials, "omit");
  assert.equal(calls[1].init.headers["X-AW-Broker"], "1");
  globalThis.fetch = async () => {
    throw new TypeError("connection refused");
  };
  await assert.rejects(api.brokerRequest("http://127.0.0.1:8765/health", { timeoutMs: 2_500 }), (error) => error.code === "AUTH_BROKER_UNAVAILABLE");
});

test("the broker panel polls health, launches the installed launcher and waits 60 seconds", () => {
  assert.match(queries, /refetchInterval: 15_000,\s*retry: false/);
  assert.match(queries, /timeoutMs: 2_500/);
  assert.match(broker, /BROKER_LAUNCH_URI = "academicwatcher:\/\/start"/);
  assert.match(broker, /window\.location\.href = BROKER_LAUNCH_URI/);
  assert.match(broker, /LAUNCH_WAIT_MS = 60_000/);
  assert.match(broker, /Local Auth Broker · /);
  assert.match(broker, /The broker must run on this computer, outside Docker\./);
});

test("browser sign-in: challenge, hand the ticket to the broker, poll every second, cancel both", () => {
  assert.match(broker, /brokerApi\.challenge\(\{ provider: clearAll \? "all" : provider, credential_id: credentialId, operation: kind \}\)/);
  assert.match(broker, /brokerRequest\(`\$\{url\}\/login`[^]*?timeoutMs: 10_000/);
  assert.match(broker, /STATUS_POLL_MS = 1_000/);
  assert.match(broker, /brokerApi\.cancel\([^]*?brokerRequest\(`\$\{url\}\/cancel`[^]*?timeoutMs: 2_500/);
  assert.match(broker, /CanvasWatcher never receives your password/);
  assert.match(queries, /"X-AW-Broker": "1"/);
  assert.match(broker, /Use Start broker in the Local Auth Broker panel, then retry sign-in\./);
});

test("the Canvas card shows each slot, its expiry, Remove with the generation and a confirmed Clear all", () => {
  assert.match(card, /METHOD_ORDER\.map/);
  assert.match(card, /current \? "Current" : "Backup"/);
  assert.match(card, /remove\.mutate\(\{ method, generation: slot\.generation \}/);
  assert.match(card, /Clear all Canvas credentials\?/);
  assert.match(card, /Cached course data will be preserved/);
  assert.match(card, /Default priority: OAuth → PAT → Browser Session/);
  assert.match(card, /Copy as cURL \(bash\)/);
  assert.match(card, /Authorize with Canvas OAuth/);
  assert.match(card, /popup\.opener = null/);
  assert.match(card, /If the probe fails, the existing working URL remains active\./);
  assert.match(queries, /`\/api\/auth\/canvas\/methods\/\$\{method\}\?generation=\$\{generation\}`/);
});

test("Settings → Sources: storage notice, wizard with four types, ?edit deep link, registry placeholders", () => {
  assert.match(settings, /<SourcesSection \/>/);
  assert.match(section, /id="sources"/);
  assert.match(section, /Configured connections/);
  assert.match(section, /Server storage enabled: credentials are encrypted/);
  assert.match(section, /params\.get\("edit"\)/);
  assert.match(section, /next\.delete\("edit"\)/);
  for (const label of ["Canvas", "Course Website", "Gradescope", "PrairieLearn"]) assert.match(registry, new RegExp(`label: "${label}"`));
  assert.match(registry, /export function registerSourceUi/);
  assert.match(registry, /COMING_SOON = "Coming in this release"/);
  assert.match(section, /<UnavailableButton className="button primary">/);
});

test("the sidebar lists sources with a quick panel, Sync now and Manage; previews grey out Sync", () => {
  assert.match(shell, /<SourcesList \/>/);
  assert.match(shell, /<SourcesButton \/>/);
  assert.match(shell, /VITE_ACCOUNT_URL/);
  assert.match(shell, /to="\/settings#sources"/);
  assert.match(sidebar, /role="dialog"/);
  assert.match(sidebar, /event\.key === "Escape"/);
  assert.match(sidebar, /Advanced resource diagnostics/);
  assert.match(sidebar, /navigate\(`\/settings\?edit=\$\{encodeURIComponent\(source\.id\)\}#sources`\)/);
  assert.match(sidebar, /<UnavailableButton className="button small secondary">/);
  assert.match(welcome, /<WelcomeBrowserSignIn/);
});

test("sources styles cover narrow and wide screens, and dark mode through tokens", () => {
  const root = postcss.parse(css);
  const rules = new Map();
  root.walkRules((rule) => {
    const media = rule.parent?.type === "atrule" ? `${rule.parent.name} ${rule.parent.params}` : "";
    rules.set(`${media}|${rule.selector}`, rule.toString());
  });
  assert.ok(rules.has("|.quick-panel-sheet"));
  assert.ok(rules.has("media (min-width: 1280px)|.source-connection-grid"));
  assert.ok(rules.has("media (max-width: 479px)|.quick-panel-list > div"));
  assert.ok(rules.has("container (max-width: 420px)|.source-card-head"));
  const block = css.slice(css.indexOf("/* --- Sources:"));
  assert.doesNotMatch(block, /#[0-9a-f]{3,6}\b/i, "colours come from the themed tokens");
});
