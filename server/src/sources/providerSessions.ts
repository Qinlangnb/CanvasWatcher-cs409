import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { SecretBox } from "../security/secretBox.js";

// Gradescope / PrairieLearn cookie jars captured by the Auth Broker. Sealed per connection, so a jar
// cannot be moved to another user or connection; every change bumps the generation.

export const providerContext = (userId: string, connectionId: string) => `${userId}:provider-session:${connectionId}`;

type Tx = Prisma.TransactionClient | Db;

/** Stores a verified jar if the session is still at `expectedGeneration`. Returns false if it changed meanwhile. */
export async function storeProviderSession(
  tx: Tx,
  secrets: SecretBox,
  userId: string,
  connectionId: string,
  cookies: Map<string, string>,
  expectedGeneration: number,
): Promise<boolean> {
  const current = await tx.providerSession.findUnique({ where: { connectionId } });
  if (current && current.userId !== userId) return false;
  if ((current?.generation ?? 0) !== expectedGeneration) return false;
  const fields = {
    cookieCiphertext: secrets.seal(JSON.stringify(Object.fromEntries(cookies)), providerContext(userId, connectionId)),
    generation: expectedGeneration + 1,
    state: "VALID" as const,
    verifiedAt: new Date(),
    failedAt: null,
    failureReason: null,
  };
  await tx.providerSession.upsert({ where: { connectionId }, create: { connectionId, userId, ...fields }, update: fields });
  await tx.sourceConnection.updateMany({ where: { id: connectionId, userId }, data: { state: "READY" } });
  return true;
}

/** Empties a session (sign-out or a failed check). With `expectedGeneration`, only that exact jar. */
export async function clearProviderSession(
  tx: Tx,
  userId: string,
  connectionId: string,
  options: { expectedGeneration?: number; state?: "MISSING" | "INVALID" | "EXPIRED"; reason?: string } = {},
): Promise<boolean> {
  const current = await tx.providerSession.findUnique({ where: { connectionId } });
  if (!current || current.userId !== userId) return false;
  if (options.expectedGeneration !== undefined && current.generation !== options.expectedGeneration) return false;
  await tx.providerSession.update({
    where: { connectionId },
    data: {
      cookieCiphertext: null,
      generation: current.generation + 1,
      state: options.state ?? "MISSING",
      failedAt: new Date(),
      failureReason: options.reason ?? "CLEARED",
    },
  });
  await tx.sourceConnection.updateMany({ where: { id: connectionId, userId }, data: { state: "AUTH_REQUIRED" } });
  return true;
}

/** The jar for a sync, or null when there is none or it can no longer be opened. */
export async function openProviderSession(db: Db, secrets: SecretBox, userId: string, connectionId: string): Promise<Map<string, string> | null> {
  const row = await db.providerSession.findUnique({ where: { connectionId } });
  if (!row?.cookieCiphertext || row.userId !== userId) return null;
  try {
    return new Map(Object.entries(JSON.parse(secrets.open(row.cookieCiphertext, providerContext(userId, connectionId))) as Record<string, string>));
  } catch {
    return null;
  }
}
