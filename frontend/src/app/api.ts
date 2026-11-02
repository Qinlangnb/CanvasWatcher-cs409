import { withBasePath } from "../publicPath";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The server's CSRF cookie, echoed in a header on every change (double-submit). */
export function readCsrfCookie(cookie: string): string | null {
  for (const entry of cookie.split(";")) {
    const [name, ...rest] = entry.split("=");
    if (name?.trim() !== "aw_csrf") continue;
    const value = rest.join("=").trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/** An API error with the server's sentence, its code, and per-field messages for forms. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

interface ErrorBody {
  detail?: unknown;
  code?: unknown;
}

function toApiError(status: number, body: ErrorBody | null): ApiError {
  const code = typeof body?.code === "string" ? body.code : "HTTP_ERROR";
  if (Array.isArray(body?.detail)) {
    const fields: Record<string, string> = {};
    for (const item of body.detail as { loc?: unknown[]; msg?: unknown }[]) {
      const field = item.loc?.at(-1);
      if (typeof field === "string" && typeof item.msg === "string") fields[field] ??= item.msg;
    }
    const first = Object.values(fields)[0];
    return new ApiError(status, code, first ?? "Check the highlighted fields.", fields);
  }
  if (typeof body?.detail === "string") return new ApiError(status, code, body.detail);
  if (status >= 500) return new ApiError(status, code, "The server had a problem. Try again in a moment.");
  return new ApiError(status, code, `The request failed (${status}).`);
}

/** Calls the CanvasWatcher API. Sends the CSRF header on changes; returns undefined for 204. */
export async function request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (MUTATING.has(method)) {
    const csrf = readCsrfCookie(document.cookie);
    if (csrf) headers.set("X-AW-CSRF", csrf);
  }
  let response: Response;
  try {
    response = await fetch(withBasePath(path), {
      method,
      headers,
      credentials: "same-origin",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach CanvasWatcher. Check your connection and try again.");
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw toApiError(response.status, body as ErrorBody | null);
  return body as T;
}

export const isApiError = (error: unknown, status?: number, code?: string): error is ApiError =>
  error instanceof ApiError && (status === undefined || error.status === status) && (code === undefined || error.code === code);

/** Same-origin URL for links the browser follows itself, such as downloads. */
export const apiHref = (path: string) => withBasePath(path);
