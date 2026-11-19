// Runs the sync of one non-Canvas source (course website, Gradescope) and records its health, for
// both "Sync now" and the scheduler. One sync per source at a time in this process (the Compose
// deployment runs one API process, as the Canvas sync lease also assumes).
import type { Logger } from "pino";
import type { Db } from "../db.js";
import type { Prisma, SourceConnection } from "../generated/prisma/client.js";
import { HttpError } from "../http/errors.js";
import type { Services } from "../services.js";
import { HEALTH_SUMMARIES } from "../sync/service.js";
import { sourceAdapter, type SourceSyncResult } from "./registry.js";

/** Most scheduled source syncs at once. */
const SCHEDULED_CONCURRENCY = 2;

export class SourceSyncs {
  private readonly running = new Set<string>();
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly services: () => Services,
  ) {}

  /** Syncs `source` now and stores the outcome on it. */
  async run(source: SourceConnection): Promise<SourceSyncResult> {
    const adapter = sourceAdapter(source.type);
    if (!adapter?.sync) throw new HttpError(501, "SOURCE_TYPE_UNAVAILABLE", "Syncing this kind of source is coming in this release.");
    if (this.running.has(source.id)) throw new HttpError(409, "SOURCE_SYNC_RUNNING", "This source is syncing already. Try again in a moment.");
    this.running.add(source.id);
    const job = (async () => {
      try {
        const result = await adapter.sync!(source, { db: this.db, services: this.services(), userId: source.userId });
        await this.record(source, result);
        return result;
      } finally {
        this.running.delete(source.id);
      }
    })();
    this.inFlight.add(job);
    try {
      return await job;
    } finally {
      this.inFlight.delete(job);
    }
  }

  private async record(source: SourceConnection, result: SourceSyncResult): Promise<void> {
    const failed = result.errors.length > 0;
    const health =
      result.state === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : result.state === "ERROR" ? "ERROR" : failed ? (result.items_seen > 0 ? "DEGRADED" : "ERROR") : "HEALTHY";
    const now = new Date();
    await this.db.sourceConnection.updateMany({
      where: { id: source.id, userId: source.userId },
      data: {
        state: result.state,
        lastSyncAt: now,
        ...(health === "HEALTHY" || health === "DEGRADED" ? { lastSuccessAt: now } : {}),
        lastError: failed ? `${result.errors.length} resource(s) could not be read.` : null,
        health,
        healthSummary: HEALTH_SUMMARIES[health],
        diagnostics: result.errors.slice(0, 50).map((row) => ({ ...row, course: null, optional: false })) as Prisma.InputJsonValue,
      },
    });
  }

  /** Starts syncs of enabled sources not synced within `intervalMs`; returns how many started. */
  async startDue(intervalMs: number): Promise<number> {
    const room = SCHEDULED_CONCURRENCY - this.inFlight.size;
    if (room <= 0) return 0;
    const types = (["WEBSITE", "GRADESCOPE"] as const).filter((type) => sourceAdapter(type)?.sync);
    if (types.length === 0) return 0;
    const due = await this.db.sourceConnection.findMany({
      where: {
        type: { in: [...types] },
        enabled: true,
        user: { previewExpiresAt: null },
        OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: new Date(Date.now() - intervalMs) } }],
        id: { notIn: [...this.running] },
      },
      orderBy: { lastSyncAt: { sort: "asc", nulls: "first" } },
      take: room,
    });
    for (const source of due) {
      this.run(source).catch((error: unknown) => {
        if (!(error instanceof HttpError)) this.logger.error({ err: error, sourceId: source.id }, "source sync failed");
      });
    }
    return due.length;
  }

  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }
}
