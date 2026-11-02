import type { Db } from "../db.js";
import { HttpError } from "../http/errors.js";
import { digest } from "./tokens.js";

export interface ThrottleRule {
  key: string;
  limit: number;
  windowMs: number;
}

/** Counts one attempt against the rule; returns false once the window's limit is exceeded. */
export async function countAttempt(db: Db, rule: ThrottleRule, now = new Date()): Promise<boolean> {
  const windowOpenedBefore = new Date(now.getTime() - rule.windowMs);
  // One atomic upsert, so concurrent attempts cannot both read a stale count.
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO login_attempts (key_hash, window_start, count)
    VALUES (${digest(rule.key)}, ${now}, 1)
    ON CONFLICT (key_hash) DO UPDATE SET
      count = CASE WHEN login_attempts.window_start <= ${windowOpenedBefore}
                   THEN 1 ELSE login_attempts.count + 1 END,
      window_start = CASE WHEN login_attempts.window_start <= ${windowOpenedBefore}
                          THEN ${now} ELSE login_attempts.window_start END
    RETURNING count`;
  return (rows[0]?.count ?? 1) <= rule.limit;
}

export async function clearAttempts(db: Db, key: string): Promise<void> {
  await db.loginAttempt.deleteMany({ where: { keyHash: digest(key) } });
}

/** Counts every rule (so each window keeps advancing) and rejects if any is over its limit. */
export async function enforce(db: Db, rules: ThrottleRule[], message: string): Promise<void> {
  const results = await Promise.all(rules.map((rule) => countAttempt(db, rule)));
  if (results.includes(false)) {
    const retryAfter = Math.ceil(Math.max(...rules.map((rule) => rule.windowMs)) / 1000);
    throw new HttpError(429, "TOO_MANY_ATTEMPTS", message, { "Retry-After": String(retryAfter) });
  }
}
