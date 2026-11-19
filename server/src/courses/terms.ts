// Terms and course display names, ported from the original's course_terms. Canvas term names vary
// ("Fall 2026", "2026 Fall", "Fall 2026 - Main"); a season and year give a sortable key, otherwise
// the term's dates do. Course codes are reduced to "DEPT 123" with the section kept apart.
import { DateTime } from "luxon";

const SEASON_RANK: Record<string, number> = { winter: 1, spring: 2, summer: 3, fall: 4 };
/** Where term dates without a season are read; the original's campus zone. */
const TERM_ZONE = "America/Chicago";

export interface NormalizedTerm {
  /** Stable, URL-safe id, for example "fall-2026"; "none" for courses without a term. */
  id: string;
  displayName: string;
  startAt: Date | null;
  endAt: Date | null;
  /** Larger is newer: "2026-4" for Fall 2026, a date key when there is no season. */
  sortKey: string;
}

export const NO_TERM_ID = "none";

const slug = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

export function normalizeTerm(rawName: string | null | undefined, startAt: Date | null = null, endAt: Date | null = null): NormalizedTerm {
  const raw = (rawName ?? "").replace(/\s+/g, " ").trim();
  if (!raw && !startAt && !endAt) {
    return { id: NO_TERM_ID, displayName: "No term", startAt: null, endAt: null, sortKey: "0000-0-" };
  }
  let display = raw;
  let year: number | null = null;
  let rank = 0;
  const match =
    /\b(spring|summer|fall|winter)\b\s*[-,/]?\s*(20\d{2})|\b(20\d{2})\b\s*[-,/]?\s*\b(spring|summer|fall|winter)\b/i.exec(raw);
  if (match) {
    const season = (match[1] ?? match[4] ?? "").toLowerCase();
    year = Number(match[2] ?? match[3]);
    rank = SEASON_RANK[season] ?? 0;
    display = `${season.charAt(0).toUpperCase()}${season.slice(1)} ${year}`;
  }
  const basis = endAt ?? startAt;
  let sortKey: string;
  if (year !== null) sortKey = `${String(year).padStart(4, "0")}-${rank}`;
  else if (basis) sortKey = `${DateTime.fromJSDate(basis, { zone: TERM_ZONE }).toFormat("yyyyLLdd")}-0`;
  else sortKey = `0000-0-${display.toLowerCase()}`;
  if (!display && basis) display = `Term ending ${DateTime.fromJSDate(basis, { zone: TERM_ZONE }).toFormat("LLL d, yyyy")}`;
  return { id: slug(display) || NO_TERM_ID, displayName: display || "No term", startAt, endAt, sortKey };
}

export interface CourseDisplay {
  code: string;
  name: string;
  section: string | null;
}

const isSeasonYear = (dept: string, number: string) => dept.toLowerCase() in SEASON_RANK && /^20\d{2}$/.test(number);
const compactCode = (value: string | null | undefined) => (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** "CS 409", the descriptive name without term or section noise, and the section if named. */
export function normalizeCourseDisplay(rawCode: string, rawName: string, termName?: string | null): CourseDisplay {
  const codeText = (rawCode ?? "").replace(/\s+/g, " ").trim();
  let code = codeText;
  for (const match of codeText.matchAll(/(?<![A-Z])([A-Z]{2,6})[\s_-]?(\d{2,4})(?!\d)/gi)) {
    const [, dept = "", number = ""] = match;
    if (isSeasonYear(dept, number)) continue;
    code = `${dept.toUpperCase()} ${number}`;
    break;
  }
  const parts = (rawName ?? "")
    .split(/\s+-\s+|(?<=\d)-|-(?=[A-Za-z])/)
    .map((part) => part.trim())
    .filter(Boolean);
  const section = parts.find((part) => /^section\b/i.test(part)) ?? null;
  const ignored = new Set([termName, code].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase()));
  const descriptive = parts.filter(
    (part) =>
      !ignored.has(part.toLowerCase()) &&
      !/^(?:spring|summer|fall|winter)\s+20\d{2}$/i.test(part) &&
      !/^section\b/i.test(part) &&
      compactCode(part) !== compactCode(code),
  );
  const name = descriptive.length > 0 ? descriptive.join(" - ").trim() : rawName || code;
  return { code: code || rawCode, name, section };
}

/** The term containing `now`, else the newest. */
export function chooseDefaultTerm(terms: NormalizedTerm[], now = new Date()): string | null {
  if (terms.length === 0) return null;
  const containing = terms.filter((term) => term.startAt && term.endAt && term.startAt <= now && now <= term.endAt);
  const candidates = containing.length > 0 ? containing : terms;
  return candidates.reduce((best, term) => (term.sortKey > best.sortKey ? term : best)).id;
}

/** A course first seen after its term ended starts archived. */
export function shouldArchiveNewCourse(termEndAt: Date | null, now = new Date()): boolean {
  return termEndAt !== null && termEndAt < now;
}
