import type { SecretBox } from "../security/secretBox.js";
import type { CanvasAnnouncement, CanvasAssignment, CanvasCourse, CanvasFile, CanvasId, CanvasUser } from "./types.js";

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
 * Opens a connection's stored token. One that no longer opens (say, CREDENTIALS_KEY was changed)
 * counts as rejected, so the user is asked to reconnect instead of every sync failing.
 */
export function openToken(secrets: SecretBox, sealed: string, userId: string): string {
  try {
    return secrets.open(sealed, userId);
  } catch {
    throw new CanvasError("TOKEN_REJECTED", "The saved access token can no longer be read. Create a new token and reconnect.");
  }
}

export interface CanvasClientOptions {
  /** An https origin already checked by `canvasOrigin`. */
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Extra attempts after throttling, server errors and network failures. */
  retries?: number;
  retryDelayMs?: number;
}

export type CanvasClientFactory = (baseUrl: string, token: string) => CanvasClient;

type Params = [string, string][];

/** Stops a misbehaving pagination chain; 50 pages of 100 is far beyond any real course. */
const MAX_PAGES = 50;
const MAX_RETRY_DELAY_MS = 10_000;

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

/** A read-only Canvas REST client for one user's token. */
export class CanvasClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: CanvasClientOptions) {
    this.origin = new URL(options.baseUrl).origin;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retries = options.retries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  self(): Promise<CanvasUser> {
    return this.get("/api/v1/users/self");
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

  private url(path: string, params: Params): string {
    const url = new URL(path, this.origin);
    for (const [key, value] of params) url.searchParams.append(key, value);
    return url.toString();
  }

  private async request(url: string): Promise<{ body: unknown; link: string | null }> {
    for (let attempt = 0; ; attempt += 1) {
      const delay = this.retryDelayMs * 2 ** attempt;
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          headers: { Authorization: `Bearer ${this.options.token}`, Accept: "application/json" },
          // A redirect could carry the token to another host.
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        if (attempt < this.retries) {
          await sleep(delay);
          continue;
        }
        throw new CanvasError("UNREACHABLE", "Canvas did not respond. Check the address or try again later.");
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
      throw errorFor(response.status, throttled);
    }
  }
}
