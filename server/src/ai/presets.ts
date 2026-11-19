// AI providers a user can pick in Settings > AI API. Base URLs are fixed here, so a client can never
// point the server at an address of its choosing.

export type AiProtocol = "openai" | "anthropic" | "local";

export interface AiPreset {
  id: string;
  label: string;
  baseUrl: string;
  protocol: AiProtocol;
}

export const AI_PRESETS: readonly AiPreset[] = [
  { id: "kimi", label: "Kimi · China", baseUrl: "https://api.moonshot.cn/v1", protocol: "openai" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", protocol: "openai" },
  { id: "qwen", label: "Qwen · Beijing", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", protocol: "openai" },
  { id: "qwen_sg", label: "Qwen · Singapore", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", protocol: "openai" },
  { id: "qwen_us", label: "Qwen · US", baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1", protocol: "openai" },
  { id: "glm", label: "GLM · BigModel", baseUrl: "https://open.bigmodel.cn/api/paas/v4", protocol: "openai" },
  { id: "glm_global", label: "GLM · Z.ai", baseUrl: "https://api.z.ai/api/paas/v4", protocol: "openai" },
  { id: "gpt", label: "GPT · OpenAI", baseUrl: "https://api.openai.com/v1", protocol: "openai" },
  { id: "claude", label: "Claude · Anthropic", baseUrl: "https://api.anthropic.com/v1", protocol: "anthropic" },
  // Local models reach into the server's own network, so a hosted server only offers them when AI_ALLOW_LOCAL is set.
  { id: "ollama", label: "Ollama · Docker host", baseUrl: "http://host.docker.internal:11434/v1", protocol: "local" },
  { id: "ollama_local", label: "Ollama · this server", baseUrl: "http://127.0.0.1:11434/v1", protocol: "local" },
];

/** The id of the "Server default" choice: the server's own AI_API_KEY, base URL and model. */
export const SERVER_DEFAULT = "server";

export function presetsFor(allowLocal: boolean): AiPreset[] {
  return AI_PRESETS.filter((preset) => allowLocal || preset.protocol !== "local");
}

export function findPreset(id: string, allowLocal: boolean): AiPreset | null {
  return presetsFor(allowLocal).find((preset) => preset.id === id) ?? null;
}

export const requiresKey = (preset: AiPreset) => preset.protocol !== "local";

export function presentPreset(preset: AiPreset) {
  return { id: preset.id, label: preset.label, base_url: preset.baseUrl, requires_key: requiresKey(preset) };
}

/**
 * Keys are pasted by hand: reject anything a provider would never issue, such as text with spaces, a
 * "Bearer " prefix, or characters that can't go in an HTTP header.
 */
export function validApiKey(value: string): boolean {
  return value.length >= 8 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value) && !/^bearer/i.test(value);
}
