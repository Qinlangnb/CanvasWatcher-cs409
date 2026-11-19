// AI connection settings, stored AI Chat conversations with confirm-before-change, and AI help on tasks.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isApiError, request } from "./api";
import { keys } from "./queries";

// --- Types ---

export interface AiPresetChoice {
  id: string;
  label: string;
  base_url: string;
  requires_key: boolean;
}

export interface AiSettings {
  /** "server" (the server's default), a preset id, or null when nothing is available. */
  provider: string | null;
  providers: AiPresetChoice[];
  server_default: { available: boolean; model: string | null };
  needs_provider_selection: boolean;
  base_url: string | null;
  requires_key: boolean;
  model_id: string;
  credential_loaded: boolean;
  credential_storage: "server_encrypted";
  verified: boolean;
  verified_at: string | null;
  /** Which connection AI features use now. */
  active: "own" | "server" | null;
  active_model: string | null;
  chat_ready: boolean;
  read_only: boolean;
}

export interface ModelList {
  success: boolean;
  models: string[];
  message: string | null;
}

export interface ModelTest {
  success: boolean;
  latency_ms: number | null;
  model_id: string;
  message: string | null;
}

export interface Evidence {
  title: string;
  summary: string | null;
  route: string | null;
}

export type ConfirmationStatus = "pending" | "applying" | "applied" | "cancelled" | "expired" | "failed";

export interface Confirmation {
  id: string;
  tool_name: string;
  summary: string;
  details: { label: string; value: string }[];
  status: ConfirmationStatus;
  expires_at: string;
  error: string | null;
}

export interface ChatTurn {
  conversation_id: string;
  message: string | null;
  tool_results: Evidence[];
  confirmation: Confirmation | null;
  tools_used: string[];
}

export interface StoredMessage {
  id: number;
  role: "user" | "assistant";
  kind: "message" | "confirmation" | "mutation_result";
  content: string;
  tool_name: string | null;
  evidence: Evidence[];
  confirmation: Confirmation | null;
  created_at: string;
}

export interface Conversation {
  conversation_id: string;
  messages: StoredMessage[];
}

export interface ConfirmResult {
  conversation_id: string;
  confirmation: Confirmation;
  message: string;
}

export interface TaskSummary {
  status: "ready" | "pending" | "failed" | "unavailable";
  summary: string | null;
}

// --- Settings > AI API ---

const settingsKey = ["ai-settings"] as const;

export function useAiSettings() {
  return useQuery({ queryKey: settingsKey, queryFn: () => request<AiSettings>("/api/settings/ai") });
}

/** Every AI feature follows the active connection, so a change refreshes them all. */
function useRefreshAi() {
  const client = useQueryClient();
  return () => Promise.all([settingsKey, keys.ai, ["ai-summary"]].map((queryKey) => client.invalidateQueries({ queryKey })));
}

export function useSaveAiConnection() {
  const refresh = useRefreshAi();
  return useMutation({
    mutationFn: async ({ provider, model_id, api_key }: { provider: string; model_id: string; api_key?: string }) => {
      await request<AiSettings>("/api/settings/ai", { method: "PUT", body: { provider, model_id } });
      if (api_key) await request("/api/settings/ai/credential", { method: "POST", body: { provider, api_key } });
    },
    onSettled: refresh,
  });
}

export function useRemoveAiKey() {
  const refresh = useRefreshAi();
  return useMutation({
    mutationFn: () => request<void>("/api/settings/ai/credential", { method: "DELETE" }),
    onSettled: refresh,
  });
}

export function useFetchModels() {
  const refresh = useRefreshAi();
  return useMutation({ mutationFn: () => request<ModelList>("/api/settings/ai/models", { method: "POST" }), onSettled: refresh });
}

export function useTestModel() {
  const refresh = useRefreshAi();
  return useMutation({
    mutationFn: (model_id: string) => request<ModelTest>("/api/settings/ai/test", { method: "POST", body: { model_id } }),
    onSettled: refresh,
  });
}

// --- AI Chat ---

/** A conversation kept on the server; a missing one (deleted with the account data) reads as null. */
export function useConversation(id: string | null) {
  return useQuery({
    queryKey: ["ai-conversation", id],
    queryFn: async () => {
      try {
        return await request<Conversation>(`/api/ai/chat/conversations/${id}`);
      } catch (error) {
        if (isApiError(error, 404)) return null;
        throw error;
      }
    },
    enabled: id !== null,
    staleTime: Infinity,
    retry: (count, error) => !isApiError(error) && count < 2,
  });
}

export function useSendChat() {
  return useMutation({
    mutationFn: (body: { conversation_id: string | null; message: string; page: { path: string; course_id: number | null } }) =>
      request<ChatTurn>("/api/ai/chat", { method: "POST", body }),
  });
}

/** Confirms or cancels a proposed change; a confirmed one may touch anything, so everything is refreshed. */
export function useResolveConfirmation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { confirmation_id: string; action: "confirm" | "cancel" }) =>
      request<ConfirmResult>("/api/ai/chat/confirm", { method: "POST", body }),
    onSuccess: (result, body) => {
      if (body.action === "confirm") void client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== keys.me[0] });
    },
  });
}

// --- Tasks ---

/** The AI summary of a Canvas assignment; polled while it is being made. */
export function useTaskSummary(taskId: number, enabled: boolean) {
  return useQuery({
    queryKey: ["ai-summary", taskId],
    queryFn: () => request<TaskSummary>(`/api/ai/tasks/${taskId}/summary`),
    enabled,
    staleTime: 5 * 60_000,
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 5_000 : false),
    retry: false,
  });
}

export function useReestimate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (taskId: number) => request<{ state: string }>(`/api/tasks/${taskId}/reestimate`, { method: "POST" }),
    // The estimate arrives in the background; refresh the plan once it has had time to land.
    onSuccess: () => {
      window.setTimeout(() => {
        for (const key of ["tasks", "today"]) void client.invalidateQueries({ queryKey: [key] });
      }, 8_000);
    },
  });
}
