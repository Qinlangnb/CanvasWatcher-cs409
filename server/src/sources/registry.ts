import type { Db } from "../db.js";
import type { SourceConnection } from "../generated/prisma/client.js";
import type { SourceType } from "../generated/prisma/enums.js";
import type { Services } from "../services.js";

// Extension points for source types other than Canvas (course websites, Gradescope, PrairieLearn).
// Canvas is built in. Another module registers an adapter at startup:
//
//   registerSourceAdapter({ type: "GRADESCOPE", normalizeBaseUrl, verifySession, sync });
//
// Until an adapter is registered, its type cannot be created ("Coming in this release"), its sync is
// refused and a broker sign-in for it is rejected.

export type ProviderType = Extract<SourceType, "GRADESCOPE" | "PRAIRIELEARN">;

export interface SourceContext {
  db: Db;
  services: Services;
  userId: string;
}

export interface SourceSyncResult {
  /** READY, AUTH_REQUIRED, ERROR… stored on the connection. */
  state: string;
  items_seen: number;
  changes: number;
  /** Each failed resource, shown as diagnostics: { resource, code, http_status }. */
  errors: { resource: string; code: string; http_status: number | null }[];
}

export interface SessionVerification {
  ok: boolean;
  /** A fixed failure code (never provider text), for example AUTH_LOGIN_FAILED. */
  reason?: string;
}

export interface SourceAdapter {
  type: Exclude<SourceType, "CANVAS">;
  /** Checks and normalizes a pasted address (no userinfo, query or fragment). Throws FieldError("base_url"). */
  normalizeBaseUrl(input: string): string;
  /** Validates the type's settings from the add/edit form; returns the secret-free config to store. */
  validateConfig?(input: unknown, context: SourceContext): Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Default display name for a new connection. */
  defaultName?(baseUrl: string): string;
  /**
   * Gradescope / PrairieLearn: decides whether cookies captured by the Auth Broker are a signed-in
   * session for `baseUrl` (for example by fetching the dashboard). Only GET requests to that origin.
   */
  verifySession?(baseUrl: string, cookies: Map<string, string>): Promise<SessionVerification>;
  /** Syncs one connection. Disabled connections are never passed in. */
  sync?(connection: SourceConnection, context: SourceContext): Promise<SourceSyncResult>;
  /** Extra JSON shown with the connection in GET /api/sources (counts, mapped courses…). */
  present?(connection: SourceConnection): Record<string, unknown>;
}

const adapters = new Map<SourceType, SourceAdapter>();

export function registerSourceAdapter(adapter: SourceAdapter): void {
  adapters.set(adapter.type, adapter);
}

export function sourceAdapter(type: SourceType): SourceAdapter | null {
  return adapters.get(type) ?? null;
}

/** Tests only: removes a registered adapter. */
export function unregisterSourceAdapter(type: SourceType): void {
  adapters.delete(type);
}

/** The hook the broker calls for Gradescope / PrairieLearn. Without an adapter, every session is rejected. */
export async function verifyProviderSession(provider: ProviderType, baseUrl: string, cookies: Map<string, string>): Promise<SessionVerification> {
  const verify = sourceAdapter(provider)?.verifySession;
  if (!verify) return { ok: false, reason: "AUTH_PROVIDER_UNSUPPORTED" };
  try {
    return await verify(baseUrl, cookies);
  } catch {
    return { ok: false, reason: "AUTH_LOGIN_FAILED" };
  }
}
