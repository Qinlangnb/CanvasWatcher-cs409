// Course-website pages and readable website files as syllabus candidates, scored with the same
// name and grading-policy signals the Canvas syllabus finder uses (canvas/syllabus.ts).
import type { Block } from "../../canvas/richText.js";
import { blocksText } from "../../canvas/richText.js";
import { contentSignals, SYLLABUS_NAME, type Syllabus, type SyllabusSource } from "../../canvas/syllabus.js";
import type { Db } from "../../db.js";

const CUTOFF = 40;
const MAX_SOURCES = 5;

interface Scored {
  source: SyllabusSource;
  score: number;
}

function score(title: string, url: string, blocks: Block[]): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let points = 0;
  if (SYLLABUS_NAME.test(`${title} ${url}`)) {
    points += 50;
    reasons.push("syllabus-like name");
  }
  const signals = contentSignals(blocksText(blocks));
  return { score: points + signals.score, reasons: [...reasons, ...signals.reasons] };
}

/** Website candidates of one course, best first. */
export async function websiteSyllabusSources(db: Db, userId: string, courseId: number): Promise<Scored[]> {
  const pages = await db.websitePage.findMany({
    where: { userId, courseId, removedAt: null },
    select: { url: true, title: true, blocks: true, fetchedAt: true },
    take: 500,
  });
  const scored: Scored[] = [];
  for (const page of pages) {
    const blocks = (Array.isArray(page.blocks) ? page.blocks : []) as unknown as Block[];
    const { score: points, reasons } = score(page.title, page.url, blocks);
    if (points < CUTOFF) continue;
    scored.push({
      score: points,
      source: { kind: "page", title: page.title, html_url: page.url, download_url: null, updated_at: page.fetchedAt.toISOString(), reasons, blocks },
    });
  }
  const files = await db.courseFile.findMany({
    where: { userId, courseId, removedAt: null, sourceId: { not: null }, integrityStatus: "VALID" },
    select: { id: true, displayName: true, sourceUrl: true, canvasUpdatedAt: true },
    take: 500,
  });
  for (const file of files) {
    if (!SYLLABUS_NAME.test(`${file.displayName} ${file.sourceUrl ?? ""}`)) continue;
    scored.push({
      score: 50,
      source: {
        kind: "file",
        title: file.displayName,
        html_url: null,
        download_url: `/api/files/${file.id}/download`,
        updated_at: file.canvasUpdatedAt?.toISOString() ?? null,
        reasons: ["syllabus-like name"],
        blocks: [],
      },
    });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_SOURCES);
}

/** Adds the course's website candidates after what Canvas found (Canvas first, at most five). */
export async function withWebsiteSources(db: Db, userId: string, courseId: number, syllabus: Syllabus): Promise<Syllabus> {
  const extra = await websiteSyllabusSources(db, userId, courseId);
  if (extra.length === 0) return syllabus;
  const seen = new Set(syllabus.sources.map((source) => source.html_url ?? source.download_url));
  const sources = [...syllabus.sources, ...extra.map((row) => row.source).filter((source) => !seen.has(source.html_url ?? source.download_url))].slice(
    0,
    Math.max(MAX_SOURCES, syllabus.sources.length),
  );
  return { found: sources.length > 0, sources };
}

/** A course created by a course website (its canvasId is `website:<source id>`); Canvas knows nothing of it. */
export function isWebsiteCourse(course: { canvasId: string }): boolean {
  return course.canvasId.startsWith("website:");
}
