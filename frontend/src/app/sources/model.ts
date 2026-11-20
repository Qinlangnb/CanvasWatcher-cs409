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
  /** The CanvasWatcher address the broker hands sessions to (broker 0.8.1 and later). */
  backend?: string;
}

/**
 * Whether the broker serves this site. A broker hands sessions only to the one backend it was
 * registered for, so a broker set up for another site would accept the ticket and then fail to claim
 * it. Local installs talk to the API port directly, so a loopback backend matches a loopback page.
 * Brokers before 0.8.1 don't say which site they serve: "unknown".
 */
export type BrokerSite = "this" | "other" | "unknown";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function brokerSite(health: BrokerHealth | null | undefined, page: { origin: string; hostname: string }, basePath: string): BrokerSite {
  const backend = health?.backend?.replace(/\/+$/, "");
  if (!backend) return "unknown";
  try {
    const url = new URL(backend);
    if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return LOOPBACK.has(page.hostname) ? "this" : "other";
  } catch {
    return "unknown";
  }
  return backend === `${page.origin}${basePath}` ? "this" : "other";
}

/** The commands that re-register the broker for this site (auth-broker/README.md). */
export function brokerInstallCommand(page: { origin: string; hostname: string }, basePath: string): string {
  const install = LOOPBACK.has(page.hostname)
    ? "python -m academic_watcher_auth_broker.install_launcher install"
    : `python -m academic_watcher_auth_broker.install_launcher install --backend ${page.origin}${basePath} --origin ${page.origin}`;
  return `python -m academic_watcher_auth_broker.install_launcher stop\n${install}`;
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
  return brokerStatus(health) === "running";
}

/**
 * What the broker's /health says, before comparing sites: nothing answered ("absent"), a broker that
 * speaks another protocol ("incompatible": update it), one that answers but cannot reach its
 * CanvasWatcher site ("no-backend"), or one that is up ("running").
 */
export type BrokerStatus = "absent" | "incompatible" | "no-backend" | "running";

export function brokerStatus(health: BrokerHealth | null | undefined): BrokerStatus {
  if (!health || typeof health.protocol_version !== "number") return "absent";
  if (health.protocol_version !== 1) return "incompatible";
  return health.backend_ready === true ? "running" : "no-backend";
}

/** The panel's one-line state for a broker status and the site it serves. */
export function brokerHeadline(status: BrokerStatus, site: BrokerSite): string {
  if (status === "absent") return "Not running";
  if (status === "incompatible") return "Outdated";
  if (site === "other") return "Set up for another site";
  return status === "no-backend" ? "Can't reach this site" : "Running";
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
    case "AUTH_CHALLENGE_INVALID":
      return "The Local Auth Broker could not take over this sign-in. It is probably registered for a different CanvasWatcher site or is outdated: register it for this site (see the Local Auth Broker panel), then retry.";
    case "AUTH_BROKER_BUSY":
      return "The Local Auth Broker already has a sign-in window open. Finish or close it, then retry.";
    case "AUTH_BROKER_VERSION_UNSUPPORTED":
      return "The Local Auth Broker is too old for this site. Update it from auth-broker/ and register it again.";
    case "AUTH_ORIGIN_DENIED":
      return "The Local Auth Broker does not accept requests from this site. Register it again with this site's address.";
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
  if (["READ ONLY", "COMING SOON", "UNKNOWN", "MAPPING REQUIRED"].includes(value)) return "neutral";
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
  const state = sourceState(source, canvas);
  if (state === "MAPPING_REQUIRED") return "Link a course to start syncing";
  return state.replaceAll("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

/** A state as a badge reads it. A provider source without a linked course is waiting, not failing. */
export function stateLabel(state: string): string {
  return state === "MAPPING_REQUIRED" ? "Link a course" : state.replaceAll("_", " ");
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
  const failedStates = ["FAILED", "DEGRADED", "PARTIAL", "PARTIAL_SUCCESS", "AUTH_REQUIRED", "MAPPING_REQUIRED"];
  const code = result?.errors?.[0]?.code ?? (result?.state ?? "").toUpperCase();
  if (!result || (!(result.errors?.length) && !failedStates.includes((result.state ?? "").toUpperCase()))) {
    return { ok: true, message: "Sync completed successfully." };
  }
  const messages: Record<string, string> = {
    AUTH_REQUIRED: "Sign in again to sync this source.",
    PROVIDER_COURSE_MAPPING_REQUIRED: "Link the discovered courses before syncing.",
    MAPPING_REQUIRED: "Link a course to start syncing.",
    PROVIDER_TASK_MAPPING_REQUIRED: "Confirm which assignments match your tasks before syncing.",
    PRAIRIELEARN_PARSER_NOT_VERIFIED: "PrairieLearn course pages cannot be read yet.",
    PRAIRIELEARN_COURSE_PARSER_NOT_VERIFIED: "PrairieLearn course pages cannot be read yet.",
    STORAGE_QUOTA_EXCEEDED: "Some website files were not kept: your file storage is full.",
    FILE_TOO_LARGE: "Some website files are larger than this server stores. They are listed in Files without their contents and checked again in a week.",
    SCHEDULE_CONFLICT: "Another page has a homework schedule with different dates. Deadlines follow the course's schedule page only.",
    DISCOVERY_LIMIT_REACHED: "The website has more pages than its discovery limit; raise the limit in the website's settings.",
    PERMISSION_DENIED: "The source refused access to some pages.",
  };
  return { ok: false, message: messages[code.toUpperCase()] ?? "Some items could not be synced. Existing data was kept." };
}

// --- Course websites ---

export type WebsiteAuth = "none" | "ntlm";

export interface WebsiteConfig {
  authentication_method: WebsiteAuth;
  protected_path_prefix: string | null;
  probe_url: string | null;
  discovery_path_limit: number;
  week_1_monday: string | null;
}

export interface PendingResource {
  id: number;
  url: string;
  title: string;
  item_type: string;
  state: "AUTH_REQUIRED" | "DISCOVERED" | "FAILED";
  last_error_code: string | null;
  last_attempt_at: string;
}

/** GET /api/sources/:id/website. Never carries the password. */
export interface WebsiteDetails {
  config: WebsiteConfig;
  course: { id: number; code: string; name: string; term: string | null; owned: boolean } | null;
  credential: { username: string; state: string; present: boolean; last_error_code: string | null; verified_at: string | null } | null;
  pending: PendingResource[];
}

export interface WebsiteVerification {
  verified: boolean;
  message: string;
  public_only: boolean;
}

/** What the website form edits; strings so inputs stay controlled. */
export interface WebsiteDraft {
  name: string;
  course_code: string;
  course_name: string;
  term: string;
  base_url: string;
  authentication_method: WebsiteAuth;
  protected_path_prefix: string;
  probe_url: string;
  discovery_path_limit: string;
  week_1_monday: string;
}

export const DEFAULT_DISCOVERY_LIMIT = 100;

export function websiteDraft(source: SourceConnection | null, details: WebsiteDetails | null | undefined, defaultTerm: string): WebsiteDraft {
  const config = details?.config;
  return {
    name: source?.name ?? "",
    course_code: details?.course?.code ?? "",
    course_name: details?.course?.name ?? "",
    term: source ? (details?.course?.term ?? "") : defaultTerm,
    base_url: source?.base_url ?? "",
    authentication_method: config?.authentication_method ?? (source?.config_json.authentication_method === "ntlm" ? "ntlm" : "none"),
    protected_path_prefix: config?.protected_path_prefix ?? "",
    probe_url: config?.probe_url ?? "",
    discovery_path_limit: String(config?.discovery_path_limit ?? DEFAULT_DISCOVERY_LIMIT),
    week_1_monday: config?.week_1_monday ?? "",
  };
}

const NETWORK_FIELDS = ["base_url", "authentication_method", "protected_path_prefix", "probe_url"] as const;

/** A changed address or access setting is probed again before it replaces the working one. */
export function websiteNetworkChanged(initial: WebsiteDraft, draft: WebsiteDraft): boolean {
  return NETWORK_FIELDS.some((key) => initial[key].trim() !== draft[key].trim());
}

/**
 * The body for POST/PUT /api/sources/website (and its test). The login goes along only when it is
 * needed: a test, a new source, changed access, a typed password or another user name. A label-only
 * edit sends none, so it needs no password.
 */
export function websitePayload(
  draft: WebsiteDraft,
  initial: WebsiteDraft,
  login: { username: string; password: string; storedUsername: string | null },
  options: { editing: boolean; testOnly: boolean },
): Record<string, unknown> {
  const ntlm = draft.authentication_method === "ntlm";
  const includeLogin =
    ntlm &&
    (options.testOnly ||
      !options.editing ||
      websiteNetworkChanged(initial, draft) ||
      login.password !== "" ||
      login.username.trim() !== (login.storedUsername ?? ""));
  const limit = Number(draft.discovery_path_limit);
  return {
    name: draft.name.trim() || `${draft.course_code.trim() || "Course"} Site`,
    course_code: draft.course_code.trim(),
    course_name: draft.course_name.trim(),
    // An untouched term on edit is left alone.
    term: options.editing && draft.term === initial.term ? undefined : draft.term.trim() || null,
    base_url: draft.base_url.trim(),
    authentication_method: draft.authentication_method,
    protected_path_prefix: ntlm ? draft.protected_path_prefix.trim() || null : null,
    probe_url: ntlm ? draft.probe_url.trim() || null : null,
    discovery_path_limit: Number.isInteger(limit) && limit >= 1 ? limit : DEFAULT_DISCOVERY_LIMIT,
    week_1_monday: draft.week_1_monday || null,
    ...(includeLogin ? { ntlm: { username: login.username.trim(), password: login.password } } : {}),
  };
}

/** The website card's status line, in the original's words. */
export function websiteCredentialLine(details: WebsiteDetails | null | undefined): string {
  if (!details) return "Website authentication: checking…";
  if (details.config.authentication_method !== "ntlm") return "Public website · no password needed.";
  const credential = details.credential;
  if (credential?.present && credential.state === "VALID") return "Website authentication: Verified.";
  if (credential?.last_error_code === "protected_access_not_verified") return "Public website reachable. Protected access not yet verified.";
  if (credential?.last_error_code === "auth_failed") return "Website authentication: the website rejected the password. Enter it again.";
  if (!credential?.present) return "Website authentication: Authentication required.";
  return `Website authentication: ${credential.state.replaceAll("_", " ").toLowerCase()}.`;
}

/** " · 3 protected resources pending" after the card's course line. */
export function pendingNote(pending: readonly PendingResource[] | undefined): string {
  const count = pending?.length ?? 0;
  if (count === 0) return "";
  const waiting = pending?.filter((row) => row.state === "AUTH_REQUIRED").length ?? 0;
  if (waiting === count) return ` · ${count} protected resource${count === 1 ? "" : "s"} pending`;
  return ` · ${count} resource${count === 1 ? "" : "s"} pending`;
}

// --- Gradescope / PrairieLearn ---

export type ProviderType = "gradescope" | "prairielearn";

export const PROVIDER_DEFAULT_URLS: Record<ProviderType, string> = {
  gradescope: "https://www.gradescope.com",
  prairielearn: "https://us.prairielearn.com/pl",
};

/** The original's wording while PrairieLearn's course pages are not read. */
export const PRAIRIELEARN_NOTE = "Student course parsing awaits representative course data; authentication can be tested independently.";

export interface ProviderCourse {
  external_id: string;
  course_code: string;
  name: string;
  term: string | null;
  url: string;
  mapped_course_id: number | null;
}

export interface ProviderCourseMapping {
  provider_course_id: string;
  course_id: number;
  course_code: string;
  name: string;
}

export interface ProviderAssignmentRow {
  id: number;
  provider_course_id: string;
  assignment_id: string;
  title: string;
  url: string;
  due_at: string | null;
  course_id: number;
  task_id: number | null;
  binding: string | null;
  confirmed: boolean;
  candidates: { id: number; title: string; due_at: string | null }[];
}

export interface ProviderFactRow {
  provider: string;
  due_at: string | null;
  late_due_at: string | null;
  submission_state: string | null;
  submitted_at: string | null;
  score: number | null;
  max_score: number | null;
  grade: string | null;
  direct_assignment_url: string | null;
  source_item_id: number;
  source_url: string | null;
  is_deleted: boolean;
}

export interface TaskProviderFacts {
  local_completed: boolean;
  effective_submission_state: "graded" | "submitted" | null;
  effective_due_at: string | null;
  deadlines_differ: boolean;
  provider_facts: ProviderFactRow[];
}

export const PROVIDER_LABELS: Record<string, string> = { canvas: "Canvas", gradescope: "Gradescope", prairielearn: "PrairieLearn" };

/** True when the sources disagree on the deadline (to the minute). */
export function deadlinesDiffer(facts: readonly Pick<ProviderFactRow, "due_at">[]): boolean {
  const dues = new Set(facts.filter((row) => row.due_at).map((row) => Math.round(Date.parse(row.due_at as string) / 60_000)));
  return dues.size > 1;
}

/** "Source facts", with the original's "· deadlines differ". */
export function sourceFactsTitle(facts: TaskProviderFacts): string {
  return facts.deadlines_differ || deadlinesDiffer(facts.provider_facts) ? "Source facts · deadlines differ" : "Source facts";
}

/** Only worth showing when another source than Canvas reports on the task. */
export function hasProviderFacts(facts: TaskProviderFacts | null | undefined): boolean {
  return Boolean(facts?.provider_facts.some((row) => row.provider !== "canvas"));
}

export function submissionLabel(state: string | null | undefined): string {
  if (state === "graded") return "Graded";
  if (state === "submitted" || state === "pending_review") return "Submitted";
  if (state === "unsubmitted" || state === "unknown" || !state) return "Not submitted";
  return state.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}
