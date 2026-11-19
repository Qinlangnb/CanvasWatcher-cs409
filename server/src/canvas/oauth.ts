import type { CanvasCredentials } from "./credentials.js";
import type { CanvasUser } from "./types.js";

// Canvas OAuth2 with a developer key set up by the operator (CANVAS_OAUTH_*). Nothing Canvas answers is
// ever reflected to the user or logged: failures become fixed codes.

const MAX_LIFETIME_S = 365 * 86_400;

export class OAuthError extends Error {
  constructor(readonly code: "CANVAS_OAUTH_NOT_CONFIGURED" | "CANVAS_OAUTH_FAILED" | "CANVAS_OAUTH_REVOKED" | "CANVAS_OAUTH_STATE_INVALID") {
    super(code);
  }
}

export interface OAuthResult {
  tokens: { access_token: string; refresh_token: string };
  expiresAt: Date;
  account: CanvasUser;
}

/** Posts to Canvas's token endpoint (code or refresh grant), then asks Canvas who the token belongs to. */
export async function exchangeOAuth(
  credentials: CanvasCredentials,
  baseUrl: string,
  grant: Record<string, string>,
): Promise<OAuthResult> {
  const config = credentials.oauth;
  if (!config) throw new OAuthError("CANVAS_OAUTH_NOT_CONFIGURED");
  let status: number;
  let body: Record<string, unknown>;
  try {
    const response = await credentials.fetchImpl(`${baseUrl}/login/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, ...grant }),
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    });
    status = response.status;
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new OAuthError("CANVAS_OAUTH_FAILED");
  }
  if (status === 400 && body?.error === "invalid_grant") throw new OAuthError("CANVAS_OAUTH_REVOKED");
  if (status !== 200 || !body || typeof body !== "object") throw new OAuthError("CANVAS_OAUTH_FAILED");
  const access = body.access_token;
  const lifetime = body.expires_in;
  const refresh = body.refresh_token ?? grant.refresh_token;
  if (typeof access !== "string" || !access || typeof lifetime !== "number" || !(lifetime > 0 && lifetime <= MAX_LIFETIME_S)) {
    throw new OAuthError("CANVAS_OAUTH_FAILED");
  }
  if (typeof refresh !== "string" || !refresh) throw new OAuthError("CANVAS_OAUTH_FAILED");
  let account: CanvasUser;
  try {
    account = await credentials.probe(baseUrl, access);
  } catch {
    throw new OAuthError("CANVAS_OAUTH_FAILED");
  }
  return { tokens: { access_token: access, refresh_token: refresh }, expiresAt: new Date(Date.now() + lifetime * 1000), account };
}

/** The page the browser lands on after authorizing; it says only whether it worked. */
export function callbackPage(success: boolean): string {
  const message = success
    ? "Canvas connected. You can close this window and return to CanvasWatcher."
    : "Canvas authorization failed or expired. Return to CanvasWatcher and try again.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canvas authorization</title></head><body><p>${message}</p></body></html>`;
}
