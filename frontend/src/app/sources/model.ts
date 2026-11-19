// Plain data and wording for Settings → Sources and the sidebar's SOURCES list. No React here, so the
// tests can load it directly.

export type SourceType = "canvas" | "website" | "gradescope" | "prairielearn";
export type CanvasMethod = "oauth" | "pat" | "browser_session";

export interface SourceHealthDiagnostic {
  resource: string;
  course?: string | null;
  code: string;
  http_status: number | null;
  optional?: boolean;
  historical?: boolean;
}

export interface SourceConnection {
  id: string;
  source_type: SourceType;
  name: string;
  base_url: string;
  course_id: number | null;
  credential_id: string;
  config_json: Record<string, unknown>;
  state: string;
  enabled: boolean;
  health: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "AUTH_REQUIRED" | "ERROR";
  health_summary: string | null;
  health_diagnostics: SourceHealthDiagnostic[];
  last_sync_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  session: { state: string; present: boolean; generation: number; verified_at: string | null } | null;
  /** False until a module for this source type is installed. */
  supported: boolean;
}

export interface CredentialSlot {
  present: boolean;
  generation: number;
  credential_type: CanvasMethod;
  state: "MISSING" | "VALID" | "INVALID" | "EXPIRED" | "REVOKED";
  last_verified_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure_reason: string | null;
  account_identity_fingerprint: string | null;
  expires_at: string | null;
  expiration_source?: string;
  origin?: string;
  days_remaining?: number | null;
  expiration_state?: string;
}

export interface CanvasAuthStatus {
  configured: boolean;
  credential_id: string | null;
  base_url: string | null;
  credential_storage: "server_encrypted" | "memory";
  auth_mode: CanvasMethod | null;
  credential_state: "ACTIVE" | "AUTH_REQUIRED" | "NOT_CONFIGURED";
  connection_state: "ACTIVE" | "AUTH_REQUIRED" | "NOT_CONFIGURED";
  preferred_method: CanvasMethod | null;
  effective_method: CanvasMethod | null;
  backup_ready: boolean;
  credentials: Record<CanvasMethod, CredentialSlot>;
  fallback: { from: string; to: string; reason_code: string; at: string } | null;
  source_health: string;
  verified: boolean;
  verified_at: string | null;
  account_id: string | null;
  account_display_name: string | null;
  expires_at: string | null;
  days_remaining: number | null;
  expiration_state: string;
  expiration_source: string | null;
}

export interface BrokerTicket {
  challenge_id: string;
  instance_id: string;
  provider: string;
  one_time_token: string;
  control_token: string;
  expires_in: number;
  protocol_version: number;
}

export interface BrokerHealth {
  state?: string;
  protocol_version?: number;
  version?: string;
  backend_ready?: boolean;
}

export const METHOD_LABELS: Record<CanvasMethod, string> = { oauth: "OAuth", pat: "PAT", browser_session: "Browser Session" };
export const METHOD_ORDER: CanvasMethod[] = ["oauth", "pat", "browser_session"];

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  canvas: "Canvas",
  website: "Course Website",
  gradescope: "Gradescope",
  prairielearn: "PrairieLearn",
};

/** The broker counts as ready only when it speaks protocol 1 and can reach this server. */
export function brokerReady(health: BrokerHealth | null | undefined): boolean {
  return health?.protocol_version === 1 && health.backend_ready === true;
}

export const TERMINAL_STATES = new Set(["AUTHENTICATED", "CANCELLED", "FAILED", "TIMED_OUT"]);

/** What a broker sign-in reason code means, in plain words. */
export function brokerMessage(reason: string | null | undefined): string {
  switch (reason) {
    case "AUTH_LOGIN_TIMEOUT":
    case "TIMED_OUT":
    case "AUTH_CHALLENGE_EXPIRED":
      return "Sign-in timed out. Start it again when you are ready.";
    case "AUTH_USER_CANCELLED":
    case "CANCELLED":
    case "AUTH_SUPERSEDED":
      return "Sign-in cancelled.";
    case "CANVAS_ACCOUNT_MISMATCH":
      return "That browser signed in to a different Canvas account. Sign in with the account already connected here.";
    case "AUTH_BROKER_UNAVAILABLE":
      return "The Local Auth Broker is not running. Use Start broker, then retry.";
    case "AUTH_LOGIN_FAILED":
      return "Sign-in did not finish. Make sure you reached your dashboard, then retry.";
    default:
      return "Sign-in did not complete. Retry, or use an advanced method below.";
  }
}

export type Tone = "active" | "neutral" | "warning" | "danger";

/** Status colours of the original app: green, grey, amber, red. */
export function sourceTone(state: string): Tone {
  const value = state.replaceAll("_", " ").toUpperCase();
  if (["ACTIVE", "HEALTHY", "VALID", "READY"].includes(value)) return "active";
  if (["READ ONLY", "COMING SOON", "UNKNOWN"].includes(value)) return "neutral";
  if (["DEGRADED", "RESTORED", "AUTH REQUIRED", "PENDING RECONCILIATION", "MISSING", "DISABLED", "VERIFYING", "PENDING"].includes(value)) {
    return "warning";
  }
  return "danger";
}

export const TONE_DOT: Record<Tone, string> = { active: "ok", neutral: "neutral", warning: "warn", danger: "bad" };
export const TONE_BADGE: Record<Tone, "success" | "neutral" | "warning" | "danger"> = {
  active: "success",
  neutral: "neutral",
  warning: "warning",
  danger: "danger",
};

/** The Canvas row's subtitle: which method signs in, and how long a PAT has left. */
export function canvasSubtitle(status: CanvasAuthStatus | null | undefined): string {
  if (!status || status.connection_state !== "ACTIVE" || !status.effective_method) return "Authentication required";
  if (status.effective_method === "oauth") return "OAuth";
  if (status.effective_method === "browser_session") {
    return status.credentials.pat?.state === "EXPIRED" ? "Session · PAT expired" : "Session";
  }
  const days = status.days_remaining;
  if (days === null || days === undefined) return "PAT · expiry unknown";
  return `PAT · ${days === 1 ? "1 day" : `${days} days`} left`;
}

/** The status shown for a source (a Canvas source follows its credentials). */
export function sourceState(source: SourceConnection, canvas: CanvasAuthStatus | null | undefined): string {
  if (!source.enabled) return "DISABLED";
  if (!source.supported) return "COMING_SOON";
  if (source.source_type === "canvas") {
    if (canvas?.connection_state !== "ACTIVE") return "AUTH_REQUIRED";
    return source.health === "UNKNOWN" ? "ACTIVE" : source.health;
  }
  return source.health !== "UNKNOWN" && source.state === "READY" ? source.health : source.state;
}

export function sourceSubtitle(source: SourceConnection, canvas: CanvasAuthStatus | null | undefined): string {
  if (source.source_type === "canvas") return source.enabled ? canvasSubtitle(canvas) : "Turned off";
  return sourceState(source, canvas).replaceAll("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

/** How a source signs in, for the quick panel. */
export function authenticationLabel(source: SourceConnection, canvas: CanvasAuthStatus | null | undefined): string {
  if (source.source_type === "website") return source.config_json.authentication_method === "ntlm" ? "NTLM" : "Public";
  if (source.source_type !== "canvas") return "Browser Session";
  return canvas?.effective_method ? METHOD_LABELS[canvas.effective_method] : "None";
}

/** One diagnostics row: "file (CS 409): permission_denied · HTTP 403". */
export function diagnosticLine(row: SourceHealthDiagnostic): string {
  const where = row.course ? `${row.resource} (${row.course})` : row.resource;
  const parts = [row.code];
  if (row.http_status) parts.push(`HTTP ${row.http_status}`);
  if (row.historical) parts.push("historical record");
  if (row.optional) parts.push("skipped");
  return `${where}: ${parts.join(" · ")}`;
}

/** The PAT row's detail line. */
export function slotDetail(method: CanvasMethod, slot: CredentialSlot | undefined, formatDate: (iso: string) => string): string {
  if (method === "pat") {
    if (!slot?.present) return slot?.state === "EXPIRED" ? "Expired" : "Not imported";
    if (!slot.expires_at) return "Expires: Unknown";
    const source = slot.expiration_source === "USER_ENTERED" ? "entered by you" : slot.expiration_source === "CANVAS_API" ? "from Canvas" : "unknown source";
    return `Expires: ${formatDate(slot.expires_at)} (${source})`;
  }
  return slot?.last_verified_at ? `Verified: ${formatDate(slot.last_verified_at)}` : "Not verified";
}

/**
 * Where the quick panel goes: beside the row on wide screens (clamped into the window), or null for a
 * bottom sheet at 820px and below.
 */
export function quickPanelPosition(
  row: { top: number; right: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } | null {
  if (viewport.width <= 820) return null;
  const left = Math.max(12, Math.min(row.right + 10, viewport.width - panel.width - 12));
  const top = Math.max(12, Math.min(row.top, viewport.height - panel.height - 12));
  return { left, top };
}

/** Sync feedback in the original's words; a result with errors or a bad state counts as failed. */
export function syncFeedback(result: { state?: string; errors?: { code?: string }[] } | null, error?: { code?: string; message: string } | null): { ok: boolean; message: string } {
  if (error) return { ok: false, message: error.message };
  const failedStates = ["FAILED", "DEGRADED", "PARTIAL", "PARTIAL_SUCCESS", "AUTH_REQUIRED"];
  const code = result?.errors?.[0]?.code ?? (result?.state ?? "").toUpperCase();
  if (!result || (!(result.errors?.length) && !failedStates.includes((result.state ?? "").toUpperCase()))) {
    return { ok: true, message: "Sync completed successfully." };
  }
  const messages: Record<string, string> = {
    AUTH_REQUIRED: "Sign in again to sync this source.",
    PROVIDER_COURSE_MAPPING_REQUIRED: "Link the discovered courses before syncing.",
    PROVIDER_TASK_MAPPING_REQUIRED: "Confirm which assignments match your tasks before syncing.",
    PRAIRIELEARN_PARSER_NOT_VERIFIED: "PrairieLearn course pages cannot be read yet.",
    PERMISSION_DENIED: "The source refused access to some pages.",
  };
  return { ok: false, message: messages[code.toUpperCase()] ?? "Some items could not be synced. Existing data was kept." };
}
