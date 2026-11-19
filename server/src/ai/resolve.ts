import type { Db } from "../db.js";
import type { Services } from "../services.js";
import type { AiProvider } from "./provider.js";

/** The AI provider to use for one user. For now every user shares the server's provider. */
export async function aiProviderFor(db: Db, services: Services, userId: string): Promise<AiProvider | null> {
  return services.ai;
}
