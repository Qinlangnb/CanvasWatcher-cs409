import { createHash } from "node:crypto";
import type { ChangeType, ItemKind } from "../generated/prisma/enums.js";
import type { CanvasAnnouncement, CanvasAssignment, CanvasCourse, CanvasFile } from "./types.js";

/** Long descriptions are cut so one course cannot fill the database. */
const MAX_TEXT = 10_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Plain text of Canvas rich content, keeping paragraph breaks. Good enough for diffs and previews. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (code[0] === "#") {
        const point = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
      }
      return ENTITIES[code.toLowerCase()] ?? entity;
    });
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT);
}

/** Guesses a task category from its title (ported from the legacy Python backend). */
export function taskType(title: string, groupName?: string | null): string {
  const value = `${groupName ?? ""} ${title}`.toLowerCase();
  if (value.includes("project")) return "project";
  if (/\bexam|midterm|final|quiz\b/.test(value)) return "exam";
  if (value.includes("reading")) return "reading";
  return /\bhw\b|homework/.test(value) ? "homework" : "assignment";
}

export function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function dateOrNull(value: string | null | undefined): Date | null {
  const iso = isoOrNull(value);
  return iso ? new Date(iso) : null;
}

/** Canvas lists courses a student can no longer open; those are skipped. */
export function isReadableCourse(course: CanvasCourse): boolean {
  return !course.access_restricted_by_date && course.workflow_state !== "completed" && course.workflow_state !== "deleted";
}

export type ContentValue = string | number | null;
export type Content = Record<string, ContentValue>;

/** The version of a Canvas item that is compared between syncs. */
export interface TrackedItem {
  kind: ItemKind;
  canvasId: string;
  title: string;
  htmlUrl: string | null;
  content: Content;
}

export function trackedAssignment(assignment: CanvasAssignment): TrackedItem {
  const title = assignment.name?.trim() || "Untitled assignment";
  return {
    kind: "ASSIGNMENT",
    canvasId: String(assignment.id),
    title,
    htmlUrl: assignment.html_url ?? null,
    // The student's own submission is left out: it is progress, not a change made in Canvas.
    content: {
      title,
      due_at: isoOrNull(assignment.due_at),
      lock_at: isoOrNull(assignment.lock_at),
      points_possible: assignment.points_possible ?? null,
      description: htmlToText(assignment.description),
    },
  };
}

export function trackedFile(file: CanvasFile, courseUrl: string): TrackedItem {
  const name = file.display_name?.trim() || file.filename || "Untitled file";
  return {
    kind: "FILE",
    canvasId: String(file.id),
    title: name,
    htmlUrl: `${courseUrl}/files/${encodeURIComponent(String(file.id))}`,
    content: {
      name,
      size: file.size ?? 0,
      content_type: file["content-type"] ?? null,
      updated_at: isoOrNull(file.modified_at ?? file.updated_at),
    },
  };
}

export function trackedAnnouncement(announcement: CanvasAnnouncement): TrackedItem {
  const title = announcement.title?.trim() || "Untitled announcement";
  return {
    kind: "ANNOUNCEMENT",
    canvasId: String(announcement.id),
    title,
    htmlUrl: announcement.html_url ?? null,
    content: {
      title,
      message: htmlToText(announcement.message),
      posted_at: isoOrNull(announcement.posted_at),
    },
  };
}

/** Builders give content a fixed key order, so plain JSON is a stable input for the hash. */
export function contentHash(content: Content): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export function changedFields(before: Content, after: Content): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null));
}

const FIELD_LABELS: Record<string, string> = {
  title: "title",
  due_at: "due date",
  lock_at: "lock date",
  points_possible: "points",
  description: "description",
  name: "name",
  size: "size",
  content_type: "file type",
  updated_at: "contents",
  message: "message",
  posted_at: "posting date",
};

function sentenceList(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One line shown in the change feed, for example `Due date changed for "HW 3"`. */
export function changeSummary(kind: ItemKind, type: ChangeType, title: string, fields: string[] = []): string {
  if (kind === "FILE") {
    if (type === "CREATED") return `New file: ${title}`;
    if (type === "REMOVED") return `File removed: ${title}`;
    return `File updated: ${title}`;
  }
  const noun = kind === "ASSIGNMENT" ? "assignment" : "announcement";
  if (type === "CREATED") return `New ${noun}: "${title}"`;
  if (type === "REMOVED") return `${capitalize(noun)} removed: "${title}"`;
  const labels = fields.map((field) => FIELD_LABELS[field] ?? field.replaceAll("_", " "));
  return labels.length > 0 ? `${capitalize(sentenceList(labels))} changed for "${title}"` : `${capitalize(noun)} updated: "${title}"`;
}
