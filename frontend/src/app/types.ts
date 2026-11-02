// Response shapes of the CanvasWatcher API (server/src/routes/present.ts).

export interface User {
  id: string;
  username: string;
  email: string;
  created_at: string;
}

export interface CanvasConnection {
  base_url: string;
  canvas_user_name: string;
  status: "ok" | "token_rejected";
  verified_at: string;
  last_synced_at: string | null;
  syncing: boolean;
}

export interface SyncRun {
  id: string;
  trigger: "connect" | "manual" | "scheduled";
  status: "running" | "succeeded" | "partial" | "failed";
  started_at: string;
  finished_at: string | null;
  courses_synced: number;
  changes_detected: number;
  error: string | null;
}

export interface CourseSummary {
  id: number;
  code: string;
  name: string;
}

export interface Course extends CourseSummary {
  canvas_id: string;
  term: { name: string; start_at: string | null; end_at: string | null } | null;
  html_url: string;
  archived: boolean;
  last_seen_at: string;
  counts: { open_tasks: number; unread_changes: number; files: number };
}

export type TaskState = "open" | "overdue" | "done" | "ignored" | "removed";

export interface Task {
  id: number;
  course: CourseSummary;
  title: string;
  type: string;
  due_at: string | null;
  points_possible: number | null;
  html_url: string | null;
  submission_state: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  state: TaskState;
}

export interface CourseFile {
  id: number;
  course: CourseSummary;
  name: string;
  content_type: string | null;
  size_bytes: number;
  updated_at: string | null;
  download_url: string;
}

export type ChangeKind = "assignment" | "file" | "announcement";

export interface Change {
  id: number;
  course: CourseSummary;
  kind: ChangeKind;
  change_type: "created" | "updated" | "removed";
  fields: string[];
  summary: string;
  title: string;
  html_url: string | null;
  detected_at: string;
  read: boolean;
}

export type ContentValue = string | number | null;

export interface ChangeDetail extends Change {
  before: Record<string, ContentValue> | null;
  after: Record<string, ContentValue> | null;
  related_task: Task | null;
}

export interface ChangePage {
  items: Change[];
  next_before: number | null;
}
