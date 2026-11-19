import type { Db } from "../db.js";

/**
 * Records a notice for the user (for example "Canvas authentication required"). Placeholder until the
 * notifications module lands; callers pass a stable `key` so the same notice is shown once.
 */
export async function notify(db: Db, userId: string, notice: { key: string; level: "important" | "critical"; title: string; body: string }): Promise<void> {}
