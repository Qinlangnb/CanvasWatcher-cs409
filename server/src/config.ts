import { z } from "zod";

/**
 * "/cs409/" becomes "/cs409" and the site root becomes "". Null unless the value is an absolute path of
 * plain segments (the same rule as the frontend's VITE_PUBLIC_BASE, plus no characters a cookie path rejects).
 */
export function normalizeBasePath(value: string): string | null {
  const path = value.trim().replace(/\/+$/, "");
  if (!path) return "";
  if (!path.startsWith("/") || /[?#;,\s]/.test(path)) return null;
  const segments = path.slice(1).split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..") ? path : null;
}

const environment = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  /** 32 random bytes, base64 or base64url. Encrypts stored Canvas tokens; losing it means users reconnect. */
  CREDENTIALS_KEY: z
    .string()
    .refine((value) => Buffer.from(value, "base64").length === 32, "CREDENTIALS_KEY must encode exactly 32 bytes"),
  /** Comma-separated browser origins allowed to send state-changing requests. */
  ALLOWED_ORIGINS: z.string().default("http://localhost:5173,http://localhost:8080"),
  /** Comma-separated Canvas hosts users may connect; `*.example.com` matches subdomains. */
  CANVAS_ALLOWED_HOSTS: z.string().default("canvas.illinois.edu,*.instructure.com"),
  /** Minutes between automatic syncs of each connected account; 0 turns the scheduler off. */
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(30),
  /** Overrides the default, which is Secure cookies whenever every allowed origin is HTTPS. */
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  /**
   * The path the app is served under, such as /cs409 (matching the frontend's VITE_PUBLIC_BASE). The
   * sign-in cookies are scoped to it, so another app on the same site cannot overwrite them.
   */
  PUBLIC_BASE_PATH: z
    .string()
    .default("/")
    .refine((value) => normalizeBasePath(value) !== null, "PUBLIC_BASE_PATH must be an absolute path such as /cs409"),
  /** Number of reverse proxies in front of the API, used to find the client address. */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /**
   * Username of the account whose data the sign-in page's Preview button copies, with that person's
   * identity taken out. Empty turns previews off.
   */
  PREVIEW_SOURCE_USERNAME: z.string().trim().max(64).default(""),
  /**
   * AI Chat: an OpenAI-compatible chat completions API (DeepSeek by default). One key serves every
   * account, previews included. An empty key turns AI Chat off.
   */
  AI_API_KEY: z.string().trim().default(""),
  AI_BASE_URL: z
    .string()
    .trim()
    .default("https://api.deepseek.com/v1")
    .refine((value) => /^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/.test(value), "AI_BASE_URL must be an http(s) URL without a query"),
  AI_MODEL: z.string().trim().min(1).max(100).default("deepseek-flash"),
  /**
   * Lets users pick a local Ollama in Settings > AI API. Off by default: on a hosted server those
   * addresses reach into the server's own network.
   */
  AI_ALLOW_LOCAL: z.enum(["true", "false"]).default("false"),
  /**
   * The desktop Auth Broker the browser talks to for browser sign-in (see auth-broker/). It always runs
   * on the student's own computer, so this is a loopback address.
   */
  AUTH_BROKER_URL: z
    .string()
    .trim()
    .default("http://127.0.0.1:8765")
    .refine((value) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(value), "AUTH_BROKER_URL must be a loopback http origin with a port"),
  /**
   * Canvas OAuth2 (optional): a Canvas developer key. All three must be set; the redirect URI must be
   * `<public site>/<PUBLIC_BASE_PATH>/api/auth/canvas/oauth/callback` (https) or a loopback http address.
   */
  CANVAS_OAUTH_CLIENT_ID: z.string().trim().default(""),
  CANVAS_OAUTH_CLIENT_SECRET: z.string().trim().default(""),
  CANVAS_OAUTH_REDIRECT_URI: z.string().trim().default(""),
});

export interface Config {
  env: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  credentialsKey: Buffer;
  allowedOrigins: string[];
  canvasAllowedHosts: string[];
  syncIntervalMinutes: number;
  secureCookies: boolean;
  /** Path attribute of the session and CSRF cookies: PUBLIC_BASE_PATH, or "/" at the site root. */
  cookiePath: string;
  trustProxy: number;
  logLevel: string;
  /** Username previews copy, or null when previews are off. */
  previewSource: string | null;
  /** AI Chat's provider, or null when it is off. */
  ai: AiConfig | null;
  /** Whether users may choose a local Ollama as their own AI provider. */
  aiAllowLocal: boolean;
  /** PUBLIC_BASE_PATH without a trailing slash; "" at the site root. */
  basePath: string;
  authBrokerUrl: string;
  /** Canvas OAuth2, or null when it is not set up (or set up wrongly). */
  canvasOAuth: CanvasOAuthConfig | null;
}

export interface CanvasOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * The redirect URI must come back to this API's callback: on a loopback http address while developing,
 * otherwise over https under PUBLIC_BASE_PATH. No query, fragment or user name, which a redirect could abuse.
 */
export function oauthRedirectAllowed(value: string, basePath: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash || value.includes("#") || value.includes("?")) return false;
  if (url.protocol === "http:") {
    return ["localhost", "127.0.0.1"].includes(url.hostname) && url.port !== "" && url.pathname === "/api/auth/canvas/oauth/callback";
  }
  return url.protocol === "https:" && url.pathname === `${basePath}/api/auth/canvas/oauth/callback`;
}

export interface AiConfig {
  /** Chat completions are posted to `${baseUrl}/chat/completions`. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = environment.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid server configuration:\n${problems.join("\n")}`);
  }
  const values = parsed.data;
  const allowedOrigins = list(values.ALLOWED_ORIGINS).map((origin) => origin.replace(/\/+$/, ""));
  const basePath = normalizeBasePath(values.PUBLIC_BASE_PATH) ?? "";
  return {
    env: values.NODE_ENV,
    port: values.PORT,
    databaseUrl: values.DATABASE_URL,
    sessionSecret: values.SESSION_SECRET,
    credentialsKey: Buffer.from(values.CREDENTIALS_KEY, "base64"),
    allowedOrigins,
    canvasAllowedHosts: list(values.CANVAS_ALLOWED_HOSTS).map((host) => host.toLowerCase()),
    syncIntervalMinutes: values.SYNC_INTERVAL_MINUTES,
    secureCookies: values.COOKIE_SECURE
      ? values.COOKIE_SECURE === "true"
      : allowedOrigins.every((origin) => origin.startsWith("https://")),
    cookiePath: basePath || "/",
    trustProxy: values.TRUST_PROXY,
    logLevel: values.LOG_LEVEL,
    previewSource: values.PREVIEW_SOURCE_USERNAME || null,
    ai: values.AI_API_KEY
      ? { baseUrl: values.AI_BASE_URL.replace(/\/+$/, ""), apiKey: values.AI_API_KEY, model: values.AI_MODEL }
      : null,
    aiAllowLocal: values.AI_ALLOW_LOCAL === "true",
    basePath,
    authBrokerUrl: values.AUTH_BROKER_URL,
    canvasOAuth:
      values.CANVAS_OAUTH_CLIENT_ID && values.CANVAS_OAUTH_CLIENT_SECRET && oauthRedirectAllowed(values.CANVAS_OAUTH_REDIRECT_URI, basePath)
        ? {
            clientId: values.CANVAS_OAUTH_CLIENT_ID,
            clientSecret: values.CANVAS_OAUTH_CLIENT_SECRET,
            redirectUri: values.CANVAS_OAUTH_REDIRECT_URI,
          }
        : null,
  };
}
