// Files an assignment's description links to: exact Canvas file references on the same Canvas, in
// the same course (or course-less /files/<id> links). Titles are never guessed from.

const COURSE_FILE = /^\/(?:api\/v1\/)?courses\/(\d+)\/files\/(\d+)(?:\/(?:download|preview))?\/?$/;
const GLOBAL_FILE = /^\/(?:api\/v1\/)?files\/(\d+)(?:\/(?:download|preview))?\/?$/;

/** The Canvas file id a link points at, or null. */
export function canvasFileId(reference: string, courseCanvasId: string, baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(reference.trim(), `${baseUrl.replace(/\/$/, "")}/`);
  } catch {
    return null;
  }
  if (url.origin !== new URL(baseUrl).origin) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const inCourse = COURSE_FILE.exec(path);
  if (inCourse) return inCourse[1] === courseCanvasId ? (inCourse[2] as string) : null;
  return GLOBAL_FILE.exec(path)?.[1] ?? null;
}

const ATTRIBUTE = /\b(href|src|data|data-api-endpoint)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const decode = (value: string) => value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Canvas file ids linked from rich-content HTML, in order of first appearance. */
export function linkedFileIds(html: string | null | undefined, courseCanvasId: string, baseUrl: string): string[] {
  if (!html) return [];
  const found = new Set<string>();
  for (const match of html.matchAll(ATTRIBUTE)) {
    const id = canvasFileId(decode(match[2] ?? match[3] ?? ""), courseCanvasId, baseUrl);
    if (id) found.add(id);
  }
  return [...found];
}
