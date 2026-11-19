import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { brokerRequest, request } from "../api";
import { invalidateCanvasData, keys as appKeys, useIsPreview } from "../queries";
import type { SyncRun } from "../types";
import type {
  BrokerHealth,
  CanvasAuthStatus,
  CanvasMethod,
  ProviderAssignmentRow,
  ProviderCourse,
  ProviderCourseMapping,
  ProviderType,
  SourceConnection,
  TaskProviderFacts,
  WebsiteDetails,
  WebsiteVerification,
} from "./model";

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

// --- Course websites, Gradescope and PrairieLearn ---

export const providerKeys = {
  website: (id: string) => ["source-connections", id, "website"] as const,
  mappings: (id: string) => ["source-connections", id, "course-mappings"] as const,
  assignments: (id: string, pending: boolean) => ["source-connections", id, "assignments", { pending }] as const,
  facts: (taskId: number) => ["tasks", "provider-facts", taskId] as const,
};

/** A website's settings, credential status (never the password) and pending resources. */
export function useWebsiteDetails(id: string | null) {
  return useQuery({
    queryKey: providerKeys.website(id ?? ""),
    queryFn: () => request<WebsiteDetails>(`/api/sources/${id}/website`),
    enabled: Boolean(id),
  });
}

/** Test connection: verifies without saving anything. */
export function useTestWebsite() {
  return useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: Record<string, unknown> }) =>
      request<WebsiteVerification>(`/api/sources/website/test${id ? `?connection_id=${encodeURIComponent(id)}` : ""}`, { method: "POST", body }),
  });
}

export function useSaveWebsite() {
  return useSourceMutation(({ id, body }: { id: string | null; body: Record<string, unknown> }) =>
    request<{ source: SourceConnection; verification: WebsiteVerification | null }>(id ? `/api/sources/website/${id}` : "/api/sources/website", {
      method: id ? "PUT" : "POST",
      body,
    }),
  );
}

/** Signs a website in again; on success the server retries its pending resources right away. */
export function useWebsiteCredential() {
  return useSourceMutation(({ id, username, password }: { id: string; username: string; password: string }) =>
    request<{ source: SourceConnection; verification: WebsiteVerification | null; sync: { state: string; errors: { code?: string }[] } | null }>(
      `/api/sources/${id}/website/credential`,
      { method: "POST", body: { username, password } },
    ),
  );
}

export function useForgetWebsitePassword() {
  return useSourceMutation((id: string) => request<void>(`/api/sources/${id}/website/credential`, { method: "DELETE" }));
}

export function useCreateProviderSource() {
  return useSourceMutation((body: { type: ProviderType; base_url: string; course_id?: number | null }) =>
    request<SourceConnection>("/api/sources", { method: "POST", body }),
  );
}

export function useDeleteSource() {
  return useSourceMutation((id: string) => request<void>(`/api/sources/${id}`, { method: "DELETE" }));
}

/** Discover courses: reads the provider's dashboard with the saved browser session. */
export function useDiscoverCourses() {
  return useMutation({ mutationFn: (id: string) => request<ProviderCourse[]>(`/api/sources/${id}/provider-courses`) });
}

export function useCourseMappings(id: string, enabled = true) {
  return useQuery({
    queryKey: providerKeys.mappings(id),
    queryFn: () => request<{ note: string | null; mappings: ProviderCourseMapping[] }>(`/api/sources/${id}/course-mappings`),
    enabled,
  });
}

export function useMapCourse() {
  return useSourceMutation(({ id, ...body }: { id: string; provider_course_id: string; course_id: number; course_code?: string; name?: string }) =>
    request<{ provider_course_id: string; course_id: number }>(`/api/sources/${id}/course-mappings`, { method: "POST", body }),
  );
}

export function useUnmapCourse() {
  return useSourceMutation(({ id, providerCourseId }: { id: string; providerCourseId: string }) =>
    request<void>(`/api/sources/${id}/course-mappings/${encodeURIComponent(providerCourseId)}`, { method: "DELETE" }),
  );
}

/** Gradescope assignments waiting for the student to say which task they are. */
export function useProviderAssignments(id: string, pending: boolean, enabled = true) {
  return useQuery({
    queryKey: providerKeys.assignments(id, pending),
    queryFn: () => request<ProviderAssignmentRow[]>(`/api/sources/${id}/assignments${pending ? "?pending=1" : ""}`),
    enabled,
  });
}

/** Confirms a task mapping; `task_id: null` keeps the assignment as its own task. */
export function useMapTask() {
  return useSourceMutation(({ id, ...body }: { id: string; provider_course_id: string; assignment_id: string; task_id: number | null }) =>
    request<{ confirmed: boolean }>(`/api/sources/${id}/task-mappings`, { method: "POST", body }),
  );
}

/** "Source facts" of one task: what Canvas and Gradescope each say. */
export function useTaskProviderFacts(taskId: number, enabled = true) {
  return useQuery({
    queryKey: providerKeys.facts(taskId),
    queryFn: () => request<TaskProviderFacts>(`/api/tasks/${taskId}/provider-facts`),
    enabled,
    staleTime: 60_000,
  });
}
