// Homework dates from a course website's schedule table, read from the table structure only:
// a "Week" column, a weekday column and a homework column whose cells say "HW 3 assigned" or
// "HW 3 due". With the Monday of week 1 as anchor that gives date-only deadlines; no LLM, no
// guessing. Without a valid anchor nothing is produced.
import { attr, byTag, childElements, cleanText, findAll, type HtmlElement, links, parseHtml } from "../html.js";

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const EVENT = /\b(?:HW|Homework)\s*0*(\d+)\s+(assigned|due)\b/gi;
const MAX_SPAN = 50;

export interface ScheduleHomework {
  number: number;
  sourceKey: string;
  /** Local dates, YYYY-MM-DD; the deadline precision is DATE_ONLY. */
  assignedDate: string | null;
  dueDate: string | null;
  assignmentResourceUrl: string | null;
  solutionResourceUrl: string | null;
  /** Evidence, e.g. "Week 4, Thursday: HW 3 due". */
  assignedText: string | null;
  dueText: string | null;
}

export interface ScheduleOptions {
  /** Monday of week 1 (YYYY-MM-DD) for this exact website and term. */
  week1Monday: string;
  scheduleUrl: string;
}

function validMonday(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value) && date.getUTCDay() === 1 ? date : null;
}

/** Rows of cells with rowspan/colspan expanded, so every row has its week and day. */
function grid(table: HtmlElement): HtmlElement[][] {
  const rows = findAll(table, (element) => element.tagName === "tr").filter((tr) => {
    for (let node = tr.parentNode; node && "tagName" in node; node = node.parentNode) if (node.tagName === "table") return node === table;
    return false;
  });
  const carried = new Map<number, { cell: HtmlElement; left: number }>();
  return rows.map((tr) => {
    const row: HtmlElement[] = [];
    const carry = () => {
      for (let entry = carried.get(row.length); entry; entry = carried.get(row.length)) {
        row.push(entry.cell);
        if (--entry.left <= 0) carried.delete(row.length - 1);
      }
    };
    for (const cell of childElements(tr, ["td", "th"])) {
      carry();
      const rowspan = Math.min(Math.max(Number.parseInt(attr(cell, "rowspan") ?? "1", 10) || 1, 1), MAX_SPAN);
      const colspan = Math.min(Math.max(Number.parseInt(attr(cell, "colspan") ?? "1", 10) || 1, 1), MAX_SPAN);
      for (let i = 0; i < colspan; i++) {
        if (rowspan > 1) carried.set(row.length, { cell, left: rowspan - 1 });
        row.push(cell);
      }
    }
    carry();
    return row;
  });
}

function linkFor(cell: HtmlElement, number: number, solutions: boolean, base: string): string | null {
  const marker = new RegExp(`\\b(?:hw|homework)[\\s_-]*0*${number}(?!\\d)`, "i");
  for (const link of links(cell)) {
    if (!link.href || !(marker.test(link.href) || marker.test(link.label))) continue;
    if (/solution/i.test(`${link.href} ${link.label}`) !== solutions) continue;
    try {
      return new URL(link.href, base).href;
    } catch {
      continue;
    }
  }
  return null;
}

export function parseScheduleTable(html: string | Buffer, options: ScheduleOptions): ScheduleHomework[] {
  const anchor = validMonday(options.week1Monday);
  if (!anchor) return [];
  const document = parseHtml(html);
  const table = findAll(document, byTag("table")).find((candidate) => /homework/i.test(cleanText(candidate)));
  if (!table) return [];
  const rows = grid(table);
  const headerIndex = rows.findIndex((row) => row.length > 0 && row.every((cell) => cell.tagName === "th"));
  if (headerIndex < 0) return [];
  const headers = (rows[headerIndex] ?? []).map((cell) => cleanText(cell).toLowerCase());
  const weekColumn = headers.findIndex((text) => /\bweek\b/.test(text));
  const dayColumn = headers.findIndex((text, index) => index !== weekColumn && /\b(day|date)\b/.test(text));
  const workColumn = headers.findIndex((text) => /\b(homework|assignments?)\b/.test(text));
  if (weekColumn < 0 || dayColumn < 0 || workColumn < 0) return [];

  const homework = new Map<number, ScheduleHomework>();
  for (const row of rows.slice(headerIndex + 1)) {
    const weekCell = row[weekColumn];
    const dayCell = row[dayColumn];
    const workCell = row[workColumn];
    if (!weekCell || !dayCell || !workCell || workCell === dayCell) continue;
    const weekText = cleanText(weekCell);
    if (!/^\d{1,2}$/.test(weekText)) continue;
    const week = Number(weekText);
    if (week < 1 || week > 53) continue;
    const dayText = cleanText(dayCell).toLowerCase();
    const weekday = WEEKDAYS.findIndex((name) => dayText.includes(name));
    if (weekday < 0) continue;
    const date = new Date(anchor.getTime() + ((week - 1) * 7 + weekday) * 86_400_000).toISOString().slice(0, 10);
    const dayName = WEEKDAYS[weekday] ?? "";
    for (const match of cleanText(workCell).matchAll(EVENT)) {
      const number = Number(match[1]);
      const item = homework.get(number) ?? {
        number,
        sourceKey: `homework:${number}`,
        assignedDate: null,
        dueDate: null,
        assignmentResourceUrl: null,
        solutionResourceUrl: null,
        assignedText: null,
        dueText: null,
      };
      homework.set(number, item);
      const evidence = `Week ${week}, ${dayName[0]?.toUpperCase()}${dayName.slice(1)}: ${match[0]}`;
      if (match[2]?.toLowerCase() === "assigned") {
        item.assignedDate = date;
        item.assignedText = evidence;
        item.assignmentResourceUrl = linkFor(workCell, number, false, options.scheduleUrl) ?? item.assignmentResourceUrl;
      } else {
        item.dueDate = date;
        item.dueText = evidence;
        item.solutionResourceUrl = linkFor(workCell, number, true, options.scheduleUrl) ?? item.solutionResourceUrl;
      }
    }
  }
  return [...homework.values()].sort((a, b) => a.number - b.number);
}
