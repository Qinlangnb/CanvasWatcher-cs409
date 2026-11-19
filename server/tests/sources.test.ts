import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mergeSetCookies } from "../src/canvas/client.js";
import { endOfDay, expiration } from "../src/canvas/credentials.js";
import { parseSessionImport, shellSplit } from "../src/canvas/sessionImport.js";
import { CANVAS_ORIGIN, CANVAS_SESSION, CANVAS_TOKEN, fakeCanvas, seedCourse } from "./fakeCanvas.js";
import { connectCanvas, db, resetDatabase, services, signUp, syncNow, type Browser } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
  fakeCanvas.reset();
});
afterAll(() => db.$disconnect());

const SESSION_CURL = `curl 'https://canvas.example.edu/api/v1/users/self' \\\n  -H 'accept: application/json' \\\n  -b 'canvas_session=${CANVAS_SESSION}; _csrf_token=abc%3D' \\\n  --compressed`;

async function importSession(browser: Browser, sessionImport = SESSION_CURL) {
  const res = await browser.send("post", "/api/auth/canvas/browser-session", { body: { base_url: CANVAS_ORIGIN, session_import: sessionImport } });
  await services.sync.whenIdle();
  return res;
}

const status = async (browser: Browser) => (await browser.send("get", "/api/auth/canvas/status")).body;

describe("session import parsing", () => {
  it("reads raw Cookie headers, Cookie: lines and copied cURL (bash and cmd)", () => {
    expect([...parseSessionImport("a=1; b=\"two\"")]).toEqual([["a", "1"], ["b", "two"]]);
    expect([...parseSessionImport("Cookie: a=1")]).toEqual([["a", "1"]]);
    expect(parseSessionImport(SESSION_CURL).get("canvas_session")).toBe(CANVAS_SESSION);
    expect(parseSessionImport(`curl $'https://x' -H $'Cookie: a=1\\x3b b=2'`).get("b")).toBe("2");
    expect(parseSessionImport(`curl "https://x" -H "cookie: a=\\"q\\"" --header="Cookie: c=3"`).get("c")).toBe("3");
    const cmd = `curl ^"https://canvas.example.edu/^" ^\r\n  -H ^"cookie: canvas_session=s1; x=^%^20^" ^\r\n  --compressed`;
    expect(parseSessionImport(cmd).get("canvas_session")).toBe("s1");
  });

  it("rejects malformed, oversized or cookie-less input without echoing it", () => {
    for (const input of ["", "curl https://x -H 'Accept: x'", "bad name=1", "a=1\r\nb=2", `curl 'unterminated`, "x".repeat(131_073)]) {
      expect(() => parseSessionImport(input), input.slice(0, 20)).toThrow();
    }
    try {
      parseSessionImport("secret-value-without-equals\nmore");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-value");
    }
    expect(shellSplit(`a 'b c' "d\\"e" f\\ g`)).toEqual(["a", "b c", 'd"e', "f g"]);
  });

  it("merges only same-host Set-Cookie values", () => {
    const jar = new Map([["a", "1"]]);
    expect(mergeSetCookies(jar, ["b=2; Path=/", "c=3; Domain=.example.edu", "d=4; Domain=canvas.example.edu", "a=; Max-Age=0"], "canvas.example.edu")).toBe(true);
    expect([...jar]).toEqual([["b", "2"], ["d", "4"]]);
  });

  it("PAT expiry: end of the chosen day in the user's zone, then warning levels", () => {
    expect(endOfDay("2026-12-01", "America/Chicago").toISOString()).toBe("2026-12-02T05:59:59.999Z");
    const now = new Date("2026-11-20T12:00:00Z");
    const at = (days: number) => new Date(now.getTime() + days * 86_400_000);
    expect(expiration(at(10), now)).toEqual({ days: 10, state: "normal" });
    expect(expiration(at(6.5), now).state).toBe("warning");
    expect(expiration(at(2.5), now).state).toBe("urgent");
    expect(expiration(at(0.5), now)).toEqual({ days: 1, state: "critical" });
    expect(expiration(at(-1), now).state).toBe("expired");
    expect(expiration(null, now).state).toBe("unknown");
  });
});

describe("Canvas credential slots", () => {
  it("imports a PAT with an expiry date and reports it in the status", async () => {
    const ada = await signUp();
    const date = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    const res = await ada.send("post", "/api/auth/canvas/pat", { body: { base_url: CANVAS_ORIGIN, token: CANVAS_TOKEN, expiration_date: date } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ verified: true, method: "pat" });
    await services.sync.whenIdle();
    const body = await status(ada);
    expect(JSON.stringify(body)).not.toContain(CANVAS_TOKEN);
    expect(body).toMatchObject({ configured: true, connection_state: "ACTIVE", effective_method: "pat", backup_ready: false, credential_storage: "server_encrypted" });
    expect(body.credentials.pat).toMatchObject({ present: true, state: "VALID", generation: 1, expiration_source: "USER_ENTERED", expiration_state: "normal" });
    expect(body.credentials.browser_session).toMatchObject({ present: false, state: "MISSING" });
  });

  it("an expired PAT is removed and the connection asks for a sign-in", async () => {
    const ada = await signUp();
    await connectCanvas(ada);
    await db.canvasCredential.updateMany({ where: { method: "PAT" }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const body = await status(ada);
    expect(body.credentials.pat).toMatchObject({ present: false, state: "EXPIRED", last_failure_reason: "PAT_EXPIRED" });
    expect(body.connection_state).toBe("AUTH_REQUIRED");
    expect((await ada.send("get", "/api/canvas/connection")).body.status).toBe("token_rejected");
  });

  it("imports a browser session from cURL, which then becomes a backup", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    const res = await importSession(ada);
    expect(res.status).toBe(200);
    const stored = await db.canvasCredential.findFirstOrThrow({ where: { method: "BROWSER_SESSION" } });
    expect(stored.secretCiphertext).not.toContain(CANVAS_SESSION);
    const body = await status(ada);
    expect(body).toMatchObject({ effective_method: "pat", backup_ready: true });
    expect(body.credentials.browser_session).toMatchObject({ present: true, state: "VALID" });
  });

  it("refuses a session that Canvas rejects, or one for another account, and keeps the current one", async () => {
    const ada = await signUp();
    await connectCanvas(ada);
    const bad = await importSession(ada, "canvas_session=wrong");
    expect(bad.status).toBe(422);
    expect(bad.body.detail[0].loc).toEqual(["body", "session_import"]);
    fakeCanvas.sessionUser = { id: 7, name: "Someone Else" };
    const other = await importSession(ada);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe("account_mismatch");
    const wrongHost = await ada.send("post", "/api/auth/canvas/pat", { body: { base_url: "https://other.example.edu", token: "x" } });
    expect(wrongHost.status).toBe(422);
    expect((await status(ada)).credentials.browser_session.present).toBe(false);
  });

  it("keeps a working PAT when its replacement fails (replacement_invalid)", async () => {
    const ada = await signUp();
    await connectCanvas(ada);
    const res = await ada.send("post", "/api/auth/canvas/pat", { body: { token: "not-a-token" } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("replacement_invalid");
    expect((await status(ada)).credentials.pat).toMatchObject({ present: true, generation: 1 });
  });

  it("removes a slot only at the expected generation", async () => {
    const ada = await signUp();
    await connectCanvas(ada);
    await importSession(ada);
    const stale = await ada.send("delete", "/api/auth/canvas/methods/browser_session?generation=0");
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("stale_generation");
    expect((await ada.send("delete", "/api/auth/canvas/methods/browser_session?generation=1")).status).toBe(204);
    const body = await status(ada);
    expect(body.credentials.browser_session).toMatchObject({ present: false, generation: 2, state: "MISSING" });
    expect(body.connection_state).toBe("ACTIVE");
    expect((await ada.send("delete", "/api/auth/canvas/methods/nope")).status).toBe(404);
  });

  it("verifies a slot on request", async () => {
    const ada = await signUp();
    await connectCanvas(ada);
    expect((await ada.send("post", "/api/auth/canvas/methods/pat/verify")).body).toEqual({ verified: true, method: "pat" });
    fakeCanvas.token = "rotated";
    expect((await ada.send("post", "/api/auth/canvas/methods/pat/verify")).body).toEqual({ verified: false, method: "pat" });
    expect((await status(ada)).credentials.pat).toMatchObject({ present: false, state: "INVALID" });
  });

  it("clear all signs out of every method but keeps course data", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    await importSession(ada);
    expect((await ada.send("delete", "/api/auth/canvas/credentials")).status).toBe(204);
    const body = await status(ada);
    expect(body.connection_state).toBe("AUTH_REQUIRED");
    expect(body.credentials.pat.present || body.credentials.browser_session.present).toBe(false);
    expect((await ada.send("get", "/api/courses")).body).toHaveLength(1);
    expect(await db.canvasConnection.count()).toBe(1);
  });

  it("uses the preferred method first", async () => {
    const ada = await signUp();
    await connectCanvas(ada);
    await importSession(ada);
    const res = await ada.send("put", "/api/auth/canvas/preferred", { body: { method: "browser_session" } });
    expect(res.body).toMatchObject({ preferred_method: "browser_session", effective_method: "browser_session" });
    fakeCanvas.requests.length = 0;
    fakeCanvas.token = "rotated";
    expect(await syncNow(ada)).toMatchObject({ status: "succeeded" });
    // The PAT was never needed, so it was never found out.
    expect((await status(ada)).credentials.pat.present).toBe(true);
  });

  it("preview accounts cannot import credentials", async () => {
    const ada = await signUp();
    await db.user.updateMany({ data: { previewExpiresAt: new Date(Date.now() + 86_400_000) } });
    const res = await ada.send("post", "/api/auth/canvas/pat", { body: { base_url: CANVAS_ORIGIN, token: CANVAS_TOKEN } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PREVIEW_ACCOUNT");
  });
});

describe("failover routing", () => {
  it("fails over from a rejected PAT to the browser session and records it", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    await importSession(ada);
    fakeCanvas.token = "rotated";
    expect(await syncNow(ada)).toMatchObject({ status: "succeeded", courses_synced: 1 });
    const body = await status(ada);
    expect(body.credentials.pat).toMatchObject({ present: false, state: "INVALID", last_failure_reason: "TOKEN_REJECTED" });
    expect(body).toMatchObject({ effective_method: "browser_session", connection_state: "ACTIVE" });
    expect(body.fallback).toMatchObject({ from: "pat", to: "browser_session", reason_code: "PAT_INVALID" });

    // Once the last slot fails too, the connection needs a new sign-in.
    fakeCanvas.session = null;
    const run = await syncNow(ada);
    expect(run.status).toBe("failed");
    expect((await ada.send("get", "/api/canvas/connection")).body.status).toBe("token_rejected");
    expect((await ada.send("get", "/api/sources")).body[0]).toMatchObject({ source_type: "canvas", health: "AUTH_REQUIRED", state: "AUTH_REQUIRED" });
  });

  it("a rejection for one resource while the credential still works never invalidates it", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    fakeCanvas.failures.set("/api/v1/courses/101/files", 401);
    expect(await syncNow(ada)).toMatchObject({ status: "succeeded" });
    expect((await status(ada)).credentials.pat).toMatchObject({ present: true, state: "VALID" });
  });

  it("removes a backup that now signs in as someone else (identity drift)", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    await importSession(ada);
    // Older than 15 minutes, so the backup is probed before it is used.
    await db.canvasCredential.updateMany({ where: { method: "BROWSER_SESSION" }, data: { verifiedAt: new Date(Date.now() - 20 * 60_000) } });
    fakeCanvas.sessionUser = { id: 7, name: "Someone Else" };
    fakeCanvas.token = "rotated";
    expect((await syncNow(ada)).status).toBe("failed");
    const body = await status(ada);
    expect(body.credentials.browser_session).toMatchObject({ present: false, state: "REVOKED", last_failure_reason: "ACCOUNT_CHANGED" });
  });

  it.each(["redirect", "html"] as const)("a browser session sent to the login page (%s) counts as signed out", async (mode) => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    await importSession(ada);
    await ada.send("put", "/api/auth/canvas/preferred", { body: { method: "browser_session" } });
    fakeCanvas.sessionRejection = mode;
    fakeCanvas.session = "expired";
    expect(await syncNow(ada)).toMatchObject({ status: "succeeded" });
    expect((await status(ada)).credentials.browser_session).toMatchObject({ present: false, state: "INVALID" });
    expect((await status(ada)).effective_method).toBe("pat");
  });

  it("saves cookies Canvas rotates during a sync", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await importSession(ada);
    fakeCanvas.rotateCookie = "rotated-csrf";
    await syncNow(ada);
    const row = await db.canvasCredential.findFirstOrThrow({ where: { method: "BROWSER_SESSION" } });
    const jar = JSON.parse(services.secrets.open(row.secretCiphertext ?? "", `${row.userId}:canvas:browser_session`));
    expect(jar).toMatchObject({ canvas_session: CANVAS_SESSION, _csrf_token: "rotated-csrf" });
  });

  it("opens a PAT stored before credential slots and re-seals it for its slot", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    const user = await db.user.findFirstOrThrow();
    const legacy = services.secrets.seal(CANVAS_TOKEN, user.id);
    await db.canvasCredential.updateMany({ where: { method: "PAT" }, data: { secretCiphertext: legacy, legacyAad: true } });
    await db.canvasConnection.updateMany({ data: { tokenCiphertext: legacy } });
    expect(await syncNow(ada)).toMatchObject({ status: "succeeded" });
    const row = await db.canvasCredential.findFirstOrThrow({ where: { method: "PAT" } });
    expect(row.legacyAad).toBe(false);
    expect(services.secrets.open(row.secretCiphertext ?? "", `${user.id}:canvas:pat`)).toBe(CANVAS_TOKEN);
    expect((await db.canvasConnection.findFirstOrThrow()).tokenCiphertext).toBeNull();
  });

  it("the migration turns an existing token into a PAT slot and a Canvas source", async () => {
    const sql = readFileSync(new URL("../prisma/migrations/20261117090000_sources_parity/migration.sql", import.meta.url), "utf8");
    const data = sql.slice(sql.indexOf("-- Every existing Canvas connection"));
    const ada = await signUp();
    const user = await db.user.findFirstOrThrow();
    const sealed = services.secrets.seal(CANVAS_TOKEN, user.id);
    await db.canvasConnection.create({
      data: { userId: user.id, baseUrl: CANVAS_ORIGIN, tokenCiphertext: sealed, canvasUserId: "42", displayName: "Ada", verifiedAt: new Date() },
    });
    for (const statement of data.split(/;\s*\n/).filter((part) => part.replace(/--.*$/gm, "").trim())) {
      await db.$executeRawUnsafe(statement);
    }
    const row = await db.canvasCredential.findFirstOrThrow();
    expect(row).toMatchObject({ method: "PAT", legacyAad: true, state: "VALID", generation: 1, secretCiphertext: sealed });
    expect((await ada.send("get", "/api/sources")).body).toMatchObject([{ source_type: "canvas", base_url: CANVAS_ORIGIN, state: "READY" }]);
    expect((await status(ada)).credentials.pat).toMatchObject({ present: true });
  });
});

describe("sources", () => {
  it("lists the Canvas source with health and diagnostics from the last sync", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    let [canvas] = (await ada.send("get", "/api/sources")).body;
    expect(canvas).toMatchObject({ source_type: "canvas", enabled: true, health: "HEALTHY", health_diagnostics: [], supported: true });
    fakeCanvas.failures.set("/api/v1/announcements", 500);
    fakeCanvas.failures.set("/api/v1/courses/101/files", 403);
    await syncNow(ada);
    [canvas] = (await ada.send("get", "/api/sources")).body;
    expect(canvas.health).toBe("DEGRADED");
    expect(canvas.health_summary).toContain("Some resources");
    expect(canvas.health_diagnostics).toEqual(
      expect.arrayContaining([
        { resource: "announcement", course: "CS 409", code: "server_error", http_status: 500, optional: false },
        { resource: "file", course: "CS 409", code: "permission_denied", http_status: 403, optional: true },
      ]),
    );
  });

  it("a disabled source is skipped by sync", async () => {
    const ada = await signUp();
    await connectCanvas(ada);
    const [canvas] = (await ada.send("get", "/api/sources")).body;
    const off = await ada.send("patch", `/api/sources/${canvas.id}`, { body: { enabled: false } });
    expect(off.body).toMatchObject({ enabled: false, state: "DISABLED" });
    const sync = await ada.send("post", "/api/sync");
    expect(sync.status).toBe(409);
    expect(sync.body.code).toBe("SOURCE_DISABLED");
    await db.canvasConnection.updateMany({ data: { lastSyncedAt: new Date(0) } });
    expect(await services.sync.startDue(60_000)).toBe(0);
    await ada.send("patch", `/api/sources/${canvas.id}`, { body: { enabled: true } });
    expect((await ada.send("post", `/api/sources/${canvas.id}/sync`)).status).toBe(202);
    await services.sync.whenIdle();
  });

  it("adds one Canvas source, renames it, and refuses other types until they are installed", async () => {
    const ada = await signUp();
    const created = await ada.send("post", "/api/sources/canvas", { body: { base_url: CANVAS_ORIGIN, name: "My Canvas" } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ source_type: "canvas", name: "My Canvas", state: "AUTH_REQUIRED" });
    expect((await ada.send("post", "/api/sources/canvas", { body: { base_url: CANVAS_ORIGIN } })).status).toBe(409);
    const renamed = await ada.send("patch", `/api/sources/${created.body.id}`, { body: { name: "Canvas (school)", default_auth_method: "browser_session" } });
    expect(renamed.body.name).toBe("Canvas (school)");
    const website = await ada.send("post", "/api/sources", { body: { type: "website", base_url: "https://courses.example.edu/" } });
    expect(website.status).toBe(501);
    expect(website.body.code).toBe("SOURCE_TYPE_UNAVAILABLE");
    expect((await ada.send("get", "/api/settings/credential-storage")).body).toEqual({ mode: "server_encrypted" });
  });

  it("refuses an unsupported Canvas address and keeps the current one", async () => {
    const ada = await signUp();
    await connectCanvas(ada);
    const [canvas] = (await ada.send("get", "/api/sources")).body;
    const unknown = await ada.send("patch", `/api/sources/${canvas.id}`, { body: { base_url: "https://elsewhere.example.org" } });
    expect(unknown.status).toBe(422);
    expect((await ada.send("get", "/api/sources")).body[0].base_url).toBe(CANVAS_ORIGIN);
  });

  it("keeps each user's sources apart", async () => {
    const ada = await signUp();
    await connectCanvas(ada);
    const [canvas] = (await ada.send("get", "/api/sources")).body;
    const bob = await signUp({ username: "bob", email: "bob@example.com" });
    expect((await bob.send("get", "/api/sources")).body).toEqual([]);
    expect((await bob.send("patch", `/api/sources/${canvas.id}`, { body: { enabled: false } })).status).toBe(404);
    expect((await bob.send("get", "/api/auth/canvas/status")).body.configured).toBe(false);
  });
});
