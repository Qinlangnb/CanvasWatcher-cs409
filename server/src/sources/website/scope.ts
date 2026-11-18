// Conservative URL rules for course websites. Discovery never grants authentication scope: a
// password is only ever sent to URLs that pass `inAuthScope` against the configured website.

const SPLIT = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#([\s\S]*))?$/;

/** urlsplit-style view of the raw string; the WHATWG parser would silently resolve `%2e%2e` and `\`. */
export interface RawUrl {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string | null;
}

export function splitUrl(value: string): RawUrl | null {
  const match = SPLIT.exec(value);
  if (!match) return null;
  return {
    scheme: (match[1] ?? "").toLowerCase(),
    netloc: match[2] ?? "",
    path: match[3] ?? "",
    query: match[4] ?? "",
    fragment: match[5] ?? null,
  };
}

const hasControl = (value: string) => /[\u0000-\u001f\u007f\\]/.test(value);
const hasPercentEscape = (value: string) => /%[0-9a-fA-F]{2}/.test(value);
const hasDotSegment = (value: string) => value.split("/").some((part) => part === "." || part === "..");

function hostAndPort(value: string): { host: string; port: string } | null {
  try {
    const url = new URL(value);
    const port = url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
    return url.hostname ? { host: url.hostname.toLowerCase(), port } : null;
  } catch {
    return null;
  }
}

/** True when `url` may receive the website's credential: same https origin, path inside `prefix`. */
export function inAuthScope(url: string, baseUrl: string, prefix: string): boolean {
  if (hasControl(url + baseUrl)) return false;
  const target = splitUrl(url);
  const base = splitUrl(baseUrl);
  if (!target || !base || target.scheme !== "https" || base.scheme !== "https") return false;
  if (target.netloc.includes("@") || base.netloc.includes("@")) return false;
  const targetHost = hostAndPort(url);
  const baseHost = hostAndPort(baseUrl);
  if (!targetHost || !baseHost || targetHost.host !== baseHost.host || targetHost.port !== baseHost.port) return false;
  // Reject ambiguous encodings rather than trusting proxy or server decoding rules.
  const path = target.path || "/";
  if (hasPercentEscape(path) || hasPercentEscape(prefix)) return false;
  if (hasDotSegment(path) || hasDotSegment(prefix)) return false;
  if (prefix.includes("\\") || !prefix.startsWith("/") || path.includes("//")) return false;
  const root = prefix.replace(/\/+$/, "");
  return path === root || path.startsWith(root + "/");
}

/** A website base URL as stored: http(s), no credentials, query or fragment, no trailing slash. */
export function normalizedHttpUrl(value: string): string {
  if (hasControl(value)) throw new Error("Website URL contains invalid characters");
  const parts = splitUrl(value.trim());
  if (!parts || (parts.scheme !== "http" && parts.scheme !== "https") || !hostAndPort(value.trim())) {
    throw new Error("Base URL must be an absolute HTTP or HTTPS URL");
  }
  if (parts.netloc.includes("@") || parts.query || parts.fragment) {
    throw new Error("Website base URL must not contain credentials, query parameters or a fragment");
  }
  return `${parts.scheme}://${parts.netloc.toLowerCase()}${parts.path.replace(/\/+$/, "")}`;
}

const SECRET_QUERY_KEY =
  /token|password|secret|signature|credential|authorization|cookie|session|sessid|api.?key|^sid$|^code$|^t$|^sig$|^key$|^auth$|^x-amz-|^x-goog-/i;

/** A protected test page: HTTPS, ≤512 characters, no credentials or signed/secret query keys. */
export function normalizedProbeUrl(value: string): string {
  if (value.length > 512 || hasControl(value)) throw new Error("Protected test page contains invalid characters");
  const parts = splitUrl(value.trim());
  if (!parts || parts.scheme !== "https" || !hostAndPort(value.trim()) || parts.netloc.includes("@")) {
    throw new Error("Protected test page must be an absolute HTTPS URL without credentials");
  }
  for (const key of new URLSearchParams(parts.query).keys()) {
    if (SECRET_QUERY_KEY.test(key)) {
      throw new Error("Protected test page must not contain secret or signed query parameters");
    }
  }
  return `https://${parts.netloc.toLowerCase()}${parts.path}${parts.query ? `?${parts.query}` : ""}`;
}

/** A user-entered protected path, as `/a/b/`; "" when blank. */
export function protectedPrefix(value: string | null | undefined): string {
  let prefix = (value ?? "").trim();
  if (!prefix) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(prefix) || prefix.startsWith("//") || prefix.includes("?") || prefix.includes("#")) {
    throw new Error("Protected path prefix must be a URL path");
  }
  if (!prefix.startsWith("/")) prefix = `/${prefix}`;
  return `${prefix.replace(/\/+$/, "")}/`;
}

/** The directory a website URL lives in: `/c/fa26/index.html` -> `/c/fa26/`. */
export function courseDirectory(baseUrl: string): string {
  let path = splitUrl(baseUrl)?.path || "/";
  if ((path.split("/").pop() ?? "").includes(".")) path = path.slice(0, path.lastIndexOf("/") + 1);
  return path;
}

/**
 * The NTLM scope and probe target for a website. Defaults to the course directory of the base
 * URL; an explicit prefix must lie inside it, and the probe must lie inside the scope.
 */
export function websiteNtlmScope(
  baseUrl: string,
  prefix?: string | null,
  probe?: string | null,
): { scope: string; target: string } {
  const course = protectedPrefix(courseDirectory(baseUrl));
  const scope = protectedPrefix(prefix) || course;
  const origin = splitUrl(baseUrl);
  const scopedUrl = origin ? `${origin.scheme}://${origin.netloc}${scope}` : "";
  if (!inAuthScope(scopedUrl, baseUrl, course)) {
    throw new Error("NTLM requires HTTPS and a protected path within this course website");
  }
  const target = probe ? normalizedProbeUrl(probe) : baseUrl;
  if (probe && !inAuthScope(target, baseUrl, scope)) {
    throw new Error("Protected test page must be within this website's protected scope");
  }
  return { scope, target };
}

/** Same scheme, host and port. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
