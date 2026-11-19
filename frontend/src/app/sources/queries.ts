import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { brokerRequest, request } from "../api";
import { invalidateCanvasData, keys as appKeys, useIsPreview } from "../queries";
import type { SyncRun } from "../types";
import type { BrokerHealth, CanvasAuthStatus, CanvasMethod, SourceConnection } from "./model";

const BROKER = { "X-AW-Broker": "1" };

export const sourceKeys = {
  sources: ["source-connections"] as const,
  canvasStatus: ["canvas-status"] as const,
  storage: ["credential-storage"] as const,
  brokerConfig: ["broker-configuration"] as const,
  brokerHealth: (url: string) => ["broker-health", url] as const,
  oauth: ["canvas-oauth-capability"] as const,
};

/** After any credential or source change: the lists, the Canvas status and the synced data. */
export function invalidateSources(client: QueryClient) {
  void client.invalidateQueries({ queryKey: sourceKeys.sources });
  void client.invalidateQueries({ queryKey: sourceKeys.canvasStatus });
  invalidateCanvasData(client);
}

export function useSources(enabled = true) {
  return useQuery({
    queryKey: sourceKeys.sources,
    queryFn: () => request<SourceConnection[]>("/api/sources"),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useCanvasStatus(enabled = true) {
  return useQuery({
    queryKey: sourceKeys.canvasStatus,
    queryFn: () => request<CanvasAuthStatus>("/api/auth/canvas/status"),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useCredentialStorage() {
  return useQuery({
    queryKey: sourceKeys.storage,
    queryFn: () => request<{ mode: "server_encrypted" | "memory" }>("/api/settings/credential-storage"),
    staleTime: 60_000,
  });
}

export function useBrokerConfig() {
  return useQuery({
    queryKey: sourceKeys.brokerConfig,
    queryFn: () => request<{ broker_url: string; protocol_version: number }>("/api/auth/broker/configuration"),
    staleTime: Infinity,
  });
}

/** The desktop broker's /health, every 15 seconds with a 2.5 second timeout and no retry. */
export function useBrokerHealth(brokerUrl: string | undefined) {
  return useQuery({
    queryKey: sourceKeys.brokerHealth(brokerUrl ?? ""),
    queryFn: () => brokerRequest<BrokerHealth>(`${brokerUrl}/health`, { timeoutMs: 2_500 }),
    enabled: Boolean(brokerUrl),
    refetchInterval: 15_000,
    retry: false,
  });
}

export function useOAuthCapability() {
  return useQuery({
    queryKey: sourceKeys.oauth,
    queryFn: () => request<{ configured: boolean; reason: string | null }>("/api/auth/canvas/oauth/capability"),
    staleTime: 5 * 60_000,
  });
}

/** Runs a credential or source change, then refreshes everything that depends on it. */
function useSourceMutation<Input, Output>(run: (input: Input) => Promise<Output>) {
  const client = useQueryClient();
  return useMutation({ mutationFn: run, onSuccess: () => invalidateSources(client) });
}

export interface VerifyResult {
  verified: boolean;
  method: CanvasMethod;
  sync_run: SyncRun | null;
}

export function useImportPat() {
  return useSourceMutation((body: { base_url?: string; token: string; expiration_date?: string | null }) =>
    request<VerifyResult>("/api/auth/canvas/pat", { method: "POST", body }),
  );
}

export function useImportSession() {
  return useSourceMutation((body: { base_url?: string; session_import: string }) =>
    request<VerifyResult>("/api/auth/canvas/browser-session", { method: "POST", body }),
  );
}

export function useRemoveMethod() {
  return useSourceMutation(({ method, generation }: { method: CanvasMethod; generation: number }) =>
    request<void>(`/api/auth/canvas/methods/${method}?generation=${generation}`, { method: "DELETE" }),
  );
}

export function useVerifyMethod() {
  return useSourceMutation((method: CanvasMethod) =>
    request<{ verified: boolean; method: CanvasMethod }>(`/api/auth/canvas/methods/${method}/verify`, { method: "POST" }),
  );
}

export function useClearCredentials() {
  return useSourceMutation(() => request<void>("/api/auth/canvas/credentials", { method: "DELETE" }));
}

export function useCreateCanvasSource() {
  return useSourceMutation((body: { name?: string; base_url: string }) =>
    request<SourceConnection>("/api/sources/canvas", { method: "POST", body }),
  );
}

export function useUpdateSource() {
  return useSourceMutation(
    ({ id, ...body }: { id: string; name?: string; base_url?: string; enabled?: boolean; default_auth_method?: CanvasMethod | null }) =>
      request<SourceConnection>(`/api/sources/${id}`, { method: "PATCH", body }),
  );
}

/** Sync one source now; Canvas starts the usual background sync. */
export function useSyncSource() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (source: SourceConnection) =>
      request<{ state: string; sync_run?: SyncRun; errors?: { code?: string }[] }>(`/api/sources/${source.id}/sync`, { method: "POST" }),
    onSuccess: (result) => {
      if (result.sync_run) client.setQueryData(appKeys.latestRun, result.sync_run);
      invalidateSources(client);
    },
  });
}

export function useStartOAuth() {
  return useMutation({
    mutationFn: () => request<{ authorization_url: string }>("/api/auth/canvas/oauth/start", { method: "POST", headers: BROKER }),
  });
}

// --- Auth Broker handshake (page side) ---

export const brokerApi = {
  challenge: (body: { provider: string; credential_id: string; operation: "login" | "clear" | "clear_all" }) =>
    request<import("./model").BrokerTicket>("/api/auth/broker/challenges", { method: "POST", body, headers: BROKER }),
  status: (body: Record<string, string>) =>
    request<{ state: string; reason: string | null; provider: string }>("/api/auth/broker/status", { method: "POST", body, headers: BROKER }),
  cancel: (body: Record<string, string>) =>
    request<{ state: string; reason: string | null }>("/api/auth/broker/cancel", { method: "POST", body, headers: BROKER }),
};

/** Preview accounts see every source control greyed out. */
export const useSourcesLocked = useIsPreview;
