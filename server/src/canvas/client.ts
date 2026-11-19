import type { SecretBox } from "../security/secretBox.js";
import type { CanvasAnnouncement, CanvasAssignment, CanvasAssignmentGroup, CanvasCourse, CanvasFile, CanvasId, CanvasUser } from "./types.js";

export type CanvasErrorKind =
  | "TOKEN_REJECTED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UNREACHABLE"
  | "BAD_RESPONSE";

/** A failed Canvas request. `message` is safe to show to the user. */
export class CanvasError extends Error {
  constructor(
    readonly kind: CanvasErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/**
 * Opens a stored secret. One that no longer opens (say, CREDENTIALS_KEY was changed) counts as
 * rejected, so the user is asked to sign in again instead of every sync failing.
 */
export function openToken(secrets: SecretBox, sealed: string, context: string): string {
  try {
    return secrets.open(sealed, context);
  } catch {
    throw new CanvasError("TOKEN_REJECTED", "The saved access token can no longer be read. Create a new token and reconnect.");
  }
}

/**
 * A Canvas browser session: the cookies a signed-in browser sends. They only ever go to the Canvas
 * origin; cookies Canvas sets in its answers are merged back and `onChange` is called so they can be saved.
 */
export interface BrowserSessionAuth {
  kind: "browser_session";
  cookies: Map<string, string>;
  onChange?: () => void;
}

/** A bearer token (personal access token or OAuth access token), or a browser session. */
export type CanvasAuth = string | BrowserSessionAuth;

export interface CanvasClientOptions {
  /** An https origin already checked by `canvasOrigin`. */
  baseUrl: string;
  auth?: CanvasAuth;
  /** Same as a string `auth`; kept for callers written before browser sessions. */
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Extra attempts after throttling, server errors and network failures. */
  retries?: number;
  retryDelayMs?: number;
}

export type CanvasClientFactory = (baseUrl: string, auth: CanvasAuth) => CanvasClient;

type Params = [string, string][];

/** Stops a misbehaving pagination chain; 50 pages of 100 is far beyond any real course. */
const MAX_PAGES = 50;
const MAX_RETRY_DELAY_MS = 10_000;
/** Same-origin redirects a browser-session request may follow. */
const MAX_SESSION_REDIRECTS = 5;

export const PROFILE_PATH = "/api/v1/users/self/profile";
const SESSION_REJECTED = "Canvas signed the browser session out. Sign in with the browser again.";

function errorFor(status: number, throttled: boolean): CanvasError {
  if (status === 401) {
    return new CanvasError("TOKEN_REJECTED", "Canvas rejected the access token. Create a new token and reconnect.", status);
  }
  if (throttled) return new CanvasError("RATE_LIMITED", "Canvas is limiting requests. Try again in a few minutes.", status);
  if (status === 403) return new CanvasError("FORBIDDEN", "Canvas does not allow this account to read that page.", status);
  if (status === 404) return new CanvasError("NOT_FOUND", "Canvas could not find that page.", status);
  if (status >= 500) return new CanvasError("UNREACHABLE", "Canvas is having problems. Try again in a few minutes.", status);
  return new CanvasError("BAD_RESPONSE", `Canvas answered with an unexpected status (${status}).`, status);
}

/** Canvas sends a signed-out browser to its sign-in page (or the school's SSO). */
function isLoginPath(pathname: string): boolean {
  return /^\/login(\/|$)/.test(pathname) || /\/(saml|cas)(\/|$)/i.test(pathname);
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Applies Set-Cookie lines from a Canvas answer to the jar. Only cookies scoped to the Canvas host itself
 * are kept: one with a Domain attribute for a parent domain is meant for other sites too, so it is ignored.
 * Returns whether the jar changed.
 */
export function mergeSetCookies(jar: Map<string, string>, lines: string[], host: string): boolean {
  let changed = false;
  for (const line of lines) {
    const [pair = "", ...attributes] = line.split(";");
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!COOKIE_NAME.test(name) || /[\x00-\x1f\x7f]/.test(value)) continue;
    let removed = value === "";
    let foreign = false;
    for (const attribute of attributes) {
      const [key = "", ...rest] = attribute.trim().split("=");
      const option = rest.join("=").trim();
      if (/^domain$/i.test(key) && option.replace(/^\./, "").toLowerCase() !== host) foreign = true;
      if (/^max-age$/i.test(key) && Number(option) <= 0) removed = true;
      if (/^expires$/i.test(key) && Date.parse(option) <= Date.now()) removed = true;
    }
    if (foreign) continue;
    if (removed) {
      changed = jar.delete(name) || changed;
    } else if (jar.get(name) !== value) {
      jar.set(name, value);
      changed = true;
    }
  }
  return changed;
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}

function retryAfterMs(response: Response): number | null {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_DELAY_MS) : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const id = (value: CanvasId) => encodeURIComponent(String(value));

/** A read-only Canvas REST client for one credential. */
export class CanvasClient {
  protected readonly origin: string;
  private readonly auth: CanvasAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(options: CanvasClientOptions) {
    this.origin = new URL(options.baseUrl).origin;
    this.auth = options.auth ?? options.token ?? "";
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retries = options.retries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  get baseUrl(): string {
    return this.origin;
  }

  self(): Promise<CanvasUser> {
    return this.get("/api/v1/users/self");
  }

  /** Who the credential signs in as; the probe used to verify every credential slot. */
  profile(): Promise<CanvasUser> {
    return this.get(PROFILE_PATH);
  }

  /** Courses with an active enrollment, including their term. */
  courses(): Promise<CanvasCourse[]> {
    return this.getAll("/api/v1/courses", [
      ["enrollment_state", "active"],
      ["include[]", "term"],
    ]);
  }

  /** Due dates are already personalized for this student (override_assignment_dates). */
  assignments(courseId: CanvasId): Promise<CanvasAssignment[]> {
    return this.getAll(`/api/v1/courses/${id(courseId)}/assignments`, [
      ["include[]", "submission"],
      ["override_assignment_dates", "true"],
    ]);
  }

  /** Grading categories with their weights and drop rules. */
  assignmentGroups(courseId: CanvasId): Promise<CanvasAssignmentGroup[]> {
    return this.getAll(`/api/v1/courses/${id(courseId)}/assignment_groups`);
  }

  files(courseId: CanvasId): Promise<CanvasFile[]> {
    return this.getAll(`/api/v1/courses/${id(courseId)}/files`);
  }

  file(courseId: CanvasId, fileId: CanvasId): Promise<CanvasFile> {
    return this.get(`/api/v1/courses/${id(courseId)}/files/${id(fileId)}`);
  }

  /** Canvas only returns the last 14 days of announcements unless given a start date. */
  announcements(courseId: CanvasId, since: Date, until: Date): Promise<CanvasAnnouncement[]> {
    return this.getAll("/api/v1/announcements", [
      ["context_codes[]", `course_${courseId}`],
      ["start_date", since.toISOString()],
      ["end_date", until.toISOString()],
    ]);
  }

  async get<T>(path: string, params: Params = []): Promise<T> {
    return (await this.request(this.url(path, params))).body as T;
  }

  /** Follows `Link: rel="next"` pagination, only ever to the same origin. */
  async getAll<T>(path: string, params: Params = []): Promise<T[]> {
    const rows: T[] = [];
    let next: string | null = this.url(path, [...params, ["per_page", "100"]]);
    for (let page = 0; next; page += 1) {
      if (page === MAX_PAGES) throw new CanvasError("BAD_RESPONSE", "Canvas returned more pages than expected.");
      const { body, link } = await this.request(next);
      if (!Array.isArray(body)) throw new CanvasError("BAD_RESPONSE", "Canvas returned an unexpected response.");
      rows.push(...(body as T[]));
      next = nextLink(link);
      if (next && new URL(next, this.origin).origin !== this.origin) {
        throw new CanvasError("BAD_RESPONSE", "Canvas pointed to another site for the next page.");
      }
    }
    return rows;
  }

  protected url(path: string, params: Params): string {
    const url = new URL(path, this.origin);
    for (const [key, value] of params) url.searchParams.append(key, value);
    return url.toString();
  }

  /** One GET of a same-origin URL, with retries. A routed client replaces it to fail over between credentials. */
  async request(url: string): Promise<{ body: unknown; link: string | null }> {
    if (new URL(url).origin !== this.origin) throw new CanvasError("BAD_RESPONSE", "Canvas pointed to another site.");
    const session = typeof this.auth === "string" ? null : this.auth;
    for (let attempt = 0; ; attempt += 1) {
      const delay = this.retryDelayMs * 2 ** attempt;
      let response: Response;
      try {
        response = session ? await this.sessionFetch(url, session) : await this.bearerFetch(url);
      } catch (error) {
        if (error instanceof CanvasError) throw error;
        if (attempt < this.retries) {
          await sleep(delay);
          continue;
        }
        throw new CanvasError("UNREACHABLE", "Canvas did not respond. Check the address or try again later.");
      }
      if (response.ok && session && !/json/i.test(response.headers.get("content-type") ?? "")) {
        // A JSON endpoint answering with a page: Canvas showed a signed-out browser its sign-in page.
        await response.body?.cancel().catch(() => {});
        throw new CanvasError("TOKEN_REJECTED", SESSION_REJECTED, response.status);
      }
      if (response.ok) {
        try {
          return { body: await response.json(), link: response.headers.get("link") };
        } catch {
          throw new CanvasError("BAD_RESPONSE", "Canvas returned a response that is not JSON.");
        }
      }
      const text = await response.text().catch(() => "");
      // Canvas signals throttling with 403 "Rate Limit Exceeded" as well as 429.
      const throttled = response.status === 429 || (response.status === 403 && /rate limit exceeded/i.test(text));
      if ((throttled || response.status >= 500) && attempt < this.retries) {
        await sleep(retryAfterMs(response) ?? delay);
        continue;
      }
      if (response.status === 401 && session) throw new CanvasError("TOKEN_REJECTED", SESSION_REJECTED, 401);
      throw errorFor(response.status, throttled);
    }
  }

  private bearerFetch(url: string): Promise<Response> {
    return this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.auth as string}`, Accept: "application/json" },
      // A redirect could carry the token to another host.
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  /**
   * Sends the session cookies to the Canvas origin only. Redirects are followed by hand: within the
   * origin, with the cookies; never to another host; and one to the sign-in page means the session is over.
   */
  private async sessionFetch(url: string, session: BrowserSessionAuth): Promise<Response> {
    const host = new URL(this.origin).hostname;
    let target = url;
    for (let hop = 0; ; hop += 1) {
      const response = await this.fetchImpl(target, {
        headers: {
          Cookie: [...session.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
          Accept: "application/json",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (mergeSetCookies(session.cookies, response.headers.getSetCookie?.() ?? [], host)) session.onChange?.();
      if (response.status < 300 || response.status >= 400) return response;
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      const next = location ? new URL(location, target) : null;
      if (!next || next.origin !== this.origin || isLoginPath(next.pathname)) {
        throw new CanvasError("TOKEN_REJECTED", SESSION_REJECTED, response.status);
      }
      if (hop === MAX_SESSION_REDIRECTS) throw new CanvasError("BAD_RESPONSE", "Canvas redirected too many times.");
      target = next.toString();
    }
  }
}
