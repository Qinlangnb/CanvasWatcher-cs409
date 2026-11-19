// Queries and mutations for timers, progress revisions, terms, course lifecycle and file types.
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { request } from "./api";
import type { ActiveWork, Course, CourseFile, CourseTerm, FileType, Task, WorkSummary } from "./types";

export const workKeys = {
  active: ["work", "active"] as const,
};

/** Timers change time used and the plan, so lists refresh with them. */
function invalidateWork(client: QueryClient) {
  return Promise.all(["work", "tasks", "today", "courses"].map((key) => client.invalidateQueries({ queryKey: [key] })));
}

/** The running timer, or null. Refreshed every minute in case it was stopped in another tab. */
export function useActiveWork() {
  return useQuery({
    queryKey: workKeys.active,
    queryFn: async () => (await request<{ active: ActiveWork | null }>("/api/work/active")).active,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
}

export function useStartWork() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (task: Pick<Task, "id">) => request<WorkSummary>(`/api/tasks/${task.id}/work/start`, { method: "POST" }),
    onSettled: () => invalidateWork(client),
  });
}

export function useStopWork() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (taskId: number) => request<WorkSummary>(`/api/tasks/${taskId}/work/stop`, { method: "POST" }),
    onSettled: () => invalidateWork(client),
  });
}

export function sendHeartbeat(taskId: number, body: { client_timestamp: string; expected_revision?: number; progress_percent?: number; elapsed_snapshot_seconds?: number }) {
  return request<WorkSummary>(`/api/tasks/${taskId}/work/heartbeat`, { method: "POST", body });
}

export interface ProgressResult {
  applied: boolean;
  state_revision: number;
  task: Task;
}

/** Progress with the revision check; `applied: false` means the task changed elsewhere. */
export function useSaveProgress() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ task, progress, reopen, actionAt }: { task: Task; progress: number; reopen?: boolean; actionAt?: string }) =>
      request<ProgressResult>(`/api/tasks/${task.id}/progress`, {
        method: "POST",
        body: { progress_percent: progress, expected_revision: task.state_revision, reopen, action_at: actionAt },
      }),
    onSettled: () => invalidateWork(client),
  });
}

export function useCourseTerms() {
  return useQuery({ queryKey: ["courses", "terms"], queryFn: () => request<CourseTerm[]>("/api/courses/terms") });
}

/** Active courses of one term ("all" for every term). */
export function useTermCourses(termId: string | null) {
  return useQuery({
    queryKey: ["courses", { archived: false, term: termId }],
    queryFn: () => request<Course[]>(termId && termId !== "all" ? `/api/courses?term_id=${encodeURIComponent(termId)}` : "/api/courses"),
    enabled: termId !== null,
    placeholderData: (previous) => previous,
  });
}

export function useCourseLifecycle() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, archive }: { id: number; archive: boolean }) =>
      request<Course & { reconciliation_queued?: boolean }>(`/api/courses/${id}/${archive ? "archive" : "restore"}`, { method: "POST" }),
    onSuccess: (course, { archive }) => {
      for (const key of ["courses", "tasks", "files", "changes", "today"]) void client.invalidateQueries({ queryKey: [key] });
      // A restore starts a sync; the sync control picks it up.
      if (!archive && course.reconciliation_queued) void client.invalidateQueries({ queryKey: ["sync-run"] });
    },
  });
}

export function useClassifyFile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, type }: { id: number; type: FileType }) =>
      request<CourseFile>(`/api/files/${id}/classification`, { method: "PATCH", body: { type } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["files"] }),
  });
}

/** A fresh Canvas download link, asked for first so a missing file can be reported. */
export function fileDownloadLink(fileId: number) {
  return request<{ url: string; filename: string }>(`/api/files/${fileId}/download?link=1`);
}
