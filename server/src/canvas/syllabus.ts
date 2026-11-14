// Finds a course's syllabus wherever the instructor put it. Courses publish it in very different
// places: the Canvas Syllabus tab, a Canvas Page ("Course Information", "Syllabus"), a file in
// Files or a module, or a link to another site. Every candidate is scored by its name, by links
// pointing at it from the Syllabus tab and syllabus-named modules, and by grading-policy content.
// Pages are read live from Canvas when the Syllabus tab is opened; files are offered as downloads
// because this app does not read file contents.
import { CanvasError, type CanvasClient } from "./client.js";
import type { CanvasId } from "./types.js";
import { blocksText, htmlBlocks, type Block } from "./richText.js";

export const SYLLABUS_NAME =
  /syl+ab|course\s*(?:info(?:rmation)?|outline|polic(?:y|ies)|overview|guide|handbook)|grading\s*polic|教学大纲|课程大纲|课程说明/i;
const POLICY =
  /grad(?:e|ing)\s*(?:breakdown|scale|scheme|policy|policies|distribution|weights?|cutoffs?)|letter\s+grades?|final\s+grades?|course\s+grade|late\s+(?:policy|work|submissions?|penalty)|academic\s+integrity|office\s+hours|attendance|make-?up|drop(?:ped)?\s+(?:the\s+)?lowest|\b[ABCD][+-]?\s*[:=(]?\s*\d{2}/gi;
const SECTION = /^#+\s*(?:course\s+)?(?:grading|grades?|evaluation|assessments?|exams?|policies)\b/gim;
const PERCENT = /\b\d{1,3}(?:\.\d+)?\s?%/g;
/** Pages read per request; each is one Canvas call. */
const MAX_PAGE_READS = 6;
const MAX_SOURCES = 5;
const CUTOFF = 40;

export interface SyllabusFile {
  id: number;
  canvasId: string;
  displayName: string;
}

export interface SyllabusSource {
  kind: "syllabus" | "page" | "file" | "link";
  title: string;
  /** Canvas page for syllabus and page sources, the outside address for links. */
  html_url: string | null;
  /** This app's download route, for files. */
  download_url: string | null;
  updated_at: string | null;
  reasons: string[];
  blocks: Block[];
}

export interface Syllabus {
  found: boolean;
  sources: SyllabusSource[];
}

interface CanvasPageSummary {
  url: string;
  title?: string;
  html_url?: string;
  updated_at?: string | null;
  front_page?: boolean;
  body?: string | null;
}

interface CanvasModule {
  name?: string;
  items?: { title?: string; type?: string; page_url?: string; content_id?: CanvasId; external_url?: string; html_url?: string }[];
}

interface Candidate {
  kind: SyllabusSource["kind"];
  key: string;
  title: string;
  score: number;
  reasons: string[];
  html_url: string | null;
  download_url: string | null;
  updated_at: string | null;
  blocks: Block[];
  /** Page slug still to read from Canvas. */
  slug?: string;
}

/** Points for grading and policy content: terms, percentages and section headings. */
export function contentSignals(text: string): { score: number; reasons: string[] } {
  const policy = text.match(POLICY)?.length ?? 0;
  const percent = text.match(PERCENT)?.length ?? 0;
  const sections = text.match(SECTION)?.length ?? 0;
  const reasons: string[] = [];
  if (sections) reasons.push("grading or policy section");
  if (policy) reasons.push(`${policy} grading or policy terms`);
  if (percent >= 3) reasons.push(`${percent} percentages`);
  return { score: Math.min(policy, 8) * 4 + Math.min(percent, 10) * 2 + Math.min(sections, 2) * 8, reasons };
}

/** Missing or hidden course areas (Pages or Modules turned off) are skipped; token problems are not. */
async function optional<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof CanvasError && (error.kind === "FORBIDDEN" || error.kind === "NOT_FOUND")) return fallback;
    throw error;
  }
}

function links(html: string | null | undefined): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  for (const match of (html ?? "").matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    out.push({ href: match[1] as string, text: blocksText(htmlBlocks(match[2])) });
  }
  return out;
}

export async function findSyllabus(
  client: CanvasClient,
  canvasCourseId: string,
  courseUrl: string,
  files: SyllabusFile[],
): Promise<Syllabus> {
  const id = encodeURIComponent(canvasCourseId);
  const origin = new URL(courseUrl).origin;
  const [course, pages, modules] = await Promise.all([
    optional(() => client.get<{ syllabus_body?: string | null }>(`/api/v1/courses/${id}`, [["include[]", "syllabus_body"]]), {}),
    optional(() => client.getAll<CanvasPageSummary>(`/api/v1/courses/${id}/pages`, [["sort", "title"]]), []),
    optional(() => client.getAll<CanvasModule>(`/api/v1/courses/${id}/modules`, [["include[]", "items"]]), []),
  ]);
  const pageBySlug = new Map(pages.map((page) => [page.url, page]));
  const fileByCanvasId = new Map(files.map((file) => [file.canvasId, file]));
  const candidates = new Map<string, Candidate>();

  const note = (candidate: Omit<Candidate, "score" | "reasons">, points: number, reason: string) => {
    const row = candidates.get(candidate.key) ?? { ...candidate, score: 0, reasons: [] };
    row.score += points;
    if (!row.reasons.includes(reason)) row.reasons.push(reason);
    candidates.set(candidate.key, row);
  };
  const page = (slug: string) => {
    const summary = pageBySlug.get(slug);
    return {
      kind: "page" as const,
      key: `page:${slug}`,
      title: summary?.title ?? slug,
      html_url: summary?.html_url ?? `${courseUrl}/pages/${encodeURIComponent(slug)}`,
      download_url: null,
      updated_at: summary?.updated_at ?? null,
      blocks: [],
      slug,
    };
  };
  const file = (row: SyllabusFile) => ({
    kind: "file" as const,
    key: `file:${row.canvasId}`,
    title: row.displayName,
    html_url: null,
    download_url: `/api/files/${row.id}/download`,
    updated_at: null,
    blocks: [],
  });
  const link = (href: string, text: string) => ({
    kind: "link" as const,
    key: `link:${href}`,
    title: text || href,
    html_url: href,
    download_url: null,
    updated_at: null,
    blocks: [],
  });
  /** Canvas pages and files a link points at; outside links only when they look like a syllabus. */
  const follow = (html: string | null | undefined, points: number, reason: string) => {
    for (const { href, text } of links(html)) {
      let url: URL;
      try {
        url = new URL(href, origin);
      } catch {
        continue;
      }
      const fileId = /\/files\/(\d+)/.exec(url.pathname)?.[1];
      const slug = /\/pages\/([^/?#]+)/.exec(url.pathname)?.[1];
      if (url.origin === origin && fileId) {
        const row = fileByCanvasId.get(fileId);
        if (row) note(file(row), points, reason);
      } else if (url.origin === origin && slug) {
        note(page(decodeURIComponent(slug)), points, reason);
      } else if (url.origin !== origin && /^https?:$/.test(url.protocol) && SYLLABUS_NAME.test(`${text} ${url.pathname}`)) {
        note(link(url.toString(), text), points, reason);
      }
    }
  };

  const body = course.syllabus_body ?? "";
  if (body.trim()) {
    note(
      {
        kind: "syllabus",
        key: "syllabus",
        title: "Syllabus",
        html_url: `${courseUrl}/assignments/syllabus`,
        download_url: null,
        updated_at: null,
        blocks: htmlBlocks(body),
      },
      50,
      "Canvas Syllabus tab",
    );
    follow(body, 45, "linked from the Canvas Syllabus tab");
  }
  for (const module of modules) {
    for (const item of module.items ?? []) {
      if (!SYLLABUS_NAME.test(`${item.title ?? ""} ${module.name ?? ""}`)) continue;
      if (item.type === "Page" && item.page_url) note(page(item.page_url), 45, "syllabus entry in Modules");
      else if (item.type === "File" && item.content_id !== undefined) {
        const row = fileByCanvasId.get(String(item.content_id));
        if (row) note(file(row), 45, "syllabus entry in Modules");
      } else if (item.type === "ExternalUrl" && item.external_url) {
        note(link(item.external_url, item.title ?? ""), 45, "syllabus entry in Modules");
      }
    }
  }
  for (const summary of pages) {
    if (SYLLABUS_NAME.test(summary.title ?? "")) note(page(summary.url), 60, "named like a syllabus");
  }
  for (const row of files) {
    if (SYLLABUS_NAME.test(row.displayName)) note(file(row), 60, "named like a syllabus");
  }
  // The front page often is the course information page, without saying so in its title.
  const front = pages.find((summary) => summary.front_page);
  if (front && !candidates.has(`page:${front.url}`)) {
    candidates.set(`page:${front.url}`, { ...page(front.url), score: 16, reasons: ["course front page"] });
  }

  // Read the most promising pages. A syllabus-named page may itself link to the real syllabus,
  // so pages it points at get a second, smaller round.
  const read = new Set<Candidate>();
  for (const budget of [MAX_PAGE_READS - 2, 2]) {
    const batch = [...candidates.values()]
      .filter((row) => row.slug && !read.has(row))
      .sort((a, b) => b.score - a.score)
      .slice(0, budget);
    const bodies = await Promise.all(
      batch.map((row) =>
        optional(() => client.get<CanvasPageSummary>(`/api/v1/courses/${id}/pages/${encodeURIComponent(row.slug as string)}`), null),
      ),
    );
    batch.forEach((row, index) => {
      read.add(row);
      const body = bodies[index];
      if (!body) {
        candidates.delete(row.key);
        return;
      }
      row.title = body.title ?? row.title;
      row.html_url = body.html_url ?? row.html_url;
      row.updated_at = body.updated_at ?? row.updated_at;
      row.blocks = htmlBlocks(body.body);
      if (SYLLABUS_NAME.test(row.title)) follow(body.body, 30, `linked from ${row.title}`);
    });
  }

  const sources: (SyllabusSource & { score: number })[] = [];
  for (const row of candidates.values()) {
    if (row.slug && !read.has(row)) continue; // never read, so nothing to show
    let score = row.score;
    const reasons = [...row.reasons];
    if (row.kind === "syllabus" || row.kind === "page") {
      const text = blocksText(row.blocks);
      if (!text.trim()) continue;
      const content = contentSignals(text);
      score += content.score;
      reasons.push(...content.reasons);
      // "See the syllabus PDF": the tab itself is then only a pointer.
      if (row.kind === "syllabus" && text.length < 300) score -= 35;
    }
    if (score < CUTOFF) continue;
    sources.push({
      kind: row.kind,
      title: row.title,
      html_url: row.html_url,
      download_url: row.download_url,
      updated_at: row.updated_at,
      reasons,
      blocks: row.blocks,
      score,
    });
  }
  sources.sort((a, b) => b.score - a.score);
  return { found: sources.length > 0, sources: sources.slice(0, MAX_SOURCES).map(({ score: _score, ...source }) => source) };
}
