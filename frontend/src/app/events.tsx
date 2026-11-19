// Calendar dialogs: an event's details, add or edit an event by hand, import .ics files with a preview.
import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { usePreviewCalendar } from "./calendarApi";
import { formatBytes, plural } from "./format";
import { EVENT_TYPES, MAX_ICS_BYTES, eventBody, eventDraft, problemsOf, type EventDraft } from "./forms";
import { useCourses, useCreateEvent, useDeleteEvent, useImportCalendar, usePlanZone, useUpdateEvent } from "./queries";
import { useToast } from "./toast";
import type { CalendarEvent, IcsPreview } from "./types";
import { Alert, Badge, Dialog, Field, SelectField, Spinner, TextAreaField } from "./ui";
import { dateLabel, eventTimeLabel, localDate } from "./zoned";

export const EVENT_TYPE_LABELS: Record<string, string> = { class: "Class", busy: "Busy", personal: "Personal", study: "Study", other: "Other" };

/** Asks before deleting a manual event; a recurring one goes with its whole series. */
function DeleteEventButtons({ event, onDone, onCancel }: { event: CalendarEvent; onDone: () => void; onCancel: () => void }) {
  const remove = useDeleteEvent();
  const toast = useToast();
  const series = event.recurrence_rule !== null;
  return (
    <>
      <p className="footer-question">{series ? "Delete this entire recurring series?" : "Delete this event?"}</p>
      <button type="button" className="button ghost" onClick={onCancel} disabled={remove.isPending}>
        Keep it
      </button>
      <button
        type="button"
        className="button danger"
        disabled={remove.isPending}
        onClick={() =>
          remove.mutate(event.id, {
            onSuccess: () => {
              toast(`Deleted: ${event.title}`);
              onDone();
            },
            onError: (error) => toast(error.message, "error"),
          })
        }
      >
        {remove.isPending ? <Spinner size={16} /> : null}
        {series ? "Delete entire series" : "Delete event"}
      </button>
    </>
  );
}

/** What an event is and where it comes from; manual events can be edited or deleted from here. */
function EventDetails({
  event,
  zone,
  open,
  deleteNow,
  onClose,
  onEdit,
}: {
  event: CalendarEvent;
  zone: string;
  open: boolean;
  deleteNow: boolean;
  onClose: () => void;
  onEdit: () => void;
}) {
  const [deleting, setDeleting] = useState(deleteNow && event.editable);
  const date = event.all_day ? event.start : localDate(event.start, zone);
  const series = event.recurrence_rule !== null;
  const footer = deleting ? (
    <DeleteEventButtons event={event} onDone={onClose} onCancel={() => setDeleting(false)} />
  ) : event.editable ? (
    <>
      <button type="button" className="button danger-ghost footer-start" onClick={() => setDeleting(true)}>
        {series ? "Delete entire series" : "Delete event"}
      </button>
      <button type="button" className="button ghost" onClick={onClose}>
        Close
      </button>
      <button type="button" className="button primary" onClick={onEdit}>
        {series ? "Edit entire series" : "Edit event"}
      </button>
    </>
  ) : (
    <button type="button" className="button primary" onClick={onClose}>
      Close
    </button>
  );
  return (
    <Dialog open={open} onClose={onClose} title={event.title} size="small" footer={footer}>
      <dl className="detail-list">
        <div>
          <dt>When</dt>
          <dd>{`${dateLabel(date, localDate(new Date(), zone))} · ${eventTimeLabel(event, date, zone)}`}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>
            {event.source ? `${event.source.name} (imported) ` : "Added by hand "}
            {event.editable ? <Badge tone="success">Editable</Badge> : <Badge>Read-only · manage through import source</Badge>}
          </dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{EVENT_TYPE_LABELS[event.event_type] ?? event.event_type}</dd>
        </div>
        {event.course ? (
          <div>
            <dt>Course</dt>
            <dd>{event.course.code}</dd>
          </div>
        ) : null}
        {event.location ? (
          <div>
            <dt>Where</dt>
            <dd>{event.location}</dd>
          </div>
        ) : null}
        <div>
          <dt>Study time</dt>
          <dd>{event.busy ? "Busy: not used for your plan" : "Free: can be used for your plan"}</dd>
        </div>
        {event.time_zone && event.time_zone !== zone ? (
          <div>
            <dt>Time zone</dt>
            <dd>{event.time_zone.replaceAll("_", " ")}</dd>
          </div>
        ) : null}
        {event.description ? (
          <div>
            <dt>Description</dt>
            <dd className="event-description">{event.description}</dd>
          </div>
        ) : null}
      </dl>
      {series ? <p className="muted">Recurring series ({event.recurrence_rule}): editing or deleting applies to the entire series.</p> : null}
      {event.editable ? null : (
        <p className="muted">
          Imported events follow their file. To change one, update the calendar it came from and re-import it under{" "}
          <Link to="/settings#calendars" onClick={onClose}>
            Settings
          </Link>
          .
        </p>
      )}
    </Dialog>
  );
}

/**
 * Shows an event's details (`event`), or the form to add one. `slot` pre-fills a new event from a
 * selected time; editing a recurring event edits its whole series.
 */
export function EventDialog({
  open,
  event,
  date,
  slot,
  intent,
  onClose,
}: {
  open: boolean;
  event?: CalendarEvent;
  /** The day a new event starts on. */
  date: string;
  slot?: { start: string; end: string };
  /** Skip straight to editing, or to the delete question. */
  intent?: "edit" | "delete";
  onClose: () => void;
}) {
  const zone = usePlanZone();
  const [editing, setEditing] = useState(intent === "edit" && Boolean(event?.editable));
  if (event && !editing) {
    return <EventDetails event={event} zone={zone} open={open} deleteNow={intent === "delete"} onClose={onClose} onEdit={() => setEditing(true)} />;
  }
  return <EventForm open={open} event={event} date={date} slot={slot} zone={zone} onClose={onClose} />;
}

function EventForm({
  open,
  event,
  date,
  slot,
  zone,
  onClose,
}: {
  open: boolean;
  event?: CalendarEvent;
  date: string;
  slot?: { start: string; end: string };
  zone: string;
  onClose: () => void;
}) {
  const create = useCreateEvent();
  const update = useUpdateEvent();
  const courses = useCourses(false);
  const toast = useToast();
  const formId = useId();
  const [initial] = useState(() => {
    const draft = eventDraft(event, date, zone, new Date());
    return slot ? { ...draft, start: slot.start, end: slot.end } : draft;
  });
  const [draft, setDraft] = useState(initial);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const saving = create.isPending || update.isPending;
  const server = problemsOf(event ? update.error : create.error);
  const fields = { ...server.fields, ...local };
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const series = Boolean(event?.recurrence_rule);
  const set = <K extends keyof EventDraft>(key: K, value: EventDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const toggleAllDay = (allDay: boolean) =>
    setDraft((current) => {
      if (allDay === current.allDay) return current;
      const day = current.start.slice(0, 10) || date;
      const lastDay = current.end.slice(0, 10) || day;
      // All-day events usually don't block study time (holidays, deadlines); timed ones do.
      return allDay
        ? { ...current, allDay, start: day, end: lastDay < day ? day : lastDay, busy: false }
        : { ...current, allDay, start: `${day}T09:00`, end: `${day}T10:00`, busy: true };
    });

  const requestClose = () => {
    if (saving) return;
    if (dirty && !discarding) setDiscarding(true);
    else onClose();
  };

  const submit = (formEvent: FormEvent) => {
    formEvent.preventDefault();
    const result = eventBody(draft, zone);
    setLocal(result.errors);
    if (!result.body) return;
    const done = () => {
      toast(event ? `Saved: ${result.body?.title}` : `Added: ${result.body?.title}`);
      onClose();
    };
    if (event) update.mutate({ id: event.id, changes: result.body }, { onSuccess: done });
    else create.mutate(result.body, { onSuccess: done });
  };

  const footer =
    deleting && event ? (
      <DeleteEventButtons event={event} onDone={onClose} onCancel={() => setDeleting(false)} />
    ) : (
      <>
        {event ? (
          <button type="button" className="button danger-ghost footer-start" onClick={() => setDeleting(true)}>
            {series ? "Delete entire series" : "Delete"}
          </button>
        ) : null}
        <button type="button" className="button ghost" onClick={requestClose}>
          Cancel
        </button>
        <button type="submit" form={formId} className="button primary" disabled={saving}>
          {saving ? <Spinner size={16} /> : null}
          {event ? "Save" : "Add event"}
        </button>
      </>
    );

  const shownZone = draft.timeZone?.trim() || zone;
  return (
    <Dialog open={open} onClose={requestClose} title={event ? (series ? "Edit entire series" : "Edit event") : "New event"} footer={footer}>
      <form id={formId} className="stack" onSubmit={submit} noValidate>
        {discarding ? (
          <Alert
            tone="warning"
            title="Discard your changes?"
            action={
              <div className="alert-buttons">
                <button type="button" className="button small secondary" autoFocus onClick={() => setDiscarding(false)}>
                  Keep editing
                </button>
                <button type="button" className="button small danger-ghost" onClick={onClose}>
                  Discard
                </button>
              </div>
            }
          />
        ) : null}
        {server.general ? <Alert>{server.general}</Alert> : null}
        {series ? <Alert tone="info">Recurring series: changes apply to every occurrence, starting from the first.</Alert> : null}
        <Field label="Title" value={draft.title} onChange={(e) => set("title", e.target.value)} maxLength={200} error={fields.title} required data-autofocus />
        <label className="check-field">
          <input type="checkbox" checked={draft.allDay} onChange={(e) => toggleAllDay(e.target.checked)} />
          <span>All day</span>
        </label>
        <div className="form-row">
          {draft.allDay ? (
            <>
              <Field label="First day" type="date" value={draft.start} onChange={(e) => set("start", e.target.value)} error={fields.start} />
              <Field label="Last day" type="date" value={draft.end} min={draft.start} onChange={(e) => set("end", e.target.value)} error={fields.end} />
            </>
          ) : (
            <>
              <Field label="Starts" type="datetime-local" value={draft.start} onChange={(e) => set("start", e.target.value)} error={fields.start} />
              <Field label="Ends" type="datetime-local" value={draft.end} min={draft.start} onChange={(e) => set("end", e.target.value)} error={fields.end} />
            </>
          )}
        </div>
        <Field label="Location (optional)" value={draft.location} onChange={(e) => set("location", e.target.value)} maxLength={200} error={fields.location} />
        <TextAreaField
          label="Description (optional)"
          value={draft.description ?? ""}
          onChange={(e) => set("description", e.target.value)}
          maxLength={5000}
          rows={3}
          error={fields.description}
        />
        <div className="form-row">
          <SelectField label="Type" value={draft.eventType ?? "other"} onChange={(e) => set("eventType", e.target.value as EventDraft["eventType"])} error={fields.event_type}>
            {EVENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {EVENT_TYPE_LABELS[type]}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Course"
            value={draft.courseId ?? ""}
            onChange={(e) => set("courseId", e.target.value)}
            error={fields.course_id}
            hint={draft.eventType === "class" ? "Class events get the course's commute." : undefined}
          >
            <option value="">No course</option>
            {(courses.data ?? []).map((course) => (
              <option key={course.id} value={course.id}>
                {course.code}
              </option>
            ))}
          </SelectField>
        </div>
        <Field
          label="Repeats (RRULE, optional)"
          value={draft.recurrence ?? ""}
          onChange={(e) => set("recurrence", e.target.value)}
          placeholder="FREQ=WEEKLY;BYDAY=MO,WE"
          maxLength={512}
          spellCheck={false}
          hint="FREQ (DAILY, WEEKLY, MONTHLY, YEARLY), INTERVAL, COUNT or UNTIL, BYDAY, BYMONTHDAY, BYMONTH, BYSETPOS, WKST."
          error={fields.recurrence_rule}
        />
        <Field
          label="Time zone (optional)"
          value={draft.timeZone ?? ""}
          onChange={(e) => set("timeZone", e.target.value)}
          placeholder={zone}
          maxLength={64}
          spellCheck={false}
          hint="An IANA name such as America/Chicago. Leave empty to use your planning zone."
          error={fields.time_zone}
        />
        <label className="check-field">
          <input type="checkbox" checked={draft.busy} onChange={(e) => set("busy", e.target.checked)} />
          <span>
            Busy
            <span className="check-hint">Keeps this time out of your study plan.</span>
          </span>
        </label>
        {draft.allDay ? null : <p className="field-hint">Times are in {shownZone.replaceAll("_", " ")}.</p>}
      </form>
    </Dialog>
  );
}

/** "New 3 · Updated 1 · Removed 0 · Unchanged 5". */
export function reconciliationLabel(preview: Pick<IcsPreview, "reconciliation">): string {
  const { reconciliation: r } = preview;
  return `New ${r.new} · Updated ${r.updated} · Removed ${r.removed} · Unchanged ${r.unchanged}`;
}

interface PickedFile {
  key: string;
  file: File;
  text?: string;
  preview?: IcsPreview;
  error?: string;
  /** Confirms the zone of times the file gives without one. */
  zone: string;
  done?: boolean;
}

/** Reads a chosen file, refusing ones over the size limit. */
export async function readIcs(file: File): Promise<{ text?: string; error?: string }> {
  if (file.size > MAX_ICS_BYTES) {
    return { error: `This file is ${formatBytes(file.size)}. Import files up to ${formatBytes(MAX_ICS_BYTES)}; export a shorter date range.` };
  }
  try {
    return { text: await file.text() };
  } catch {
    return { error: "This file couldn't be read. Try exporting it again." };
  }
}

/**
 * Picks one or more .ics files, previews each (event counts, recurring series, a time zone to confirm
 * for floating times) and imports them all. The server keeps events from last month to a year ahead.
 */
export function ImportCalendarDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const preview = usePreviewCalendar();
  const importCalendar = useImportCalendar();
  const zone = usePlanZone();
  const toast = useToast();
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [working, setWorking] = useState(false);
  const busy = working || importCalendar.isPending;
  const patch = (key: string, changes: Partial<PickedFile>) => setFiles((list) => list.map((item) => (item.key === key ? { ...item, ...changes } : item)));

  const close = () => {
    if (busy) return;
    setFiles([]);
    importCalendar.reset();
    onClose();
  };

  const pick = async (chosen: File[]) => {
    const picked = chosen.map((file, index) => ({ key: `${Date.now()}-${index}-${file.name}`, file, zone }));
    setFiles(picked);
    setWorking(true);
    for (const item of picked) {
      const read = await readIcs(item.file);
      if (!read.text) {
        patch(item.key, { error: read.error });
        continue;
      }
      try {
        const result = await preview.mutateAsync({ ics: read.text, file_name: item.file.name });
        patch(item.key, { text: read.text, preview: result });
      } catch (error) {
        patch(item.key, { text: read.text, error: error instanceof Error ? error.message : "This file couldn't be previewed." });
      }
    }
    setWorking(false);
  };

  const pending = files.filter((item) => !item.done);
  const ready =
    pending.length > 0 && pending.every((item) => item.preview && !item.error && (!item.preview.time_zone_confirmation_required || item.zone.trim()));

  const importAll = async () => {
    setWorking(true);
    let imported = 0;
    for (const item of pending) {
      if (!item.text || !item.preview) continue;
      try {
        const source = await importCalendar.mutateAsync({
          ics: item.text,
          file_name: item.file.name,
          time_zone: item.preview.time_zone_confirmation_required ? item.zone.trim() : null,
        });
        patch(item.key, { done: true });
        imported += source.event_count;
      } catch (error) {
        // The files before this one stay imported; fix this one and try again.
        patch(item.key, { error: error instanceof Error ? error.message : "This file couldn't be imported." });
        setWorking(false);
        return;
      }
    }
    setWorking(false);
    toast(`Imported ${plural(imported, "event")} from ${plural(pending.length, "file")}.`);
    setFiles([]);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Import calendars"
      footer={
        <>
          <button type="button" className="button ghost" onClick={close}>
            Cancel
          </button>
          <button type="button" className="button primary" disabled={!ready || busy} onClick={() => void importAll()}>
            {busy ? <Spinner size={16} /> : null}
            {busy ? "Working…" : "Import calendars"}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="muted">
          Preview one or more .ics files before importing, exported from Google Calendar, Outlook, Apple Calendar or your school's registration
          site. Recurrence, exclusions, moved occurrences and all-day dates are kept. Events from last month to a year ahead are added; busy
          ones take time out of your plan.
        </p>
        <Field
          label="Calendar files (.ics)"
          type="file"
          accept=".ics,text/calendar"
          multiple
          disabled={busy}
          onChange={(event) => void pick([...(event.target.files ?? [])])}
          data-autofocus
        />
        {files.length > 0 ? (
          <ul className="ics-preview-list">
            {files.map((item) => (
              <li key={item.key}>
                <p className="source-name">{item.file.name}</p>
                {item.error ? <Alert>{item.error}</Alert> : null}
                {!item.preview && !item.error ? <p className="muted">Previewing…</p> : null}
                {item.preview ? (
                  <>
                    <p className="muted">
                      {item.preview.calendar_name ? `${item.preview.calendar_name} · ` : ""}
                      {plural(item.preview.event_count, "event")} · {plural(item.preview.recurring_series_count, "recurring series", "recurring series")}
                      {item.done ? " · imported" : ""}
                    </p>
                    <p className="muted">{reconciliationLabel(item.preview)}</p>
                    {item.preview.truncated ? <Alert tone="warning">Only the first 2,000 events are imported.</Alert> : null}
                    {item.preview.time_zone_confirmation_required ? (
                      <Field
                        label="Confirm time zone"
                        value={item.zone}
                        onChange={(event) => patch(item.key, { zone: event.target.value })}
                        hint="Some times in this file have no time zone. Which zone are they in?"
                        spellCheck={false}
                        maxLength={64}
                      />
                    ) : null}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Dialog>
  );
}
