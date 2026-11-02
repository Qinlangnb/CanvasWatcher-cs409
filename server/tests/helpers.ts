import { pino } from "pino";
import request, { type Response } from "supertest";
import { expect } from "vitest";
import { createApp } from "../src/app.js";
import { CSRF_COOKIE, CSRF_HEADER } from "../src/auth/sessions.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db.js";
import { testDatabaseUrl } from "./database.js";

export const ORIGIN = "http://localhost:5173";
/** Fixture passwords for the throwaway test database. */
export const PASSWORD = "test-password-123";
export const NEW_PASSWORD = "test-password-456";

export const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: testDatabaseUrl(),
  SESSION_SECRET: "test-session-secret-0123456789abcdef",
  ALLOWED_ORIGINS: ORIGIN,
  LOG_LEVEL: "silent",
});
export const db = createDb(config.databaseUrl);
export const app = createApp({ config, db, logger: pino({ level: "silent" }) });

export async function resetDatabase(): Promise<void> {
  await db.$executeRaw`TRUNCATE users, sessions, login_attempts CASCADE`;
}

export function setCookieLines(res: Response): string[] {
  const header: unknown = res.headers["set-cookie"];
  if (Array.isArray(header)) return header.map(String);
  return typeof header === "string" ? [header] : [];
}

/** The Set-Cookie line for one cookie, so tests can check its attributes. */
export function cookieLine(res: Response, name: string): string {
  return setCookieLines(res).find((line) => line.startsWith(`${name}=`)) ?? "";
}

type Method = "get" | "post" | "put" | "delete";

interface SendOptions {
  body?: object;
  /** Defaults to the allowed origin; `null` sends no Origin header. */
  origin?: string | null;
  /** Set to false to leave out the CSRF header the frontend normally sends. */
  csrf?: boolean;
}

/** Keeps cookies between requests and sends Origin and CSRF headers like the frontend's `api()`. */
export class Browser {
  readonly cookies = new Map<string, string>();

  async send(method: Method, path: string, options: SendOptions = {}): Promise<Response> {
    const req = request(app)[method](path);
    const origin = options.origin === undefined ? ORIGIN : options.origin;
    if (origin) req.set("Origin", origin);
    if (this.cookies.size > 0) {
      req.set("Cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    const csrf = this.cookies.get(CSRF_COOKIE);
    if (csrf && options.csrf !== false) req.set(CSRF_HEADER, csrf);
    const res = options.body === undefined ? await req : await req.send(options.body);
    for (const line of setCookieLines(res)) {
      const pair = line.split(";", 1)[0] ?? "";
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (!value || /expires=Thu, 01 Jan 1970/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  signIn(username = "ada", password = PASSWORD): Promise<Response> {
    return this.send("post", "/api/sessions", { body: { username, password } });
  }
}

/** Registers `ada` and returns the browser that is now signed in. */
export async function signUp(fields: Record<string, string> = {}): Promise<Browser> {
  const browser = new Browser();
  const res = await browser.send("post", "/api/users", {
    body: { username: "ada", email: "ada@example.com", password: PASSWORD, ...fields },
  });
  expect(res.status).toBe(201);
  return browser;
}
