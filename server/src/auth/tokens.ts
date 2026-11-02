import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** CSRF token bound to one session: readable by the page, useless without the session cookie. */
export function csrfToken(secret: string, sessionToken: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionToken}`).digest("base64url");
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
