// Settings > AI API: a user's own AI provider, key and model, next to the server's default.
// The key is sealed and never sent back; AI features use the connection only after its model passed a test.
import { Router } from "express";
import { z } from "zod";
import { listModels, probeModel, settingsMessage } from "../ai/connection.js";
import { SERVER_DEFAULT, findPreset, presentPreset, presetsFor, requiresKey, validApiKey } from "../ai/presets.js";
import { AiError } from "../ai/provider.js";
import { aiKeyContext, isVerified, openAiKey, ownProvider } from "../ai/resolve.js";
import { currentAuth } from "../auth/middleware.js";
import { enforce } from "../auth/throttle.js";
import type { Db } from "../db.js";
import type { AiConnection, User } from "../generated/prisma/client.js";
import { FieldError, HttpError } from "../http/errors.js";
import { isPreview, previewUnavailable } from "../preview/accounts.js";
import type { Services } from "../services.js";

/** Model lists and tests are paid calls with the user's key; a few a minute is plenty. */
export const AI_PROBES_PER_ACCOUNT = { limit: 20, windowMs: 10 * 60_000 };

const modelId = z
  .string()
  .trim()
  .max(200, "Use at most 200 characters.")
  .regex(/^[\w.:/@+-]*$/, "Model IDs have no spaces or special characters.");

const connectionChange = z
  .object({
    provider: z.string({ error: "Choose a provider." }).trim().min(1, "Choose a provider.").max(40),
    model_id: modelId.default(""),
  })
  .strict();

const credential = z
  .object({
    provider: z.string({ error: "Choose a provider." }).trim().min(1).max(40),
    api_key: z.string({ error: "Paste the API key." }).trim().min(1, "Paste the API key.").max(512, "That key is too long."),
  })
  .strict();

const testRequest = z.object({ model_id: modelId.optional() }).strict();

const saveProviderFirst = () =>
  new HttpError(409, "AI_PROVIDER_NOT_SAVED", "Save the selected provider first, then add its key.");

function noPreview(user: User) {
  if (isPreview(user)) throw previewUnavailable();
}

export function aiSettingsRouter(db: Db, services: Services): Router {
  const router = Router();
  const allowLocal = () => services.aiOptions.allowLocal;
  const find = (userId: string) => db.aiConnection.findUnique({ where: { userId } });

  function present(row: AiConnection | null, user: User) {
    const preset = row && row.provider !== SERVER_DEFAULT ? findPreset(row.provider, allowLocal()) : null;
    const own = ownProvider(services, row);
    const active = own ?? services.ai;
    return {
      /** "server", a preset id, or null when nothing is chosen and the server has no default. */
      provider: preset ? preset.id : services.ai ? SERVER_DEFAULT : null,
      providers: presetsFor(allowLocal()).map(presentPreset),
      server_default: { available: services.ai !== null, model: services.ai?.model ?? null },
      /** A saved provider this server no longer offers (for example a local one after AI_ALLOW_LOCAL was turned off). */
      needs_provider_selection: Boolean(row && row.provider !== SERVER_DEFAULT && !preset),
      base_url: preset?.baseUrl ?? null,
      requires_key: preset ? requiresKey(preset) : false,
      model_id: preset ? row?.modelId ?? "" : "",
      credential_loaded: Boolean(preset && row?.keyCiphertext),
      credential_storage: "server_encrypted" as const,
      verified: Boolean(preset && row && row.modelId && isVerified(row)),
      verified_at: preset && row && isVerified(row) ? (row.verifiedAt?.toISOString() ?? null) : null,
      /** Which connection AI features use right now. */
      active: own ? ("own" as const) : active ? ("server" as const) : null,
      active_model: active?.model ?? null,
      chat_ready: active !== null,
      read_only: isPreview(user),
    };
  }

  /** Bumps the generation, which voids any earlier test of this connection. */
  const changed = { generation: { increment: 1 }, verifiedGeneration: null, verifiedAt: null };

  router.get("/", async (_req, res) => {
    const { user } = currentAuth(res.locals);
    res.json(present(await find(user.id), user));
  });

  /** Chooses the provider and model. A new provider drops the old key; a new model needs a new test. */
  router.put("/", async (req, res) => {
    const { user } = currentAuth(res.locals);
    noPreview(user);
    const body = connectionChange.parse(req.body ?? {});
    if (body.provider === SERVER_DEFAULT) {
      await db.aiConnection.deleteMany({ where: { userId: user.id } });
      res.json(present(null, user));
      return;
    }
    const preset = findPreset(body.provider, allowLocal());
    if (!preset) throw new FieldError("provider", "Choose one of the providers in the list.");
    const row = await find(user.id);
    let saved: AiConnection;
    if (!row || row.provider !== preset.id) {
      const fresh = { provider: preset.id, modelId: body.model_id, keyCiphertext: null };
      saved = await db.aiConnection.upsert({
        where: { userId: user.id },
        create: { userId: user.id, ...fresh },
        update: { ...fresh, ...changed },
      });
    } else if (row.modelId !== body.model_id) {
      saved = await db.aiConnection.update({ where: { userId: user.id }, data: { modelId: body.model_id, ...changed } });
    } else {
      saved = row;
    }
    res.json(present(saved, user));
  });

  router.post("/credential", async (req, res) => {
    const { user } = currentAuth(res.locals);
    noPreview(user);
    const body = credential.parse(req.body ?? {});
    const row = await find(user.id);
    if (!row || row.provider !== body.provider) throw saveProviderFirst();
    const preset = findPreset(row.provider, allowLocal());
    if (!preset) throw saveProviderFirst();
    if (!requiresKey(preset)) throw new FieldError("api_key", "This provider runs locally and needs no key.");
    if (!validApiKey(body.api_key)) {
      throw new FieldError("api_key", 'Paste the key alone: no spaces, line breaks or "Bearer" in front.');
    }
    await db.aiConnection.update({
      where: { userId: user.id },
      data: { keyCiphertext: services.secrets.seal(body.api_key, aiKeyContext(user.id)), ...changed },
    });
    res.json({ credential_loaded: true });
  });

  router.delete("/credential", async (_req, res) => {
    const { user } = currentAuth(res.locals);
    noPreview(user);
    await db.aiConnection.updateMany({ where: { userId: user.id, keyCiphertext: { not: null } }, data: { keyCiphertext: null, ...changed } });
    res.status(204).end();
  });

  /** The saved connection's preset and key, or the reason it can't be used yet. */
  async function usable(userId: string) {
    const row = await find(userId);
    const preset = row && row.provider !== SERVER_DEFAULT ? findPreset(row.provider, allowLocal()) : null;
    if (!row || !preset) return { problem: "Choose and save a provider first." } as const;
    const key = requiresKey(preset) ? openAiKey(services, row) : null;
    if (requiresKey(preset) && !key) return { problem: "Add this provider's API key first." } as const;
    return { row, preset, key } as const;
  }

  router.post("/models", async (_req, res) => {
    const { user } = currentAuth(res.locals);
    noPreview(user);
    await enforce(db, [{ key: `ai-settings:${user.id}`, ...AI_PROBES_PER_ACCOUNT }], "Too many connection checks. Try again in a few minutes.");
    const found = await usable(user.id);
    if ("problem" in found) {
      res.json({ success: false, models: [], message: found.problem ?? null });
      return;
    }
    try {
      const models = await listModels(found.preset, found.key, services.aiOptions.fetch);
      res.json({ success: true, models, message: null });
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      res.json({ success: false, models: [], message: settingsMessage(error) });
    }
  });

  /** Tests the saved model with one tiny request. Only a pass makes the connection the one AI features use. */
  router.post("/test", async (req, res) => {
    const { user } = currentAuth(res.locals);
    noPreview(user);
    const body = testRequest.parse(req.body ?? {});
    await enforce(db, [{ key: `ai-settings:${user.id}`, ...AI_PROBES_PER_ACCOUNT }], "Too many connection checks. Try again in a few minutes.");
    const found = await usable(user.id);
    const fail = (message: string, model: string) => res.json({ success: false, latency_ms: null, model_id: model, message });
    if ("problem" in found) return void fail(found.problem ?? "", body.model_id ?? "");
    const { row, preset, key } = found;
    if (!row.modelId) return void fail("Enter a model ID first.", "");
    if (body.model_id !== undefined && body.model_id !== row.modelId) return void fail("Save the selected model ID before testing it.", body.model_id ?? "");
    try {
      const latency = await probeModel(preset, key, row.modelId, services.aiOptions.fetch);
      // Only counts if nothing changed while the test ran.
      const { count } = await db.aiConnection.updateMany({
        where: { userId: user.id, generation: row.generation },
        data: { verifiedGeneration: row.generation, verifiedAt: new Date() },
      });
      if (!count) return void fail("The connection changed during the test. Test it again.", row.modelId);
      // Summaries and estimates can start now that a provider is ready.
      services.aiJobs.kick(user.id);
      res.json({ success: true, latency_ms: latency, model_id: row.modelId, message: null });
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      fail(settingsMessage(error), row.modelId);
    }
  });

  return router;
}
