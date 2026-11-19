import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import ts from "typescript";

// Course websites, Gradescope and PrairieLearn in Settings → Sources, and "Source facts" on task cards.
const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText,
  ).toString("base64")}`;

const model = await import(moduleUrl(read("app/sources/model.ts")));
const website = read("app/sources/website.tsx");
const providers = read("app/sources/providers.tsx");
const plugins = read("app/sources/plugins.ts");
const registry = read("app/sources/registry.tsx");
const section = read("app/sources/settingsSources.tsx");
const queries = read("app/sources/queries.ts");
const taskCard = read("app/taskCard.tsx");
const lists = read("app/lists.tsx");
const css = read("app/app.css");

const details = (overrides = {}) => ({
  config: { authentication_method: "ntlm", protected_path_prefix: null, probe_url: "https://courses.example.edu/c/secure/a.html", discovery_path_limit: 100, week_1_monday: null },
  course: { id: 4, code: "TEST 101", name: "Example course", term: "Fall 2026", owned: true },
  credential: { username: "SCHOOL\\student", state: "VALID", present: true, last_error_code: null, verified_at: "2026-09-01T12:00:00Z" },
  pending: [],
  ...overrides,
});
const source = { id: "s1", name: "TEST 101 Site", base_url: "https://courses.example.edu/c", config_json: { authentication_method: "ntlm" } };

test("the website and provider modules are registered with the sources registry", () => {
  assert.match(plugins, /import "\.\/website";/);
  assert.match(plugins, /import "\.\/providers";/);
  assert.match(website, /registerSourceUi\("website", \{/);
  assert.match(website, /AddForm: WebsiteAddForm/);
  assert.match(website, /CardExtras: WebsiteCardExtras/);
  assert.match(website, /EditDialog: WebsiteEditDialog/);
  assert.match(providers, /registerSourceUi\("gradescope", \{/);
  assert.match(providers, /registerSourceUi\("prairielearn", \{/);
  assert.match(registry, /EditDialog\?: ComponentType<EditDialogProps>/);
  // ?edit=<id> from the sidebar's Manage opens the registered editor; previews never get it.
  assert.match(section, /sourceUi\(editingSource\.source_type\)\?\.EditDialog/);
  assert.match(section, /editingSource && EditDialog && !locked/);
});

test("a label-only website edit sends no login; a test, a new source or changed access does", () => {
  const initial = model.websiteDraft(source, details(), "Fall 2026");
  assert.equal(initial.term, "Fall 2026");
  assert.equal(initial.authentication_method, "ntlm");
  const login = { username: "SCHOOL\\student", password: "", storedUsername: "SCHOOL\\student" };
  const relabel = model.websitePayload({ ...initial, name: "Renamed" }, initial, login, { editing: true, testOnly: false });
  assert.equal(relabel.ntlm, undefined);
  assert.equal(relabel.term, undefined, "an untouched term is left alone");
  assert.equal(relabel.name, "Renamed");
  const tested = model.websitePayload(initial, initial, login, { editing: true, testOnly: true });
  assert.deepEqual(tested.ntlm, { username: "SCHOOL\\student", password: "" });
  const moved = { ...initial, base_url: "https://other.example.edu/c" };
  assert.ok(model.websiteNetworkChanged(initial, moved));
  assert.ok(model.websitePayload(moved, initial, login, { editing: true, testOnly: false }).ntlm);
  const otherUser = model.websitePayload(initial, initial, { ...login, username: "someone" }, { editing: true, testOnly: false });
  assert.equal(otherUser.ntlm.username, "someone");
  const typed = model.websitePayload(initial, initial, { ...login, password: "test-only" }, { editing: true, testOnly: false });
  assert.equal(typed.ntlm.password, "test-only");
});

test("a new public website gets a default label and no access settings", () => {
  const fresh = model.websiteDraft(null, null, "Fall 2026");
  const draft = { ...fresh, course_code: "TEST 101", course_name: "Example", base_url: " https://courses.example.edu/c/ ", protected_path_prefix: "/c/x", discovery_path_limit: "abc" };
  const body = model.websitePayload(draft, fresh, { username: "", password: "", storedUsername: null }, { editing: false, testOnly: false });
  assert.equal(body.name, "TEST 101 Site");
  assert.equal(body.base_url, "https://courses.example.edu/c/");
  assert.equal(body.term, "Fall 2026");
  assert.equal(body.protected_path_prefix, null);
  assert.equal(body.discovery_path_limit, 100);
  assert.equal(body.ntlm, undefined);
  assert.equal(body.week_1_monday, null);
});

test("the website card says how its credential stands and how many resources wait", () => {
  assert.equal(model.websiteCredentialLine(details()), "Website authentication: Verified.");
  assert.equal(
    model.websiteCredentialLine(details({ credential: { username: "u", state: "MISSING", present: true, last_error_code: "protected_access_not_verified" } })),
    "Public website reachable. Protected access not yet verified.",
  );
  assert.match(model.websiteCredentialLine(details({ credential: { username: "u", state: "INVALID", present: false, last_error_code: "auth_failed" } })), /rejected the password/);
  assert.equal(model.websiteCredentialLine(details({ credential: null })), "Website authentication: Authentication required.");
  assert.equal(model.websiteCredentialLine(details({ config: { ...details().config, authentication_method: "none" } })), "Public website · no password needed.");
  assert.equal(model.pendingNote([]), "");
  assert.equal(model.pendingNote([{ state: "AUTH_REQUIRED" }, { state: "AUTH_REQUIRED" }]), " · 2 protected resources pending");
  assert.equal(model.pendingNote([{ state: "AUTH_REQUIRED" }, { state: "FAILED" }]), " · 2 resources pending");
  assert.equal(model.authenticationLabel({ source_type: "website", config_json: { authentication_method: "ntlm" } }, null), "NTLM");
  assert.equal(model.authenticationLabel({ source_type: "website", config_json: {} }, null), "Public");
  assert.equal(model.authenticationLabel({ source_type: "gradescope", config_json: {} }, null), "Browser Session");
});

test("the website form: term picker, NTLM fields, advanced settings, Test connection that never saves", () => {
  for (const text of [
    "Subject / Course code",
    "Use existing term",
    "Create new term",
    "Course website URL",
    "NTLM \\(username and password\\)",
    "Advanced access settings",
    "Protected resource path \\(optional, usually detected\\)",
    "Protected test page \\(optional\\)",
    "Advanced source settings",
    "Source label",
    "Discovery path limit",
    "Monday of week 1",
    "Test connection does not save",
    "Leave blank to keep a matching saved password",
  ]) {
    assert.match(website, new RegExp(text));
  }
  assert.match(website, /test\.mutate\(\s*\{ id: source\?\.id \?\? null, body: body\(true\) \}/);
  assert.match(website, /disabled=\{busy \|\| !dirty\}/);
  assert.match(website, /setPassword\(""\)/);
  assert.match(queries, /`\/api\/sources\/website\/test\$\{id \? `\?connection_id=\$\{encodeURIComponent\(id\)\}` : ""\}`/);
  assert.match(queries, /id \? `\/api\/sources\/website\/\$\{id\}` : "\/api\/sources\/website"/);
  assert.match(queries, /`\/api\/sources\/\$\{id\}\/website\/credential`/);
  // Previews see Edit and Authenticate greyed out.
  assert.match(website, /<UnavailableButton className="button secondary small">Edit<\/UnavailableButton>/);
  assert.match(website, /<UnavailableButton className="button secondary small">Authenticate<\/UnavailableButton>/);
  assert.match(website, /This website uses\s+its own NTLM credentials/);
});

test("Gradescope: add form defaults, discover → map → sync, task mappings, PrairieLearn note", () => {
  assert.equal(model.PROVIDER_DEFAULT_URLS.gradescope, "https://www.gradescope.com");
  assert.equal(model.PROVIDER_DEFAULT_URLS.prairielearn, "https://us.prairielearn.com/pl");
  assert.match(model.PRAIRIELEARN_NOTE, /Student course parsing awaits representative course data/);
  assert.match(providers, /Optional Canvas course for LTI sign-in/);
  assert.match(providers, /Student assessment parsing is not yet verified with an enrolled course\./);
  for (const label of ["Discover courses", "Sync mapped courses", "Confirm course mapping", "Confirm task mappings", "Keep as its own task", "Unlink"]) {
    assert.match(providers, new RegExp(label));
  }
  assert.match(providers, /No student courses were visible\. Existing courses were not removed\./);
  assert.match(queries, /`\/api\/sources\/\$\{id\}\/provider-courses`/);
  assert.match(queries, /`\/api\/sources\/\$\{id\}\/course-mappings`/);
  assert.match(queries, /`\/api\/sources\/\$\{id\}\/assignments\$\{pending \? "\?pending=1" : ""\}`/);
  assert.match(queries, /`\/api\/sources\/\$\{id\}\/task-mappings`/);
  assert.match(providers, /task_id: choice === "separate" \? null : Number\(choice\)/);
  assert.equal(model.syncFeedback({ state: "READY", errors: [{ code: "PROVIDER_TASK_MAPPING_REQUIRED" }] }).ok, false);
  assert.match(model.syncFeedback({ state: "READY", errors: [{ code: "storage_quota_exceeded" }] }).message, /storage is full/);
});

test("non-Canvas cards can sync now and be removed after a confirmation", () => {
  assert.match(section, /function ConnectionActions/);
  assert.match(section, /Remove \$\{source\.name\}\?/);
  assert.match(section, /<UnavailableButton className="button ghost small">Remove<\/UnavailableButton>/);
  assert.match(queries, /request<void>\(`\/api\/sources\/\$\{id\}`, \{ method: "DELETE" \}\)/);
});

test("task cards show Source facts, flagging deadlines that differ", () => {
  const facts = (rows, differ = false) => ({ deadlines_differ: differ, provider_facts: rows });
  const canvas = { provider: "canvas", due_at: "2026-09-25T04:59:00Z" };
  const gradescope = { provider: "gradescope", due_at: "2026-09-24T23:59:00-05:00" };
  assert.equal(model.hasProviderFacts(facts([canvas])), false);
  assert.equal(model.hasProviderFacts(facts([canvas, gradescope])), true);
  assert.equal(model.sourceFactsTitle(facts([canvas, gradescope])), "Source facts");
  assert.equal(model.sourceFactsTitle(facts([canvas, { ...gradescope, due_at: "2026-09-26T23:59:00-05:00" }])), "Source facts · deadlines differ");
  assert.equal(model.submissionLabel("graded"), "Graded");
  assert.equal(model.submissionLabel("unsubmitted"), "Not submitted");
  assert.match(taskCard, /<SourceFacts task=\{task\} \/>/);
  assert.match(taskCard, /Late cutoff:/);
  assert.match(queries, /`\/api\/tasks\/\$\{taskId\}\/provider-facts`/);
  assert.match(lists, /file\.source === "website" \? " · Website" : ""/);
});

test("website and provider styles use the themed tokens and wrap on phones", () => {
  const root = postcss.parse(css);
  const rules = new Map();
  root.walkRules((rule) => {
    const media = rule.parent?.type === "atrule" ? `${rule.parent.name} ${rule.parent.params}` : "";
    rules.set(`${media}|${rule.selector}`, rule.toString());
  });
  assert.ok(rules.has("|.provider-course-map"));
  assert.match(rules.get("|.provider-course-map"), /flex-wrap: wrap/);
  assert.ok(rules.has("media (max-width: 479px)|.provider-course-map > .button"));
  assert.ok(rules.has("|.provider-facts"));
  const block = css.slice(css.indexOf("/* Course websites and read-only providers"));
  assert.doesNotMatch(block, /#[0-9a-f]{3,6}\b/i, "colours come from the themed tokens");
});
