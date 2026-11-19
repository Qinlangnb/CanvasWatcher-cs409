import { CanvasClient, type CanvasClientFactory } from "../src/canvas/client.js";
import type { CanvasAnnouncement, CanvasAssignment, CanvasAssignmentGroup, CanvasCourse, CanvasFile, CanvasUser } from "../src/canvas/types.js";

export const CANVAS_ORIGIN = "https://canvas.example.edu";
/** Fixture token accepted by the fake Canvas; not a real credential. */
export const CANVAS_TOKEN = "fake-canvas-token-0001";
/** Fixture browser-session cookie value accepted by the fake Canvas. */
export const CANVAS_SESSION = "fake-session-0001";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export interface FakePage {
  url: string;
  title: string;
  body: string;
  html_url?: string;
  front_page?: boolean;
  updated_at?: string;
}

export interface FakeModule {
  id: number;
  name: string;
  items: { id: number; title: string; type: string; page_url?: string; content_id?: number; external_url?: string }[];
}

/** An in-memory Canvas that answers the REST calls CanvasClient makes. */
export class FakeCanvas {
  token = CANVAS_TOKEN;
  user: CanvasUser = { id: 42, name: "Ada Lovelace" };
  /** Value of the canvas_session cookie a signed-in browser sends; null signs every browser out. */
  session: string | null = CANVAS_SESSION;
  /** Who the session belongs to, when not `user`. */
  sessionUser: CanvasUser | null = null;
  /** How Canvas turns away a signed-out browser: a 401, a redirect to the login page, or that page itself. */
  sessionRejection: "401" | "redirect" | "html" = "401";
  /** When set, answers to a browser session also rotate this cookie. */
  rotateCookie: string | null = null;
  /** More bearer tokens and whom they sign in as (another account, OAuth access tokens). */
  extraTokens = new Map<string, CanvasUser>();
  /** OAuth: authorization codes and refresh tokens the token endpoint accepts. */
  oauthCodes = new Map<string, CanvasUser>();
  oauthRefresh = new Map<string, CanvasUser>();
  oauthIssued = 0;
  courses: CanvasCourse[] = [];
  assignments = new Map<string, CanvasAssignment[]>();
  files = new Map<string, CanvasFile[]>();
  announcements = new Map<string, CanvasAnnouncement[]>();
  /** Assignment groups per course; a course without an entry answers 404, like a hidden grading setup. */
  assignmentGroups = new Map<string, CanvasAssignmentGroup[]>();
  /** Syllabus tab HTML per course. */
  syllabusBodies = new Map<string, string>();
  pages = new Map<string, FakePage[]>();
  modules = new Map<string, FakeModule[]>();
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
    this.session = CANVAS_SESSION;
    this.sessionUser = null;
    this.sessionRejection = "401";
    this.rotateCookie = null;
    this.extraTokens.clear();
    this.oauthCodes.clear();
    this.oauthRefresh.clear();
    this.oauthIssued = 0;
    this.courses = [];
    this.assignments.clear();
    this.files.clear();
    this.announcements.clear();
    this.assignmentGroups.clear();
    this.syllabusBodies.clear();
    this.pages.clear();
    this.modules.clear();
    this.failures.clear();
    this.pageSize = 100;
    this.gate = null;
    this.requests.length = 0;
  }

  /** Answers like Canvas; with `rotateCookie`, every answer to a signed-in browser also sets a cookie. */
  readonly fetch: typeof fetch = async (input, init) => {
    const response = await this.handle(input, init);
    const cookie = new Headers(init?.headers).get("cookie");
    if (this.rotateCookie && cookie?.includes(`canvas_session=${this.session}`) && response.status === 200) {
      response.headers.append("set-cookie", `_csrf_token=${this.rotateCookie}; path=/; secure`);
    }
    return response;
  };

  private readonly handle: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    this.requests.push(url.pathname + url.search);
    if (this.gate) await this.gate;
    if (url.origin !== CANVAS_ORIGIN) throw new TypeError("fetch failed");
    if (url.pathname === "/login/oauth2/token" && init?.method === "POST") return this.oauthToken(String(init.body));
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    const cookie = headers.get("cookie");
    let who: CanvasUser | null = null;
    if (auth?.startsWith("Bearer ")) {
      const presented = auth.slice(7);
      who = presented === this.token ? this.user : (this.extraTokens.get(presented) ?? null);
    } else if (cookie) {
      const value = /(?:^|;\s*)canvas_session=([^;]*)/.exec(cookie)?.[1];
      if (this.session && value === this.session) {
        who = this.sessionUser ?? this.user;
      } else if (this.sessionRejection === "redirect") {
        return new Response(null, { status: 302, headers: { location: `${CANVAS_ORIGIN}/login/canvas` } });
      } else if (this.sessionRejection === "html") {
        return new Response('<form action="/login"><input type="password"></form>', { status: 200, headers: { "content-type": "text/html" } });
      }
    }
    if (!who) return json({ errors: [{ message: "Invalid access token." }] }, 401);
    const failure = this.failures.get(url.pathname);
    if (failure) return json({ errors: [{ message: "failure" }] }, failure);

    const path = url.pathname;
    if (path === "/api/v1/users/self" || path === "/api/v1/users/self/profile") return json(who);
    if (path === "/api/v1/courses") return this.page(url, this.courses);
    if (path === "/api/v1/announcements") {
      const courseId = url.searchParams.get("context_codes[]")?.replace(/^course_/, "") ?? "";
      return this.page(url, this.announcements.get(courseId) ?? []);
    }
    let match = /^\/api\/v1\/courses\/([^/]+)$/.exec(path);
    if (match) {
      const course = this.courses.find((row) => String(row.id) === match?.[1]);
      if (!course) return json({ errors: [{ message: "not found" }] }, 404);
      const withSyllabus = url.searchParams.getAll("include[]").includes("syllabus_body");
      return json({ ...course, ...(withSyllabus ? { syllabus_body: this.syllabusBodies.get(match[1] as string) ?? null } : {}) });
    }
    match = /^\/api\/v1\/courses\/([^/]+)\/pages$/.exec(path);
    if (match) return this.page(url, (this.pages.get(match[1] as string) ?? []).map(({ body: _body, ...page }) => page));
    match = /^\/api\/v1\/courses\/([^/]+)\/pages\/([^/]+)$/.exec(path);
    if (match) {
      const slug = decodeURIComponent(match[2] as string);
      const page = (this.pages.get(match[1] as string) ?? []).find((row) => row.url === slug);
      return page ? json(page) : json({ errors: [{ message: "not found" }] }, 404);
    }
    match = /^\/api\/v1\/courses\/([^/]+)\/modules$/.exec(path);
    if (match) return this.page(url, this.modules.get(match[1] as string) ?? []);
    match = /^\/api\/v1\/courses\/([^/]+)\/assignments$/.exec(path);
    if (match) return this.page(url, this.assignments.get(match[1] as string) ?? []);
    match = /^\/api\/v1\/courses\/([^/]+)\/assignment_groups$/.exec(path);
    if (match) {
      const groups = this.assignmentGroups.get(match[1] as string);
      return groups ? this.page(url, groups) : json({ errors: [{ message: "not found" }] }, 404);
    }
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

  readonly factory: CanvasClientFactory = (baseUrl, auth) =>
    new CanvasClient({ baseUrl, auth, fetch: this.fetch, retries: 0 });

  /** Canvas's OAuth token endpoint: codes and refresh tokens become fresh access tokens. */
  private oauthToken(body: string): Response {
    const form = new URLSearchParams(body);
    const grant = form.get("grant_type");
    const key = grant === "authorization_code" ? (form.get("code") ?? "") : (form.get("refresh_token") ?? "");
    const user = grant === "authorization_code" ? this.oauthCodes.get(key) : this.oauthRefresh.get(key);
    if (!user) return json({ error: "invalid_grant" }, 400);
    if (grant === "authorization_code") this.oauthCodes.delete(key);
    this.oauthIssued += 1;
    const access = `oauth-access-${this.oauthIssued}`;
    const refresh = `oauth-refresh-${this.oauthIssued}`;
    this.extraTokens.set(access, user);
    this.oauthRefresh.set(refresh, user);
    return json({ access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "Bearer" });
  }

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
