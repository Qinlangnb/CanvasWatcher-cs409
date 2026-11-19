// Calendar parity API: the calendar view with background layers, study availability, date overrides,
// course commute and .ics preview / re-import. Kept apart from queries.ts so the calendar can grow alone.
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "./api";
import type { CalendarEvent, CalendarImport, CapacitySource, Course, IcsPreview } from "./types";

export interface CalendarLayer {
  kind: "availability" | "commute" | "short_gap";
  start: string;
  end: string;
}

export interface CalendarWarning {
  event: CalendarEvent;
  code: "unsupported_timezone" | "unsupported_recurrence";
  message: string;
}

export interface CalendarView {
  time_zone: string;
  events: CalendarEvent[];
  layers: CalendarLayer[];
  warnings: CalendarWarning[];
}

export interface AvailabilityRule {
  id?: number;
  /** 0 = Monday ... 6 = Sunday. */
  weekday: number;
  start_local_time: string;
  end_local_time: string;
  enabled: boolean;
}

export interface AvailabilityOverride {
  id?: number;
  date: string;
  /** Empty means not available that day. */
  available_intervals: { start: string; end: string }[];
}

export interface Capacity {
  minutes: number | null;
  source: CapacitySource;
  time_zone: string;
}

const calendarKeys = {
  // Under "events", so every existing calendar invalidation refreshes the view too.
  view: (from: string, to: string) => ["events", "view", { from, to }] as const,
  availability: ["availability", "rules"] as const,
  overrides: ["availability", "overrides"] as const,
};

/** Everything that follows from events, availability or commute: the calendar, Today and the course list. */
function invalidatePlanning(client: QueryClient) {
  return Promise.all(["events", "today", "calendar-sources", "availability"].map((key) => client.invalidateQueries({ queryKey: [key] })));
}

const range = (path: string, from: string, to: string) => `${path}?${new URLSearchParams({ from, to }).toString()}`;

export function useCalendarView(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: calendarKeys.view(from, to),
    queryFn: () => request<CalendarView>(range("/api/calendar/view", from, to)),
    enabled,
    placeholderData: (previousData) => previousData,
  });
}

export function useAvailability() {
  return useQuery({ queryKey: calendarKeys.availability, queryFn: () => request<AvailabilityRule[]>("/api/calendar/availability") });
}

export function useSaveAvailability() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (rules: AvailabilityRule[]) =>
      request<AvailabilityRule[]>("/api/calendar/availability", {
        method: "PUT",
        body: rules.map(({ weekday, start_local_time, end_local_time, enabled }) => ({ weekday, start_local_time, end_local_time, enabled })),
      }),
    onSuccess: () => invalidatePlanning(client),
  });
}

export function useOverrides() {
  return useQuery({ queryKey: calendarKeys.overrides, queryFn: () => request<AvailabilityOverride[]>("/api/calendar/availability/overrides") });
}

export function useSaveOverride() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (override: AvailabilityOverride) =>
      request<AvailabilityOverride>(`/api/calendar/availability/overrides/${override.date}`, {
        method: "PUT",
        body: { date: override.date, available_intervals: override.available_intervals },
      }),
    onSuccess: () => invalidatePlanning(client),
  });
}

export function useDeleteOverride() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (date: string) => request<void>(`/api/calendar/availability/overrides/${date}`, { method: "DELETE" }),
    onSuccess: () => invalidatePlanning(client),
  });
}

export function useSetCommute() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ courseId, minutes }: { courseId: number; minutes: number }) =>
      request<Course>(`/api/courses/${courseId}/commute`, { method: "PATCH", body: { commute_minutes: minutes } }),
    onSuccess: () => Promise.all([invalidatePlanning(client), client.invalidateQueries({ queryKey: ["courses"] })]),
  });
}

export interface IcsFileBody {
  file_name?: string;
  ics: string;
  time_zone?: string | null;
}

/** What importing a file would do; with `source_id`, what re-importing it into that calendar would change. */
export function usePreviewCalendar() {
  return useMutation({
    mutationFn: (body: IcsFileBody & { source_id?: number }) => request<IcsPreview>("/api/calendar/sources/preview", { method: "POST", body }),
  });
}

export function useReimportCalendar() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: IcsFileBody & { id: number; confirm_removals: boolean }) =>
      request<CalendarImport>(`/api/calendar/sources/${id}/reimport`, { method: "POST", body }),
    onSuccess: () => invalidatePlanning(client),
  });
}

/** Days for the availability editors, Monday first like the API. */
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Display filters live in this browser only: they never change the plan. */
export const FILTERS_KEY = "aw-calendar-filters";

export interface CalendarFilters {
  /** Hidden calendars: "manual" or "ics:<source id>". */
  hidden: string[];
  layers: boolean;
}

export function readFilters(): CalendarFilters {
  try {
    const value = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? "null") as Partial<CalendarFilters> | null;
    return {
      hidden: Array.isArray(value?.hidden) ? value.hidden.filter((item): item is string => typeof item === "string") : [],
      layers: value?.layers !== false,
    };
  } catch {
    return { hidden: [], layers: true };
  }
}

export function writeFilters(filters: CalendarFilters): void {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  } catch {
    // Private windows may refuse storage; the filters then last until the page closes.
  }
}

/** "manual" or "ics:<id>": the calendar an event belongs to, for the display filters. */
export const calendarOf = (event: CalendarEvent) => (event.source ? `ics:${event.source.id}` : "manual");
