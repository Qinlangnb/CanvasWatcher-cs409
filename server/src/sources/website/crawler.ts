// Course website crawler: breadth-first over same-origin links inside the course path, with a
// depth and page budget. It only reads; the result is a plain object a sync step persists.
import { htmlBlocks, type Block } from "../../canvas/richText.js";
import { cleanText, documentTitle, links, parseHtml } from "../html.js";
import type { AuthRule, FetchResult, FetchStatus } from "./fetcher.js";
import { validateCourseFile, safeFilename, sha256, urlExtension, type IntegrityResult } from "./integrity.js";
import { canonicalizeUrl, normalizeText } from "./normalize.js";
import { courseDirectory, inAuthScope, splitUrl } from "./scope.js";

export const FILE_EXTENSIONS = [
  ".pdf", ".ppt", ".pptx", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".txt", ".md", ".zip", ".ipynb", ".py",
] as const;

const HTML_EXTENSIONS = new Set(["", ".html", ".htm", ".asp", ".aspx"]);

/** What the crawler needs from a fetcher; `ResourceFetcher` satisfies it. */
export interface PageFetcher {
  fetch(url: string, rule: AuthRule | null, options?: { redirectAllowed?: (url: string) => boolean }): Promise<FetchResult>;
}

export interface CrawlConfig {
  /** Shown as the title of an unnamed seed. */
  name: string;
  baseUrl: string;
  /** Seeds; default the base URL. */
  publicPages?: string[];
  authRules?: Omit<AuthRule, "baseUrl">[];
  sameOriginOnly?: boolean;
  /** Default: the course directory of the base URL. */
  allowedPathPrefixes?: string[];
  /** Link depth from a seed, clamped to 0..5 (default 2). */
  maxDepth?: number;
  /** URLs visited per crawl, clamped to 1..10000 (default 100). */
  pathLimit?: number;
  /** Regexes over "label url"; a link must match one include (if any) and no exclude. */
  includePatterns?: string[];
  excludePatterns?: string[];
  /** Added to `FILE_EXTENSIONS`. */
  extensions?: string[];
  /** False keeps file metadata but drops the bytes. */
  download?: boolean;
  /** Pending URLs from the last crawl, retried as explicit seeds. */
  retryUrls?: string[];
}

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
  blocks: Block[];
  html: string;
  etag: string | null;
  lastModified: string | null;
  credentialId: string | null;
}

export interface CrawledFile {
  url: string;
  title: string;
  filename: string;
  contentType: string | null;
  /** Null when downloads are off or the bytes failed validation. */
  content: Buffer | null;
  size: number;
  sha256: string;
  integrity: IntegrityResult;
  etag: string | null;
  lastModified: string | null;
  credentialId: string | null;
}

export type PendingState = "AUTH_REQUIRED" | "DISCOVERED" | "FAILED";

export interface PendingResource {
  url: string;
  title: string;
  itemType: "website_page" | "website_file";
  credentialId: string | null;
  /** auth_required -> AUTH_REQUIRED, not_found -> DISCOVERED, anything else FAILED (as before). */
  state: PendingState;
  fetchStatus: FetchStatus;
  errorCode: string;
}

export type CrawlHealth = "HEALTHY" | "AUTH_REQUIRED" | "DEGRADED";

export interface CrawlResult {
  pages: CrawledPage[];
  files: CrawledFile[];
  pending: PendingResource[];
  /** Sorted error codes for the source's last_error (`discovery_limit_reached` when truncated). */
  errors: string[];
  truncated: boolean;
  health: CrawlHealth;
}

interface QueueEntry {
  url: string;
  depth: number;
  title: string;
}

const clampInt = (value: number | undefined, fallback: number, min: number, max: number) =>
  Math.max(min, Math.min(Math.trunc(Number.isFinite(value) ? (value as number) : fallback), max));

function lastName(url: string): string {
  const path = splitUrl(url)?.path ?? "";
  return path.slice(path.lastIndexOf("/") + 1);
}

function pendingState(status: FetchStatus): PendingState {
  return status === "auth_required" ? "AUTH_REQUIRED" : status === "not_found" ? "DISCOVERED" : "FAILED";
}

/** Health as the old sync judged it: only-auth failures ask for a password, others degrade. */
export function crawlHealth(pending: PendingResource[], truncated: boolean, invalidFiles = 0): CrawlHealth {
  const failures = pending.filter((row) => row.fetchStatus !== "not_found");
  if (failures.length && failures.every((row) => row.fetchStatus === "auth_required" || row.fetchStatus === "auth_failed")) {
    return "AUTH_REQUIRED";
  }
  return failures.length || truncated || invalidFiles ? "DEGRADED" : "HEALTHY";
}

export class WebsiteCrawler {
  readonly baseUrl: string;
  private readonly rules: AuthRule[];
  private readonly prefixes: string[];
  private readonly sameOriginOnly: boolean;
  private readonly maxDepth: number;
  private readonly pathLimit: number;
  private readonly includes: RegExp[];
  private readonly excludes: RegExp[];
  private readonly extensions: Set<string>;

  constructor(
    private readonly config: CrawlConfig,
    private readonly fetcher: PageFetcher,
  ) {
    this.baseUrl = canonicalizeUrl(config.baseUrl);
    this.rules = (config.authRules ?? []).map((rule) => ({ ...rule, baseUrl: this.baseUrl }));
    this.prefixes = config.allowedPathPrefixes ?? [courseDirectory(this.baseUrl) || "/"];
    this.sameOriginOnly = config.sameOriginOnly ?? true;
    this.maxDepth = clampInt(config.maxDepth, 2, 0, 5);
    this.pathLimit = clampInt(config.pathLimit, 100, 1, 10_000);
    this.includes = (config.includePatterns ?? []).map((pattern) => new RegExp(pattern));
    this.excludes = (config.excludePatterns ?? []).map((pattern) => new RegExp(pattern));
    this.extensions = new Set([...FILE_EXTENSIONS, ...(config.extensions ?? []).map((value) => value.toLowerCase())]);
  }

  /** The most specific rule whose scope holds the URL. */
  authRuleFor(url: string): AuthRule | null {
    return this.rules
      .filter((rule) => inAuthScope(url, this.baseUrl, rule.pathPrefix))
      .reduce<AuthRule | null>((best, rule) => (!best || rule.pathPrefix.length > best.pathPrefix.length ? rule : best), null);
  }

  /** Same origin, inside an allowed prefix, no credentials or dot segments. */
  allowed(url: string): boolean {
    let target: URL;
    let base: URL;
    try {
      target = new URL(url);
      base = new URL(this.baseUrl);
    } catch {
      return false;
    }
    if ((target.protocol !== "http:" && target.protocol !== "https:") || target.username || target.password) return false;
    let path: string;
    try {
      path = decodeURIComponent(target.pathname);
    } catch {
      return false;
    }
    if (path.includes("\\") || path.split("/").some((part) => part === "." || part === "..")) return false;
    if (this.sameOriginOnly && target.origin !== base.origin) return false;
    return (
      this.prefixes.length === 0 ||
      this.prefixes.some((prefix) => {
        const root = prefix.replace(/\/+$/, "");
        return path === root || path.startsWith(root + "/");
      })
    );
  }

  private included(label: string, url: string): boolean {
    const searchable = `${label} ${url}`;
    if (this.includes.length && !this.includes.some((rule) => rule.test(searchable))) return false;
    return !this.excludes.some((rule) => rule.test(searchable));
  }

  private isFileUrl(url: string): boolean {
    return this.extensions.has(urlExtension(url));
  }

  private pending(url: string, title: string, result: Pick<FetchResult, "status" | "error" | "statusCode">, rule: AuthRule | null): PendingResource {
    return {
      url,
      title,
      itemType: this.isFileUrl(url) ? "website_file" : "website_page",
      credentialId: rule?.credentialId ?? null,
      state: pendingState(result.status),
      fetchStatus: result.status,
      errorCode: result.error ?? result.status,
    };
  }

  private canonical(href: string, base: string): string | null {
    // The WHATWG parser turns `\` into `/`; treat such links as hostile instead.
    if (!href || href.includes("\\")) return null;
    try {
      return canonicalizeUrl(href, base);
    } catch {
      return null;
    }
  }

  async crawl(): Promise<CrawlResult> {
    const queue: QueueEntry[] = [];
    for (const seed of this.config.publicPages?.length ? this.config.publicPages : [this.baseUrl]) {
      const url = this.canonical(seed, this.baseUrl);
      if (url) queue.push({ url, depth: 0, title: lastName(seed) || this.config.name });
    }
    // Pending resources are explicit seeds, not children of the landing page; scope still applies.
    for (const retry of this.config.retryUrls ?? []) {
      const url = this.canonical(retry, this.baseUrl);
      if (url && this.included("", url)) queue.push({ url, depth: 0, title: lastName(url) });
    }
    const seen = new Set<string>();
    const pages: CrawledPage[] = [];
    const files: CrawledFile[] = [];
    const pending: PendingResource[] = [];
    let truncated = false;
    const redirectAllowed = (url: string) => this.allowed(url);

    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const { url, depth, title } = entry;
      if (seen.has(url) || !this.allowed(url)) continue;
      if (seen.size >= this.pathLimit) {
        truncated = true;
        break;
      }
      seen.add(url);
      const rule = this.authRuleFor(url);
      const result = await this.fetcher.fetch(url, rule, { redirectAllowed });
      if (result.status !== "ok" || !result.content) {
        pending.push(this.pending(url, title, result, rule));
        continue;
      }
      // An HTML type or page-like path is a page, except at a file URL: a login page served for
      // lecture.pdf must reach the integrity check, not be stored as a page.
      const html = !this.isFileUrl(url) && (result.contentType === "text/html" || HTML_EXTENSIONS.has(urlExtension(url)));
      if (!html) {
        files.push(this.file(url, title, result, rule));
        continue;
      }
      // Resolve links against the final URL after a redirect (/fa26 -> /fa26/), not the seed.
      const pageUrl = this.canonical(result.url, url) ?? url;
      if (!this.allowed(pageUrl)) {
        pending.push(this.pending(url, title, { status: "error", error: "discovery_scope_rejected", statusCode: null }, rule));
        continue;
      }
      const source = result.content.toString("utf8");
      const document = parseHtml(source);
      pages.push({
        url,
        title: normalizeText(documentTitle(document) ?? "") || title,
        text: cleanText(document),
        blocks: htmlBlocks(source),
        html: source,
        etag: result.etag,
        lastModified: result.lastModified,
        credentialId: rule?.credentialId ?? null,
      });
      if (depth >= this.maxDepth) continue;
      for (const link of links(document)) {
        const linked = this.canonical(link.href, pageUrl);
        if (!linked || !this.allowed(linked) || !this.included(link.label, linked)) continue;
        queue.push({ url: linked, depth: depth + 1, title: link.label || lastName(linked) || linked });
      }
    }
    const errors = new Set<string>(pending.filter((row) => row.fetchStatus !== "not_found").map((row) => row.fetchStatus));
    if (truncated) errors.add("discovery_limit_reached");
    const invalidFiles = files.filter((file) => !file.integrity.valid).length;
    if (invalidFiles) errors.add("invalid_download");
    return { pages, files, pending, errors: [...errors].sort(), truncated, health: crawlHealth(pending, truncated, invalidFiles) };
  }

  private file(url: string, title: string, result: FetchResult, rule: AuthRule | null): CrawledFile {
    const content = result.content ?? Buffer.alloc(0);
    const filename = safeFilename(url, null, result.contentType);
    const integrity = validateCourseFile(content, {
      url,
      filename,
      mimeType: result.contentType,
      expectedLength: result.contentLength,
      httpStatus: result.statusCode,
    });
    const keep = integrity.valid && this.config.download !== false;
    return {
      url,
      title,
      filename,
      contentType: result.contentType,
      content: keep ? content : null,
      size: content.length,
      sha256: sha256(content),
      integrity,
      etag: result.etag,
      lastModified: result.lastModified,
      credentialId: rule?.credentialId ?? null,
    };
  }
}

export function crawlWebsite(config: CrawlConfig, fetcher: PageFetcher): Promise<CrawlResult> {
  return new WebsiteCrawler(config, fetcher).crawl();
}
