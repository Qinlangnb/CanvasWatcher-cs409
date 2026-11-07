import { useState } from "react";
import { Link } from "react-router";
import { REASON_LABELS, formatLongDate, formatMinutes, formatTime, hourOf, plural } from "../format";
import { BellIcon, CalendarIcon, ClipboardIcon, PlusIcon } from "../icons";
import { ChangeDialog, ChangeList, TaskList, TaskRow } from "../lists";
import { useChanges, useConnection, useMe, useToday } from "../queries";
import { useNow } from "../shell";
import { useTaskEditor } from "../tasks";
import type { Today, TodayItem } from "../types";
import { Alert, Badge, EmptyState, PageHeader, QueryError, SkeletonList } from "../ui";
import { eventOrder, eventTimeLabel } from "../zoned";

const TODAY_CHANGES = 5;

function greeting(hour: number): string {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** How much of today's goal is planned, and why the plan may hold less than the goal. */
function PlanMeter({ plan, now }: { plan: Today; now: Date }) {
  const zone = plan.time_zone;
  const windowStart = formatTime(new Date(plan.study_window.start), zone);
  const windowEnd = formatTime(new Date(plan.study_window.end), zone);
  const ended = now >= new Date(plan.study_window.end);
  const share = plan.goal_minutes > 0 ? Math.min(100, Math.round((plan.planned_minutes / plan.goal_minutes) * 100)) : 0;

  let note: string;
  if (ended) note = `Your study window ended at ${windowEnd}. Tomorrow's plan starts at ${windowStart}.`;
  else if (plan.free_minutes === 0) note = `Your calendar is full for the rest of your study window (${windowStart}–${windowEnd}).`;
  else if (plan.capacity_minutes < plan.goal_minutes)
    note = `Only ${formatMinutes(plan.free_minutes)} is free in your study window (${windowStart}–${windowEnd}) after your events.`;
  else note = `${formatMinutes(plan.free_minutes)} free between ${windowStart} and ${windowEnd}; the plan fills up to your daily goal.`;

  return (
    <div className="plan-meter">
      <p className="plan-meter-figures">
        <strong>{formatMinutes(plan.planned_minutes)}</strong> planned
        <span> of your {formatMinutes(plan.goal_minutes)} daily goal</span>
      </p>
      <div className="meter" aria-hidden="true">
        <span style={{ width: `${share}%` }} />
      </div>
      <p className="muted">{note}</p>
    </div>
  );
}

/** Why a task is on the plan and how long to spend on it today. */
function PlanNote({ item }: { item: TodayItem }) {
  const amount =
    item.planned_minutes >= item.remaining_minutes
      ? `Finish it today: ${formatMinutes(item.planned_minutes)}`
      : `${formatMinutes(item.planned_minutes)} today`;
  return (
    <p className="plan-note">
      {item.reasons.map((reason) => (
        <Badge key={reason} tone={REASON_LABELS[reason].tone}>
          {REASON_LABELS[reason].label}
        </Badge>
      ))}
      {item.planned_minutes > 0 ? <span className="plan-amount">{amount}</span> : null}
    </p>
  );
}

function PlanSection({ plan, now }: { plan: Today; now: Date }) {
  const editor = useTaskEditor();
  const planned = plan.items.filter((item) => item.planned_minutes > 0);
  const waiting = plan.items.filter((item) => item.planned_minutes === 0);
  const overloaded = plan.due_today_minutes > plan.capacity_minutes && !(now >= new Date(plan.study_window.end));
  return (
    <section className="card plan-card" aria-labelledby="plan-heading">
      <div className="section-header">
        <h2 id="plan-heading">Today's plan</h2>
        <Link to="/settings#study-plan">Study settings</Link>
      </div>
      <PlanMeter plan={plan} now={now} />
      {overloaded ? (
        <Alert tone="warning" title="More is due today than fits">
          Work due today needs about {formatMinutes(plan.due_today_minutes)}, and you have {formatMinutes(plan.capacity_minutes)} planned
          time left. Ask for an extension, study longer, or lower an estimate if a task is quicker than it looks.
        </Alert>
      ) : null}
      {plan.items.length === 0 ? (
        <EmptyState
          icon={<ClipboardIcon size={28} />}
          title="Nothing to plan"
          action={
            <button type="button" className="button secondary" onClick={() => editor.create()}>
              <PlusIcon size={18} />
              Add a task
            </button>
          }
        >
          No open work is due in the next two weeks. Add your own task, or enjoy the breathing room.
        </EmptyState>
      ) : null}
      {planned.length > 0 ? (
        <ul className="task-list plan-list">
          {planned.map((item) => (
            <TaskRow key={item.task.id} task={item.task} now={now} extra={<PlanNote item={item} />} />
          ))}
        </ul>
      ) : null}
      {planned.length === 0 && waiting.length > 0 ? (
        <p className="muted">There's no study time left today. These tasks come first tomorrow.</p>
      ) : null}
      {waiting.length > 0 ? (
        <details className="plan-more" open={planned.length === 0}>
          <summary>
            Doesn't fit today <span className="count">{waiting.length}</span>
          </summary>
          <ul className="task-list">
            {waiting.map((item) => (
              <TaskRow key={item.task.id} task={item.task} now={now} extra={<PlanNote item={item} />} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function ScheduleSection({ plan }: { plan: Today }) {
  const events = [...plan.events].sort(eventOrder);
  return (
    <section className="card" aria-labelledby="schedule-heading">
      <div className="section-header">
        <h2 id="schedule-heading">Schedule</h2>
        <Link to="/calendar">Open calendar</Link>
      </div>
      {events.length === 0 ? (
        <EmptyState icon={<CalendarIcon size={28} />} title="No events today">
          Import your class schedule on the <Link to="/calendar">Calendar</Link> so the plan knows when you're busy.
        </EmptyState>
      ) : (
        <ul className="event-list">
          {events.map((event) => (
            <li key={event.id} className={`event-row${event.busy ? "" : " free"}`}>
              <span className="event-time">{eventTimeLabel(event, plan.date, plan.time_zone)}</span>
              <span className="event-title">
                {event.title}
                {event.location ? <span className="event-location">{event.location}</span> : null}
              </span>
              {event.busy ? null : <Badge>Free</Badge>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DoneSection({ plan, now }: { plan: Today; now: Date }) {
  return (
    <section className="card" aria-labelledby="done-heading">
      <div className="section-header">
        <h2 id="done-heading">
          Done today {plan.done_today.length > 0 ? <span className="count">{plan.done_today.length}</span> : null}
        </h2>
      </div>
      {plan.done_today.length === 0 ? (
        <p className="muted">Check off tasks as you finish them. Work you hand in on Canvas shows up here after a sync.</p>
      ) : (
        <TaskList tasks={plan.done_today} now={now} />
      )}
    </section>
  );
}

function ChangesSection({ now, onOpen }: { now: Date; onOpen: (id: number) => void }) {
  const changes = useChanges({ unread: true, pages: 1 });
  const unread = changes.data?.items ?? [];
  return (
    <section className="card" aria-labelledby="changes-heading">
      <div className="section-header">
        <h2 id="changes-heading">New changes</h2>
        <Link to="/changes">See all changes</Link>
      </div>
      {changes.isPending ? <SkeletonList rows={2} label="Loading changes" /> : null}
      {changes.isError ? <QueryError error={changes.error} retry={() => void changes.refetch()} /> : null}
      {changes.data && unread.length === 0 ? (
        <EmptyState icon={<BellIcon size={28} />} title="You're up to date">
          When something changes in Canvas, it appears here.
        </EmptyState>
      ) : null}
      {unread.length > 0 ? <ChangeList changes={unread.slice(0, TODAY_CHANGES)} now={now} onOpen={onOpen} /> : null}
    </section>
  );
}

export function TodayPage() {
  const me = useMe();
  const now = useNow();
  const connection = useConnection();
  const today = useToday();
  const editor = useTaskEditor();
  const [openChange, setOpenChange] = useState<number | null>(null);
  const plan = today.data;
  const zone = plan?.time_zone;
  const firstSync = connection.data?.syncing && !connection.data.last_synced_at;
  const plannedCount = plan?.items.filter((item) => item.planned_minutes > 0).length ?? 0;

  return (
    <div className="page">
      <PageHeader
        eyebrow={formatLongDate(now, zone)}
        title={`${greeting(hourOf(now, zone))}, ${me.data?.username ?? ""}`}
        documentTitle="Today"
        description={
          plan
            ? plannedCount > 0
              ? `${plural(plannedCount, "task")} planned for ${formatMinutes(plan.planned_minutes)} today.`
              : "Nothing planned for the rest of today."
            : undefined
        }
        actions={
          <button type="button" className="button primary" onClick={() => editor.create()}>
            <PlusIcon size={18} />
            New task
          </button>
        }
      />
      {firstSync ? (
        <Alert tone="info" title="Your first sync is still running">
          Your courses and tasks will appear here as soon as it finishes.
        </Alert>
      ) : null}

      <div className="today-grid">
        <div className="today-main">
          {today.isPending ? (
            <section className="card" aria-label="Today's plan">
              <SkeletonList rows={4} label="Loading today's plan" />
            </section>
          ) : null}
          {today.isError ? <QueryError title="Today's plan didn't load" error={today.error} retry={() => void today.refetch()} /> : null}
          {plan ? <PlanSection plan={plan} now={now} /> : null}
        </div>
        <div className="today-side">
          {plan ? <ScheduleSection plan={plan} /> : null}
          {plan ? <DoneSection plan={plan} now={now} /> : null}
          <ChangesSection now={now} onOpen={setOpenChange} />
        </div>
      </div>

      <ChangeDialog id={openChange} onClose={() => setOpenChange(null)} />
    </div>
  );
}
