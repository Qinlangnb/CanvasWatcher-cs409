// The NTLM credential of a course website: username in clear, password sealed per user and source.
// Replacements compare and swap on `generation`, so a verification that raced another save can't
// overwrite the newer credential.
import type { Db } from "../../db.js";
import type { Prisma, WebsiteCredential } from "../../generated/prisma/client.js";
import type { SecretBox } from "../../security/secretBox.js";
import type { NtlmCredential } from "../ntlm.js";

type Tx = Prisma.TransactionClient | Db;

export const websiteContext = (userId: string, connectionId: string) => `${userId}:website-ntlm:${connectionId}`;

/** The stored credential, or null when none is stored or it can no longer be opened. */
export function openWebsiteCredential(secrets: SecretBox, row: WebsiteCredential | null, userId: string): NtlmCredential | null {
  if (!row?.passwordCiphertext || row.userId !== userId) return null;
  try {
    return { username: row.username, password: secrets.open(row.passwordCiphertext, websiteContext(userId, row.connectionId)) };
  } catch {
    return null;
  }
}

export interface CredentialOutcome {
  /** VALID when a protected page accepted it; MISSING while only public pages were seen. */
  state: "VALID" | "MISSING";
  lastErrorCode: string | null;
}

/**
 * Stores `candidate` if the row is still at `expectedGeneration` (0 when there was none). Returns
 * false when another save got there first; the caller then keeps nothing.
 */
export async function replaceWebsiteCredential(
  tx: Tx,
  secrets: SecretBox,
  userId: string,
  connectionId: string,
  candidate: NtlmCredential,
  outcome: CredentialOutcome,
  expectedGeneration: number,
): Promise<boolean> {
  const fields = {
    username: candidate.username,
    passwordCiphertext: secrets.seal(candidate.password, websiteContext(userId, connectionId)),
    generation: expectedGeneration + 1,
    state: outcome.state,
    verifiedAt: outcome.state === "VALID" ? new Date() : null,
    failedAt: null,
    lastErrorCode: outcome.lastErrorCode,
  };
  if (expectedGeneration === 0) {
    const created = await tx.websiteCredential.createMany({ data: [{ connectionId, userId, ...fields }], skipDuplicates: true });
    if (created.count === 1) return true;
  }
  const updated = await tx.websiteCredential.updateMany({ where: { connectionId, userId, generation: expectedGeneration }, data: fields });
  return updated.count === 1;
}

/** Records what the latest use of the stored credential showed, without touching the password. */
export async function markWebsiteCredential(
  tx: Tx,
  userId: string,
  connectionId: string,
  state: "VALID" | "INVALID" | "MISSING",
  lastErrorCode: string | null,
): Promise<void> {
  await tx.websiteCredential.updateMany({
    where: { connectionId, userId },
    data: state === "VALID" ? { state, verifiedAt: new Date(), lastErrorCode: null } : { state, failedAt: new Date(), lastErrorCode },
  });
}

/** Forgets the password (sign-out); the username stays as a hint for the form. */
export async function clearWebsiteCredential(tx: Tx, userId: string, connectionId: string): Promise<void> {
  const row = await tx.websiteCredential.findUnique({ where: { connectionId } });
  if (!row || row.userId !== userId) return;
  await tx.websiteCredential.update({
    where: { connectionId },
    data: { passwordCiphertext: null, generation: row.generation + 1, state: "MISSING", failedAt: new Date(), lastErrorCode: "credential_cleared" },
  });
}

/**
 * The site rejected the stored password while syncing: it is dropped (so later syncs can't lock the
 * account) unless a newer password was saved meanwhile, which the generation check leaves alone.
 */
export async function rejectWebsiteCredential(tx: Tx, userId: string, connectionId: string, expectedGeneration: number): Promise<boolean> {
  const { count } = await tx.websiteCredential.updateMany({
    where: { connectionId, userId, generation: expectedGeneration },
    data: { passwordCiphertext: null, generation: expectedGeneration + 1, state: "INVALID", failedAt: new Date(), lastErrorCode: "auth_failed" },
  });
  return count === 1;
}
