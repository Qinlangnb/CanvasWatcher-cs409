// Claude through Anthropic's messages API, behind the same interface as the OpenAI-compatible provider:
// the chat loop keeps OpenAI-shaped messages, and they are translated on the way in and out.
import type { AiConfig } from "../config.js";
import type { AiProvider, AssistantMessage, ChatMessage, ToolCall, ToolSpec } from "./provider.js";
import { AiError, TIMEOUT_MS, httpFailure, timedOut } from "./provider.js";

export const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface Turn {
  role: "user" | "assistant";
  content: Block[];
}

function parseArguments(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/** System text apart; tool results become user turns; consecutive turns of one role are merged. */
export function toAnthropic(messages: ChatMessage[]): { system: string; turns: Turn[] } {
  const system: string[] = [];
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      system.push(message.content);
      continue;
    }
    let role: Turn["role"];
    let blocks: Block[];
    if (message.role === "tool") {
      role = "user";
      blocks = [{ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content }];
    } else if (message.role === "assistant") {
      role = "assistant";
      blocks = message.content ? [{ type: "text", text: message.content }] : [];
      for (const call of message.tool_calls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) });
      }
    } else {
      role = "user";
      blocks = [{ type: "text", text: message.content }];
    }
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  }
  return { system: system.join("\n\n"), turns };
}

export class AnthropicProvider implements AiProvider {
  readonly model: string;

  constructor(
    private readonly config: AiConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    readonly source = "claude",
    private readonly timeoutMs = TIMEOUT_MS,
  ) {
    this.model = config.model;
  }

  async complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<AssistantMessage> {
    const { system, turns } = toAnthropic(messages);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": this.config.apiKey, "anthropic-version": ANTHROPIC_VERSION },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: MAX_TOKENS,
          ...(system ? { system } : {}),
          messages: turns,
          ...(tools.length > 0
            ? { tools: tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })) }
            : {}),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw timedOut();
    }
    if (!response.ok) throw httpFailure(response.status);
    const body = (await response.json().catch(() => null)) as { content?: unknown } | null;
    if (!body || !Array.isArray(body.content)) throw new AiError("bad_reply", "The AI service sent an empty answer.");
    const blocks = body.content as Record<string, unknown>[];
    const text = blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    const calls: ToolCall[] = blocks
      .filter((block) => block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string")
      .map((block) => ({
        id: block.id as string,
        type: "function" as const,
        function: { name: block.name as string, arguments: JSON.stringify(block.input ?? {}) },
      }));
    return { role: "assistant", content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) };
  }
}
