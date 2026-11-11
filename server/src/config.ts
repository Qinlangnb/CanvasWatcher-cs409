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
  /** Lets visitors start a demo account with sample data, for example for usability evaluations. */
  DEMO_ACCOUNTS: z.enum(["true", "false"]).default("false"),
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
  demoAccounts: boolean;
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
    cookiePath: normalizeBasePath(values.PUBLIC_BASE_PATH) || "/",
    trustProxy: values.TRUST_PROXY,
    logLevel: values.LOG_LEVEL,
    demoAccounts: values.DEMO_ACCOUNTS === "true",
  };
}
