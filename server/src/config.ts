import { z } from "zod";

const environment = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  /** Comma-separated browser origins allowed to send state-changing requests. */
  ALLOWED_ORIGINS: z.string().default("http://localhost:5173,http://localhost:8080"),
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
  allowedOrigins: string[];
  secureCookies: boolean;
  trustProxy: number;
  logLevel: string;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = environment.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid server configuration:\n${problems.join("\n")}`);
  }
  const values = parsed.data;
  const allowedOrigins = values.ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return {
    env: values.NODE_ENV,
    port: values.PORT,
    databaseUrl: values.DATABASE_URL,
    sessionSecret: values.SESSION_SECRET,
    allowedOrigins,
    secureCookies: values.COOKIE_SECURE
      ? values.COOKIE_SECURE === "true"
      : allowedOrigins.every((origin) => origin.startsWith("https://")),
    trustProxy: values.TRUST_PROXY,
    logLevel: values.LOG_LEVEL,
  };
}
