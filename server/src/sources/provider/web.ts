// Read-only, GET-only access to one Gradescope or PrairieLearn instance with the student's own
// session cookies. Redirects are never followed (they would carry the cookies elsewhere); a
// redirect or 401 means the session is gone.
import { attr, byTag, cleanText, findAll, findFirst, parseHtml } from "../html.js";
import { header, nodeTransport, TransportError, type HttpConnection, type HttpTransport } from "../website/http.js";

export type Provider = "gradescope" | "prairielearn";

export type ProviderErrorCode =
  | "PROVIDER_BASE_INVALID"
  | "PROVIDER_PATH_INVALID"
  | "PROVIDER_COOKIES_INVALID"
  | "AUTH_REQUIRED"
  | "PROVIDER_PERMISSION_DENIED"
  | "PROVIDER_RESPONSE_CHANGED"
  | "PROVIDER_RESPONSE_TOO_LARGE"
  | "PROVIDER_NETWORK_ERROR"
  | "PRAIRIELEARN_COURSE_PARSER_NOT_VERIFIED";

export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode) {
    super(code);
  }
}

const MAX_BYTES = 8_000_000;
const TIMEOUT_MS = 20_000;

/** The instance root: HTTPS, no credentials/query/fragment; Gradescope at `/`, PrairieLearn at `/` or `/pl`. */
export function providerBase(provider: string, value: string): string {
  if (/[\u0000- \u007f\\]/.test(value)) throw new ProviderError("PROVIDER_BASE_INVALID");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError("PROVIDER_BASE_INVALID");
  }
  const path = url.pathname.replace(/\/+$/, "");
  const allowedPaths = provider === "gradescope" ? [""] : provider === "prairielearn" ? ["", "/pl"] : [];
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    value.includes("?") ||
    value.includes("#") ||
    !allowedPaths.includes(path)
  ) {
    throw new ProviderError("PROVIDER_BASE_INVALID");
  }
  return `${url.origin}${path}`;
}

export type CookieJar = Record<string, string> | { name: string; value: string }[];

/** A Cookie header from a jar; names and values that could split the header are refused. */
export function cookieHeader(jar: CookieJar): string {
  const entries = Array.isArray(jar) ? jar.map((cookie) => [cookie.name, cookie.value] as const) : Object.entries(jar);
  if (!entries.length) throw new ProviderError("PROVIDER_COOKIES_INVALID");
  return entries
    .map(([name, value]) => {
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || /[\u0000- ",;\\\u007f]/.test(value)) {
        throw new ProviderError("PROVIDER_COOKIES_INVALID");
      }
      return `${name}=${value}`;
    })
    .join("; ");
}

/** Logged-in markers of the student dashboard, as the desktop helper checks them. */
export function authenticatedPage(provider: Provider, html: string): boolean {
  const document = parseHtml(html);
  if (findFirst(document, (element) => element.tagName === "input" && attr(element, "type")?.toLowerCase() === "password")) return false;
  const heading = (text: string) => findAll(document, byTag("h1")).some((h1) => cleanText(h1) === text);
  if (provider === "gradescope") {
    return heading("Course Dashboard") && findAll(document, byTag("a")).some((a) => (attr(a, "href") ?? "").startsWith("/logout"));
  }
  return heading("PrairieLearn Homepage") && findAll(document, byTag("a")).some((a) => attr(a, "href") === "/pl/logout");
}

export class ProviderWeb {
  readonly base: string;
  private readonly cookie: string;
  private readonly connection: HttpConnection;

  constructor(
    readonly provider: Provider,
    baseUrl: string,
    cookies: CookieJar,
    transport: HttpTransport = nodeTransport(),
  ) {
    this.base = providerBase(provider, baseUrl);
    this.cookie = cookieHeader(cookies);
    this.connection = transport.open({ maxSockets: 2 });
  }

  /** GET an HTML page below the instance root. Only plain paths: no `//`, `?`, `#`, `..` or `\`. */
  async get(path = ""): Promise<string> {
    if (path && (!path.startsWith("/") || path.startsWith("//") || /[?#\\]/.test(path) || path.includes(".."))) {
      throw new ProviderError("PROVIDER_PATH_INVALID");
    }
    let response;
    try {
      response = await this.connection.get(this.base + path, { Cookie: this.cookie, Accept: "text/html" }, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
    } catch (error) {
      if (error instanceof TransportError && error.code === "response_too_large") throw new ProviderError("PROVIDER_RESPONSE_TOO_LARGE");
      throw new ProviderError("PROVIDER_NETWORK_ERROR");
    }
    if ([301, 302, 303, 307, 308, 401].includes(response.status)) throw new ProviderError("AUTH_REQUIRED");
    if (response.status === 403) throw new ProviderError("PROVIDER_PERMISSION_DENIED");
    if (response.status !== 200 || !(header(response.headers, "content-type") ?? "").includes("text/html")) {
      throw new ProviderError("PROVIDER_RESPONSE_CHANGED");
    }
    return response.body.toString("utf8");
  }

  /** The dashboard page, after checking it is the logged-in one. */
  async probe(): Promise<string> {
    const html = await this.get(this.provider === "gradescope" ? "/" : "");
    if (!authenticatedPage(this.provider, html)) throw new ProviderError("AUTH_REQUIRED");
    return html;
  }

  close(): void {
    this.connection.close();
  }
}

export interface SessionCheck {
  verified: boolean;
  /** AUTH_REQUIRED, PROVIDER_NETWORK_ERROR, ... when not verified. */
  code: ProviderErrorCode | null;
}

/** Checks that imported cookies open the student's dashboard. Never throws for a bad session. */
export async function verifySession(
  provider: Provider,
  baseUrl: string,
  cookies: CookieJar,
  transport?: HttpTransport,
): Promise<SessionCheck> {
  let client: ProviderWeb | null = null;
  try {
    client = new ProviderWeb(provider, baseUrl, cookies, transport);
    await client.probe();
    return { verified: true, code: null };
  } catch (error) {
    if (error instanceof ProviderError) return { verified: false, code: error.code };
    throw error;
  } finally {
    client?.close();
  }
}
