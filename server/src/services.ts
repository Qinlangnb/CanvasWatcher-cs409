import type { Logger } from "pino";
import { CanvasClient, type CanvasClientFactory } from "./canvas/client.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { SecretBox } from "./security/secretBox.js";
import { SyncService } from "./sync/service.js";

export interface Services {
  secrets: SecretBox;
  canvas: CanvasClientFactory;
  sync: SyncService;
}

export interface ServiceOptions {
  config: Config;
  db: Db;
  logger: Logger;
  /** Replaces the real Canvas client, for tests. */
  canvas?: CanvasClientFactory;
}

export function createServices({ config, db, logger, canvas }: ServiceOptions): Services {
  const secrets = new SecretBox(config.credentialsKey);
  const factory = canvas ?? ((baseUrl, token) => new CanvasClient({ baseUrl, token }));
  return { secrets, canvas: factory, sync: new SyncService({ db, logger, secrets, canvas: factory }) };
}
