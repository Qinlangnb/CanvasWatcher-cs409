// Layout of the swimlane timeline, ported from the original app: one lane per course, a window from
// 7 days back to 24 days ahead (or 5 days past the last deadline), 58px per day after a 180px label
// column, sparse date ticks at least 68px apart, and labels spread over three offsets so neighbours
// stay readable. Pure (no imports), so tests can load it directly.

export const DAY_MS = 86_400_000;
export const AXIS_START = 180;
export const DAY_WIDTH = 58;
export const MIN_TICK_SPACING = 68;
export const LANE_HEIGHT = 96;
const FIRST_LANE_Y = 78;
const LABEL_OFFSETS = [-13, 21, -35];

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(value: Date, zone: string): Parts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Local midnight of a calendar day in `zone`. */
function zonedMidnight(year: number, month: number, day: number, zone: string): Date {
  const rough = new Date(Date.UTC(year, month - 1, day));
  const parts = zonedParts(rough, zone);
  const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return new Date(rough.getTime() - (shown - rough.getTime()));
}

function shiftedMidnight(date: Date, days: number, zone: string): Date {
  const parts = zonedParts(date, zone);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return zonedMidnight(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), zone);
}

export interface TimelineTask {
  id: number;
  title: string;
  due_at: string | null;
  course: { id: number };
}

export interface TimelineLane {
  id: number;
  label: string;
}

export interface TimelineWindow {
  start: Date;
  end: Date;
}

export function timelineWindow(now: Date, tasks: TimelineTask[], zone: string): TimelineWindow {
  const start = shiftedMidnight(now, -7, zone);
  const baseEnd = shiftedMidnight(now, 24, zone);
  let latest: number | null = null;
  for (const task of tasks) {
    if (!task.due_at) continue;
    const at = Date.parse(task.due_at);
    if (latest === null || at > latest) latest = at;
  }
  const latestPlusFive = latest === null ? baseEnd.getTime() : latest + 5 * DAY_MS;
  return { start, end: new Date(Math.max(baseEnd.getTime(), latestPlusFive)) };
}

export const timelineX = (value: Date, window: { start: Date }) =>
  AXIS_START + ((value.getTime() - window.start.getTime()) / DAY_MS) * DAY_WIDTH;

export const laneY = (index: number) => FIRST_LANE_Y + index * LANE_HEIGHT;

/** "Nov.17" in `zone`. */
export function compactDate(value: Date, zone: string): string {
  const parts = zonedParts(value, zone);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parts.month - 1]}.${parts.day}`;
}

/** Cuts titles longer than 24 characters to 22 plus an ellipsis. */
export const shortTitle = (title: string) => (title.length > 24 ? `${title.slice(0, 22)}…` : title);

export interface TimelineNode<T extends TimelineTask> {
  task: T;
  date: Date;
  lane: number;
  x: number;
  y: number;
  labelY: number;
}

export function layoutTimeline<T extends TimelineTask>(tasks: T[], lanes: TimelineLane[], now: Date, zone: string) {
  const window = timelineWindow(now, tasks, zone);
  const laneIndex = new Map(lanes.map((lane, index) => [lane.id, index]));
  const raw = tasks.flatMap((task) => {
    if (!task.due_at) return [];
    const date = new Date(task.due_at);
    const lane = laneIndex.get(task.course.id);
    if (lane === undefined || date < window.start || date > window.end) return [];
    return [{ task, date, lane, x: timelineX(date, window), y: laneY(lane) }];
  });
  // The dot stays on its lane; its label moves above or below when the previous one is too close.
  const tracks = new Map<number, number[]>();
  const nodes: TimelineNode<T>[] = [...raw]
    .sort((a, b) => a.lane - b.lane || a.x - b.x)
    .map((node) => {
      const ends = tracks.get(node.lane) ?? [-Infinity, -Infinity, -Infinity];
      let track = ends.findIndex((end) => node.x + 14 > end + 10);
      if (track < 0) track = ends.indexOf(Math.min(...ends));
      ends[track] = node.x + 14 + Math.min(24, node.task.title.length) * 7.4;
      tracks.set(node.lane, ends);
      return { ...node, labelY: node.y + (LABEL_OFFSETS[track] ?? 0) };
    });
  const days = new Map<string, { date: Date; x: number }>();
  for (const node of nodes) {
    const parts = zonedParts(node.date, zone);
    const key = `${parts.year}-${parts.month}-${parts.day}`;
    if (!days.has(key)) {
      const date = zonedMidnight(parts.year, parts.month, parts.day, zone);
      days.set(key, { date, x: timelineX(date, window) });
    }
  }
  let last = -Infinity;
  const ticks = [...days.values()]
    .sort((a, b) => a.x - b.x)
    .filter((tick) => {
      if (tick.x - last < MIN_TICK_SPACING) return false;
      last = tick.x;
      return true;
    });
  const width = AXIS_START + Math.max(1, (window.end.getTime() - window.start.getTime()) / DAY_MS) * DAY_WIDTH;
  const laneLines = lanes
    .map((lane, index) => ({ id: lane.id, index }))
    .filter((lane) => nodes.some((node) => node.lane === lane.index))
    .map((lane) => ({ id: lane.id, y: laneY(lane.index), x1: AXIS_START, x2: width }));
  const nowX = now >= window.start && now < window.end ? timelineX(now, window) : null;
  return { window, nodes, ticks, laneLines, nowX, width, height: 110 + lanes.length * LANE_HEIGHT };
}
