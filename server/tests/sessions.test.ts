import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createSession, findSession } from "../src/auth/sessions.js";
import { db, resetDatabase } from "./helpers.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const start = new Date("2026-01-05T12:00:00Z");
const at = (offset: number) => new Date(start.getTime() + offset);

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

async function issue() {
  const user = await db.user.create({
    data: { username: "ada", usernameKey: "ada", email: "ada@example.com", passwordHash: "unused" },
  });
  return (await createSession(db, user.id, start)).token;
}

describe("session lifetime", () => {
  it("expires after 7 idle days", async () => {
    const token = await issue();
    expect(await findSession(db, token, at(7 * DAY))).toBeNull();
  });

  it("slides the idle expiry forward while the session is used", async () => {
    const token = await issue();
    const session = await findSession(db, token, at(6 * DAY));
    expect(session?.expiresAt).toEqual(at(13 * DAY));
    expect(await findSession(db, token, at(12 * DAY))).not.toBeNull();
  });

  it("never lasts more than 30 days, however often it is used", async () => {
    const token = await issue();
    for (const day of [6, 12, 18, 24]) {
      expect(await findSession(db, token, at(day * DAY))).not.toBeNull();
    }
    const last = await findSession(db, token, at(29 * DAY));
    expect(last?.expiresAt).toEqual(at(30 * DAY));
    expect(await findSession(db, token, at(30 * DAY))).toBeNull();
  });

  it("does not write to the database on every request", async () => {
    const token = await issue();
    await findSession(db, token, at(5 * MINUTE));
    const stored = await db.session.findFirstOrThrow();
    expect(stored.lastSeenAt).toEqual(start);
  });
});
