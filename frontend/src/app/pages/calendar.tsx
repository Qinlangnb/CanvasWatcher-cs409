import { useState } from "react";
import { useSearchParams } from "react-router";
import { type CalendarFilters, type CalendarLayer, type CalendarWarning, calendarOf, readFilters, useCalendarView, writeFilters } from "../calendarApi";
import { addMonths, dayLabel, minutesOnDay, monthGrid, monthLabel, placeEvents, sameMonth, slotValue } from "../calendarGrid";
import { EventDialog, ImportCalendarDialog } from "../events";
import { formatMinutes, formatTime } from "../format";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, ClipboardIcon, ClockIcon, LockIcon, PlusIcon, UploadIcon } from "../icons";
import { TaskList } from "../lists";
import { useCalendarSources, usePlanZone, useSettings, useTasks } from "../queries";
import { useNow } from "../shell";
import { useTaskEditor } from "../tasks";
import type { CalendarEvent, Task } from "../types";
import { Alert, Badge, EmptyState, PageHeader, QueryError, SkeletonList } from "../ui";
import {
  addDays,
  buildTimeline,
  dateLabel,
  eventDates,
  eventOrder,
  eventTimeLabel,
  groupByDate,
  localDate,
  rangeOf,
  weekOf,
  weekRangeLabel,
  weekdayLabel,
  type TimelineDay,
} from "../zoned";
import { CalendarSwimlane } from "../courseViews";

/** "timeline" is the swimlane chart; "workload" the day-by-day list measured against the daily goal. */
type View = "day" | "week" | "month" | "timeline" | "workload";
const VIEWS: View[] = ["day", "week", "month", "timeline", "workload"];
/** The views that show calendar dates and use the date navigation. */
type RangeView = "day" | "week" | "month";
const isRangeView = (view: View): view is RangeView => view === "day" || view === "week" || view === "month";
const TIMELINE_DAYS = 28;
/** Pixels per hour on the day grid. */
const HOUR_PX = 48;
/** Events shown per month cell before "+N more". */
const MONTH_ITEMS = 3;

const isDate = (value: string | null): value is string => value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

type DayItem = { kind: "event"; at: number; event: CalendarEvent } | { kind: "task"; at: number; task: Task };

/** A slot chosen on the day grid, or a day, to start a new event from. */
type NewEvent = { date: string; slot?: { start: string; end: string } };

function EventButton({ event, date, zone, onEvent, compact = false }: { event: CalendarEvent; date: string; zone: string; onEvent: (event: CalendarEvent) => void; compact?: boolean }) {
  return (
    <button
      type="button"
      className={`cal-item cal-event type-${event.event_type}${event.busy ? "" : " free"}${event.editable ? "" : " read-only"}`}
      onClick={() => onEvent(event)}
    >
      <span className="cal-time">
        {event.editable ? null : <LockIcon size={12} aria-hidden="true" />}
        {eventTimeLabel(event, date, zone)}
        {event.editable ? "" : <span className="visually-hidden"> (read-only)</span>}
      </span>
      <span className="cal-title">{event.title}</span>
      {!compact && event.location ? <span className="cal-detail">{event.location}</span> : null}
    </button>
  );
}

function TaskButton({ task, zone, onTask }: { task: Task; zone: string; onTask: (task: Task) => void }) {
  return (
    <button type="button" className={`cal-item cal-task type-${task.type} state-${task.state}`} onClick={() => onTask(task)}>
      <span className="cal-time">
        Due {formatTime(new Date(task.due_at ?? ""), zone)}
        {task.state === "done" ? " · done" : task.state === "ignored" ? " · ignored" : ""}
      </span>
      <span className="cal-title">{task.title}</span>
      <span className="cal-detail">{task.course.code}</span>
    </button>
  );
}

function useDueTasks(from: string, to: string) {
  return useTasks({ status: "all", dueAfter: from, dueBefore: to });
}

const datedTasks = (tasks: Task[]) => tasks.filter((task) => task.due_at && task.state !== "removed");

function WeekView({
  dates,
  today,
  zone,
  events,
  tasks,
  onEvent,
}: {
  dates: string[];
  today: string;
  zone: string;
  events: CalendarEvent[];
  tasks: Task[];
  onEvent: (event: CalendarEvent) => void;
}) {
  const editor = useTaskEditor();
  const eventsByDate = groupByDate(dates, events, (event) => eventDates(event, zone));
  const tasksByDate = groupByDate(dates, datedTasks(tasks), (task) => [localDate(task.due_at ?? "", zone)]);

  return (
    <div className="week-grid">
      {dates.map((date) => {
        const label = weekdayLabel(date);
        const dayStart = Date.parse(rangeOf(date, date, zone).from);
        const items: DayItem[] = [
          ...(eventsByDate.get(date) ?? []).map((event): DayItem => ({
            kind: "event",
            event,
            at: event.all_day ? -Infinity : Math.max(Date.parse(event.start), dayStart),
          })),
          ...(tasksByDate.get(date) ?? []).map((task): DayItem => ({ kind: "task", task, at: Date.parse(task.due_at ?? "") })),
        ].sort((a, b) => a.at - b.at);
        return (
          <section key={date} className={`day-column${date === today ? " today" : ""}${date < today ? " past" : ""}`} aria-labelledby={`day-${date}`}>
            <h2 className="day-head" id={`day-${date}`}>
              <span className="day-weekday">{label.weekday}</span>
              <span className="day-number">{label.day}</span>
              <span className="visually-hidden">{`, ${label.full}${date === today ? " (today)" : ""}`}</span>
            </h2>
            {items.length === 0 ? (
              <p className="day-empty">Nothing scheduled</p>
            ) : (
              <ul className="day-items">
                {items.map((item) =>
                  item.kind === "event" ? (
                    <li key={`e${item.event.key}`}>
                      <EventButton event={item.event} date={date} zone={zone} onEvent={onEvent} />
                    </li>
                  ) : (
                    <li key={`t${item.task.id}`}>
                      <TaskButton task={item.task} zone={zone} onTask={(task) => editor.open(task)} />
                    </li>
                  ),
                )}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

const LAYER_LABELS: Record<CalendarLayer["kind"], string> = {
  availability: "Study window",
  commute: "Commute",
  short_gap: "Short class gap",
};

/**
 * One day as a time grid: background layers, events placed by time in side-by-side lanes, and a
 * button per hour to add an event there (the keyboard way to select a slot).
 */
function DayView({
  date,
  today,
  zone,
  events,
  tasks,
  layers,
  onEvent,
  onCreate,
}: {
  date: string;
  today: string;
  zone: string;
  events: CalendarEvent[];
  tasks: Task[];
  layers: CalendarLayer[];
  onEvent: (event: CalendarEvent) => void;
  onCreate: (create: NewEvent) => void;
}) {
  const editor = useTaskEditor();
  const onDay = events.filter((event) => eventDates(event, zone).includes(date));
  const allDay = onDay.filter((event) => event.all_day).sort(eventOrder);
  const placed = placeEvents(onDay, date, zone);
  const due = datedTasks(tasks).filter((task) => localDate(task.due_at ?? "", zone) === date);
  const bands = layers.flatMap((layer) => {
    const span = minutesOnDay(layer.start, layer.end, date, zone);
    return span ? [{ layer, ...span }] : [];
  });
  const dayStart = Date.parse(rangeOf(date, date, zone).from);
  const nowMinute = date === today ? (Date.now() - dayStart) / 60_000 : null;
  const hours = Array.from({ length: 24 }, (_, hour) => hour);

  return (
    <div className="day-view">
      {allDay.length || due.length ? (
        <ul className="day-view-top" aria-label="All day and due">
          {allDay.map((event) => (
            <li key={event.key}>
              <EventButton event={event} date={date} zone={zone} onEvent={onEvent} compact />
            </li>
          ))}
          {due.map((task) => (
            <li key={`t${task.id}`}>
              <TaskButton task={task} zone={zone} onTask={(chosen) => editor.open(chosen)} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="time-grid" style={{ height: `${24 * HOUR_PX}px` }}>
        <ol className="time-slots">
          {hours.map((hour) => {
            const label = formatTime(new Date(dayStart + hour * 3_600_000), zone);
            return (
              <li key={hour} style={{ height: `${HOUR_PX}px` }}>
                <span className="time-label" aria-hidden="true">
                  {label}
                </span>
                <button
                  type="button"
                  className="time-slot"
                  onClick={() => onCreate({ date, slot: { start: slotValue(date, hour * 60), end: slotValue(date, hour * 60 + 60) } })}
                >
                  <span className="visually-hidden">Add an event at {label}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="time-layers" aria-hidden="true">
          {bands.map(({ layer, top, bottom }, index) => (
            <span
              key={`${layer.kind}-${index}`}
              className={`time-layer layer-${layer.kind}`}
              style={{ top: `${(top / 60) * HOUR_PX}px`, height: `${((bottom - top) / 60) * HOUR_PX}px` }}
              title={LAYER_LABELS[layer.kind]}
            />
          ))}
        </div>
        <ul className="time-events">
          {placed.map((item) => (
            <li
              key={item.event.key}
              style={{
                top: `${(item.top / 60) * HOUR_PX}px`,
                height: `${Math.max(20, ((item.bottom - item.top) / 60) * HOUR_PX)}px`,
                left: `calc(${(item.lane / item.lanes) * 100}% + 2px)`,
                width: `calc(${100 / item.lanes}% - 4px)`,
              }}
            >
              <EventButton event={item.event} date={date} zone={zone} onEvent={onEvent} compact />
            </li>
          ))}
        </ul>
        {nowMinute !== null && nowMinute >= 0 && nowMinute < 1440 ? (
          <span className="time-now" style={{ top: `${(nowMinute / 60) * HOUR_PX}px` }} aria-hidden="true" />
        ) : null}
      </div>
      {bands.length ? (
        <p className="layer-legend muted">
          {(["availability", "commute", "short_gap"] as const)
            .filter((kind) => bands.some((band) => band.layer.kind === kind))
            .map((kind) => (
              <span key={kind} className={`legend-item layer-${kind}`}>
                {LAYER_LABELS[kind]}
              </span>
            ))}
        </p>
      ) : null}
    </div>
  );
}

function MonthView({
  anchor,
  today,
  zone,
  events,
  tasks,
  onEvent,
  onDay,
}: {
  anchor: string;
  today: string;
  zone: string;
  events: CalendarEvent[];
  tasks: Task[];
  onEvent: (event: CalendarEvent) => void;
  onDay: (date: string) => void;
}) {
  const editor = useTaskEditor();
  const dates = monthGrid(anchor);
  const eventsByDate = groupByDate(dates, [...events].sort(eventOrder), (event) => eventDates(event, zone));
  const tasksByDate = groupByDate(dates, datedTasks(tasks), (task) => [localDate(task.due_at ?? "", zone)]);
  const weekdays = dates.slice(0, 7).map((date) => weekdayLabel(date).weekday);

  return (
    <div className="month-view">
      <div className="month-weekdays" aria-hidden="true">
        {weekdays.map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>
      <ol className="month-grid">
        {dates.map((date) => {
          const dayEvents = eventsByDate.get(date) ?? [];
          const dayTasks = tasksByDate.get(date) ?? [];
          const shown = dayEvents.slice(0, MONTH_ITEMS);
          const more = dayEvents.length - shown.length + dayTasks.length;
          const label = weekdayLabel(date);
          return (
            <li
              key={date}
              className={`month-cell${sameMonth(date, anchor) ? "" : " outside"}${date === today ? " today" : ""}${dayEvents.length + dayTasks.length ? "" : " empty"}`}
            >
              <button type="button" className="month-day" onClick={() => onDay(date)} aria-label={`${label.full}${date === today ? " (today)" : ""}: open day`}>
                {label.day}
              </button>
              <ul className="month-items">
                {shown.map((event) => (
                  <li key={event.key}>
                    <EventButton event={event} date={date} zone={zone} onEvent={onEvent} compact />
                  </li>
                ))}
                {dayTasks.length === 1 && dayEvents.length < MONTH_ITEMS ? (
                  <li>
                    <TaskButton task={dayTasks[0] as Task} zone={zone} onTask={(task) => editor.open(task)} />
                  </li>
                ) : null}
              </ul>
              {more > (dayTasks.length === 1 && dayEvents.length < MONTH_ITEMS ? 1 : 0) ? (
                <button type="button" className="link-button month-more" onClick={() => onDay(date)}>
                  +{more - (dayTasks.length === 1 && dayEvents.length < MONTH_ITEMS ? 1 : 0)} more
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function LoadBar({ minutes, daily }: { minutes: number; daily: number }) {
  const share = daily > 0 ? Math.min(100, Math.round((minutes / daily) * 100)) : 100;
  return (
    <span className={`load-bar${minutes > daily ? " over" : ""}`} aria-hidden="true">
      <span style={{ width: `${share}%` }} />
    </span>
  );
}

function TimelineDaySection({ day, today, daily, now }: { day: TimelineDay; today: string; daily: number; now: Date }) {
  return (
    <section className="timeline-day" aria-labelledby={`tl-${day.date}`}>
      <header className="timeline-head">
        <h2 id={`tl-${day.date}`}>{dateLabel(day.date, today)}</h2>
        <span className="timeline-load">
          <LoadBar minutes={day.minutes} daily={daily} />
          {formatMinutes(day.minutes)} of work due
        </span>
        {day.shortfall > 0 ? <Badge tone="warning">{formatMinutes(day.shortfall)} behind at your daily goal</Badge> : null}
      </header>
      <TaskList tasks={day.tasks} now={now} />
    </section>
  );
}

function TimelineView({ today, zone, now }: { today: string; zone: string; now: Date }) {
  const tasks = useTasks({ status: "open" });
  const settings = useSettings();
  const editor = useTaskEditor();
  const daily = settings.data?.daily_study_minutes ?? 180;

  if (tasks.isPending) return <SkeletonList rows={5} label="Loading your timeline" />;
  if (tasks.isError) return <QueryError title="Your tasks didn't load" error={tasks.error} retry={() => void tasks.refetch()} />;

  const timeline = buildTimeline(tasks.data, { today, zone, length: TIMELINE_DAYS, dailyMinutes: daily });
  const behind = timeline.days.find((day) => day.shortfall > 0);
  const behindLabel = behind ? dateLabel(behind.date, today) : "";
  const behindWhen = behindLabel === "Today" || behindLabel === "Tomorrow" ? behindLabel.toLowerCase() : `on ${behindLabel}`;
  const empty = timeline.overdue.length + timeline.days.length + timeline.later.length + timeline.undated.length === 0;

  if (empty) {
    return (
      <EmptyState
        icon={<ClipboardIcon size={28} />}
        title="No open work"
        action={
          <button type="button" className="button secondary" onClick={() => editor.create()}>
            <PlusIcon size={18} />
            Add a task
          </button>
        }
      >
        Everything is done or ignored. New assignments appear here after each sync.
      </EmptyState>
    );
  }

  return (
    <div className="timeline">
      <p className="muted">
        Open work for the next four weeks by due date, measured against your daily goal of {formatMinutes(daily)}.
        {behind
          ? ` At that pace you first fall behind ${behindWhen}: start earlier, study longer, or check your estimates.`
          : " At that pace you stay on track."}
      </p>
      {timeline.overdue.length > 0 ? (
        <section className="timeline-day overdue" aria-labelledby="tl-overdue">
          <header className="timeline-head">
            <h2 id="tl-overdue">Overdue</h2>
            <span className="timeline-load">{formatMinutes(timeline.overdue.reduce((sum, task) => sum + task.remaining_minutes, 0))} of work</span>
          </header>
          <TaskList tasks={timeline.overdue} now={now} />
        </section>
      ) : null}
      {timeline.days.map((day) => (
        <TimelineDaySection key={day.date} day={day} today={today} daily={daily} now={now} />
      ))}
      {timeline.days.length === 0 ? <p className="muted">Nothing is due in the next four weeks.</p> : null}
      {timeline.later.length > 0 ? (
        <details className="timeline-more">
          <summary>
            Due after {dateLabel(addDays(today, TIMELINE_DAYS - 1), today)} <span className="count">{timeline.later.length}</span>
          </summary>
          <TaskList tasks={timeline.later} now={now} />
        </details>
      ) : null}
      {timeline.undated.length > 0 ? (
        <details className="timeline-more">
          <summary>
            No due date <span className="count">{timeline.undated.length}</span>
          </summary>
          <TaskList tasks={timeline.undated} now={now} />
        </details>
      ) : null}
    </div>
  );
}

/** Calendars and background layers to show; display only, saved in this browser. */
function DisplayFilters({ filters, onChange }: { filters: CalendarFilters; onChange: (filters: CalendarFilters) => void }) {
  const sources = useCalendarSources();
  const calendars = [{ id: "manual", name: "Added by hand" }, ...(sources.data ?? []).map((source) => ({ id: `ics:${source.id}`, name: `ICS · ${source.name}` }))];
  const toggle = (id: string, shown: boolean) =>
    onChange({ ...filters, hidden: shown ? filters.hidden.filter((item) => item !== id) : [...new Set([...filters.hidden, id])] });
  const hiddenCount = filters.hidden.length + (filters.layers ? 0 : 1);
  return (
    <details className="calendar-filters">
      <summary>
        Display filters{hiddenCount ? <span className="count">{hiddenCount} hidden</span> : null}
      </summary>
      <fieldset>
        <legend className="visually-hidden">Calendars and layers to show</legend>
        {calendars.map((calendar) => (
          <label key={calendar.id} className="check-field">
            <input type="checkbox" checked={!filters.hidden.includes(calendar.id)} onChange={(event) => toggle(calendar.id, event.target.checked)} />
            <span>{calendar.name}</span>
          </label>
        ))}
        <label className="check-field">
          <input type="checkbox" checked={filters.layers} onChange={(event) => onChange({ ...filters, layers: event.target.checked })} />
          <span>Study windows, commute and short class gaps</span>
        </label>
      </fieldset>
      <p className="muted">Display only. Hidden events still affect study capacity.</p>
    </details>
  );
}

function Warnings({ warnings, onRepair }: { warnings: CalendarWarning[]; onRepair: (event: CalendarEvent) => void }) {
  if (!warnings.length) return null;
  return (
    <div className="stack">
      {warnings.map((warning) => (
        <Alert
          key={`${warning.code}-${warning.event.id}`}
          tone="warning"
          title={`${warning.event.title}: ${warning.code === "unsupported_timezone" ? "time zone" : "repeat rule"} needs repair`}
          action={
            warning.event.editable ? (
              <button type="button" className="button small secondary" onClick={() => onRepair(warning.event)}>
                Repair event
              </button>
            ) : undefined
          }
        >
          {warning.message}
        </Alert>
      ))}
    </div>
  );
}

/** The dates a view shows. */
function datesOf(view: View, anchor: string): string[] {
  if (view === "day") return [anchor];
  if (view === "month") return monthGrid(anchor);
  return weekOf(anchor);
}

function viewLabel(view: View, anchor: string, dates: string[]): string {
  if (view === "day") return dayLabel(anchor);
  if (view === "month") return monthLabel(anchor);
  return weekRangeLabel(dates);
}

const STEP_LABELS: Record<RangeView, [string, string, string]> = {
  day: ["Previous day", "Today", "Next day"],
  week: ["Previous week", "This week", "Next week"],
  month: ["Previous month", "This month", "Next month"],
};

/** The day, week or month views: one request for events, layers and warnings, then filtered for display. */
function CalendarRange({
  view,
  anchor,
  today,
  zone,
  filters,
  onEvent,
  onCreate,
  onDay,
}: {
  view: RangeView;
  anchor: string;
  today: string;
  zone: string;
  filters: CalendarFilters;
  onEvent: (event: CalendarEvent, edit?: boolean) => void;
  onCreate: (create: NewEvent) => void;
  onDay: (date: string) => void;
}) {
  const dates = datesOf(view, anchor);
  const range = rangeOf(dates[0] ?? today, dates.at(-1) ?? today, zone);
  const calendar = useCalendarView(range.from, range.to);
  const tasks = useDueTasks(range.from, range.to);

  if (calendar.isPending || tasks.isPending) return <SkeletonList rows={5} label="Loading your calendar" />;
  if (calendar.isError) return <QueryError title="Your events didn't load" error={calendar.error} retry={() => void calendar.refetch()} />;
  if (tasks.isError) return <QueryError title="Due dates didn't load" error={tasks.error} retry={() => void tasks.refetch()} />;

  const events = calendar.data.events.filter((event) => !filters.hidden.includes(calendarOf(event)));
  const layers = filters.layers ? calendar.data.layers : [];
  return (
    <>
      <Warnings warnings={calendar.data.warnings} onRepair={(event) => onEvent(event, true)} />
      {view === "day" ? (
        <DayView date={anchor} today={today} zone={zone} events={events} tasks={tasks.data} layers={layers} onEvent={onEvent} onCreate={onCreate} />
      ) : view === "month" ? (
        <MonthView anchor={anchor} today={today} zone={zone} events={events} tasks={tasks.data} onEvent={onEvent} onDay={onDay} />
      ) : (
        <WeekView dates={dates} today={today} zone={zone} events={events} tasks={tasks.data} onEvent={onEvent} />
      )}
    </>
  );
}

export function CalendarPage() {
  const zone = usePlanZone();
  const now = useNow();
  const today = localDate(now, zone);
  const [search, setSearch] = useSearchParams();
  const requested = search.get("view") as View | null;
  const view: View = requested && VIEWS.includes(requested) ? requested : "week";
  const anchor = isDate(search.get("date")) ? (search.get("date") as string) : today;
  const dates = datesOf(view, anchor);
  const showsToday = view === "month" ? sameMonth(anchor, today) : dates.includes(today);
  const [dialog, setDialog] = useState<{ key: number; open: boolean; event?: CalendarEvent; date: string; slot?: NewEvent["slot"]; edit?: boolean } | null>(null);
  const [importing, setImporting] = useState(false);
  const [filters, setFilters] = useState(readFilters);

  const go = (params: { view?: View; date?: string }) => {
    const next = new URLSearchParams(search);
    if (params.view) {
      if (params.view === "week") next.delete("view");
      else next.set("view", params.view);
    }
    if (params.date !== undefined) {
      if (params.date === today) next.delete("date");
      else next.set("date", params.date);
    }
    setSearch(next, { replace: true });
  };
  const step = (direction: 1 | -1) => {
    if (view === "day") go({ date: addDays(anchor, direction) });
    else if (view === "month") go({ date: addMonths(anchor, direction) });
    else go({ date: addDays(anchor, 7 * direction) });
  };
  const openEvent = (event?: CalendarEvent, edit = false) =>
    setDialog({ key: Date.now(), open: true, event, edit, date: showsToday ? today : (view === "day" ? anchor : (dates[0] ?? today)) });
  const create = ({ date, slot }: NewEvent) => setDialog({ key: Date.now(), open: true, date, slot });
  const changeFilters = (next: CalendarFilters) => {
    setFilters(next);
    writeFilters(next);
  };

  return (
    <div className="page">
      <PageHeader
        title="Calendar"
        description="Classes, events and due dates. Busy events take time out of your Today plan."
        actions={
          <>
            <button type="button" className="button secondary" onClick={() => setImporting(true)}>
              <UploadIcon size={18} />
              Import .ics
            </button>
            <button type="button" className="button primary" onClick={() => openEvent()}>
              <PlusIcon size={18} />
              New event
            </button>
          </>
        }
      />

      <div className="calendar-toolbar">
        <div className="segmented" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "day"} onClick={() => go({ view: "day" })}>
            Day
          </button>
          <button type="button" aria-pressed={view === "week"} onClick={() => go({ view: "week" })}>
            <CalendarIcon size={16} />
            Week
          </button>
          <button type="button" aria-pressed={view === "month"} onClick={() => go({ view: "month" })}>
            Month
          </button>
          <button type="button" aria-pressed={view === "timeline"} onClick={() => go({ view: "timeline" })}>
            <ClockIcon size={16} />
            Timeline
          </button>
          <button type="button" aria-pressed={view === "workload"} onClick={() => go({ view: "workload" })}>
            <ClipboardIcon size={16} />
            Workload
          </button>
        </div>
        {isRangeView(view) ? (
          <div className="week-nav">
            <button type="button" className="icon-button" aria-label={STEP_LABELS[view][0]} onClick={() => step(-1)}>
              <ChevronLeftIcon />
            </button>
            <button type="button" className="button small secondary" disabled={showsToday && (view !== "day" || anchor === today)} onClick={() => go({ date: today })}>
              {STEP_LABELS[view][1]}
            </button>
            <button type="button" className="icon-button" aria-label={STEP_LABELS[view][2]} onClick={() => step(1)}>
              <ChevronRightIcon />
            </button>
            <p className="week-label" aria-live="polite">
              {viewLabel(view, anchor, dates)}
            </p>
            <label className="go-to-date">
              <span>Go to date</span>
              <input type="date" value={anchor} onChange={(event) => isDate(event.target.value) && go({ date: event.target.value })} />
            </label>
          </div>
        ) : null}
      </div>
      {isRangeView(view) ? <DisplayFilters filters={filters} onChange={changeFilters} /> : null}

      {isRangeView(view) ? (
        <CalendarRange
          view={view}
          anchor={anchor}
          today={today}
          zone={zone}
          filters={filters}
          onEvent={openEvent}
          onCreate={create}
          onDay={(date) => go({ view: "day", date })}
        />
      ) : null}
      {view === "timeline" ? <CalendarSwimlane now={now} zone={zone} /> : null}
      {view === "workload" ? <TimelineView today={today} zone={zone} now={now} /> : null}

      {dialog ? (
        <EventDialog
          key={dialog.key}
          open={dialog.open}
          event={dialog.event}
          date={dialog.date}
          slot={dialog.slot}
          intent={dialog.edit ? "edit" : undefined}
          onClose={() => setDialog((current) => (current ? { ...current, open: false } : current))}
        />
      ) : null}
      <ImportCalendarDialog open={importing} onClose={() => setImporting(false)} />
      <p className="muted calendar-zone">
        Times are shown in {zone.replaceAll("_", " ")}. {view === "day" ? "Choose an empty hour to add an event there." : null}
      </p>
    </div>
  );
}
