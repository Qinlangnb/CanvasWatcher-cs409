import { useState } from "react";
import { useSearchParams } from "react-router";
import { EventDialog, ImportCalendarDialog } from "../events";
import { formatMinutes, formatTime } from "../format";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, ClipboardIcon, PlusIcon, UploadIcon } from "../icons";
import { TaskList } from "../lists";
import { useEvents, usePlanZone, useSettings, useTasks } from "../queries";
import { useNow } from "../shell";
import { useTaskEditor } from "../tasks";
import type { CalendarEvent, Task } from "../types";
import { Badge, EmptyState, PageHeader, QueryError, SkeletonList } from "../ui";
import {
  addDays,
  buildTimeline,
  dateLabel,
  eventDates,
  eventTimeLabel,
  groupByDate,
  localDate,
  rangeOf,
  weekOf,
  weekRangeLabel,
  weekdayLabel,
  type TimelineDay,
} from "../zoned";

type View = "week" | "timeline";
const TIMELINE_DAYS = 28;

const isDate = (value: string | null): value is string => value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

type DayItem = { kind: "event"; at: number; event: CalendarEvent } | { kind: "task"; at: number; task: Task };

function WeekView({ dates, today, zone, onEvent }: { dates: string[]; today: string; zone: string; onEvent: (event: CalendarEvent) => void }) {
  const range = rangeOf(dates[0] ?? today, dates.at(-1) ?? today, zone);
  const events = useEvents(range.from, range.to);
  const tasks = useTasks({ status: "all", dueAfter: range.from, dueBefore: range.to });
  const editor = useTaskEditor();

  if (events.isPending || tasks.isPending) return <SkeletonList rows={5} label="Loading this week" />;
  if (events.isError) return <QueryError title="Your events didn't load" error={events.error} retry={() => void events.refetch()} />;
  if (tasks.isError) return <QueryError title="Due dates didn't load" error={tasks.error} retry={() => void tasks.refetch()} />;

  const eventsByDate = groupByDate(dates, events.data, (event) => eventDates(event, zone));
  const dated = tasks.data.filter((task) => task.due_at && task.state !== "removed");
  const tasksByDate = groupByDate(dates, dated, (task) => [localDate(task.due_at ?? "", zone)]);

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
                    <li key={`e${item.event.id}`}>
                      <button type="button" className={`cal-item cal-event${item.event.busy ? "" : " free"}`} onClick={() => onEvent(item.event)}>
                        <span className="cal-time">{eventTimeLabel(item.event, date, zone)}</span>
                        <span className="cal-title">{item.event.title}</span>
                        {item.event.location ? <span className="cal-detail">{item.event.location}</span> : null}
                      </button>
                    </li>
                  ) : (
                    <li key={`t${item.task.id}`}>
                      <button
                        type="button"
                        className={`cal-item cal-task type-${item.task.type} state-${item.task.state}`}
                        onClick={() => editor.open(item.task)}
                      >
                        <span className="cal-time">
                          Due {formatTime(new Date(item.task.due_at ?? ""), zone)}
                          {item.task.state === "done" ? " · done" : item.task.state === "ignored" ? " · ignored" : ""}
                        </span>
                        <span className="cal-title">{item.task.title}</span>
                        <span className="cal-detail">{item.task.course.code}</span>
                      </button>
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

export function CalendarPage() {
  const zone = usePlanZone();
  const now = useNow();
  const today = localDate(now, zone);
  const [search, setSearch] = useSearchParams();
  const view: View = search.get("view") === "timeline" ? "timeline" : "week";
  const anchor = isDate(search.get("date")) ? (search.get("date") as string) : today;
  const dates = weekOf(anchor);
  const thisWeek = dates.includes(today);
  const [dialog, setDialog] = useState<{ key: number; open: boolean; event?: CalendarEvent; date: string } | null>(null);
  const [importing, setImporting] = useState(false);

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
  const openEvent = (event?: CalendarEvent) =>
    setDialog({ key: Date.now(), open: true, event, date: thisWeek ? today : (dates[0] ?? today) });

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
          <button type="button" aria-pressed={view === "week"} onClick={() => go({ view: "week" })}>
            <CalendarIcon size={16} />
            Week
          </button>
          <button type="button" aria-pressed={view === "timeline"} onClick={() => go({ view: "timeline" })}>
            <ClipboardIcon size={16} />
            Timeline
          </button>
        </div>
        {view === "week" ? (
          <div className="week-nav">
            <button type="button" className="icon-button" aria-label="Previous week" onClick={() => go({ date: addDays(anchor, -7) })}>
              <ChevronLeftIcon />
            </button>
            <button type="button" className="button small secondary" disabled={thisWeek} onClick={() => go({ date: today })}>
              This week
            </button>
            <button type="button" className="icon-button" aria-label="Next week" onClick={() => go({ date: addDays(anchor, 7) })}>
              <ChevronRightIcon />
            </button>
            <p className="week-label" aria-live="polite">
              {weekRangeLabel(dates)}
            </p>
          </div>
        ) : null}
      </div>

      {view === "week" ? (
        <WeekView dates={dates} today={today} zone={zone} onEvent={openEvent} />
      ) : (
        <TimelineView today={today} zone={zone} now={now} />
      )}

      {dialog ? (
        <EventDialog
          key={dialog.key}
          open={dialog.open}
          event={dialog.event}
          date={dialog.date}
          onClose={() => setDialog((current) => (current ? { ...current, open: false } : current))}
        />
      ) : null}
      <ImportCalendarDialog open={importing} onClose={() => setImporting(false)} />
      <p className="muted calendar-zone">Times are shown in {zone.replaceAll("_", " ")}.</p>
    </div>
  );
}
