// Which AI provider serves a user: their own connection from Settings > AI API once it has passed its
// test, otherwise the server-wide key ("Server default"), otherwise none. Chat, summaries, estimates and
// any other AI feature go through aiProviderFor, so they all follow the same choice.
import type { Db } from "../db.js";
import type { AiConnection } from "../generated/prisma/client.js";
import type { Services } from "../services.js";
import { buildProvider } from "./connection.js";
import { SERVER_DEFAULT, findPreset, requiresKey } from "./presets.js";
import type { AiProvider } from "./provider.js";

/** SecretBox context of a user's AI key: bound to the user and to this purpose. */
export const aiKeyContext = (userId: string) => `${userId}:ai-api-key`;

/** True when the row's current provider, model and key passed a test (the generation matches). */
export const isVerified = (row: Pick<AiConnection, "generation" | "verifiedGeneration">) => row.verifiedGeneration === row.generation;

/** The opened key, or null when the row has none or it can't be opened (key rotated, row tampered with). */
export function openAiKey(services: Services, row: Pick<AiConnection, "userId" | "keyCiphertext">): string | null {
  if (!row.keyCiphertext) return null;
  try {
    return services.secrets.open(row.keyCiphertext, aiKeyContext(row.userId));
  } catch {
    return null;
  }
}

/** The user's own provider when it is complete and verified; null otherwise. */
export function ownProvider(services: Services, row: AiConnection | null): AiProvider | null {
  if (!row || row.provider === SERVER_DEFAULT || !row.modelId || !isVerified(row)) return null;
  const preset = findPreset(row.provider, services.aiOptions.allowLocal);
  if (!preset) return null;
  const key = requiresKey(preset) ? openAiKey(services, row) : null;
  if (requiresKey(preset) && !key) return null;
  return buildProvider(preset, key, row.modelId, services.aiOptions.fetch);
}

export async function aiProviderFor(db: Db, services: Services, userId: string): Promise<AiProvider | null> {
  const row = await db.aiConnection.findUnique({ where: { userId } });
  return ownProvider(services, row) ?? services.ai;
}
