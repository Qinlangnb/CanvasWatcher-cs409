import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import type { Logger } from "pino";
import type { CanvasOAuthConfig } from "../config.js";
import type { Db } from "../db.js";
import type { CanvasConnection, CanvasCredential, Prisma } from "../generated/prisma/client.js";
import type { CanvasAuthMethod, CredentialState } from "../generated/prisma/enums.js";
import { HttpError } from "../http/errors.js";
import { notify } from "../notifications/notify.js";
import type { SecretBox } from "../security/secretBox.js";
import { CanvasClient, CanvasError, PROFILE_PATH, type CanvasAuth, type CanvasClientFactory } from "./client.js";
import { exchangeOAuth, OAuthError } from "./oauth.js";
import type { CanvasUser } from "./types.js";

// Canvas credential slots: one per method (PAT, browser session, OAuth), all bound to one Canvas account.
// Sync and every other Canvas call go through a RoutedCanvasClient, which uses the best working slot
// and fails over to the next verified one when Canvas stops accepting it.

export type Method = CanvasAuthMethod;
export const METHODS: Method[] = ["OAUTH", "PAT", "BROWSER_SESSION"];
export const methodName = (method: Method) => method.toLowerCase() as "pat" | "browser_session" | "oauth";
export const methodFromName = (name: string): Method | null =>
  ({ pat: "PAT", browser_session: "BROWSER_SESSION", oauth: "OAUTH" })[name] as Method | undefined ?? null;
export const METHOD_LABELS: Record<Method, string> = { PAT: "PAT", BROWSER_SESSION: "Browser Session", OAUTH: "OAuth" };

/** A slot verified this recently is trusted as a backup without probing Canvas again. */
const RECENTLY_VERIFIED_MS = 15 * 60_000;
/** OAuth access tokens are refreshed this long before they expire. */
const OAUTH_REFRESH_MARGIN_MS = 30_000;
const DAY_MS = 86_400_000;

/** AAD for a slot's secret, so a sealed value cannot be moved to another user or slot. */
export const slotContext = (userId: string, method: Method) => `${userId}:canvas:${methodName(method)}`;
export const fingerprint = (baseUrl: string, accountId: string) => createHash("sha256").update(`${baseUrl}|${accountId}`).digest("hex");

export const usable = (row: CanvasCredential | null | undefined): row is CanvasCredential & { secretCiphertext: string } =>
  Boolean(row?.secretCiphertext);

/** Preferred method first, then OAuth, PAT and browser session. */
export function priority(preferred: Method | null | undefined): Method[] {
  return preferred ? [preferred, ...METHODS.filter((method) => method !== preferred)] : METHODS;
}

export type ExpirationState = "normal" | "warning" | "urgent" | "critical" | "expired" | "unknown";

/** Days left (rounded up) and the warning level of a PAT expiry: ≤7 warning, ≤3 urgent, ≤1 critical. */
export function expiration(expiresAt: Date | null, now = new Date()): { days: number | null; state: ExpirationState } {
  if (!expiresAt) return { days: null, state: "unknown" };
  const ms = expiresAt.getTime() - now.getTime();
  if (ms <= 0) return { days: 0, state: "expired" };
  const days = Math.max(1, Math.ceil(ms / DAY_MS));
  return { days, state: days <= 1 ? "critical" : days <= 3 ? "urgent" : days <= 7 ? "warning" : "normal" };
}

/** A PAT's "expires on" date means the end of that day in the student's time zone. */
export function endOfDay(date: string, zone: string): Date {
  const day = DateTime.fromISO(date, { zone });
  if (!day.isValid) throw new HttpError(422, "VALIDATION_ERROR", "Enter the expiration date as YYYY-MM-DD.");
  return day.endOf("day").toJSDate();
}

interface OAuthSecret {
  access_token: string;
  refresh_token: string;
}

export interface InstallOptions {
  /** The secret as stored: a PAT, a JSON cookie object or JSON OAuth tokens. */
  secret: string;
  baseUrl: string;
  /** Who the secret signed in as (from the profile probe). */
  account: CanvasUser;
  expiresAt?: Date | null;
  expirationSource?: string | null;
  /** The slot generation the caller saw; a different one means the slot changed meanwhile. */
  expectedGeneration?: number;
}

export const accountMismatch = () =>
  new HttpError(409, "account_mismatch", "That credential signs in to a different Canvas account or site. The current one was kept.");

type Tx = Prisma.TransactionClient;

export interface CanvasCredentialsOptions {
  db: Db;
  secrets: SecretBox;
  canvas: CanvasClientFactory;
  logger: Logger;
  oauth: CanvasOAuthConfig | null;
  /** Used for OAuth token requests; tests replace it. */
  fetch?: typeof fetch;
}

export class CanvasCredentials {
  readonly db: Db;
  readonly secrets: SecretBox;
  readonly factory: CanvasClientFactory;
  readonly logger: Logger;
  readonly oauth: CanvasOAuthConfig | null;
  readonly fetchImpl: typeof fetch;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: CanvasCredentialsOptions) {
    this.db = options.db;
    this.secrets = options.secrets;
    this.factory = options.canvas;
    this.logger = options.logger;
    this.oauth = options.oauth;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Runs `work` after any other routing change for this user has finished (one process). */
  async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    const tail = run.catch(() => {});
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  async rows(userId: string, db: Db | Tx = this.db): Promise<Map<Method, CanvasCredential>> {
    const rows = await db.canvasCredential.findMany({ where: { userId } });
    return new Map(rows.map((row) => [row.method, row]));
  }

  /** Opens a slot's secret. PATs copied from the old single-token column are re-sealed for their slot. */
  async open(row: CanvasCredential & { secretCiphertext: string }): Promise<string> {
    const context = row.legacyAad ? row.userId : slotContext(row.userId, row.method);
    let secret: string;
    try {
      secret = this.secrets.open(row.secretCiphertext, context);
    } catch {
      throw new CanvasError("TOKEN_REJECTED", "The saved credential can no longer be read. Sign in to Canvas again.");
    }
    if (row.legacyAad) {
      await this.db.$transaction([
        this.db.canvasCredential.updateMany({
          where: { userId: row.userId, method: row.method, generation: row.generation, legacyAad: true },
          data: { secretCiphertext: this.secrets.seal(secret, slotContext(row.userId, row.method)), legacyAad: false },
        }),
        this.db.canvasConnection.updateMany({ where: { userId: row.userId }, data: { tokenCiphertext: null } }),
      ]);
    }
    return secret;
  }

  /** A plain client for one slot. Browser-session cookies changed by Canvas are reported to `onCookies`. */
  clientFor(baseUrl: string, method: Method, secret: string, onCookies?: (cookies: Map<string, string>) => void): CanvasClient {
    return this.factory(baseUrl, this.authFor(method, secret, onCookies));
  }

  authFor(method: Method, secret: string, onCookies?: (cookies: Map<string, string>) => void): CanvasAuth {
    if (method === "PAT") return secret;
    if (method === "OAUTH") return (JSON.parse(secret) as OAuthSecret).access_token;
    const cookies = new Map(Object.entries(JSON.parse(secret) as Record<string, string>));
    return { kind: "browser_session", cookies, onChange: onCookies ? () => onCookies(cookies) : undefined };
  }

  /** Asks Canvas who a candidate credential signs in as. Throws CanvasError when it does not work. */
  async probe(baseUrl: string, auth: CanvasAuth): Promise<CanvasUser> {
    const me = await this.factory(baseUrl, auth).profile();
    if (me?.id === undefined || me.id === null || String(me.id) === "") {
      throw new CanvasError("BAD_RESPONSE", "Canvas did not say which account this is.");
    }
    return me;
  }

  /**
   * Stores a verified credential in its slot, binding the account on first use. A credential for a
   * different account or Canvas site is rejected and the current one kept.
   */
  async install(userId: string, method: Method, options: InstallOptions, outer?: Tx): Promise<CanvasCredential> {
    const accountId = String(options.account.id);
    const now = new Date();
    const inTransaction = <T>(work: (tx: Tx) => Promise<T>) => (outer ? work(outer) : this.db.$transaction(work));
    return inTransaction(async (tx) => {
      const binding = await tx.canvasConnection.findUnique({ where: { userId } });
      if (binding && (binding.baseUrl !== options.baseUrl || binding.canvasUserId !== accountId)) throw accountMismatch();
      const current = await tx.canvasCredential.findUnique({ where: { userId_method: { userId, method } } });
      if (options.expectedGeneration !== undefined && (current?.generation ?? 0) !== options.expectedGeneration) {
        throw new HttpError(409, "stale_generation", "This credential changed in the meantime. Reload and try again.");
      }
      const fields = {
        secretCiphertext: this.secrets.seal(options.secret, slotContext(userId, method)),
        legacyAad: false,
        generation: (current?.generation ?? 0) + 1,
        state: "VALID" as CredentialState,
        verifiedAt: now,
        lastSuccessAt: now,
        failedAt: null,
        failureReason: null,
        accountFingerprint: fingerprint(options.baseUrl, accountId),
        expiresAt: options.expiresAt ?? null,
        expirationSource: options.expirationSource ?? null,
        notifiedState: null,
      };
      const row = await tx.canvasCredential.upsert({
        where: { userId_method: { userId, method } },
        create: { userId, method, ...fields },
        update: fields,
      });
      const displayName = options.account.name ?? options.account.short_name ?? binding?.displayName ?? "";
      await tx.canvasConnection.upsert({
        where: { userId },
        create: { userId, baseUrl: options.baseUrl, canvasUserId: accountId, displayName, status: "OK", verifiedAt: now },
        update: { status: "OK", verifiedAt: now, displayName, ...(method === "PAT" ? { tokenCiphertext: null } : {}) },
      });
      await ensureCanvasSource(tx, userId, options.baseUrl, "READY");
      return row;
    });
  }

  /**
   * Empties a slot, keeping its row with the new state and reason. With `generation`, only that exact
   * credential is removed (a replacement installed meanwhile stays). Returns whether a secret was removed.
   */
  async remove(
    userId: string,
    method: Method,
    options: { generation?: number; state?: CredentialState; reason?: string } = {},
    outer?: Tx,
  ): Promise<boolean> {
    const state = options.state ?? "INVALID";
    const now = new Date();
    const inTransaction = <T>(work: (tx: Tx) => Promise<T>) => (outer ? work(outer) : this.db.$transaction(work));
    return inTransaction(async (tx) => {
      const row = await tx.canvasCredential.findUnique({ where: { userId_method: { userId, method } } });
      if (!row) return false;
      if (options.generation !== undefined && row.generation !== options.generation) return false;
      const removed = await tx.canvasCredential.updateMany({
        where: { userId, method, generation: row.generation },
        data: {
          secretCiphertext: null,
          legacyAad: false,
          generation: row.generation + 1,
          state,
          failedAt: now,
          failureReason: options.reason ?? state,
          expiresAt: method === "PAT" ? row.expiresAt : null,
        },
      });
      if (method === "PAT") await tx.canvasConnection.updateMany({ where: { userId }, data: { tokenCiphertext: null } });
      return removed.count > 0 && row.secretCiphertext !== null;
    });
  }

  async markVerified(userId: string, method: Method, generation: number): Promise<void> {
    const now = new Date();
    await this.db.canvasCredential.updateMany({
      where: { userId, method, generation },
      data: { state: "VALID", verifiedAt: now, lastSuccessAt: now, failureReason: null },
    });
  }

  /** Records that every slot failed: the connection asks for a new sign-in and the user is told once. */
  async markAuthRequired(userId: string, options: { quiet?: boolean } = {}): Promise<void> {
    const changed = await this.db.canvasConnection.updateMany({ where: { userId, status: "OK" }, data: { status: "TOKEN_REJECTED" } });
    await this.db.sourceConnection.updateMany({ where: { userId, type: "CANVAS" }, data: { state: "AUTH_REQUIRED", health: "AUTH_REQUIRED" } });
    // A sign-out the user asked for needs no notice.
    if (changed.count === 0 || options.quiet) return;
    const rows = [...(await this.rows(userId)).values()];
    const generations = rows.reduce((sum, row) => sum + row.generation, 0);
    await notify(this.db, userId, {
      key: `canvas-auth-required:${generations}`,
      level: "critical",
      title: "Canvas authentication required",
      body: "Canvas no longer accepts any saved sign-in, so your courses are not updating. Sign in again in Settings → Sources.",
    }).catch((error: unknown) => this.logger.warn({ err: error }, "notify failed"));
  }

  /** Announces PAT expiry levels once each, and empties the PAT slot once it has expired. */
  async refreshLifecycle(userId: string, now = new Date()): Promise<void> {
    const row = await this.db.canvasCredential.findUnique({ where: { userId_method: { userId, method: "PAT" } } });
    if (!row || !usable(row) || !row.expiresAt) return;
    const { days, state } = expiration(row.expiresAt, now);
    if (state === "normal" || state === "unknown") return;
    if (state === "expired") {
      if (await this.remove(userId, "PAT", { generation: row.generation, state: "EXPIRED", reason: "PAT_EXPIRED" })) {
        await this.notifyExpiry(userId, row.generation, state, days);
        const rows = await this.rows(userId);
        if (![...rows.values()].some(usable)) await this.markAuthRequired(userId);
      }
      return;
    }
    if (row.notifiedState === state) return;
    const updated = await this.db.canvasCredential.updateMany({
      where: { userId, method: "PAT", generation: row.generation },
      data: { notifiedState: state },
    });
    if (updated.count > 0) await this.notifyExpiry(userId, row.generation, state, days);
  }

  private async notifyExpiry(userId: string, generation: number, state: ExpirationState, days: number | null): Promise<void> {
    const expired = state === "expired";
    await notify(this.db, userId, {
      key: `canvas-pat-expiry:${generation}:${state}`,
      level: state === "critical" || expired ? "critical" : "important",
      title: expired ? "Canvas access token expired" : `Canvas access token expires in ${days === 1 ? "1 day" : `${days} days`}`,
      body: expired
        ? "The saved Canvas access token has expired and was removed. Import a new one or sign in with the browser in Settings → Sources."
        : "Create a new Canvas access token and import it in Settings → Sources before this one stops working.",
    }).catch((error: unknown) => this.logger.warn({ err: error }, "notify failed"));
  }

  /** A client that routes every request through the user's slots, or null without a Canvas connection. */
  async routed(userId: string): Promise<RoutedCanvasClient | null> {
    const connection = await this.db.canvasConnection.findUnique({ where: { userId } });
    if (!connection) return null;
    await this.refreshLifecycle(userId);
    return new RoutedCanvasClient(this, connection, await this.rows(userId));
  }

  /** Refreshes an OAuth access token that is about to expire. Invalid grants and account changes empty the slot. */
  async refreshOAuth(row: CanvasCredential & { secretCiphertext: string }, binding: CanvasConnection): Promise<void> {
    if (!row.expiresAt || row.expiresAt.getTime() - Date.now() > OAUTH_REFRESH_MARGIN_MS) return;
    await this.withLock(`oauth:${row.userId}`, async () => {
      const current = await this.db.canvasCredential.findUnique({ where: { userId_method: { userId: row.userId, method: "OAUTH" } } });
      if (!usable(current) || current.generation !== row.generation) return;
      if (current.expiresAt && current.expiresAt.getTime() - Date.now() > OAUTH_REFRESH_MARGIN_MS) return;
      if (!this.oauth) throw new CanvasError("UNREACHABLE", "Canvas OAuth is no longer set up on this server.");
      const tokens = JSON.parse(await this.open(current)) as OAuthSecret;
      let result;
      try {
        result = await exchangeOAuth(this, binding.baseUrl, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
      } catch (error) {
        if (error instanceof OAuthError && error.code === "CANVAS_OAUTH_REVOKED") {
          await this.remove(row.userId, "OAUTH", { generation: current.generation, state: "EXPIRED", reason: "OAUTH_REVOKED" });
          return;
        }
        throw new CanvasError("UNREACHABLE", "Canvas OAuth could not be refreshed. Try again later.");
      }
      if (String(result.account.id) !== binding.canvasUserId) {
        await this.remove(row.userId, "OAUTH", { generation: current.generation, state: "REVOKED", reason: "ACCOUNT_CHANGED" });
        return;
      }
      await this.db.canvasCredential.updateMany({
        where: { userId: row.userId, method: "OAUTH", generation: current.generation },
        data: {
          secretCiphertext: this.secrets.seal(JSON.stringify(result.tokens), slotContext(row.userId, "OAUTH")),
          expiresAt: result.expiresAt,
          verifiedAt: new Date(),
          state: "VALID",
        },
      });
    });
  }
}

/** Creates the user's Canvas source if there is none, or points it at the bound site. */
export async function ensureCanvasSource(tx: Tx | Db, userId: string, baseUrl: string, state?: string): Promise<void> {
  const existing = await tx.sourceConnection.findFirst({ where: { userId, type: "CANVAS" } });
  if (!existing) {
    await tx.sourceConnection.create({ data: { userId, type: "CANVAS", name: "Canvas", baseUrl, state: state ?? "AUTH_REQUIRED" } });
    return;
  }
  if (existing.baseUrl !== baseUrl || (state && existing.state !== state)) {
    await tx.sourceConnection.update({ where: { id: existing.id }, data: { baseUrl, ...(state ? { state } : {}) } });
  }
}

const isProfile = (url: string) => new URL(url).pathname === PROFILE_PATH;

interface ActiveSlot {
  row: CanvasCredential & { secretCiphertext: string };
  client: CanvasClient;
}

/**
 * A Canvas client over every credential slot of one user. Each request uses the best working slot. When
 * Canvas rejects it, the slot is probed again: if the account still signs in, only that resource is off
 * limits (a 403-like failure that never invalidates); otherwise the slot is emptied (or removed for
 * signing in as someone else) and the request moves to the next slot, probed first unless verified in
 * the last 15 minutes.
 */
export class RoutedCanvasClient extends CanvasClient {
  private slots: Map<Method, CanvasCredential>;
  private readonly clients = new Map<string, CanvasClient>();
  /** Browser-session cookie jars Canvas updated, by generation, to save in flush(). */
  private readonly dirtyCookies = new Map<number, Map<string, string>>();
  private readonly used = new Set<string>();

  constructor(
    private readonly credentials: CanvasCredentials,
    readonly connection: CanvasConnection,
    slots: Map<Method, CanvasCredential>,
  ) {
    super({ baseUrl: connection.baseUrl, auth: "" });
    this.slots = slots;
  }

  get userId(): string {
    return this.connection.userId;
  }

  /** Whether any slot holds a credential. */
  hasCredential(): boolean {
    return [...this.slots.values()].some(usable);
  }

  /** The method a request would use now, or null. */
  effectiveMethod(exclude: Set<Method> = new Set()): Method | null {
    for (const method of priority(this.connection.preferredMethod)) {
      if (!exclude.has(method) && usable(this.slots.get(method))) return method;
    }
    return null;
  }

  private async reload(): Promise<void> {
    this.slots = await this.credentials.rows(this.userId);
  }

  private async activate(method: Method): Promise<ActiveSlot> {
    let row = this.slots.get(method) as CanvasCredential & { secretCiphertext: string };
    if (method === "OAUTH") {
      await this.credentials.refreshOAuth(row, this.connection);
      await this.reload();
      const fresh = this.slots.get("OAUTH");
      if (!usable(fresh)) throw new CanvasError("TOKEN_REJECTED", "Canvas OAuth access was revoked. Authorize again.");
      row = fresh;
    }
    const key = `${method}:${row.generation}:${row.expiresAt?.getTime() ?? 0}`;
    let client = this.clients.get(key);
    if (!client) {
      const secret = await this.credentials.open(row);
      const generation = row.generation;
      client = this.credentials.clientFor(this.connection.baseUrl, method, secret, (cookies) => this.dirtyCookies.set(generation, cookies));
      this.clients.set(key, client);
    }
    return { row, client };
  }

  override async request(url: string): Promise<{ body: unknown; link: string | null }> {
    const attempted = new Set<Method>();
    let lastError: CanvasError | null = null;
    let failedFrom: Method | null = null;
    for (;;) {
      const method = this.effectiveMethod(attempted);
      if (!method) throw lastError ?? new CanvasError("TOKEN_REJECTED", "Canvas needs you to sign in again. Open Settings → Sources.");
      attempted.add(method);
      let active: ActiveSlot;
      try {
        active = await this.activate(method);
        if (failedFrom && !(await this.confirmBackup(active))) continue;
      } catch (error) {
        if (!(error instanceof CanvasError) || error.kind !== "TOKEN_REJECTED") throw error;
        // An unreadable secret or a revoked OAuth grant: this slot is out.
        const row = this.slots.get(method);
        if (row && usable(row)) await this.credentials.remove(this.userId, method, { generation: row.generation, reason: "UNREADABLE" });
        await this.reload();
        lastError = error;
        failedFrom ??= method;
        continue;
      }
      try {
        const result = await active.client.request(url);
        this.used.add(`${method}:${active.row.generation}`);
        if (failedFrom) await this.recordFallback(failedFrom, method);
        return result;
      } catch (error) {
        if (!(error instanceof CanvasError) || error.kind !== "TOKEN_REJECTED") throw error;
        lastError = error;
        const outcome = await this.credentials.withLock(`route:${this.userId}`, () => this.recheck(active, url));
        if (outcome === "resource") {
          throw new CanvasError("FORBIDDEN", "Canvas does not allow this account to read that page.", error.status);
        }
        failedFrom ??= method;
        await this.reload();
      }
    }
  }

  /** After a rejection: was it the credential or only this resource? Empties the slot if the credential. */
  private async recheck(active: ActiveSlot, url: string): Promise<"resource" | "removed"> {
    const { row, client } = active;
    const current = await this.credentials.db.canvasCredential.findUnique({ where: { userId_method: { userId: this.userId, method: row.method } } });
    // Another request already handled this slot (removed or replaced it).
    if (!usable(current) || current.generation !== row.generation) return "removed";
    if (!isProfile(url)) {
      try {
        const me = await client.profile();
        if (String(me.id) !== this.connection.canvasUserId) {
          await this.credentials.remove(this.userId, row.method, { generation: row.generation, state: "REVOKED", reason: "ACCOUNT_CHANGED" });
          return "removed";
        }
        await this.credentials.markVerified(this.userId, row.method, row.generation);
        return "resource";
      } catch (error) {
        if (!(error instanceof CanvasError) || error.kind !== "TOKEN_REJECTED") throw error;
      }
    }
    await this.credentials.remove(this.userId, row.method, { generation: row.generation, state: "INVALID", reason: "TOKEN_REJECTED" });
    return "removed";
  }

  /** A backup slot is probed before use unless it was verified within the last 15 minutes. */
  private async confirmBackup(active: ActiveSlot): Promise<boolean> {
    const { row, client } = active;
    if (row.state === "VALID" && row.verifiedAt && Date.now() - row.verifiedAt.getTime() < RECENTLY_VERIFIED_MS) return true;
    try {
      const me = await client.profile();
      if (String(me.id) !== this.connection.canvasUserId) {
        await this.credentials.remove(this.userId, row.method, { generation: row.generation, state: "REVOKED", reason: "ACCOUNT_CHANGED" });
        await this.reload();
        return false;
      }
    } catch (error) {
      if (!(error instanceof CanvasError) || error.kind !== "TOKEN_REJECTED") throw error;
      await this.credentials.remove(this.userId, row.method, { generation: row.generation, reason: "TOKEN_REJECTED" });
      await this.reload();
      return false;
    }
    await this.credentials.markVerified(this.userId, row.method, row.generation);
    return true;
  }

  private async recordFallback(from: Method, to: Method): Promise<void> {
    const fallback = { from: methodName(from), to: methodName(to), reason_code: `${from}_INVALID`, at: new Date().toISOString() };
    await this.credentials.db.canvasConnection.updateMany({ where: { userId: this.userId }, data: { fallback } });
  }

  /** Saves cookies Canvas refreshed and when each slot last worked. Best effort; call after a batch of requests. */
  async flush(): Promise<void> {
    const { db, secrets } = this.credentials;
    try {
      for (const [generation, cookies] of this.dirtyCookies) {
        await db.canvasCredential.updateMany({
          where: { userId: this.userId, method: "BROWSER_SESSION", generation, secretCiphertext: { not: null } },
          data: { secretCiphertext: secrets.seal(JSON.stringify(Object.fromEntries(cookies)), slotContext(this.userId, "BROWSER_SESSION")) },
        });
      }
      this.dirtyCookies.clear();
      const now = new Date();
      for (const key of this.used) {
        const [method, generation] = key.split(":") as [Method, string];
        await db.canvasCredential.updateMany({ where: { userId: this.userId, method, generation: Number(generation) }, data: { lastSuccessAt: now } });
      }
      this.used.clear();
    } catch (error) {
      this.credentials.logger.warn({ err: error }, "could not save Canvas session state");
    }
  }
}
