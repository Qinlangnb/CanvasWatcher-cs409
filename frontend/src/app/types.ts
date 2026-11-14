// Response shapes of the CanvasWatcher API (server/src/routes/present.ts).

export interface User {
  id: string;
  username: string;
  email: string;
  created_at: string;
  /** Set for preview accounts: when the account and its copy of the data are deleted. */
  preview_expires_at: string | null;
}

export interface PreviewAvailability {
  enabled: boolean;
  lifetime_days: number;
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

export type TaskType = "assignment" | "homework" | "exam" | "project" | "reading" | "other";

export interface Task {
  id: number;
  course: CourseSummary;
  /** Canvas tasks are synced; personal ones were added by the student. */
  source: "canvas" | "personal";
  title: string;
  type: TaskType | string;
  due_at: string | null;
  points_possible: number | null;
  html_url: string | null;
  submission_state: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  ignored_at: string | null;
  state: TaskState;
  /** Percent done, 0-100. */
  progress: number;
  /** The student's own estimate; null while the type's default applies. */
  estimated_minutes: number | null;
  total_minutes: number;
  remaining_minutes: number;
  /** Local date (YYYY-MM-DD) the student started it ahead of the plan; that day's plan includes it. */
  started_on: string | null;
  notes: string | null;
}

export interface TaskChanges {
  done?: boolean;
  ignored?: boolean;
  progress?: number;
  estimated_minutes?: number | null;
  notes?: string | null;
  /** Put the task on today's plan now (false takes it back off). */
  start_today?: boolean;
  title?: string;
  type?: TaskType;
  due_at?: string | null;
}

export interface NewTask {
  course_id: number;
  title: string;
  type: TaskType;
  due_at: string | null;
  estimated_minutes: number | null;
  notes: string | null;
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

export interface FilePage {
  items: CourseFile[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  next_cursor: string | null;
}

/** Canvas rich content split into blocks; tables keep their rows so exam names stay next to their dates. */
export type SyllabusBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "text"; text: string }
  | { type: "table"; rows: string[][]; header_rows: number; row_headers: boolean; caption?: string };

export interface SyllabusSource {
  kind: "syllabus" | "page" | "file" | "link";
  title: string;
  html_url: string | null;
  download_url: string | null;
  updated_at: string | null;
  /** Why this was picked, for example "linked from the Canvas Syllabus tab". */
  reasons: string[];
  blocks: SyllabusBlock[];
}

export interface Syllabus {
  found: boolean;
  sources: SyllabusSource[];
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

export interface PlanSettings {
  /** IANA name, for example America/Chicago. */
  time_zone: string;
  daily_study_minutes: number;
  /** Minutes after local midnight; the end may be 1440. */
  study_start_minute: number;
  study_end_minute: number;
}

export type TodayReason = "overdue" | "due_today" | "low_slack" | "quick_finish" | "started" | "get_ahead";

export interface TodayItem {
  task: Task;
  score: number;
  remaining_minutes: number;
  /** Minutes of today's capacity for this task; 0 when it doesn't fit. */
  planned_minutes: number;
  slack_minutes: number | null;
  reasons: TodayReason[];
}

/** Work due soon; `planned_minutes` is 0 when today's plan doesn't (yet) give it time. */
export type UpcomingItem = Pick<TodayItem, "task" | "remaining_minutes" | "planned_minutes" | "reasons">;

export interface Today {
  date: string;
  time_zone: string;
  study_window: { start: string; end: string };
  goal_minutes: number;
  free_minutes: number;
  capacity_minutes: number;
  planned_minutes: number;
  due_today_minutes: number;
  items: TodayItem[];
  /** Open work due from now through `upcoming_through`, planned or not, soonest first. */
  upcoming: UpcomingItem[];
  /** The last instant of the 7th local day after today. */
  upcoming_through: string;
  done_today: Task[];
  events: CalendarEvent[];
}

export interface CalendarEvent {
  id: number;
  title: string;
  location: string | null;
  all_day: boolean;
  /** "YYYY-MM-DD" for all-day events, otherwise an ISO instant. */
  start: string;
  /** Exclusive: the day after the last day, or when the event ends. */
  end: string;
  busy: boolean;
  source: { id: number; name: string } | null;
  /** Only events added by hand can be changed; imported ones follow their file. */
  editable: boolean;
}

export interface EventFields {
  title: string;
  location: string | null;
  all_day: boolean;
  start: string;
  end: string;
  busy: boolean;
}

export interface CalendarSource {
  id: number;
  name: string;
  file_name: string | null;
  imported_at: string;
  event_count: number;
}

export interface CalendarImport extends CalendarSource {
  /** The file had more events than one import keeps. */
  truncated: boolean;
}
