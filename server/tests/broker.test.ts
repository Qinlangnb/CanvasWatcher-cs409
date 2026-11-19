import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSourceAdapter, unregisterSourceAdapter } from "../src/sources/registry.js";
import { CANVAS_ORIGIN, CANVAS_SESSION, fakeCanvas, seedCourse } from "./fakeCanvas.js";
import { app, connectCanvas, db, resetDatabase, services, signUp, type Browser } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
  fakeCanvas.reset();
});
afterEach(() => unregisterSourceAdapter("GRADESCOPE"));
afterAll(() => db.$disconnect());

const BROKER = { "X-AW-Broker": "1" };

interface Ticket {
  challenge_id: string;
  instance_id: string;
  provider: string;
  one_time_token: string;
  control_token: string;
}

/** What the desktop broker sends: no Origin, no cookies, X-AW-Broker: 1. */
function broker(path: string, body: object, headers: Record<string, string> = BROKER) {
  return request(app).post(`/api/auth/broker/${path}`).set(headers).send(body);
}

const ident = (ticket: Ticket) => ({ challenge_id: ticket.challenge_id, instance_id: ticket.instance_id, provider: ticket.provider });

async function challenge(browser: Browser, body: object = { provider: "canvas" }): Promise<Ticket> {
  const res = await browser.send("post", "/api/auth/broker/challenges", { body, headers: BROKER });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function claimed(browser: Browser, body?: object) {
  const ticket = await challenge(browser, body);
  const claim = await broker("claim", { ...ident(ticket), one_time_token: ticket.one_time_token });
  expect(claim.status).toBe(200);
  return { ticket, exchange: claim.body.exchange_token as string, claim: claim.body };
}

const pageStatus = async (browser: Browser, ticket: Ticket) =>
  (await browser.send("post", "/api/auth/broker/status", { body: { ...ident(ticket), control_token: ticket.control_token }, headers: BROKER })).body;

describe("Auth Broker", () => {
  it("tells the page where the broker is", async () => {
    const ada = await signUp();
    expect((await ada.send("get", "/api/auth/broker/configuration")).body).toEqual({ broker_url: "http://127.0.0.1:8765", protocol_version: 1 });
  });

  it("page calls need the broker header; broker calls refuse anything a browser sends", async () => {
    const ada = await signUp();
    await connectCanvas(ada);
    expect((await ada.send("post", "/api/auth/broker/challenges", { body: { provider: "canvas" } })).status).toBe(403);
    const ticket = await challenge(ada);
    const body = { ...ident(ticket), one_time_token: ticket.one_time_token };
    for (const headers of [{}, { ...BROKER, Origin: "http://localhost:5173" }, { ...BROKER, "Sec-Fetch-Site": "same-origin" }]) {
      const res = await broker("claim", body, headers);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("AUTH_BROKER_ONLY");
    }
    const invalid = await broker("claim", { ...body, extra: 1 });
    expect(invalid.status).toBe(422);
    expect(invalid.body).toEqual({ detail: "AUTH_REQUEST_INVALID", code: "AUTH_REQUEST_INVALID" });
    expect((await broker("claim", body)).status).toBe(200);
  });

  it("claims once, with the right ticket only, and completes a Canvas sign-in", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    const ticket = await challenge(ada);
    expect(ticket).toMatchObject({ provider: "canvas", expires_in: 240, protocol_version: 1 });
    expect(await db.authChallenge.findFirst({ where: { ticketHash: ticket.one_time_token } })).toBeNull();
    expect((await broker("claim", { ...ident(ticket), one_time_token: "wrong" })).status).toBe(409);
    const claim = await broker("claim", { ...ident(ticket), one_time_token: ticket.one_time_token });
    expect(claim.body).toMatchObject({ protocol_version: 1, provider: "canvas", base_url: CANVAS_ORIGIN, operation: "login", generation: 0 });
    expect(claim.body.credential_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(claim.body.expires_in).toBeGreaterThan(200);
    expect((await broker("claim", { ...ident(ticket), one_time_token: ticket.one_time_token })).status).toBe(409);
    expect((await pageStatus(ada, ticket)).state).toBe("LOGIN_OPENED");

    const done = await broker("complete", { ...ident(ticket), exchange_token: claim.body.exchange_token, cookies: { canvas_session: CANVAS_SESSION } });
    expect(done.body).toEqual({ state: "AUTHENTICATED" });
    await services.sync.whenIdle();
    expect(await pageStatus(ada, ticket)).toMatchObject({ state: "AUTHENTICATED", provider: "canvas" });
    const status = (await ada.send("get", "/api/auth/canvas/status")).body;
    expect(status.credentials.browser_session).toMatchObject({ present: true, state: "VALID", generation: 1 });
    // The exchange token worked once.
    expect((await broker("complete", { ...ident(ticket), exchange_token: claim.body.exchange_token, cookies: {} })).status).toBe(409);
  });

  it("signs in a new user's Canvas with the browser alone", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await ada.send("post", "/api/sources/canvas", { body: { base_url: CANVAS_ORIGIN } });
    const { ticket, exchange } = await claimed(ada);
    await broker("complete", { ...ident(ticket), exchange_token: exchange, cookies: { canvas_session: CANVAS_SESSION } });
    await services.sync.whenIdle();
    expect((await ada.send("get", "/api/canvas/connection")).body).toMatchObject({ status: "ok", canvas_user_name: "Ada Lovelace" });
    expect((await ada.send("get", "/api/courses")).body).toHaveLength(1);
  });

  it("refuses cookies for another account and keeps the current sign-in", async () => {
    const ada = await signUp();
    await connectCanvas(ada);
    fakeCanvas.sessionUser = { id: 7, name: "Someone Else" };
    const { ticket, exchange } = await claimed(ada);
    const res = await broker("complete", { ...ident(ticket), exchange_token: exchange, cookies: { canvas_session: CANVAS_SESSION } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CANVAS_ACCOUNT_MISMATCH");
    expect(await pageStatus(ada, ticket)).toMatchObject({ state: "FAILED", reason: "CANVAS_ACCOUNT_MISMATCH" });
    expect((await ada.send("get", "/api/auth/canvas/status")).body.credentials.browser_session.present).toBe(false);
  });

  it("rejects cookies Canvas does not accept, and malformed cookies", async () => {
    const ada = await signUp();
    await connectCanvas(ada);
    let { ticket, exchange } = await claimed(ada);
    let res = await broker("complete", { ...ident(ticket), exchange_token: exchange, cookies: { canvas_session: "wrong" } });
    expect(res.body.code).toBe("AUTH_LOGIN_FAILED");
    ({ ticket, exchange } = await claimed(ada));
    res = await broker("complete", { ...ident(ticket), exchange_token: exchange, cookies: { "bad;name": "x" } });
    expect(res.body.code).toBe("AUTH_LOGIN_FAILED");
    expect((await pageStatus(ada, ticket)).state).toBe("FAILED");
  });

  it("expires after 240 seconds", async () => {
    const ada = await signUp();
    await connectCanvas(ada);
    const ticket = await challenge(ada);
    await db.authChallenge.updateMany({ data: { deadline: new Date(Date.now() - 1000) } });
    const res = await broker("claim", { ...ident(ticket), one_time_token: ticket.one_time_token });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AUTH_CHALLENGE_EXPIRED");
    expect(await pageStatus(ada, ticket)).toMatchObject({ state: "TIMED_OUT", reason: "AUTH_CHALLENGE_EXPIRED" });
  });

  it("cancel stops the sign-in, and a newer challenge supersedes a pending one", async () => {
    const ada = await signUp();
    await connectCanvas(ada);
    const { ticket, exchange } = await claimed(ada);
    const cancel = await ada.send("post", "/api/auth/broker/cancel", { body: { ...ident(ticket), control_token: ticket.control_token }, headers: BROKER });
    expect(cancel.body).toMatchObject({ state: "CANCELLED", reason: "AUTH_USER_CANCELLED" });
    expect((await broker("complete", { ...ident(ticket), exchange_token: exchange, cookies: { canvas_session: CANVAS_SESSION } })).status).toBe(409);

    const first = await challenge(ada);
    await challenge(ada);
    expect(await pageStatus(ada, first)).toMatchObject({ state: "CANCELLED", reason: "AUTH_SUPERSEDED" });
  });

  it("the broker reports failures with its exchange token", async () => {
    const ada = await signUp();
    await connectCanvas(ada);
    const { ticket, exchange } = await claimed(ada);
    expect((await broker("failed", { ...ident(ticket), exchange_token: exchange, reason: "AUTH_LOGIN_TIMEOUT" })).body).toEqual({ state: "FAILED", reason: "AUTH_LOGIN_TIMEOUT" });
    expect(await pageStatus(ada, ticket)).toMatchObject({ state: "FAILED", reason: "AUTH_LOGIN_TIMEOUT" });
  });

  it("keeps users apart: only the creator can poll or cancel", async () => {
    const ada = await signUp();
    await connectCanvas(ada);
    const ticket = await challenge(ada);
    const bob = await signUp({ username: "bob", email: "bob@example.com" });
    const res = await bob.send("post", "/api/auth/broker/status", { body: { ...ident(ticket), control_token: ticket.control_token }, headers: BROKER });
    expect(res.status).toBe(409);
    expect((await bob.send("post", "/api/auth/broker/challenges", { body: { provider: "canvas" }, headers: BROKER })).status).toBe(404);
  });

  it("clears the browser session (one, or all) and leaves the PAT", async () => {
    const ada = await signUp();
    await connectCanvas(ada);
    let { ticket, exchange } = await claimed(ada);
    await broker("complete", { ...ident(ticket), exchange_token: exchange, cookies: { canvas_session: CANVAS_SESSION } });
    await services.sync.whenIdle();
    ({ ticket, exchange } = await claimed(ada, { provider: "canvas", operation: "clear" }));
    expect((await broker("complete", { ...ident(ticket), exchange_token: exchange })).body).toEqual({ state: "AUTHENTICATED" });
    let status = (await ada.send("get", "/api/auth/canvas/status")).body;
    expect(status.credentials.browser_session).toMatchObject({ present: false, generation: 2 });
    expect(status.credentials.pat.present).toBe(true);

    expect((await ada.send("post", "/api/auth/broker/challenges", { body: { provider: "canvas", operation: "clear_all" }, headers: BROKER })).status).toBe(422);
    ({ ticket, exchange } = await claimed(ada, { provider: "all", operation: "clear_all" }));
    expect((await broker("complete", { ...ident(ticket), exchange_token: exchange })).body).toEqual({ state: "AUTHENTICATED" });
    status = (await ada.send("get", "/api/auth/canvas/status")).body;
    expect(status.connection_state).toBe("ACTIVE");
  });

  it("provider sign-ins go through the registered verifier and are rejected without one", async () => {
    // The built-in Gradescope module is taken out, so this test supplies its own verifier.
    unregisterSourceAdapter("GRADESCOPE");
    const ada = await signUp();
    const user = await db.user.findFirstOrThrow();
    const source = await db.sourceConnection.create({
      data: { userId: user.id, type: "GRADESCOPE", name: "Gradescope", baseUrl: "https://gradescope.example.com", state: "AUTH_REQUIRED" },
    });
    let { ticket, exchange, claim } = await claimed(ada, { provider: "gradescope", credential_id: source.id });
    expect(claim).toMatchObject({ provider: "gradescope", base_url: "https://gradescope.example.com", credential_id: source.id });
    let res = await broker("complete", { ...ident(ticket), exchange_token: exchange, cookies: { signed_token: "x" } });
    expect(res.body.code).toBe("AUTH_LOGIN_FAILED");

    registerSourceAdapter({
      type: "GRADESCOPE",
      normalizeBaseUrl: (input) => input,
      verifySession: async (_base, cookies) => ({ ok: cookies.get("signed_token") === "good" }),
    });
    ({ ticket, exchange } = await claimed(ada, { provider: "gradescope", credential_id: source.id }));
    res = await broker("complete", { ...ident(ticket), exchange_token: exchange, cookies: { signed_token: "good" } });
    expect(res.body).toEqual({ state: "AUTHENTICATED" });
    const row = await db.providerSession.findUniqueOrThrow({ where: { connectionId: source.id } });
    expect(row).toMatchObject({ state: "VALID", generation: 1 });
    expect(row.cookieCiphertext).not.toContain("good");
    const [listed] = (await ada.send("get", "/api/sources")).body;
    expect(listed).toMatchObject({ source_type: "gradescope", state: "READY", supported: true, session: { present: true, state: "VALID" } });
  });
});
