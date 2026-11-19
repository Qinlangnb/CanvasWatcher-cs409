// Change detection for items of a non-Canvas source (website pages and files, schedule homework,
// Gradescope assignments): the same last-seen comparison the Canvas sync does, limited to the
// source's own items, and handed to saveChanges for the taxonomy, dedupe and AI review.
import { changeSummary, changedFields, contentHash, type Content, type TrackedItem } from "../canvas/normalize.js";
import { saveChanges, type NewChange } from "../changes/review.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { ChangeType, ItemKind } from "../generated/prisma/enums.js";

export interface ItemScope {
  userId: string;
  courseId: number;
  sourceId: string;
  /** The first sync of this source records what exists without reporting all of it as new. */
  baseline: boolean;
  now: Date;
}

/**
 * Compares `items` with the source's last-seen items of `kind`. Items missing from `items` are
 * reported removed only when `removable` says so (a partial crawl proves nothing).
 */
export async function reconcileSourceItems(
  tx: Prisma.TransactionClient,
  scope: ItemScope,
  kind: ItemKind,
  items: TrackedItem[],
  removable: (canvasId: string) => boolean = () => false,
): Promise<number> {
  const { userId, courseId, sourceId, baseline, now } = scope;
  const known = new Map((await tx.sourceItem.findMany({ where: { courseId, kind, sourceId } })).map((item) => [item.canvasId, item]));
  const events: NewChange[] = [];
  const record = (sourceItemId: number, title: string, changeType: ChangeType, fields: string[], before?: Content, after?: Content) =>
    events.push({
      userId,
      courseId,
      sourceItemId,
      kind,
      title,
      changeType,
      fields,
      summary: changeSummary(kind, changeType, title, fields),
      before,
      after,
      detectedAt: now,
    });
  for (const item of items) {
    const previous = known.get(item.canvasId);
    known.delete(item.canvasId);
    const hash = contentHash(item.content);
    if (!previous) {
      const created = await tx.sourceItem.upsert({
        where: { courseId_kind_canvasId: { courseId, kind, canvasId: item.canvasId } },
        create: { userId, courseId, sourceId, kind, canvasId: item.canvasId, title: item.title, htmlUrl: item.htmlUrl, contentHash: hash, content: item.content, firstSeenAt: now },
        update: {},
      });
      if (!baseline && created.sourceId === sourceId) record(created.id, item.title, "CREATED", [], undefined, item.content);
      continue;
    }
    if (previous.removedAt === null && previous.contentHash === hash) continue;
    await tx.sourceItem.update({
      where: { id: previous.id },
      data: { title: item.title, htmlUrl: item.htmlUrl, contentHash: hash, content: item.content, removedAt: null },
    });
    if (previous.removedAt !== null) {
      record(previous.id, item.title, "CREATED", [], undefined, item.content);
      continue;
    }
    const before = previous.content as Content;
    const fields = changedFields(before, item.content);
    if (fields.length > 0) record(previous.id, item.title, "UPDATED", fields, before, item.content);
  }
  for (const gone of known.values()) {
    if (gone.removedAt !== null || !removable(gone.canvasId)) continue;
    await tx.sourceItem.update({ where: { id: gone.id }, data: { removedAt: now } });
    record(gone.id, gone.title, "REMOVED", [], gone.content as Content);
  }
  return saveChanges(tx, events);
}
