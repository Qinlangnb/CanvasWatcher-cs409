// The parts of Canvas REST API objects this app reads. Canvas returns many more fields.

export type CanvasId = number | string;

export interface CanvasUser {
  id: CanvasId;
  name?: string;
  short_name?: string;
}

export interface CanvasCourse {
  id: CanvasId;
  name?: string;
  course_code?: string;
  workflow_state?: string;
  access_restricted_by_date?: boolean;
  term?: { name?: string | null; start_at?: string | null; end_at?: string | null } | null;
  enrollments?: { enrollment_state?: string }[];
}

export interface CanvasAssignment {
  id: CanvasId;
  name?: string;
  description?: string | null;
  due_at?: string | null;
  lock_at?: string | null;
  points_possible?: number | null;
  html_url?: string;
  submission_types?: string[];
  submission?: { workflow_state?: string; submitted_at?: string | null } | null;
}

export interface CanvasFile {
  id: CanvasId;
  display_name?: string;
  filename?: string;
  "content-type"?: string;
  size?: number;
  updated_at?: string | null;
  modified_at?: string | null;
  /** Short-lived download URL; never stored. */
  url?: string;
}

export interface CanvasAnnouncement {
  id: CanvasId;
  title?: string;
  message?: string | null;
  posted_at?: string | null;
  html_url?: string;
}
