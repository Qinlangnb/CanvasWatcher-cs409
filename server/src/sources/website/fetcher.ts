// Course-website fetcher. Every URL is tried anonymously first; a password is only sent when
// the server answers 401 with an NTLM/Negotiate challenge, the URL is inside the configured
// HTTPS scope, and then only over a dedicated keep-alive connection that never follows a redirect.
import {
  authenticateMessage,
  challengeToken,
  detectAuthScheme,
  negotiateMessage,
  parseChallengeMessage,
  type AuthScheme,
  type NtlmCredential,
} from "../ntlm.js";
import { links, parseHtml } from "../html.js";
import { DEFAULT_LIMITS, header, nodeTransport, TransportError, type HttpConnection, type HttpTransport, type RawResponse, type RequestLimits } from "./http.js";
import { inAuthScope, normalizedHttpUrl, normalizedProbeUrl, sameOrigin, websiteNtlmScope } from "./scope.js";

export type FetchStatus = "ok" | "not_modified" | "auth_required" | "auth_failed" | "not_found" | "error";

export interface FetchResult {
  status: FetchStatus;
  /** Final URL after same-scope redirects. */
  url: string;
  statusCode: number | null;
  content: Buffer | null;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  contentLength: number | null;
  authScheme: AuthScheme | null;
  authenticated: boolean;
  error: string | null;
  /**
   * A 2xx answer whose body is over the size limit: status "ok", no content, the size (at least the
   * limit when the server did not declare one) in `contentLength`. Listed as a file, never stored.
   */
  tooLarge?: boolean;
}

export interface AuthRule {
  /** Path the credential is valid for, e.g. `/course/fa26/secure/`. */
  pathPrefix: string;
  /** The website base URL the rule belongs to (origin + course path). */
  baseUrl: string;
  credentialId: string;
}

/** Looks up the decrypted credential for a rule at fetch time; null when none is stored. */
export type CredentialLookup = (credentialId: string) => NtlmCredential | null | Promise<NtlmCredential | null>;

export interface FetchOptions {
  /** Which redirect targets may be followed anonymously; default: same origin as the request. */
  redirectAllowed?: (url: string) => boolean;
  limits?: Partial<RequestLimits>;
  /** Validators of the stored copy, sent as If-None-Match / If-Modified-Since: an unchanged file answers 304. */
  validators?: { etag?: string | null; lastModified?: string | null };
}

const MAX_REDIRECTS = 5;

/** Conditional request headers; a value that isn't a plain header string is left out. */
function conditionalHeaders(validators: FetchOptions["validators"]): Record<string, string> {
  const headers: Record<string, string> = {};
  const plain = (value: string | null | undefined): value is string => !!value && /^[\x20-\x7e]{1,512}$/.test(value);
  if (plain(validators?.etag)) headers["If-None-Match"] = validators.etag;
  if (plain(validators?.lastModified)) headers["If-Modified-Since"] = validators.lastModified;
  return headers;
}

function failure(url: string, error: string, extra: Partial<FetchResult> = {}): FetchResult {
  return {
    status: "error",
    url,
    statusCode: null,
    content: null,
    contentType: null,
    etag: null,
    lastModified: null,
    contentLength: null,
    authScheme: null,
    authenticated: false,
    error,
    ...extra,
  };
}

/** A 2xx response cut off at `maxBytes`, as a body-less "ok" result; anything else stays a failure. */
function oversizedResult(error: TransportError, limits: RequestLimits, authenticated: boolean): FetchResult | null {
  const response = error.response;
  if (error.code !== "response_too_large" || !response || response.status < 200 || response.status >= 300) return null;
  const result = statusResult({ url: response.url, status: response.status, headers: response.headers, body: Buffer.alloc(0) }, authenticated);
  // Without a Content-Length the real size is unknown: it is stored as 0 and shown as "over the limit".
  return { ...result, content: null, contentLength: response.declaredBytes ?? null, error: "response_too_large", tooLarge: true };
}

export function statusResult(response: RawResponse, authenticated: boolean): FetchResult {
  const lengthText = header(response.headers, "content-length");
  const length = lengthText !== undefined && /^\d+$/.test(lengthText) ? Number(lengthText) : null;
  const common = {
    url: response.url,
    statusCode: response.status,
    content: null,
    contentType: header(response.headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase() || null,
    etag: header(response.headers, "etag") ?? null,
    lastModified: header(response.headers, "last-modified") ?? null,
    contentLength: length,
    authScheme: detectAuthScheme(response.headers["www-authenticate"]),
    authenticated,
    error: null,
  };
  const status = response.status;
  if (status >= 200 && status < 300) return { ...common, status: "ok", content: response.body };
  if (status === 304) return { ...common, status: "not_modified" };
  if (status === 401) return { ...common, status: authenticated ? "auth_failed" : "auth_required" };
  if (status === 404) return { ...common, status: "not_found" };
  return { ...common, status: "error", error: `http_${status}` };
}

/** A tiny counting semaphore; keeps at most `limit` NTLM handshakes in flight across all users. */
class Semaphore {
  private waiting: (() => void)[] = [];
  private active = 0;
  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/**
 * NTLM handshake on one connection: Type 1, read the Type 2 challenge, Type 3. The response is
 * returned as is, redirects included; the caller must have checked scope and HTTPS.
 */
export async function ntlmExchange(
  connection: HttpConnection,
  url: string,
  scheme: AuthScheme,
  credential: NtlmCredential,
  limits: RequestLimits,
  extraHeaders: Record<string, string> = {},
): Promise<FetchResult> {
  const first = await connection.get(url, { ...extraHeaders, Authorization: `${scheme} ${negotiateMessage().toString("base64")}` }, limits);
  if (first.status !== 401) return statusResult(first, true);
  const token = challengeToken(first.headers["www-authenticate"], scheme);
  if (!token) return { ...statusResult(first, true), error: "ntlm_challenge_missing" };
  const challenge = parseChallengeMessage(token);
  const answer = authenticateMessage(challenge, credential).toString("base64");
  return statusResult(await connection.get(url, { ...extraHeaders, Authorization: `${scheme} ${answer}` }, limits), true);
}

interface PooledConnection {
  credential: NtlmCredential;
  connection: HttpConnection;
  queue: Promise<unknown>;
}

export interface ResourceFetcherOptions {
  transport?: HttpTransport;
  credentials?: CredentialLookup;
  /** Global NTLM concurrency; the original service used 3. */
  ntlmConcurrency?: number;
  limits?: Partial<RequestLimits>;
}

export class ResourceFetcher {
  private readonly transport: HttpTransport;
  private readonly credentials: CredentialLookup;
  private readonly limits: RequestLimits;
  private readonly ntlmLimit: Semaphore;
  private readonly pool = new Map<string, PooledConnection>();
  private anonymousConnection: HttpConnection | null = null;

  constructor(options: ResourceFetcherOptions = {}) {
    this.transport = options.transport ?? nodeTransport();
    this.credentials = options.credentials ?? (() => null);
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.ntlmLimit = new Semaphore(options.ntlmConcurrency ?? 3);
  }

  private get anonymous(): HttpConnection {
    this.anonymousConnection ??= this.transport.open({ maxSockets: 4 });
    return this.anonymousConnection;
  }

  /** Anonymous GET; follows at most five redirects, each one checked by `redirectAllowed`. */
  async fetchAnonymous(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const limits = { ...this.limits, ...options.limits };
    const allowed = options.redirectAllowed ?? ((next: string) => sameOrigin(next, url));
    const conditional = conditionalHeaders(options.validators);
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let response: RawResponse;
      try {
        response = await this.anonymous.get(current, conditional, limits);
      } catch (error) {
        if (error instanceof TransportError) return oversizedResult(error, limits, false) ?? failure(current, error.code);
        return failure(current, "http_client_error");
      }
      const location = header(response.headers, "location");
      if (response.status < 300 || response.status >= 400 || response.status === 304 || !location) {
        return statusResult(response, false);
      }
      let next: string;
      try {
        next = new URL(location, current).href.split("#", 1)[0] ?? "";
      } catch {
        return failure(current, "redirect_invalid", { statusCode: response.status });
      }
      // Never downgrade to http, never leave the caller's scope.
      if ((current.startsWith("https:") && !next.startsWith("https:")) || !allowed(next)) {
        return failure(current, "redirect_out_of_scope", { statusCode: response.status });
      }
      current = next;
    }
    return failure(current, "too_many_redirects");
  }

  async fetch(url: string, rule: AuthRule | null = null, options: FetchOptions = {}): Promise<FetchResult> {
    if (!rule) return this.fetchAnonymous(url, options);
    if (!inAuthScope(url, rule.baseUrl, rule.pathPrefix)) return failure(url, "auth_scope_rejected");
    const publicResult = await this.fetchAnonymous(url, options);
    if (publicResult.statusCode !== 401 || !publicResult.authScheme) return publicResult;
    // Anonymous redirects do not confer trust on their final destination.
    if (!inAuthScope(publicResult.url, rule.baseUrl, rule.pathPrefix)) return failure(url, "auth_scope_rejected");
    const credential = await this.credentials(rule.credentialId);
    if (!credential) {
      return failure(url, "credential_not_loaded", { status: "auth_required", authScheme: publicResult.authScheme });
    }
    return this.authenticated(
      publicResult.url,
      rule.credentialId,
      credential,
      publicResult.authScheme,
      { ...this.limits, ...options.limits },
      conditionalHeaders(options.validators),
    );
  }

  private authenticated(
    url: string,
    credentialId: string,
    credential: NtlmCredential,
    scheme: AuthScheme,
    limits: RequestLimits,
    extraHeaders: Record<string, string> = {},
  ): Promise<FetchResult> {
    let pooled = this.pool.get(credentialId);
    if (!pooled || pooled.credential !== credential) {
      pooled?.connection.close();
      pooled = { credential, connection: this.transport.open({ maxSockets: 1 }), queue: Promise.resolve() };
      this.pool.set(credentialId, pooled);
    }
    const entry = pooled;
    // One request at a time per credential: the handshake owns the connection until it finishes.
    const run = entry.queue.then(() =>
      this.ntlmLimit.run(async () => {
        try {
          return await ntlmExchange(entry.connection, url, scheme, credential, limits, extraHeaders);
        } catch (error) {
          // A broken handshake leaves the socket in an unknown auth state; start over next time.
          if (this.pool.get(credentialId) === entry) this.invalidate(credentialId);
          const oversized = error instanceof TransportError ? oversizedResult(error, limits, true) : null;
          if (oversized) return oversized;
          return failure(url, error instanceof TransportError ? error.code : "ntlm_handshake_failed", {
            authenticated: true,
          });
        }
      }),
    );
    entry.queue = run.catch(() => undefined);
    return run;
  }

  /** Drops the connection of one credential, e.g. after it was replaced or failed at runtime. */
  invalidate(credentialId: string): void {
    this.pool.get(credentialId)?.connection.close();
    this.pool.delete(credentialId);
  }

  close(): void {
    for (const id of [...this.pool.keys()]) this.invalidate(id);
    this.anonymousConnection?.close();
    this.anonymousConnection = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Candidate probe for the "Test connection" button and before saving a new password.

export interface WebsiteProbeConfig {
  baseUrl: string;
  authenticationMethod: "none" | "ntlm";
  protectedPathPrefix?: string | null;
  probeUrl?: string | null;
}

export interface WebsiteProbeResult {
  /** True only when a protected page answered 200 to the candidate credential. */
  verified: boolean;
  message: string;
  /** The site answered, but no protected page was found to test the password on. */
  publicOnly: boolean;
  /** The protected page that verified, worth storing as the probe URL. */
  probeUrl: string | null;
}

export class WebsiteProbeError extends Error {}

const PROBE_REQUESTS = 6;
const PROBE_HTML_BYTES = 1_000_000;

/**
 * Tests a candidate credential without touching stored state. Only the probe URL, real in-scope
 * `<a href>` links and the base page are visited, six requests at most; no paths are guessed.
 * Throws `WebsiteProbeError` with a user-facing message when the site or the password fails.
 */
export async function probeWebsite(
  config: WebsiteProbeConfig,
  candidate: NtlmCredential | null,
  options: { transport?: HttpTransport; limits?: Partial<RequestLimits> } = {},
): Promise<WebsiteProbeResult> {
  let base: string;
  try {
    base = normalizedHttpUrl(config.baseUrl);
  } catch (error) {
    throw new WebsiteProbeError((error as Error).message);
  }
  const trialId = "website-trial";
  // A throwaway fetcher: the candidate never enters the shared connection pool.
  const fetcher = new ResourceFetcher({
    ...options,
    credentials: (id) => (id === trialId ? candidate : null),
  });
  try {
    if (config.authenticationMethod !== "ntlm") {
      const result = await fetcher.fetchAnonymous(base);
      if (result.status !== "ok") throw new WebsiteProbeError("Public website could not be reached");
      return { verified: false, publicOnly: true, probeUrl: null, message: "Public website reachable." };
    }
    if (!candidate?.username.trim()) throw new WebsiteProbeError("Username is required");
    let scope: string;
    let target: string;
    try {
      ({ scope, target } = websiteNtlmScope(base, config.protectedPathPrefix, config.probeUrl));
    } catch (error) {
      throw new WebsiteProbeError((error as Error).message);
    }
    const courseScope = websiteNtlmScope(base).scope;
    const rule: AuthRule = { pathPrefix: scope, baseUrl: base, credentialId: trialId };
    // Public redirects may move around the course site, never off it.
    const inCourse = (url: string) => inAuthScope(url, base, courseScope);
    const queue = [target];
    const visited = new Set<string>();
    let publicReachable = false;
    while (queue.length && visited.size < PROBE_REQUESTS) {
      const url = queue.shift() as string;
      if (visited.has(url)) continue;
      visited.add(url);
      const scoped = inAuthScope(url, base, scope);
      const result = scoped
        ? await fetcher.fetch(url, rule, { redirectAllowed: inCourse })
        : await fetcher.fetchAnonymous(url, { redirectAllowed: inCourse });
      if (result.status === "ok" && result.authenticated) {
        return { verified: true, publicOnly: false, probeUrl: result.url, message: "Protected access verified." };
      }
      if (result.status === "auth_failed" || result.status === "auth_required") {
        throw new WebsiteProbeError("Protected access could not be verified; existing configuration kept");
      }
      if (result.error === "redirect_out_of_scope") {
        throw new WebsiteProbeError("Website redirected outside its trusted course scope");
      }
      if (result.status !== "ok") {
        if (url === target) throw new WebsiteProbeError("Candidate website test page could not be reached");
        continue;
      }
      publicReachable = true;
      if ((result.contentType ?? "").includes("html") && result.content) {
        const document = parseHtml(result.content.subarray(0, PROBE_HTML_BYTES));
        for (const link of links(document)) {
          if (queue.length >= PROBE_REQUESTS - visited.size) break;
          let actual: string;
          try {
            actual = normalizedProbeUrl(new URL(link.href, result.url).href);
          } catch {
            continue;
          }
          if (inAuthScope(actual, base, scope) && !visited.has(actual) && !queue.includes(actual)) queue.push(actual);
        }
      }
      if (url !== base && !visited.has(base) && queue.length === 0) queue.push(base);
    }
    if (publicReachable) {
      return {
        verified: false,
        publicOnly: true,
        probeUrl: null,
        message: "Public website reachable. Protected access not yet verified.",
      };
    }
    throw new WebsiteProbeError("Candidate website could not be reached");
  } finally {
    fetcher.close();
  }
}
