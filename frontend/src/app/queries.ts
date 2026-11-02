import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { isApiError, request } from "./api";
import type {
  CanvasConnection,
  Change,
  ChangeDetail,
  ChangePage,
  Course,
  CourseFile,
  SyncRun,
  Task,
  User,
} from "./types";

export const keys = {
  me: ["me"] as const,
  connection: ["canvas-connection"] as const,
  latestRun: ["sync-run", "latest"] as const,
  courses: (archived: boolean) => ["courses", { archived }] as const,
  course: (id: number) => ["courses", id] as const,
  tasks: (params: { courseId?: number; status: "open" | "all" }) => ["tasks", params] as const,
  files: (params: { courseId?: number; q?: string }) => ["files", params] as const,
  changes: (params: { courseId?: number; unread?: boolean }) => ["changes", "list", params] as const,
  change: (id: number) => ["changes", "detail", id] as const,
  unreadCount: ["changes", "unread-count"] as const,
};

function query(path: string, params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `${path}?${text}` : path;
}

/** Everything synced from Canvas; refreshed after a sync or a connection change. */
export function invalidateCanvasData(client: QueryClient) {
  for (const key of ["courses", "tasks", "files", "changes", "canvas-connection", "sync-run"]) {
    void client.invalidateQueries({ queryKey: [key] });
  }
}

// --- Account ---

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: () => request<User>("/api/users/me"),
    retry: (count, error) => !isApiError(error, 401) && count < 2,
    staleTime: 5 * 60_000,
    refetchInterval: false,
  });
}

/**
 * Records who is signed in and drops everything cached for the previous account. Keeps the `me` query
 * itself: `clear()` would detach the components already watching it, and they would never see the change.
 */
function setAccount(client: QueryClient, user: User | null) {
  client.setQueryData(keys.me, user);
  client.removeQueries({ predicate: (query) => query.queryKey[0] !== keys.me[0] });
}

function useSignedIn() {
  const client = useQueryClient();
  return (user: User) => setAccount(client, user);
}

export function useSignIn() {
  const signedIn = useSignedIn();
  return useMutation({
    mutationFn: (body: { username: string; password: string }) => request<User>("/api/sessions", { method: "POST", body }),
    onSuccess: signedIn,
  });
}

export function useSignUp() {
  const signedIn = useSignedIn();
  return useMutation({
    mutationFn: (body: { username: string; email: string; password: string }) =>
      request<User>("/api/users", { method: "POST", body }),
    onSuccess: signedIn,
  });
}

export function useSignOut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<void>("/api/sessions/current", { method: "DELETE" }),
    onSettled: () => setAccount(client, null),
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: { current_password: string; new_password: string }) =>
      request<void>("/api/users/me/password", { method: "PUT", body }),
  });
}

// --- Canvas connection and sync ---

export function useConnection() {
  return useQuery({
    queryKey: keys.connection,
    queryFn: async () => {
      try {
        return await request<CanvasConnection>("/api/canvas/connection");
      } catch (error) {
        if (isApiError(error, 404, "CANVAS_NOT_CONNECTED")) return null;
        throw error;
      }
    },
    refetchInterval: (state) => (state.state.data?.syncing ? 5_000 : 60_000),
  });
}

export function useConnectCanvas() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { base_url: string; access_token: string }) =>
      request<{ connection: CanvasConnection; sync_run: SyncRun | null }>("/api/canvas/connection", { method: "PUT", body }),
    onSuccess: (result) => {
      client.setQueryData(keys.connection, result.connection);
      if (result.sync_run) client.setQueryData(keys.latestRun, result.sync_run);
      invalidateCanvasData(client);
    },
  });
}

export function useDisconnectCanvas() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<void>("/api/canvas/connection", { method: "DELETE" }),
    onSuccess: () => {
      client.setQueryData(keys.connection, null);
      client.setQueryData(keys.latestRun, null);
      invalidateCanvasData(client);
    },
  });
}

export function useLatestRun(enabled = true) {
  return useQuery({
    queryKey: keys.latestRun,
    queryFn: async () => {
      try {
        return await request<SyncRun>("/api/sync/runs/latest");
      } catch (error) {
        if (isApiError(error, 404)) return null;
        throw error;
      }
    },
    enabled,
    refetchInterval: (state) => (state.state.data?.status === "running" ? 2_000 : false),
  });
}

/**
 * The latest sync and a way to start one. Pass `onFinished` in exactly one mounted component:
 * that one refetches the synced data when a running sync finishes and reports the result.
 */
export function useSync(onFinished?: (run: SyncRun) => void) {
  const client = useQueryClient();
  const latest = useLatestRun();
  const previous = useRef<SyncRun | null | undefined>(undefined);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  useEffect(() => {
    const run = latest.data;
    const before = previous.current;
    previous.current = run;
    if (!finished.current) return;
    if (run && before?.id === run.id && before.status === "running" && run.status !== "running") {
      invalidateCanvasData(client);
      finished.current?.(run);
    }
  }, [latest.data, client]);

  const start = useMutation({
    mutationFn: () => request<SyncRun>("/api/sync", { method: "POST" }),
    onSuccess: (run) => {
      client.setQueryData(keys.latestRun, run);
      void client.invalidateQueries({ queryKey: keys.connection });
    },
  });

  return { run: latest.data ?? null, running: latest.data?.status === "running" || start.isPending, start };
}

// --- Courses, tasks, files ---

/** Active courses, or only the archived ones. */
export function useCourses(archived = false, enabled = true) {
  return useQuery({
    queryKey: keys.courses(archived),
    queryFn: () => request<Course[]>(query("/api/courses", { archived: archived || undefined })),
    enabled,
  });
}

export function useCourse(id: number) {
  return useQuery({
    queryKey: keys.course(id),
    queryFn: () => request<Course>(`/api/courses/${id}`),
    enabled: id > 0,
    retry: (count, error) => !isApiError(error, 404) && count < 2,
  });
}

export function useArchiveCourse() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, archived }: { id: number; archived: boolean }) =>
      request<Course>(`/api/courses/${id}`, { method: "PATCH", body: { archived } }),
    onSuccess: (course) => {
      client.setQueryData(keys.course(course.id), course);
      for (const key of ["courses", "tasks", "files", "changes"]) void client.invalidateQueries({ queryKey: [key] });
    },
  });
}

export function useTasks(params: { courseId?: number; status: "open" | "all" }) {
  return useQuery({
    queryKey: keys.tasks(params),
    queryFn: () => request<Task[]>(query("/api/tasks", { course_id: params.courseId, status: params.status })),
  });
}

export function useFiles(params: { courseId?: number; q?: string }) {
  return useQuery({
    queryKey: keys.files(params),
    queryFn: () => request<CourseFile[]>(query("/api/files", { course_id: params.courseId, q: params.q })),
    placeholderData: (previousData) => previousData,
  });
}

// --- Changes ---

export const CHANGE_PAGE_SIZE = 30;

export function useChanges(params: { courseId?: number; unread?: boolean; pages: number }) {
  const { pages, ...filters } = params;
  return useQuery({
    queryKey: [...keys.changes(filters), pages],
    queryFn: async () => {
      const items: Change[] = [];
      let before: number | null | undefined;
      for (let page = 0; page < pages; page += 1) {
        const result: ChangePage = await request(
          query("/api/changes", {
            course_id: filters.courseId,
            unread: filters.unread || undefined,
            limit: CHANGE_PAGE_SIZE,
            before: before ?? undefined,
          }),
        );
        items.push(...result.items);
        before = result.next_before;
        if (before === null) break;
      }
      return { items, hasMore: before !== null };
    },
    placeholderData: (previousData) => previousData,
  });
}

export function useChange(id: number | null) {
  return useQuery({
    queryKey: keys.change(id ?? 0),
    queryFn: () => request<ChangeDetail>(`/api/changes/${id}`),
    enabled: id !== null,
  });
}

export function useUnreadCount(enabled = true) {
  return useQuery({
    queryKey: keys.unreadCount,
    queryFn: () => request<{ count: number }>("/api/changes/unread-count"),
    enabled,
  });
}

export function useMarkRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, read }: { id: number; read: boolean }) =>
      request<Change>(`/api/changes/${id}`, { method: "PATCH", body: { read } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["changes"] });
      void client.invalidateQueries({ queryKey: ["courses"] });
    },
  });
}

export function useMarkAllRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (courseId?: number) =>
      request<{ updated: number }>("/api/changes/mark-all-read", { method: "POST", body: courseId ? { course_id: courseId } : {} }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["changes"] });
      void client.invalidateQueries({ queryKey: ["courses"] });
    },
  });
}
