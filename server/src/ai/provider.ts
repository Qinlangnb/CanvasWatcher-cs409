// The AI provider: one call to an OpenAI-compatible chat completions API (DeepSeek by default).
// ai/anthropic.ts speaks the same interface over Anthropic's messages API.
import type { AiConfig } from "../config.js";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
      /** DeepSeek's thinking models need their reasoning sent back on the rounds that follow a tool call. */
      reasoning_content?: string;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

export interface AiProvider {
  readonly model: string;
  /** "server" for the server-wide key, otherwise the user's preset id (ai/presets.ts). */
  readonly source?: string;
  /** One completion; with `tools` empty the model has to answer in text. */
  complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<AssistantMessage>;
}

/** What went wrong, without the provider's own text (which may echo the request). */
export class AiError extends Error {
  constructor(
    readonly kind: "auth" | "rate_limited" | "bad_request" | "not_found" | "unavailable" | "bad_reply",
    message: string,
  ) {
    super(message);
  }
}

/** Per call. With chat.ts's turn budget this keeps a turn under Cloudflare's 100-second cut-off. */
export const TIMEOUT_MS = 40_000;

/** The fixed error for a failed HTTP answer; the provider's own text is never passed on. */
export function httpFailure(status: number): AiError {
  if (status === 401 || status === 403) return new AiError("auth", "The AI service rejected the key.");
  if (status === 429) return new AiError("rate_limited", "The AI service is busy. Try again in a minute.");
  if (status === 404) return new AiError("not_found", "The AI service could not find this model.");
  if (status === 400 || status === 422) return new AiError("bad_request", "The AI service could not use this request.");
  return new AiError("unavailable", "The AI service is not available right now.");
}

export const timedOut = () => new AiError("unavailable", "The AI service did not answer in time.");

export class OpenAiCompatibleProvider implements AiProvider {
  readonly model: string;
  readonly source: string;

  constructor(
    private readonly config: AiConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    source = "server",
    private readonly timeoutMs = TIMEOUT_MS,
  ) {
    this.model = config.model;
    this.source = source;
  }

  async complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<AssistantMessage> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
          stream: false,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw timedOut();
    }
    if (!response.ok) throw httpFailure(response.status);
    const body = (await response.json().catch(() => null)) as {
      choices?: { message?: { content?: unknown; tool_calls?: unknown; reasoning_content?: unknown } }[];
    } | null;
    const message = body?.choices?.[0]?.message;
    if (!message) throw new AiError("bad_reply", "The AI service sent an empty answer.");
    const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as ToolCall[]) : [];
    const valid = calls.filter(
      (call) => typeof call?.id === "string" && typeof call.function?.name === "string" && typeof call.function.arguments === "string",
    );
    return {
      role: "assistant",
      content: typeof message.content === "string" ? message.content : null,
      ...(valid.length > 0 ? { tool_calls: valid.map((call) => ({ id: call.id, type: "function" as const, function: call.function })) } : {}),
      ...(typeof message.reasoning_content === "string" ? { reasoning_content: message.reasoning_content } : {}),
    };
  }
}
