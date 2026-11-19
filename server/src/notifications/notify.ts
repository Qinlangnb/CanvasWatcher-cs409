// Banners at the top of the app. Anything may raise one: an AI-approved change, or a system event such as a
// source that needs signing in again. A dedupe key makes raising the same notice twice harmless, and a
// dismissed notice stays dismissed.
import type { Db } from "../db.js";
import type { Notification, Prisma } from "../generated/prisma/client.js";

type Tx = Db | Prisma.TransactionClient;

export type NoticeLevel = "important" | "critical";

export interface Notice {
  /** Stable for the event, for example `change:12`, `auth-required:canvas` or `canvas-expiration:<id>:<state>`. */
  key: string;
  level: NoticeLevel;
  title: string;
  body: string;
  /** Set when the notice is about one change. */
  changeEventId?: number;
}

/** Raises a notice unless one with the same key exists. Returns true when a new banner was created. */
export async function notify(db: Tx, userId: string, notice: Notice): Promise<boolean> {
  const { count } = await db.notification.createMany({
    data: [
      {
        userId,
        dedupeKey: notice.key.slice(0, 200),
        level: notice.level,
        title: notice.title.slice(0, 200),
        body: notice.body.slice(0, 1000),
        changeEventId: notice.changeEventId ?? null,
      },
    ],
    skipDuplicates: true,
  });
  return count > 0;
}

/** Takes a notice down once its cause is gone (for example after signing in again). Raising the key later shows nothing new. */
export async function resolveNotice(db: Tx, userId: string, key: string): Promise<void> {
  await db.notification.updateMany({ where: { userId, dedupeKey: key, dismissedAt: null }, data: { dismissedAt: new Date() } });
}

const LEVEL_ORDER: Record<string, number> = { critical: 0, important: 1 };

/** Critical first, then newest. */
export function bannerOrder(a: Notification, b: Notification): number {
  return (LEVEL_ORDER[a.level] ?? 2) - (LEVEL_ORDER[b.level] ?? 2) || b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id;
}

export function presentNotification(notice: Notification) {
  return {
    id: notice.id,
    level: notice.level,
    title: notice.title,
    body: notice.body,
    change_id: notice.changeEventId,
    created_at: notice.createdAt.toISOString(),
  };
}
