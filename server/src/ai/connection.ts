// Talking to a user's chosen provider for Settings > AI API: build the provider, list its models and
// test one model with a tiny request.
import { ANTHROPIC_VERSION, AnthropicProvider } from "./anthropic.js";
import type { AiPreset } from "./presets.js";
import { AiError, OpenAiCompatibleProvider, httpFailure, timedOut, type AiProvider } from "./provider.js";

const LIST_TIMEOUT_MS = 20_000;
/** A test is one short answer; reasoning models need room to produce it. */
const PROBE_TIMEOUT_MS = 45_000;
const MAX_MODELS = 500;

/** Local models take no key; Ollama ignores the header, so any placeholder will do. */
const LOCAL_KEY = "ollama";

export function buildProvider(
  preset: AiPreset,
  apiKey: string | null,
  model: string,
  fetchImpl: typeof fetch,
  timeoutMs?: number,
): AiProvider {
  const config = { baseUrl: preset.baseUrl, apiKey: apiKey ?? LOCAL_KEY, model };
  return preset.protocol === "anthropic"
    ? new AnthropicProvider(config, fetchImpl, preset.id, timeoutMs)
    : new OpenAiCompatibleProvider(config, fetchImpl, preset.id, timeoutMs);
}

function headersFor(preset: AiPreset, apiKey: string | null): Record<string, string> {
  if (preset.protocol === "anthropic") return { "x-api-key": apiKey ?? "", "anthropic-version": ANTHROPIC_VERSION };
  return { Authorization: `Bearer ${apiKey ?? LOCAL_KEY}` };
}

async function getJson(url: string, headers: Record<string, string>, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  } catch {
    throw timedOut();
  }
  if (!response.ok) throw httpFailure(response.status);
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) {
    throw new AiError("bad_reply", "The AI service sent a model list this app can't read.");
  }
  return body as Record<string, unknown>;
}

const idsOf = (body: Record<string, unknown>) =>
  (body.data as unknown[]).flatMap((row) => {
    const id = (row as { id?: unknown } | null)?.id;
    return typeof id === "string" && id.length <= 200 ? [id] : [];
  });

/** Model ids the key can use, sorted. Anthropic pages its list; OpenAI-compatible APIs send it whole. */
export async function listModels(preset: AiPreset, apiKey: string | null, fetchImpl: typeof fetch): Promise<string[]> {
  const headers = headersFor(preset, apiKey);
  const models = new Set<string>();
  if (preset.protocol === "anthropic") {
    let after: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const query: string = after ? `?limit=100&after_id=${encodeURIComponent(after)}` : "?limit=100";
      const body = await getJson(`${preset.baseUrl}/models${query}`, headers, fetchImpl);
      idsOf(body).forEach((id) => models.add(id));
      const next = typeof body.last_id === "string" ? body.last_id : null;
      if (!body.has_more || !next || next === after) break;
      after = next;
    }
  } else {
    idsOf(await getJson(`${preset.baseUrl}/models`, headers, fetchImpl)).forEach((id) => models.add(id));
  }
  return [...models].sort().slice(0, MAX_MODELS);
}

/** One tiny request to the model; resolves to the round-trip time in milliseconds. */
export async function probeModel(preset: AiPreset, apiKey: string | null, model: string, fetchImpl: typeof fetch): Promise<number> {
  const provider = buildProvider(preset, apiKey, model, fetchImpl, PROBE_TIMEOUT_MS);
  const started = performance.now();
  const reply = await provider.complete([{ role: "user", content: "Reply with OK." }], []);
  if (!reply.content && !reply.tool_calls) throw new AiError("bad_reply", "The AI service sent an empty answer.");
  return Math.round(performance.now() - started);
}

/** What Settings shows when a list or test fails: fixed sentences, never the provider's own text. */
export function settingsMessage(error: AiError): string {
  switch (error.kind) {
    case "auth":
      return "The provider rejected the key. Check that it belongs to the selected provider and region.";
    case "not_found":
      return "The provider could not find that model or address. Check the model ID.";
    case "rate_limited":
      return "The provider's rate limit or quota was reached. Try again later.";
    case "bad_request":
      return "The provider did not accept the request. Check the model ID.";
    case "bad_reply":
      return "The provider sent an answer this app can't read.";
    default:
      return "The provider could not be reached or did not answer in time.";
  }
}
