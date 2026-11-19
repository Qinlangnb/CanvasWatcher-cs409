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
  /** "CS 409" and the section, read from Canvas's code and name. */
  display_code: string;
  section: string | null;
  term: { name: string; start_at: string | null; end_at: string | null; id: string; display_name: string; sort_key: string } | null;
  html_url: string;
  archived: boolean;
  last_seen_at: string;
  /** Busy travel time before and after this course's class events. */
  commute_minutes: number;
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
  /** What remaining_minutes comes from: the pace so far, the student's estimate, the AI's estimate, or the type's default. */
  remaining_basis: "pace" | "estimate" | "ai" | "default";
  /** Minutes the student has spent on it, as they report it. */
  spent_minutes: number;
  /** Canvas score and grade once Canvas shows them; null until graded or while hidden. */
  score: number | null;
  grade: string | null;
  excused: boolean;
  /** Local date (YYYY-MM-DD) the student started it ahead of the plan; that day's plan includes it. */
  started_on: string | null;
  notes: string | null;
  // --- Tasks parity: timers, revisions, links ---
  /** Finished timer minutes; spent_minutes adds the manual correction (a running timer is not included). */
  tracked_minutes: number;
  manual_adjustment_minutes: number;
  /** Send back as expected_revision with progress and completion changes. */
  state_revision: number;
  /** The validated page the task card opens, or null. */
  source_url: string | null;
  /** date_only: the deadline is a day without a time. */
  deadline_precision: "exact" | "date_only" | null;
}

export interface TaskChanges {
  done?: boolean;
  ignored?: boolean;
  progress?: number;
  estimated_minutes?: number | null;
  spent_minutes?: number;
  notes?: string | null;
  /** Put the task on today's plan now (false takes it back off). */
  start_today?: boolean;
  title?: string;
  type?: TaskType;
  due_at?: string | null;
  due_date_only?: boolean;
  expected_revision?: number;
}

export interface NewTask {
  course_id: number;
  title: string;
  type: TaskType;
  due_at: string | null;
  estimated_minutes: number | null;
  notes: string | null;
  due_date_only?: boolean;
}

export type FileType = "lecture" | "homework" | "discussion" | "reading" | "exam" | "solution" | "other";

export interface CourseFile {
  id: number;
  course: CourseSummary;
  name: string;
  content_type: string | null;
  size_bytes: number;
  updated_at: string | null;
  download_url: string;
  /** The student's choice, else the detected type. */
  type: FileType;
  detected_type: string;
  user_override_type: FileType | null;
}

export interface TaskAttachment {
  file_id: number;
  filename: string;
  download_url: string;
}

export interface CourseTerm {
  term_id: string;
  display_name: string;
  start_at: string | null;
  end_at: string | null;
  sort_key: string;
  active_course_count: number;
  archived_course_count: number;
  is_default: boolean;
}

/** A task's timer totals (GET /api/tasks/:id/work and friends). */
export interface WorkSummary {
  task_id: number;
  state_revision: number;
  local_completed: boolean;
  tracked_minutes: number;
  manual_adjustment_minutes: number;
  effective_used_minutes: number;
  active_session_id: number | null;
  active_started_at: string | null;
  active_elapsed_seconds: number;
  switched_from_task_id?: number | null;
}

export interface ActiveWork extends WorkSummary {
  task_title: string;
  course: CourseSummary;
}

export type PriorityBucket = "Low" | "Medium" | "High" | "Critical";

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
  /** When it was read from Canvas. */
  fetched_at: string;
  /** True when Canvas couldn't be asked and this is the copy kept from an earlier read. */
  saved_copy: boolean;
}

/** One task with the assignment's description from Canvas. */
export interface TaskDetail extends Task {
  description: string | null;
  attachments: TaskAttachment[];
}

export interface AiStatus {
  enabled: boolean;
  model: string | null;
  /** The user's own connection (Settings > AI API) or the server's default. AI Chat types live in aiApi.ts. */
  source: "own" | "server" | null;
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
  priority_bucket: PriorityBucket;
}

/** Work due soon; `planned_minutes` is 0 when today's plan doesn't (yet) give it time. */
export type UpcomingItem = Pick<TodayItem, "task" | "remaining_minutes" | "planned_minutes" | "reasons"> & {
  priority_bucket: PriorityBucket | null;
};

export interface Today {
  date: string;
  time_zone: string;
  study_window: { start: string; end: string };
  /** Today's study intervals: the weekly availability, or the single study window. */
  study_windows: { start: string; end: string }[];
  /** availability, calendar (availability less busy events) or fallback (study window and daily goal). */
  capacity_source: CapacitySource;
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

export type CapacitySource = "calendar" | "availability" | "fallback";

export type EventType = "class" | "busy" | "personal" | "study" | "other";

export interface CalendarEvent {
  id: number;
  /** Unique per occurrence; occurrences of a recurring event share `id`. */
  key: string;
  title: string;
  location: string | null;
  description: string | null;
  all_day: boolean;
  /** "YYYY-MM-DD" for all-day events, otherwise an ISO instant. */
  start: string;
  /** Exclusive: the day after the last day, or when the event ends. */
  end: string;
  busy: boolean;
  event_type: EventType;
  /** IANA zone of the event's wall-clock times; null follows the planning zone. */
  time_zone: string | null;
  course: { id: number; code: string } | null;
  recurrence_rule: string | null;
  /** The first occurrence of a recurring event; edits change the whole series. */
  series: { start: string; end: string } | null;
  source: { id: number; name: string } | null;
  /** Only events added by hand can be changed; imported ones follow their file. */
  editable: boolean;
}

export interface EventFields {
  title: string;
  location: string | null;
  description?: string | null;
  all_day: boolean;
  /** An instant, a date (all day), or a wall-clock time read in `time_zone`. */
  start: string;
  end: string;
  busy: boolean;
  time_zone?: string | null;
  event_type?: EventType;
  course_id?: number | null;
  recurrence_rule?: string | null;
}

export interface CalendarSource {
  id: number;
  name: string;
  file_name: string | null;
  imported_at: string;
  last_reimported_at: string | null;
  event_count: number;
  recurring_series_count: number;
  /** The zone floating times were read in; null when every time named its own. */
  time_zone: string | null;
  range_start: string | null;
  range_end: string | null;
  read_only: true;
}

export interface IcsReconciliation {
  new: number;
  updated: number;
  removed: number;
  unchanged: number;
}

export interface IcsPreview {
  file_name: string | null;
  file_sha256: string;
  calendar_name: string | null;
  calendar_time_zone: string | null;
  time_zone_confirmation_required: boolean;
  event_count: number;
  recurring_series_count: number;
  range_start: string | null;
  range_end: string | null;
  reconciliation: IcsReconciliation;
  no_op: boolean;
  truncated: boolean;
  warnings: string[];
}

export interface CalendarImport extends CalendarSource {
  /** The file had more events than one import keeps. */
  truncated: boolean;
  preview: IcsPreview;
}
