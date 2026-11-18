import { createHash } from "node:crypto";

const TRACKING_PARAMETERS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid"]);

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * One spelling per resource so a page linked as `x//a.pdf?utm_source=mail&b=2&a=1#p` and
 * `x/a.pdf?a=1&b=2` is fetched and stored once: lower-case origin, collapsed slashes, sorted
 * query without tracking parameters, no fragment. Throws on an unparseable URL.
 */
export function canonicalizeUrl(url: string, base?: string): string {
  const parsed = base ? new URL(url, base) : new URL(url);
  const query = [...parsed.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith("utm_") && !TRACKING_PARAMETERS.has(key.toLowerCase()))
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const search = new URLSearchParams(query).toString();
  const path = parsed.pathname.replace(/\/{2,}/g, "/") || "/";
  return `${parsed.protocol}//${parsed.host}${path}${search ? `?${search}` : ""}`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Key-order independent JSON, so equal content always hashes the same. */
export function stableJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

export function contentHash(structured: Record<string, unknown>, normalizedText = ""): string {
  return createHash("sha256")
    .update(stableJson({ structured, text: normalizeText(normalizedText) }), "utf8")
    .digest("hex");
}
