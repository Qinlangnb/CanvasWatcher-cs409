// Registers the course website, Gradescope and PrairieLearn modules with the source registry.
import { FieldError } from "../http/errors.js";
import { syncProvider, verifyBrokerSession } from "./provider/service.js";
import { providerBase, ProviderError } from "./provider/web.js";
import { registerSourceAdapter, sourceAdapter, type SourceAdapter } from "./registry.js";
import { normalizedHttpUrl } from "./website/scope.js";
import { syncWebsite, websiteConfig } from "./website/service.js";
import type { Services } from "../services.js";

function providerUrl(provider: "gradescope" | "prairielearn", input: string): string {
  try {
    return providerBase(provider, input.trim());
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new FieldError(
        "base_url",
        provider === "gradescope"
          ? "Use the HTTPS address of the Gradescope site, for example https://www.gradescope.com."
          : "Use the HTTPS address of the PrairieLearn site, for example https://us.prairielearn.com/pl.",
      );
    }
    throw error;
  }
}

/** The broker's verify hook has no services argument; the latest created services are used. */
let current: Services | null = null;
export function bindSourceServices(services: Services): void {
  current = services;
}

const website: SourceAdapter = {
  type: "WEBSITE",
  normalizeBaseUrl(input) {
    try {
      return normalizedHttpUrl(input);
    } catch (error) {
      throw new FieldError("base_url", (error as Error).message);
    }
  },
  // The generic create route only adds public websites to an existing course; the website editor does the rest.
  validateConfig(input) {
    const config = websiteConfig(input);
    if (config.authentication_method !== "none") throw new FieldError("config", "Add a protected website with the course website form.");
    return { ...config };
  },
  defaultName: (baseUrl) => `${new URL(baseUrl).host} site`,
  sync: syncWebsite,
  present: (source) => ({ authentication_method: websiteConfig(source.config).authentication_method }),
};

function provider(type: "GRADESCOPE" | "PRAIRIELEARN"): SourceAdapter {
  const name = type === "GRADESCOPE" ? "gradescope" : "prairielearn";
  return {
    type,
    normalizeBaseUrl: (input) => providerUrl(name, input),
    validateConfig: () => ({ read_only: true }),
    defaultName: () => (type === "GRADESCOPE" ? "Gradescope" : "PrairieLearn"),
    verifySession: async (baseUrl, cookies) => {
      if (!current) return { ok: false, reason: "AUTH_PROVIDER_UNSUPPORTED" };
      return verifyBrokerSession(name, baseUrl, cookies, current);
    },
    sync: syncProvider,
    present: () => ({ read_only: true, parser_verified: type === "GRADESCOPE" }),
  };
}

/** Idempotent; a test may have replaced an adapter, which is then left alone. */
export function registerBuiltInSources(): void {
  if (!sourceAdapter("WEBSITE")) registerSourceAdapter(website);
  if (!sourceAdapter("GRADESCOPE")) registerSourceAdapter(provider("GRADESCOPE"));
  if (!sourceAdapter("PRAIRIELEARN")) registerSourceAdapter(provider("PRAIRIELEARN"));
}
