import { createHash } from "node:crypto";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  Browser,
  NEW_PASSWORD,
  ORIGIN,
  PASSWORD,
  app,
  cookieLine,
  db,
  resetDatabase,
  setCookieLines,
  signUp,
} from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

describe("GET /api/health", () => {
  it("reports a reachable database", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("unknown API paths", () => {
  it("answer with a JSON 404", async () => {
    const res = await request(app).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: "This address does not exist.", code: "NOT_FOUND" });
  });
});

describe("POST /api/users (sign up)", () => {
  it("creates the account and signs the browser in", async () => {
    const browser = new Browser();
    const res = await browser.send("post", "/api/users", {
      body: { username: "Ada", email: " Ada@Example.com ", password: PASSWORD },
    });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe("/api/users/me");
    expect(res.body).toEqual({
      id: expect.any(String),
      username: "Ada",
      email: "ada@example.com",
      created_at: expect.any(String),
    });
    expect(cookieLine(res, "aw_session")).toMatch(/HttpOnly/i);
    expect(cookieLine(res, "aw_session")).toMatch(/SameSite=Lax/i);
    // The frontend reads this one to fill in the CSRF header.
    expect(cookieLine(res, "aw_csrf")).not.toMatch(/HttpOnly/i);

    const me = await browser.send("get", "/api/users/me");
    expect(me.status).toBe(200);
    expect(me.body).toEqual(res.body);
  });

  it("stores only hashes of the password and the session token", async () => {
    const browser = await signUp();
    const user = await db.user.findUniqueOrThrow({ where: { usernameKey: "ada" }, include: { sessions: true } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(PASSWORD);
    const token = browser.cookies.get("aw_session") ?? "";
    expect(user.sessions.map((session) => session.tokenHash)).toEqual([
      createHash("sha256").update(token).digest("hex"),
    ]);
  });

  it("rejects a username or email that is already registered, ignoring case", async () => {
    await signUp();
    const sameName = await new Browser().send("post", "/api/users", {
      body: { username: "ADA", email: "other@example.com", password: PASSWORD },
    });
    expect(sameName.status).toBe(409);
    expect(sameName.body.code).toBe("ACCOUNT_EXISTS");
    const sameEmail = await new Browser().send("post", "/api/users", {
      body: { username: "grace", email: "ADA@example.com", password: PASSWORD },
    });
    expect(sameEmail.status).toBe(409);
    expect(await db.user.count()).toBe(1);
  });

  it("explains each invalid field", async () => {
    const res = await new Browser().send("post", "/api/users", {
      body: { username: "a b", email: "not-an-email", password: "short" },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    const fields = (res.body.detail as { loc: string[]; msg: string }[]).map((item) => item.loc.join("."));
    expect(fields).toEqual(expect.arrayContaining(["body.username", "body.email", "body.password"]));
  });

  it("rejects a body that is not JSON", async () => {
    const res = await request(app)
      .post("/api/users")
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send("{");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_JSON");
  });
});

describe("GET /api/users/me", () => {
  it("requires a signed-in browser", async () => {
    const res = await request(app).get("/api/users/me");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ detail: "Please sign in to continue.", code: "AUTH_REQUIRED" });
  });

  it("treats an expired session as signed out", async () => {
    const browser = await signUp();
    await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await browser.send("get", "/api/users/me")).status).toBe(401);
  });
});

describe("POST /api/sessions (sign in)", () => {
  it("accepts the username in any case or the email address", async () => {
    await signUp();
    for (const username of ["ada", "ADA", "Ada@Example.com"]) {
      const browser = new Browser();
      const res = await browser.signIn(username);
      expect(res.status).toBe(201);
      expect(res.body.username).toBe("ada");
      expect((await browser.send("get", "/api/users/me")).status).toBe(200);
    }
  });

  it("gives the same answer for a wrong password and an unknown account", async () => {
    await signUp();
    const wrong = await new Browser().signIn("ada", "wrong-password-1");
    const unknown = await new Browser().signIn("nobody", "wrong-password-1");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual({ detail: "Incorrect username or password.", code: "INVALID_CREDENTIALS" });
    expect(unknown.body).toEqual(wrong.body);
    expect(setCookieLines(wrong)).toEqual([]);
  });

  it("blocks an account on this network after 10 failed attempts, even with the right password", async () => {
    await signUp();
    const browser = new Browser();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await browser.signIn("ada", "wrong-password-1")).status).toBe(401);
    }
    const blocked = await browser.signIn();
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("TOO_MANY_ATTEMPTS");
    expect(blocked.headers["retry-after"]).toBe("900");
  });

  it("starts counting failures again after a successful sign-in", async () => {
    await signUp();
    for (let round = 0; round < 2; round += 1) {
      for (let attempt = 0; attempt < 9; attempt += 1) {
        expect((await new Browser().signIn("ada", "wrong-password-1")).status).toBe(401);
      }
      expect((await new Browser().signIn()).status).toBe(201);
    }
  });
});

describe("DELETE /api/sessions/current (sign out)", () => {
  it("ends only this browser's session", async () => {
    const laptop = await signUp();
    const phone = new Browser();
    await phone.signIn();
    const oldToken = laptop.cookies.get("aw_session");

    const res = await laptop.send("delete", "/api/sessions/current");
    expect(res.status).toBe(204);
    expect(laptop.cookies.size).toBe(0);
    // Replaying the old cookie no longer works.
    const replay = await request(app).get("/api/users/me").set("Cookie", `aw_session=${oldToken}`);
    expect(replay.status).toBe(401);
    expect((await phone.send("get", "/api/users/me")).status).toBe(200);
  });

  it("requires a signed-in browser", async () => {
    const res = await new Browser().send("delete", "/api/sessions/current");
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/users/me/password", () => {
  it("rejects a wrong current password", async () => {
    const browser = await signUp();
    const res = await browser.send("put", "/api/users/me/password", {
      body: { current_password: "wrong-password-1", new_password: NEW_PASSWORD },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("WRONG_PASSWORD");
  });

  it("changes the password and signs out every other browser", async () => {
    const laptop = await signUp();
    const phone = new Browser();
    await phone.signIn();
    const oldToken = laptop.cookies.get("aw_session");

    const res = await laptop.send("put", "/api/users/me/password", {
      body: { current_password: PASSWORD, new_password: NEW_PASSWORD },
    });
    expect(res.status).toBe(204);
    expect(laptop.cookies.get("aw_session")).not.toBe(oldToken);
    expect((await laptop.send("get", "/api/users/me")).status).toBe(200);
    expect((await phone.send("get", "/api/users/me")).status).toBe(401);
    expect((await new Browser().signIn("ada", PASSWORD)).status).toBe(401);
    expect((await new Browser().signIn("ada", NEW_PASSWORD)).status).toBe(201);
  });
});

describe("cross-site request protection", () => {
  const body = { username: "ada", email: "ada@example.com", password: PASSWORD };

  it("rejects state-changing requests without an allowed Origin", async () => {
    const missing = await new Browser().send("post", "/api/users", { body, origin: null });
    const foreign = await new Browser().send("post", "/api/users", { body, origin: "https://evil.example" });
    expect(missing.status).toBe(403);
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("INVALID_ORIGIN");
    expect(await db.user.count()).toBe(0);
  });

  it("falls back to the Referer when the browser sends no Origin", async () => {
    const res = await request(app).post("/api/users").set("Referer", `${ORIGIN}/signup`).send(body);
    expect(res.status).toBe(201);
  });

  it("requires the CSRF header from a signed-in browser", async () => {
    const browser = await signUp();
    const res = await browser.send("delete", "/api/sessions/current", { csrf: false });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CSRF_REQUIRED");
    expect((await browser.send("get", "/api/users/me")).status).toBe(200);
  });
});
