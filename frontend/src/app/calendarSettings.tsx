// Settings → calendar: imported calendars (re-import, remove), weekly study availability, date
// overrides, course commute, the next 31 days, and the Google Calendar placeholder.
import { useState } from "react";
import { Link } from "react-router";
import {
  type AvailabilityRule,
  WEEKDAYS,
  useAvailability,
  useDeleteOverride,
  useOverrides,
  usePreviewCalendar,
  useReimportCalendar,
  useSaveAvailability,
  useSaveOverride,
  useSetCommute,
} from "./calendarApi";
import { EventDialog, ImportCalendarDialog, readIcs, reconciliationLabel } from "./events";
import { formatDateTime, plural, timeAgo } from "./format";
import { problemsOf } from "./forms";
import { PlusIcon, UploadIcon } from "./icons";
import { useCalendarSources, useCourses, useDeleteCalendarSource, useEvents, usePlanZone } from "./queries";
import { useNow } from "./shell";
import { useToast } from "./toast";
import type { CalendarEvent, CalendarSource, Course, IcsPreview } from "./types";
import { Alert, Badge, Dialog, Field, QueryError, SelectField, SkeletonList, Spinner } from "./ui";
import { addDays, dateLabel, eventDates, eventOrder, eventTimeLabel, localDate, rangeOf } from "./zoned";

/** A re-import waiting for the user to confirm the events it removes. */
interface PendingReimport {
  source: CalendarSource;
  fileName: string;
  ics: string;
  preview: IcsPreview;
}

export function CalendarsSection() {
  const sources = useCalendarSources();
  const remove = useDeleteCalendarSource();
  const previewFile = usePreviewCalendar();
  const reimport = useReimportCalendar();
  const toast = useToast();
  const now = useNow();
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<CalendarSource | null>(null);
  const [pending, setPending] = useState<PendingReimport | null>(null);
  const [working, setWorking] = useState<number | null>(null);

  const finish = (source: CalendarSource, fileName: string, ics: string, confirm: boolean) =>
    reimport.mutate(
      { id: source.id, ics, file_name: fileName, confirm_removals: confirm },
      {
        onSuccess: (result) => {
          toast(result.preview.no_op ? `${source.name} is already up to date.` : `Re-imported ${source.name}: ${reconciliationLabel(result.preview)}.`);
          setPending(null);
        },
        onError: (error) => toast(error.message, "error"),
        onSettled: () => setWorking(null),
      },
    );

  /** Previews the new file against the calendar first; removals need a yes. */
  const start = async (source: CalendarSource, file: File | undefined) => {
    if (!file) return;
    setWorking(source.id);
    const read = await readIcs(file);
    if (!read.text) {
      toast(read.error ?? "This file couldn't be read.", "error");
      setWorking(null);
      return;
    }
    const ics = read.text;
    try {
      const preview = await previewFile.mutateAsync({ ics, file_name: file.name, source_id: source.id });
      if (preview.time_zone_confirmation_required) {
        toast("This file has times without a time zone. Remove the calendar and import it again to confirm one.", "error");
        setWorking(null);
      } else if (preview.reconciliation.removed > 0 && !preview.no_op) {
        setPending({ source, fileName: file.name, ics, preview });
        setWorking(null);
      } else finish(source, file.name, ics, false);
    } catch (error) {
      toast(error instanceof Error ? error.message : "This file couldn't be previewed.", "error");
      setWorking(null);
    }
  };

  return (
    <section className="card settings-section" id="calendars" aria-labelledby="calendars-heading">
      <h2 id="calendars-heading">Calendars</h2>
      <p className="muted">
        Imported .ics files are read-only. Re-import a newer export to update one: matching events are kept, and you confirm any that would be
        removed. Events you add by hand live on the <Link to="/calendar">Calendar</Link> page.
      </p>
      {sources.isPending ? <SkeletonList rows={2} label="Loading calendars" /> : null}
      {sources.isError ? <QueryError error={sources.error} retry={() => void sources.refetch()} /> : null}
      {sources.data?.length === 0 ? <p className="inline-note">No calendars imported yet.</p> : null}
      {sources.data && sources.data.length > 0 ? (
        <ul className="source-list">
          {sources.data.map((source) => (
            <li key={source.id}>
              <div className="source-text">
                <p className="source-name">{source.name}</p>
                <p className="muted">
                  {plural(source.event_count, "read-only event")} · {source.time_zone ? source.time_zone.replaceAll("_", " ") : "event time zones"} ·{" "}
                  {source.last_reimported_at ? "re-imported " : "imported "}
                  <time dateTime={source.last_reimported_at ?? source.imported_at} title={formatDateTime(source.last_reimported_at ?? source.imported_at)}>
                    {timeAgo(source.last_reimported_at ?? source.imported_at, now)}
                  </time>
                  {source.file_name ? ` from ${source.file_name}` : ""}
                </p>
              </div>
              <div className="source-actions">
                <label className={`button small secondary file-button${working === source.id ? " is-busy" : ""}`}>
                  {working === source.id ? <Spinner size={14} /> : null}
                  Re-import<span className="visually-hidden"> {source.name}</span>
                  <input
                    type="file"
                    accept=".ics,text/calendar"
                    className="visually-hidden"
                    disabled={working !== null}
                    onChange={(event) => {
                      void start(source, event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />
                </label>
                <button type="button" className="button small danger-ghost" onClick={() => setRemoving(source)}>
                  Remove<span className="visually-hidden"> {source.name}</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="form-actions">
        <button type="button" className="button secondary" onClick={() => setImporting(true)}>
          <UploadIcon size={18} />
          Import .ics
        </button>
      </div>
      <div className="google-placeholder">
        <p className="source-name">
          Google Calendar <Badge>Coming soon</Badge>
        </p>
        <p className="muted">Coming soon. Until then, export your Google Calendar as an .ics file and import it above.</p>
      </div>

      <ImportCalendarDialog open={importing} onClose={() => setImporting(false)} />
      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title="Remove events on re-import?"
        size="small"
        footer={
          <>
            <button type="button" className="button ghost" onClick={() => setPending(null)} disabled={reimport.isPending}>
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              disabled={reimport.isPending}
              onClick={() => pending && finish(pending.source, pending.fileName, pending.ics, true)}
            >
              {reimport.isPending ? <Spinner size={16} /> : null}
              Re-import and remove
            </button>
          </>
        }
      >
        <p>
          This re-import removes {plural(pending?.preview.reconciliation.removed ?? 0, "event")} from “{pending?.source.name}”. Continue?
        </p>
        {pending ? <p className="muted">{reconciliationLabel(pending.preview)}</p> : null}
      </Dialog>
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove “${removing?.name ?? ""}”?`}
        size="small"
        footer={
          <>
            <button type="button" className="button ghost" onClick={() => setRemoving(null)}>
              Keep it
            </button>
            <button
              type="button"
              className="button danger"
              disabled={remove.isPending}
              onClick={() =>
                removing &&
                remove.mutate(removing.id, {
                  onSuccess: () => {
                    toast(`Removed ${removing.name}.`);
                    setRemoving(null);
                  },
                  onError: (error) => toast(error.message, "error"),
                })
              }
            >
              {remove.isPending ? <Spinner size={16} /> : null}
              Remove calendar
            </button>
          </>
        }
      >
        <p>
          Remove {removing?.name} and its imported events? Its {plural(removing?.event_count ?? 0, "event")} stop taking time from your plan.
          Events you added by hand stay.
        </p>
      </Dialog>
    </section>
  );
}

function WeeklyRules({ saved }: { saved: AvailabilityRule[] }) {
  const save = useSaveAvailability();
  const toast = useToast();
  const [rules, setRules] = useState(saved);
  const dirty = JSON.stringify(rules) !== JSON.stringify(saved);
  const problems = problemsOf(save.error);
  const set = (index: number, changes: Partial<AvailabilityRule>) =>
    setRules((list) => list.map((rule, at) => (at === index ? { ...rule, ...changes } : rule)));
  const invalid = rules.some((rule) => !rule.start_local_time || !rule.end_local_time || rule.end_local_time <= rule.start_local_time);

  return (
    <div className="subsection">
      <h3>Weekly study availability</h3>
      <p className="muted">
        When you study, day by day. With any interval saved, Today plans inside these times (less busy events and commute) instead of the
        single study window and daily goal above.
      </p>
      {problems.general ?? Object.values(problems.fields)[0] ? <Alert>{problems.general ?? Object.values(problems.fields)[0]}</Alert> : null}
      {rules.length === 0 ? <p className="inline-note">No weekly availability: Today uses your study window.</p> : null}
      <ul className="availability-list">
        {rules.map((rule, index) => (
          <li key={index} className="availability-row">
            <SelectField label="Day" value={rule.weekday} onChange={(event) => set(index, { weekday: Number(event.target.value) })}>
              {WEEKDAYS.map((day, weekday) => (
                <option key={day} value={weekday}>
                  {day}
                </option>
              ))}
            </SelectField>
            <Field label="From" type="time" value={rule.start_local_time} onChange={(event) => set(index, { start_local_time: event.target.value })} />
            <Field
              label="Until"
              type="time"
              value={rule.end_local_time}
              onChange={(event) => set(index, { end_local_time: event.target.value })}
              error={rule.end_local_time && rule.end_local_time <= rule.start_local_time ? "End after the start." : undefined}
            />
            <label className="check-field">
              <input type="checkbox" checked={rule.enabled} onChange={(event) => set(index, { enabled: event.target.checked })} />
              <span>On</span>
            </label>
            <button type="button" className="button small danger-ghost" onClick={() => setRules((list) => list.filter((_, at) => at !== index))}>
              Remove<span className="visually-hidden"> {WEEKDAYS[rule.weekday]} interval</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="form-actions">
        <button
          type="button"
          className="button secondary"
          onClick={() => setRules((list) => [...list, { weekday: 0, start_local_time: "09:00", end_local_time: "17:00", enabled: true }])}
        >
          <PlusIcon size={18} />
          Add interval
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!dirty || invalid || save.isPending}
          onClick={() => save.mutate(rules, { onSuccess: (next) => (setRules(next), toast("Availability saved. Today's plan is updated.")) })}
        >
          {save.isPending ? <Spinner size={16} /> : null}
          Save availability
        </button>
      </div>
    </div>
  );
}

function DateOverrides() {
  const overrides = useOverrides();
  const save = useSaveOverride();
  const remove = useDeleteOverride();
  const toast = useToast();
  const zone = usePlanZone();
  const [date, setDate] = useState(() => localDate(new Date(), zone));
  const [unavailable, setUnavailable] = useState(false);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("17:00");
  const problems = problemsOf(save.error);
  const bad = !date || (!unavailable && (!start || !end || end <= start));

  return (
    <div className="subsection">
      <h3>Date overrides</h3>
      <p className="muted">Replace the weekly availability on one date, for example a trip or a free Saturday.</p>
      {problems.general ?? Object.values(problems.fields)[0] ? <Alert>{problems.general ?? Object.values(problems.fields)[0]}</Alert> : null}
      <div className="override-editor">
        <Field label="Date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        <label className="check-field">
          <input type="checkbox" checked={unavailable} onChange={(event) => setUnavailable(event.target.checked)} />
          <span>Unavailable all day</span>
        </label>
        {unavailable ? null : (
          <>
            <Field label="From" type="time" value={start} onChange={(event) => setStart(event.target.value)} />
            <Field label="Until" type="time" value={end} onChange={(event) => setEnd(event.target.value)} />
          </>
        )}
        <button
          type="button"
          className="button primary"
          disabled={bad || save.isPending}
          onClick={() =>
            save.mutate(
              { date, available_intervals: unavailable ? [] : [{ start, end }] },
              { onSuccess: () => toast(`Override saved for ${dateLabel(date, localDate(new Date(), zone))}.`) },
            )
          }
        >
          {save.isPending ? <Spinner size={16} /> : null}
          Save override
        </button>
      </div>
      {overrides.isError ? <QueryError error={overrides.error} retry={() => void overrides.refetch()} /> : null}
      {overrides.data?.length ? (
        <ul className="override-list">
          {overrides.data.map((override) => (
            <li key={override.date}>
              <span>
                <strong>{override.date}</strong>:{" "}
                {override.available_intervals.length
                  ? override.available_intervals.map((interval) => `${interval.start}–${interval.end}`).join(", ")
                  : "Unavailable"}
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove the override for ${override.date}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(override.date, { onError: (error) => toast(error.message, "error") })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function AvailabilitySection() {
  const rules = useAvailability();
  return (
    <section className="card settings-section" id="availability" aria-labelledby="availability-heading">
      <h2 id="availability-heading">Study availability</h2>
      {rules.isPending ? <SkeletonList rows={2} label="Loading availability" /> : null}
      {rules.isError ? <QueryError error={rules.error} retry={() => void rules.refetch()} /> : null}
      {rules.data ? <WeeklyRules key={JSON.stringify(rules.data)} saved={rules.data} /> : null}
      <DateOverrides />
    </section>
  );
}

function CommuteRow({ course }: { course: Course }) {
  const set = useSetCommute();
  const toast = useToast();
  const [minutes, setMinutes] = useState(String(course.commute_minutes ?? 0));
  const value = Number(minutes);
  const valid = minutes.trim() !== "" && Number.isInteger(value) && value >= 0 && value <= 240;
  return (
    <li className="commute-row">
      <Field
        label={`${course.code} commute (minutes)`}
        type="number"
        min={0}
        max={240}
        step={5}
        value={minutes}
        onChange={(event) => setMinutes(event.target.value)}
        error={valid ? problemsOf(set.error).general ?? undefined : "Use 0 to 240 minutes."}
      />
      <button
        type="button"
        className="button small secondary"
        disabled={!valid || value === course.commute_minutes || set.isPending}
        onClick={() => set.mutate({ courseId: course.id, minutes: value }, { onSuccess: () => toast(`Commute saved for ${course.code}.`) })}
      >
        {set.isPending ? <Spinner size={14} /> : null}
        Save<span className="visually-hidden"> {course.code} commute</span>
      </button>
    </li>
  );
}

export function CommuteSection() {
  const courses = useCourses(false);
  return (
    <section className="card settings-section" id="commute" aria-labelledby="commute-heading">
      <h2 id="commute-heading">Commute</h2>
      <p className="muted">
        Travel time before and after each class event linked to the course. It counts as busy, and gaps under 30 minutes between classes do
        too.
      </p>
      {courses.isPending ? <SkeletonList rows={2} label="Loading courses" /> : null}
      {courses.isError ? <QueryError error={courses.error} retry={() => void courses.refetch()} /> : null}
      {courses.data?.length === 0 ? <p className="inline-note">No courses yet.</p> : null}
      {courses.data?.length ? (
        <ul className="commute-grid">
          {courses.data.map((course) => (
            <CommuteRow key={course.id} course={course} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const AGENDA_DAYS = 31;

/** Every event in the next 31 days; manual ones can be edited or deleted here. */
export function AgendaSection() {
  const zone = usePlanZone();
  const today = localDate(new Date(), zone);
  const range = rangeOf(today, addDays(today, AGENDA_DAYS - 1), zone);
  const [open, setOpen] = useState(false);
  const events = useEvents(range.from, range.to, open);
  const [dialog, setDialog] = useState<{ key: number; event: CalendarEvent; edit: boolean; open: boolean } | null>(null);
  const show = (event: CalendarEvent, edit: boolean) => setDialog({ key: Date.now(), event, edit, open: true });
  const sorted = [...(events.data ?? [])].sort(eventOrder).sort((a, b) => (eventDates(a, zone)[0] ?? "").localeCompare(eventDates(b, zone)[0] ?? ""));

  return (
    <section className="card settings-section" id="agenda" aria-labelledby="agenda-heading">
      <h2 id="agenda-heading">Next {AGENDA_DAYS} days</h2>
      <details className="agenda" onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
        <summary>Show every event until {dateLabel(addDays(today, AGENDA_DAYS - 1), today)}</summary>
        {events.isPending && open ? <SkeletonList rows={3} label="Loading events" /> : null}
        {events.isError ? <QueryError error={events.error} retry={() => void events.refetch()} /> : null}
        {events.data && sorted.length === 0 ? <p className="inline-note">Nothing in the next {AGENDA_DAYS} days.</p> : null}
        {sorted.length ? (
          <ul className="agenda-list">
            {sorted.map((event) => {
              const date = eventDates(event, zone)[0] ?? today;
              return (
                <li key={event.key}>
                  <div className="agenda-text">
                    <p className="source-name">{event.title}</p>
                    <p className="muted">
                      {dateLabel(date, today)} · {eventTimeLabel(event, date, zone)} · {event.source ? event.source.name : "Added by hand"}
                      {event.editable ? "" : " · read-only"}
                      {event.busy ? "" : " · free"}
                      {event.recurrence_rule ? " · repeats" : ""}
                    </p>
                  </div>
                  <div className="source-actions">
                    {event.editable ? (
                      <>
                        <button type="button" className="button small secondary" onClick={() => show(event, true)}>
                          Edit<span className="visually-hidden"> {event.title}</span>
                        </button>
                        <button type="button" className="button small danger-ghost" onClick={() => show(event, false)}>
                          Delete<span className="visually-hidden"> {event.title}</span>
                        </button>
                      </>
                    ) : (
                      <Badge>Read only</Badge>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </details>
      {dialog ? (
        <EventDialog
          key={dialog.key}
          open={dialog.open}
          event={dialog.event}
          intent={dialog.edit ? "edit" : "delete"}
          date={today}
          onClose={() => setDialog((current) => (current ? { ...current, open: false } : current))}
        />
      ) : null}
    </section>
  );
}
