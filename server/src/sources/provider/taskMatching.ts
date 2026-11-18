// Pure rules for joining provider assignments (Gradescope) with existing tasks (Canvas). Only
// explicit same-origin provider IDs bind automatically; a matching title is just a candidate
// that the user must confirm, because "Homework 3" in two systems is not proof of identity.

export type SourceType = "canvas" | "gradescope" | "prairielearn" | "website";

export interface TaskRef {
  id: number;
  title: string;
  /** ISO instant or null. */
  dueAt: string | null;
}

/** "HW 03" and "Homework 3" read the same; punctuation and case are ignored. */
export function normalizedTaskTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:hw|homework)\s*0*(\d+)\b/g, "homework $1")
    .replace(/[^\p{L}\p{N}_]+/gu, "");
}

const DAY_MS = 86_400_000;

/** Same-course tasks whose title matches and whose due date (when both have one) is within a day. */
export function weakTaskCandidates<T extends TaskRef>(tasks: readonly T[], title: string, dueAt: string | null): T[] {
  const wanted = normalizedTaskTitle(title);
  const incoming = dueAt ? Date.parse(dueAt) : NaN;
  return tasks.filter((task) => {
    if (normalizedTaskTitle(task.title) !== wanted) return false;
    const existing = task.dueAt ? Date.parse(task.dueAt) : NaN;
    return Number.isNaN(incoming) || Number.isNaN(existing) || Math.abs(incoming - existing) <= DAY_MS;
  });
}

/** (host, course, assignment) of a Gradescope assignment URL; null for anything else. */
export function gradescopeIdentity(value: unknown): [string, string, string] | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || /[?#]/.test(value)) return null;
  const match = /^\/courses\/(\d+)\/assignments\/(\d+)(?:\/submissions\/\d+)?\/?$/.exec(url.pathname);
  return match?.[1] && match[2] ? [url.host, match[1], match[2]] : null;
}

/** A source item with the structured data of its latest snapshot. */
export interface ItemEvidence {
  sourceType: SourceType;
  url: string | null;
  structured: Record<string, unknown>;
  isDeleted?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function identityOf(item: ItemEvidence): [string, string, string] | null {
  if (item.sourceType === "canvas") {
    // A Canvas assignment that launches Gradescope names it in its external tool URL.
    return gradescopeIdentity(record(item.structured.external_tool_tag_attributes).url);
  }
  if (item.sourceType === "gradescope") {
    const facts = record(item.structured.provider_facts);
    let host: string;
    try {
      host = new URL(item.url ?? "").host;
    } catch {
      return null;
    }
    const course = facts.provider_course_id;
    const assignment = facts.provider_assignment_id;
    return course != null && assignment != null && course !== "" && assignment !== "" ? [host, String(course), String(assignment)] : null;
  }
  return null;
}

/**
 * The task an item is strongly bound to: the single task linked to an item of the other system
 * (Canvas <-> Gradescope) with the same host/course/assignment identity. Ambiguity binds nothing.
 */
export function stronglyBoundTask(item: ItemEvidence, linked: readonly (ItemEvidence & { taskId: number })[]): number | null {
  if (item.sourceType !== "canvas" && item.sourceType !== "gradescope") return null;
  const identity = identityOf(item);
  if (!identity) return null;
  const opposite = item.sourceType === "canvas" ? "gradescope" : "canvas";
  const tasks = new Set<number>();
  for (const other of linked) {
    if (other.sourceType !== opposite || other.isDeleted) continue;
    const otherIdentity = identityOf(other);
    if (otherIdentity && otherIdentity.every((part, index) => part === identity[index])) tasks.add(other.taskId);
  }
  return tasks.size === 1 ? ([...tasks][0] ?? null) : null;
}

export type ProviderTaskDecision =
  | { kind: "bound"; taskId: number }
  | { kind: "new" }
  | { kind: "mapping_required"; candidates: number[] }
  | { kind: "mapping_invalid" };

/**
 * What a Gradescope assignment attaches to: an existing link or strong binding, the user's
 * confirmed task (same course only), a new task when the user said "separate" or nothing
 * resembles it, otherwise a request for the user to decide (PROVIDER_TASK_MAPPING_REQUIRED).
 */
export function decideProviderTask(input: {
  linkedTaskId: number | null;
  strongTaskId: number | null;
  confirmedTaskId: number | null;
  confirmedSeparate: boolean;
  courseTaskIds: ReadonlySet<number>;
  weakCandidates: readonly TaskRef[];
}): ProviderTaskDecision {
  const bound = input.linkedTaskId ?? input.strongTaskId;
  if (bound !== null) return { kind: "bound", taskId: bound };
  if (input.confirmedTaskId !== null) {
    return input.courseTaskIds.has(input.confirmedTaskId) ? { kind: "bound", taskId: input.confirmedTaskId } : { kind: "mapping_invalid" };
  }
  if (!input.confirmedSeparate && input.weakCandidates.length) {
    return { kind: "mapping_required", candidates: input.weakCandidates.map((task) => task.id) };
  }
  return { kind: "new" };
}

const FACT_KEYS = [
  "provider",
  "provider_course_id",
  "provider_assignment_id",
  "due_at",
  "late_due_at",
  "personal_due_at",
  "submission_state",
  "submitted_at",
  "score",
  "max_score",
  "grade",
  "excused",
  "grade_published",
  "direct_assignment_url",
  "evidence",
] as const;

export type ProviderFactRow = Partial<Record<(typeof FACT_KEYS)[number], unknown>> & {
  source_item_id: number;
  source_url: string | null;
  is_deleted: boolean;
};

/**
 * Score facts of a Canvas submission. Canvas hides unposted scores from students, so a missing
 * score is "unpublished", not zero; without `posted_at` a visible score counts as published.
 */
function canvasGrade(submission: Record<string, unknown>, structured: Record<string, unknown>) {
  const score = submission.score ?? null;
  const grade = submission.grade ?? null;
  const excused = submission.excused === true;
  const hasGrade = excused || score !== null || (grade !== null && String(grade).trim() !== "");
  let published: boolean | null;
  if (!hasGrade) published = "posted_at" in submission && submission.graded_at ? false : null;
  else published = "posted_at" in submission ? Boolean(submission.posted_at) : true;
  return { score, max_score: structured.points_possible ?? null, grade, excused: excused || null, grade_published: published };
}

/** Provider facts of one item through an explicit allow-list: provider HTML or private fields never pass. */
export function providerFact(
  item: { id: number; sourceType: SourceType; url: string | null; isDeleted: boolean },
  structured: Record<string, unknown>,
): ProviderFactRow | null {
  let facts: unknown = structured.provider_facts;
  if (item.sourceType === "canvas") {
    const submission = record(structured.submission);
    const workflow = submission.workflow_state;
    const state =
      submission.graded_at || (submission.grade !== undefined && submission.grade !== null)
        ? "graded"
        : submission.submitted_at || workflow === "submitted" || workflow === "pending_review"
          ? "submitted"
          : (workflow ?? "unknown");
    facts = {
      provider: "canvas",
      due_at: structured.due_at ?? null,
      submission_state: state,
      submitted_at: submission.submitted_at ?? null,
      direct_assignment_url: item.url,
      ...canvasGrade(submission, structured),
    };
  }
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return null;
  const source = facts as Record<string, unknown>;
  const allowed = Object.fromEntries(FACT_KEYS.map((key) => [key, source[key] ?? null]));
  return { ...allowed, source_item_id: item.id, source_url: item.url, is_deleted: item.isDeleted };
}

/** graded > submitted from Canvas or Gradescope. PrairieLearn credit is not proof of submission. */
export function terminalState(facts: readonly ProviderFactRow[]): "graded" | "submitted" | null {
  const states = new Set(
    facts.filter((row) => (row.provider === "canvas" || row.provider === "gradescope") && !row.is_deleted).map((row) => row.submission_state),
  );
  return states.has("graded") ? "graded" : states.has("submitted") ? "submitted" : null;
}
