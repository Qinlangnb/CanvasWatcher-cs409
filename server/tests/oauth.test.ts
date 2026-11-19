import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/services.js";
import { CANVAS_ORIGIN, fakeCanvas, seedCourse } from "./fakeCanvas.js";
import { Browser, config as baseConfig, db, logger, resetDatabase, signUp } from "./helpers.js";

const REDIRECT = "http://127.0.0.1:8000/api/auth/canvas/oauth/callback";
const oauthConfig = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: baseConfig.databaseUrl,
  SESSION_SECRET: baseConfig.sessionSecret,
  CREDENTIALS_KEY: baseConfig.credentialsKey.toString("base64"),
  ALLOWED_ORIGINS: baseConfig.allowedOrigins.join(","),
  CANVAS_ALLOWED_HOSTS: new URL(CANVAS_ORIGIN).hostname,
  SYNC_INTERVAL_MINUTES: "0",
  LOG_LEVEL: "silent",
  CANVAS_OAUTH_CLIENT_ID: "client-1",
  CANVAS_OAUTH_CLIENT_SECRET: "fixture-client-secret",
  CANVAS_OAUTH_REDIRECT_URI: REDIRECT,
});
const services = createServices({ config: oauthConfig, db, logger, canvas: fakeCanvas.factory, oauthFetch: fakeCanvas.fetch });
const app = createApp({ config: oauthConfig, db, logger, services });
const BROKER = { "X-AW-Broker": "1" };

beforeEach(async () => {
  await services.sync.whenIdle();
  await resetDatabase();
  fakeCanvas.reset();
});
afterAll(() => db.$disconnect());

async function start(browser: Browser): Promise<string> {
  const res = await browser.send("post", "/api/auth/canvas/oauth/start", { headers: BROKER });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const url = new URL(res.body.authorization_url);
  expect(url.origin + url.pathname).toBe(`${CANVAS_ORIGIN}/login/oauth2/auth`);
  expect(url.searchParams.get("client_id")).toBe("client-1");
  expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
  return url.searchParams.get("state") as string;
}

const callback = (query: string) => request(app).get(`/api/auth/canvas/oauth/callback?${query}`).set("Host", "127.0.0.1:8000");

describe("Canvas OAuth", () => {
  it("is off unless configured, and only accepts our own callback addresses", async () => {
    const ada = await signUp();
    expect((await ada.send("get", "/api/auth/canvas/oauth/capability")).body).toEqual({ configured: false, reason: "CANVAS_OAUTH_NOT_CONFIGURED" });
    const bad = loadConfig({ ...process.env, DATABASE_URL: "x", SESSION_SECRET: baseConfig.sessionSecret, CREDENTIALS_KEY: baseConfig.credentialsKey.toString("base64"), CANVAS_OAUTH_CLIENT_ID: "a", CANVAS_OAUTH_CLIENT_SECRET: "b", CANVAS_OAUTH_REDIRECT_URI: "https://evil.example.com/callback?x=1" });
    expect(bad.canvasOAuth).toBeNull();
  });

  it("authorizes, stores the OAuth slot and prefers it", async () => {
    seedCourse(fakeCanvas);
    const ada = new Browser(app);
    await ada.send("post", "/api/users", { body: { username: "ada", email: "ada@example.com", password: "test-password-123" } });
    await ada.send("put", "/api/canvas/connection", { body: { base_url: CANVAS_ORIGIN, access_token: fakeCanvas.token } });
    await services.sync.whenIdle();
    expect((await ada.send("get", "/api/auth/canvas/oauth/capability")).body.configured).toBe(true);
    expect((await ada.send("post", "/api/auth/canvas/oauth/start")).status).toBe(403);
    const state = await start(ada);
    fakeCanvas.oauthCodes.set("code-1", fakeCanvas.user);
    const res = await callback(`state=${state}&code=code-1`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.text).toContain("Canvas connected");
    await services.sync.whenIdle();
    const status = (await ada.send("get", "/api/auth/canvas/status")).body;
    expect(status).toMatchObject({ effective_method: "oauth", backup_ready: true });
    expect(status.credentials.oauth).toMatchObject({ present: true, state: "VALID" });
    // The state works once.
    fakeCanvas.oauthCodes.set("code-2", fakeCanvas.user);
    expect((await callback(`state=${state}&code=code-2`)).status).toBe(400);
  });

  it("refuses unknown or expired states, other hosts, and another account", async () => {
    const ada = new Browser(app);
    await ada.send("post", "/api/users", { body: { username: "ada", email: "ada@example.com", password: "test-password-123" } });
    await ada.send("put", "/api/canvas/connection", { body: { base_url: CANVAS_ORIGIN, access_token: fakeCanvas.token } });
    await services.sync.whenIdle();
    fakeCanvas.oauthCodes.set("code-1", fakeCanvas.user);
    expect((await callback("state=unknown&code=code-1")).status).toBe(400);
    let state = await start(ada);
    await db.canvasOAuthState.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await callback(`state=${state}&code=code-1`)).status).toBe(400);
    state = await start(ada);
    expect((await request(app).get(`/api/auth/canvas/oauth/callback?state=${state}&code=code-1`).set("Host", "elsewhere.example.com")).status).toBe(400);
    state = await start(ada);
    fakeCanvas.oauthCodes.set("code-other", { id: 7, name: "Someone Else" });
    expect((await callback(`state=${state}&code=code-other`)).status).toBe(400);
    expect((await ada.send("get", "/api/auth/canvas/status")).body.credentials.oauth.present).toBe(false);
  });

  it("refreshes an access token about to expire, and drops the slot when the grant is revoked", async () => {
    seedCourse(fakeCanvas);
    const ada = new Browser(app);
    await ada.send("post", "/api/users", { body: { username: "ada", email: "ada@example.com", password: "test-password-123" } });
    await ada.send("put", "/api/canvas/connection", { body: { base_url: CANVAS_ORIGIN, access_token: fakeCanvas.token } });
    await services.sync.whenIdle();
    const state = await start(ada);
    fakeCanvas.oauthCodes.set("code-1", fakeCanvas.user);
    await callback(`state=${state}&code=code-1`);
    await services.sync.whenIdle();

    await db.canvasCredential.updateMany({ where: { method: "OAUTH" }, data: { expiresAt: new Date(Date.now() + 5_000) } });
    expect((await ada.send("post", "/api/sync")).status).toBe(202);
    await services.sync.whenIdle();
    expect(fakeCanvas.oauthIssued).toBe(2);
    const refreshed = await db.canvasCredential.findFirstOrThrow({ where: { method: "OAUTH" } });
    expect(refreshed.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3_000_000);

    fakeCanvas.oauthRefresh.clear();
    await db.canvasCredential.updateMany({ where: { method: "OAUTH" }, data: { expiresAt: new Date(Date.now() + 5_000) } });
    await ada.send("post", "/api/sync");
    await services.sync.whenIdle();
    const status = (await ada.send("get", "/api/auth/canvas/status")).body;
    expect(status.credentials.oauth).toMatchObject({ present: false, state: "EXPIRED", last_failure_reason: "OAUTH_REVOKED" });
    expect(status.effective_method).toBe("pat");
  });
});
