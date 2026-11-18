// Gradescope student pages -> courses and assignments with submission facts. Read-only; never
// submits or changes anything. Selectors come from the authenticated student DOM; anything
// unexpected fails closed with PROVIDER_RESPONSE_CHANGED instead of guessing, and stable IDs are
// never derived from titles.
import { attr, byTag, cleanText, closest, findAll, findFirst, hasClass, parseHtml, type HtmlElement } from "../html.js";
import { ProviderError, type ProviderWeb } from "./web.js";

export interface ProviderCourse {
  provider: "gradescope";
  externalId: string;
  courseCode: string;
  name: string;
  /** Unknown until the term container markup is verified. */
  term: null;
  url: string;
  identityEvidence: "student_course_link";
}

export type SubmissionState = "graded" | "submitted" | "unsubmitted" | "unknown";

/** The allow-listed facts a provider may contribute to a task. */
export interface ProviderFacts {
  provider: "gradescope";
  provider_course_id: string;
  provider_assignment_id: string;
  due_at: string | null;
  /** Late cutoff; never used as the due date. */
  late_due_at: string | null;
  personal_due_at: null;
  release_at: string | null;
  submission_state: SubmissionState;
  submitted_at: null;
  score: number | null;
  max_score: number | null;
  grade_published: true | null;
  direct_assignment_url: string | null;
  evidence: "gradescope_student_assignment_table";
}

export interface ProviderAssignment {
  externalId: string;
  sourceKey: string;
  title: string;
  url: string;
  facts: ProviderFacts;
}

export interface AssignmentPage {
  assignments: ProviderAssignment[];
  /** Rows without a stable ID (e.g. closed work with no link); reported, not invented. */
  unidentifiedRows: number;
  /** Even a valid empty table is no proof that earlier work was deleted. */
  deletionAuthoritative: false;
}

const changed = () => new ProviderError("PROVIDER_RESPONSE_CHANGED");

/** The path of a same-origin link without credentials, query or fragment; null otherwise. */
export function sameOriginPath(href: string, base: string): string | null {
  let candidate: URL;
  try {
    candidate = new URL(href, base + "/");
  } catch {
    return null;
  }
  const expected = new URL(base);
  if (candidate.origin !== expected.origin || candidate.username || candidate.password || candidate.search || candidate.hash) return null;
  if (href.includes("?") || href.includes("#")) return null;
  return candidate.pathname;
}

const exactHeading = (root: Parameters<typeof findAll>[0], text: string) =>
  findAll(root, byTag("h1")).some((h1) => cleanText(h1) === text);

export function parseCourses(html: string, base: string): ProviderCourse[] {
  const document = parseHtml(html);
  if (!exactHeading(document, "Course Dashboard")) throw changed();
  return findAll(document, (element) => element.tagName === "a" && hasClass(element, "courseBox") && attr(element, "href") !== null).map(
    (link) => {
      const path = sameOriginPath(attr(link, "href") ?? "", base);
      const match = /^\/courses\/(\d+)\/?$/.exec(path ?? "");
      const code = findFirst(link, (element) => hasClass(element, "courseBox--shortname"));
      const title = findFirst(link, (element) => hasClass(element, "courseBox--name"));
      if (!match?.[1] || !code || !title) throw changed();
      return {
        provider: "gradescope" as const,
        externalId: match[1],
        courseCode: cleanText(code),
        name: cleanText(title),
        term: null,
        url: base + path,
        identityEvidence: "student_course_link" as const,
      };
    },
  );
}

/** `2026-09-24 23:59:00 -0500` -> `2026-09-24T23:59:00-05:00`; anything else is a markup change. */
export function gradescopeTime(node: HtmlElement | null): string | null {
  if (!node) return null;
  const value = attr(node, "datetime");
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value);
  if (!match) throw changed();
  const iso = `${match[1]}T${match[2]}${match[3]}${match[4]}:${match[5]}`;
  if (Number.isNaN(Date.parse(iso))) throw changed();
  return iso;
}

export function parseAssignments(html: string, base: string, courseId: string): AssignmentPage {
  if (!/^\d+$/.test(courseId)) throw changed();
  const document = parseHtml(html);
  const table = findFirst(document, (element) => element.tagName === "table" && attr(element, "id") === "assignments-student-table");
  if (!table) throw changed();
  const assignments: ProviderAssignment[] = [];
  const identities = new Set<string>();
  let skipped = 0;
  const rows = findAll(table, (element) => element.tagName === "tr" && closest(element, "tbody") !== null);
  for (const row of rows) {
    const title = findFirst(row, byTag("th", "table--primaryLink"));
    const status = findFirst(row, byTag("td", "submissionStatus"));
    if (!title || !status) {
      // A known empty-table message can never trigger deletion.
      if (findFirst(row, byTag("td", "dataTables_empty"))) continue;
      throw changed();
    }
    let assignmentId: string | null = null;
    let directUrl: string | null = null;
    const button = findFirst(title, (element) => element.tagName === "button" && attr(element, "data-assignment-id") !== null);
    const buttonId = button ? attr(button, "data-assignment-id") : null;
    if (buttonId && /^\d+$/.test(buttonId)) assignmentId = buttonId;
    const link = findFirst(title, (element) => element.tagName === "a" && attr(element, "href") !== null);
    if (link) {
      const path = sameOriginPath(attr(link, "href") ?? "", base);
      const match = new RegExp(`^/courses/${courseId}/assignments/(\\d+)/submissions/\\d+/?$`).exec(path ?? "");
      if (!match?.[1] || (assignmentId && assignmentId !== match[1])) throw changed();
      assignmentId = match[1];
      directUrl = base + path;
    }
    // A submit button is not a GET route; the URL stays null rather than invented.
    if (!assignmentId) {
      skipped++;
      continue;
    }
    if (identities.has(assignmentId)) throw changed();
    identities.add(assignmentId);
    let due: string | null = null;
    let late: string | null = null;
    let released: string | null = null;
    for (const node of findAll(row, (element) => element.tagName === "time" && attr(element, "datetime") !== null)) {
      const label = attr(node, "aria-label") ?? "";
      if (label.startsWith("Late Due Date at ")) late = gradescopeTime(node);
      else if (label.startsWith("Due at ")) due = gradescopeTime(node);
      else if (label.startsWith("Released at ")) released = gradescopeTime(node);
    }
    const text = cleanText(status);
    const score = /^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(text);
    const state: SubmissionState = score ? "graded" : text === "Submitted" ? "submitted" : text === "No Submission" ? "unsubmitted" : "unknown";
    const titleText = cleanText(title);
    assignments.push({
      externalId: `assignment:${assignmentId}`,
      sourceKey: `gradescope:${courseId}:${assignmentId}`,
      title: titleText,
      url: directUrl ?? `${base}/courses/${courseId}`,
      facts: {
        provider: "gradescope",
        provider_course_id: courseId,
        provider_assignment_id: assignmentId,
        due_at: due,
        late_due_at: late,
        personal_due_at: null,
        release_at: released,
        submission_state: state,
        submitted_at: null,
        score: score ? Number(score[1]) : null,
        max_score: score ? Number(score[2]) : null,
        grade_published: score ? true : null,
        direct_assignment_url: directUrl,
        evidence: "gradescope_student_assignment_table",
      },
    });
  }
  return { assignments, unidentifiedRows: skipped, deletionAuthoritative: false };
}

/** The user's choice for one assignment: bound to a task, or deliberately kept separate. */
export type AssignmentBinding = number | "separate";

export interface GradescopeTaskFields {
  assignment: ProviderAssignment;
  confirmedTaskId: number | null;
  confirmedSeparate: boolean;
  dueAt: string | null;
  dueAtState: "known" | "unknown";
  deadlinePrecision: "EXACT_DATETIME" | null;
  pointsPossible: number | null;
  submissionState: SubmissionState;
}

/** One course's assignments with the user's bindings applied. The late cutoff never becomes the due date. */
export async function fetchGradescopeAssignments(
  client: ProviderWeb,
  courseId: string,
  bindings: Record<string, AssignmentBinding> = {},
): Promise<{ items: GradescopeTaskFields[]; errors: Record<string, string> }> {
  if (!/^\d+$/.test(courseId)) throw new ProviderError("PROVIDER_PATH_INVALID");
  const page = parseAssignments(await client.get(`/courses/${courseId}`), client.base, courseId);
  const items = page.assignments.map((assignment) => {
    const choice = bindings[assignment.facts.provider_assignment_id];
    const due = assignment.facts.due_at;
    return {
      assignment,
      confirmedTaskId: typeof choice === "number" && Number.isInteger(choice) ? choice : null,
      confirmedSeparate: choice === "separate",
      dueAt: due,
      dueAtState: due ? ("known" as const) : ("unknown" as const),
      deadlinePrecision: due ? ("EXACT_DATETIME" as const) : null,
      pointsPossible: assignment.facts.max_score,
      submissionState: assignment.facts.submission_state,
    };
  });
  return { items, errors: page.unidentifiedRows ? { unidentified_rows: String(page.unidentifiedRows) } : {} };
}

export async function discoverGradescopeCourses(client: ProviderWeb): Promise<ProviderCourse[]> {
  return parseCourses(await client.probe(), client.base);
}

/**
 * PrairieLearn course and assessment pages have not been verified against real student markup,
 * so syncing is refused rather than scraped from guesses. Session checks (`verifySession`) work.
 */
export function parsePrairieLearnCourses(_html: string): never {
  throw new ProviderError("PRAIRIELEARN_COURSE_PARSER_NOT_VERIFIED");
}
