import type { Logger } from "pino";
import { AiJobs } from "./ai/insights.js";
import { OpenAiCompatibleProvider, type AiProvider } from "./ai/provider.js";
import { aiProviderFor } from "./ai/resolve.js";
import { ChangeReviewWorker } from "./changes/review.js";
import { CanvasClient, type CanvasClientFactory } from "./canvas/client.js";
import { CanvasCredentials } from "./canvas/credentials.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { SecretBox } from "./security/secretBox.js";
import { SyncService } from "./sync/service.js";
import { bindSourceServices, registerBuiltInSources } from "./sources/builtIn.js";
import { SourceSyncs } from "./sources/run.js";
import { nodeTransport, type HttpTransport } from "./sources/website/http.js";

export interface Services {
  secrets: SecretBox;
  canvas: CanvasClientFactory;
  /** Canvas credential slots and the routed client every Canvas call goes through. */
  credentials: CanvasCredentials;
  sync: SyncService;
  /** The server-wide AI provider ("Server default"); null when no key is configured. */
  ai: AiProvider | null;
  /** Runs the AI review of Important Changes (changes/review.ts). */
  reviews: ChangeReviewWorker;
  /** How users' own AI connections are reached (ai/resolve.ts picks the provider per user). */
  aiOptions: { allowLocal: boolean; fetch: typeof fetch };
  /** Background AI summaries and effort estimates of tasks. */
  aiJobs: AiJobs;
  /** How course websites, Gradescope and PrairieLearn are reached (replaced in tests). */
  sourceTransport: HttpTransport;
  /** Syncs of course websites and Gradescope, by hand and on schedule. */
  sourceSyncs: SourceSyncs;
  /** Per-user storage of course-website file bytes. */
  websiteLimits: { quotaBytes: number; maxFileBytes: number };
}

export interface ServiceOptions {
  config: Config;
  db: Db;
  logger: Logger;
  /** Replaces the real Canvas client, for tests. */
  canvas?: CanvasClientFactory;
  /** Replaces fetch for Canvas OAuth token requests, for tests. */
  oauthFetch?: typeof fetch;
  /** Replaces the AI provider, for tests (null turns AI Chat off). */
  ai?: AiProvider | null;
  /** Replaces fetch for users' own AI providers, for tests. */
  aiFetch?: typeof fetch;
  /** Replaces the transport to course websites and Gradescope, for tests. */
  sourceTransport?: HttpTransport;
}

export function createServices({ config, db, logger, canvas, oauthFetch, ai, aiFetch, sourceTransport }: ServiceOptions): Services {
  registerBuiltInSources();
  const secrets = new SecretBox(config.credentialsKey);
  const factory: CanvasClientFactory = canvas ?? ((baseUrl, auth) => new CanvasClient({ baseUrl, auth }));
  const credentials = new CanvasCredentials({ db, secrets, canvas: factory, logger, oauth: config.canvasOAuth, fetch: oauthFetch });
  const services: Services = {
    secrets,
    canvas: factory,
    credentials,
    sync: new SyncService({ db, logger, credentials }),
    ai: ai !== undefined ? ai : config.ai ? new OpenAiCompatibleProvider(config.ai) : null,
    aiOptions: { allowLocal: config.aiAllowLocal, fetch: aiFetch ?? fetch },
    aiJobs: undefined as unknown as AiJobs,
    // The provider is looked up per user at review time, so a user who adds an AI later is picked up.
    reviews: new ChangeReviewWorker(db, logger, (userId) => aiProviderFor(db, services, userId)),
    sourceTransport: sourceTransport ?? nodeTransport({ allowPrivate: config.sourcesAllowPrivateHosts }),
    sourceSyncs: new SourceSyncs(db, logger, () => services),
    websiteLimits: { quotaBytes: config.websiteQuotaBytes, maxFileBytes: config.websiteMaxFileBytes },
  };
  // The jobs pick each user's provider through these same services.
  services.aiJobs = new AiJobs(db, logger, services);
  bindSourceServices(services);
  return services;
}
