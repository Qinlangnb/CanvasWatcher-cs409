// What kind of change a change event is, how much it matters, and whether the default "Important" feed shows it.
// Ported from the original app's change policy: the student hears about new files, new announcements and grade
// releases, plus deadline changes; edits to wording, sizes and the like stay in the full list only.
import { createHash } from "node:crypto";
import type { Content, ContentValue } from "../canvas/normalize.js";
import type { ChangeType, ItemKind } from "../generated/prisma/enums.js";

export type Category = "grade" | "deadline" | "file" | "announcement" | "assignment" | "content";
export type Importance = "minor" | "important" | "critical";

export interface Taxonomy {
  category: Category;
  importance: Importance;
  requiresAction: boolean;
  userFacing: boolean;
}

export const GRADE_FIELDS = ["score", "grade", "excused"] as const;
const DEADLINE_FIELDS = new Set(["due_at", "lock_at"]);

export function classify(kind: ItemKind, changeType: ChangeType, fields: string[]): Taxonomy {
  const has = (names: Iterable<string>) => {
    const wanted = new Set(names);
    return fields.some((field) => wanted.has(field));
  };
  if (kind === "ASSIGNMENT" && changeType === "UPDATED" && has(GRADE_FIELDS)) {
    return { category: "grade", importance: "important", requiresAction: false, userFacing: true };
  }
  if (kind === "FILE") return { category: "file", importance: "minor", requiresAction: false, userFacing: changeType === "CREATED" };
  if (kind === "ANNOUNCEMENT") {
    return { category: "announcement", importance: "minor", requiresAction: false, userFacing: changeType === "CREATED" };
  }
  if (changeType === "UPDATED" && has(DEADLINE_FIELDS)) {
    return { category: "deadline", importance: "important", requiresAction: true, userFacing: true };
  }
  return { category: "assignment", importance: "minor", requiresAction: false, userFacing: false };
}

/** Canvas shows a grade once it has a score, a letter grade or an excusal; a zero is a real score. */
export function gradeIsReleased(content: Content | null | undefined): boolean {
  if (!content) return false;
  const grade = content.grade;
  return content.excused === 1 || typeof content.score === "number" || (typeof grade === "string" && grade.trim() !== "");
}

/** A short name for the transition, used by filters, AI context and the dedupe key, for example `file_created`. */
export function transition(kind: ItemKind, changeType: ChangeType, category: string, before: Content | null | undefined): string {
  if (category === "grade") return gradeIsReleased(before) ? "grade_updated" : "grade_released";
  if (category === "deadline") return "deadline_changed";
  return `${kind.toLowerCase()}_${changeType.toLowerCase()}`;
}

const LABELS: Record<string, string> = {
  grade_released: "Grade released",
  grade_updated: "Grade updated",
  deadline_changed: "Deadline changed",
  file_created: "New file",
  file_updated: "File updated",
  file_removed: "File removed",
  announcement_created: "New announcement",
  announcement_updated: "Announcement updated",
  announcement_removed: "Announcement removed",
  assignment_created: "New assignment",
  assignment_updated: "Assignment updated",
  assignment_removed: "Assignment removed",
};

export function eventLabel(name: string): string {
  return LABELS[name] ?? "Content updated";
}

/** Keys are sorted: content read back from jsonb comes in another key order than freshly built content. */
const hashOf = (content: Content | null | undefined) =>
  content ? createHash("sha256").update(JSON.stringify(Object.entries(content).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))).digest("hex") : null;

/** The same transition of the same item always gets the same key, so a repeat (a retried sync, two syncs racing) is not reported again. */
export function semanticKey(sourceItemId: number, name: string, before: Content | null | undefined, after: Content | null | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify([sourceItemId, name, hashOf(before), hashOf(after)]))
    .digest("hex");
}

const SNAPSHOT_LABELS: Record<string, string> = {
  title: "Title",
  name: "Name",
  due_at: "Due",
  lock_at: "Locks",
  points_possible: "Points",
  size: "Size (bytes)",
  content_type: "File type",
  updated_at: "Updated",
  posted_at: "Posted",
  score: "Score",
  grade: "Grade",
  excused: "Excused",
};

const show = (value: ContentValue) => (value === null ? "none" : String(value));

/** One version of an item as plain text for the change dialog: short fields first, then the body text. */
export function snapshotText(content: Content | null | undefined): string | null {
  if (!content) return null;
  const lines: string[] = [];
  const long: string[] = [];
  for (const [key, value] of Object.entries(content)) {
    if (key === "description" || key === "message") {
      if (typeof value === "string" && value.trim()) long.push(value);
      continue;
    }
    if (key === "excused") {
      if (value === 1) lines.push("Excused: yes");
      continue;
    }
    lines.push(`${SNAPSHOT_LABELS[key] ?? key.replaceAll("_", " ")}: ${show(value)}`);
  }
  return [lines.join("\n"), ...long].filter(Boolean).join("\n\n");
}
