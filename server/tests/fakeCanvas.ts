import { CanvasClient, type CanvasClientFactory } from "../src/canvas/client.js";
import type { CanvasAnnouncement, CanvasAssignment, CanvasCourse, CanvasFile, CanvasUser } from "../src/canvas/types.js";

export const CANVAS_ORIGIN = "https://canvas.example.edu";
/** Fixture token accepted by the fake Canvas; not a real credential. */
export const CANVAS_TOKEN = "fake-canvas-token-0001";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** An in-memory Canvas that answers the REST calls CanvasClient makes. */
export class FakeCanvas {
  token = CANVAS_TOKEN;
  user: CanvasUser = { id: 42, name: "Ada Lovelace" };
  courses: CanvasCourse[] = [];
  assignments = new Map<string, CanvasAssignment[]>();
  files = new Map<string, CanvasFile[]>();
  announcements = new Map<string, CanvasAnnouncement[]>();
  /** Status codes to answer for a path instead of its data, for example 403 for a hidden Files tab. */
  failures = new Map<string, number>();
  /** Rows per page; small values exercise pagination. */
  pageSize = 100;
  /** While set, every request waits for it, so a test can hold a sync open. */
  gate: Promise<void> | null = null;
  readonly requests: string[] = [];

  reset(): void {
    this.token = CANVAS_TOKEN;
    this.user = { id: 42, name: "Ada Lovelace" };
    this.courses = [];
    this.assignments.clear();
    this.files.clear();
    this.announcements.clear();
    this.failures.clear();
    this.pageSize = 100;
    this.gate = null;
    this.requests.length = 0;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    this.requests.push(url.pathname + url.search);
    if (this.gate) await this.gate;
    if (url.origin !== CANVAS_ORIGIN) throw new TypeError("fetch failed");
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${this.token}`) return json({ errors: [{ message: "Invalid access token." }] }, 401);
    const failure = this.failures.get(url.pathname);
    if (failure) return json({ errors: [{ message: "failure" }] }, failure);

    const path = url.pathname;
    if (path === "/api/v1/users/self") return json(this.user);
    if (path === "/api/v1/courses") return this.page(url, this.courses);
    if (path === "/api/v1/announcements") {
      const courseId = url.searchParams.get("context_codes[]")?.replace(/^course_/, "") ?? "";
      return this.page(url, this.announcements.get(courseId) ?? []);
    }
    let match = /^\/api\/v1\/courses\/([^/]+)\/assignments$/.exec(path);
    if (match) return this.page(url, this.assignments.get(match[1] as string) ?? []);
    match = /^\/api\/v1\/courses\/([^/]+)\/files$/.exec(path);
    if (match) return this.page(url, this.files.get(match[1] as string) ?? []);
    match = /^\/api\/v1\/courses\/([^/]+)\/files\/([^/]+)$/.exec(path);
    if (match) {
      const file = (this.files.get(match[1] as string) ?? []).find((row) => String(row.id) === match?.[2]);
      if (!file) return json({ errors: [{ message: "not found" }] }, 404);
      return json({ ...file, url: `${CANVAS_ORIGIN}/files/${file.id}/download?download_frd=1&verifier=fake` });
    }
    return json({ errors: [{ message: "not found" }] }, 404);
  };

  readonly factory: CanvasClientFactory = (baseUrl, token) =>
    new CanvasClient({ baseUrl, token, fetch: this.fetch, retries: 0 });

  private page(url: URL, rows: unknown[]): Response {
    const page = Number(url.searchParams.get("page") ?? "1");
    const size = Math.min(this.pageSize, Number(url.searchParams.get("per_page") ?? "10"));
    const slice = rows.slice((page - 1) * size, page * size);
    if (page * size >= rows.length) return json(slice);
    const next = new URL(url);
    next.searchParams.set("page", String(page + 1));
    return json(slice, 200, { link: `<${next}>; rel="next"` });
  }
}

export const fakeCanvas = new FakeCanvas();

/** A Canvas-style timestamp `days` from now. Fixed dates drift into the tests' planning windows. */
export const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** One course with an assignment, a file and an announcement. */
export function seedCourse(canvas: FakeCanvas, id = 101, code = "CS 409"): void {
  const key = String(id);
  canvas.courses.push({
    id,
    name: `${code}: The Art of Web Programming`,
    course_code: code,
    workflow_state: "available",
    term: { name: "Fall 2026", start_at: "2026-08-24T05:00:00Z", end_at: "2026-12-18T05:00:00Z" },
  });
  canvas.assignments.set(key, [
    {
      id: id * 10 + 1,
      name: "MP 1: Layout",
      description: "<p>Build a <b>responsive</b> page.</p>",
      // Past Today's two-week horizon, so it never enters the plan tests.
      due_at: daysFromNow(20),
      points_possible: 100,
      html_url: `${CANVAS_ORIGIN}/courses/${id}/assignments/${id * 10 + 1}`,
      submission: { workflow_state: "unsubmitted", submitted_at: null },
    },
  ]);
  canvas.files.set(key, [
    {
      id: id * 100 + 1,
      display_name: "syllabus.pdf",
      "content-type": "application/pdf",
      size: 12_345,
      modified_at: "2026-08-20T12:00:00Z",
    },
  ]);
  canvas.announcements.set(key, [
    {
      id: id * 1000 + 1,
      title: "Welcome",
      message: "<p>Welcome to the course!</p>",
      posted_at: new Date().toISOString(),
      html_url: `${CANVAS_ORIGIN}/courses/${id}/discussion_topics/${id * 1000 + 1}`,
    },
  ]);
}
