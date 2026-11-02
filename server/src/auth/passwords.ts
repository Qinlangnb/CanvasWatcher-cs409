import { hash, verify } from "@node-rs/argon2";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

// Argon2id (the library default) with OWASP's minimum recommended cost.
// Hashing runs on libuv's thread pool, not on the event loop.
const COST = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, COST);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let timingHash: Promise<string> | undefined;

/** Spends the same time as a real check, so unknown usernames are not revealed by response time. */
export async function rejectAfterVerifyDelay(password: string): Promise<false> {
  timingHash ??= hashPassword("timing-equaliser-not-a-real-password");
  await verifyPassword(await timingHash, password);
  return false;
}
