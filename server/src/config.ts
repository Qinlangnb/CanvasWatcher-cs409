import { z } from "zod";

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
  /** Number of reverse proxies in front of the API, used to find the client address. */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
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
  trustProxy: number;
  logLevel: string;
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
    trustProxy: values.TRUST_PROXY,
    logLevel: values.LOG_LEVEL,
  };
}
