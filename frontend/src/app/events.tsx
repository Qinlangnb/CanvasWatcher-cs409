// Calendar dialogs: add or edit an event by hand, look at an imported one, import an .ics file.
import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { formatBytes, plural } from "./format";
import { MAX_ICS_BYTES, eventBody, eventDraft, problemsOf, type EventDraft } from "./forms";
import { useCreateEvent, useDeleteEvent, useImportCalendar, usePlanZone, useUpdateEvent } from "./queries";
import { useToast } from "./toast";
import type { CalendarEvent } from "./types";
import { Alert, Dialog, Field, Spinner } from "./ui";
import { dateLabel, eventTimeLabel, localDate } from "./zoned";

function ImportedEvent({ event, zone, onClose, open }: { event: CalendarEvent; zone: string; onClose: () => void; open: boolean }) {
  const date = event.all_day ? event.start : localDate(event.start, zone);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={event.title}
      size="small"
      footer={
        <button type="button" className="button primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <dl className="detail-list">
        <div>
          <dt>When</dt>
          <dd>
            {dateLabel(date, localDate(new Date(), zone))} · {eventTimeLabel(event, date, zone)}
          </dd>
        </div>
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
        <div>
          <dt>From</dt>
          <dd>{event.source?.name ?? "An imported calendar"}</dd>
        </div>
      </dl>
      <p className="muted">
        Imported events follow their file. To change one, update the calendar it came from and import it again under{" "}
        <Link to="/settings#calendars" onClick={onClose}>
          Settings
        </Link>
        .
      </p>
    </Dialog>
  );
}

/** Add an event (no `event`), edit one added by hand, or look at an imported one. */
export function EventDialog({
  open,
  event,
  date,
  onClose,
}: {
  open: boolean;
  event?: CalendarEvent;
  /** The day a new event starts on. */
  date: string;
  onClose: () => void;
}) {
  const zone = usePlanZone();
  if (event && !event.editable) return <ImportedEvent event={event} zone={zone} open={open} onClose={onClose} />;
  return <EventForm open={open} event={event} date={date} zone={zone} onClose={onClose} />;
}

function EventForm({ open, event, date, zone, onClose }: { open: boolean; event?: CalendarEvent; date: string; zone: string; onClose: () => void }) {
  const create = useCreateEvent();
  const update = useUpdateEvent();
  const remove = useDeleteEvent();
  const toast = useToast();
  const formId = useId();
  const [initial] = useState(() => eventDraft(event, date, zone, new Date()));
  const [draft, setDraft] = useState(initial);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const saving = create.isPending || update.isPending;
  const server = problemsOf(event ? update.error : create.error);
  const fields = { ...server.fields, ...local };
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
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
    if (saving || remove.isPending) return;
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

  const footer = deleting ? (
    <>
      <p className="footer-question">Delete this event?</p>
      <button type="button" className="button ghost" onClick={() => setDeleting(false)} disabled={remove.isPending}>
        Keep it
      </button>
      <button
        type="button"
        className="button danger"
        disabled={remove.isPending}
        onClick={() =>
          event &&
          remove.mutate(event.id, {
            onSuccess: () => {
              toast(`Deleted: ${event.title}`);
              onClose();
            },
            onError: (error) => toast(error.message, "error"),
          })
        }
      >
        {remove.isPending ? <Spinner size={16} /> : null}
        Delete event
      </button>
    </>
  ) : (
    <>
      {event ? (
        <button type="button" className="button danger-ghost footer-start" onClick={() => setDeleting(true)}>
          Delete
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

  return (
    <Dialog open={open} onClose={requestClose} title={event ? "Edit event" : "New event"} footer={footer}>
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
        <label className="check-field">
          <input type="checkbox" checked={draft.busy} onChange={(e) => set("busy", e.target.checked)} />
          <span>
            Busy
            <span className="check-hint">Keeps this time out of your study plan.</span>
          </span>
        </label>
        {zone ? <p className="field-hint">Times are in {zone.replaceAll("_", " ")}.</p> : null}
      </form>
    </Dialog>
  );
}

/** Reads an .ics file in the browser and sends its text; the server keeps the events from last month to a year ahead. */
export function ImportCalendarDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const importCalendar = useImportCalendar();
  const toast = useToast();
  const formId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [reading, setReading] = useState(false);
  const server = problemsOf(importCalendar.error);
  const fields = { ...server.fields, ...local };
  const busy = reading || importCalendar.isPending;

  const close = () => {
    if (busy) return;
    setFile(null);
    setName("");
    setLocal({});
    importCalendar.reset();
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) {
      setLocal({ ics: "Choose an .ics file." });
      return;
    }
    if (file.size > MAX_ICS_BYTES) {
      setLocal({ ics: `This file is ${formatBytes(file.size)}. Import files up to ${formatBytes(MAX_ICS_BYTES)}; export a shorter date range.` });
      return;
    }
    setLocal({});
    setReading(true);
    let text: string;
    try {
      text = await file.text();
    } catch {
      setLocal({ ics: "This file couldn't be read. Try exporting it again." });
      return;
    } finally {
      setReading(false);
    }
    importCalendar.mutate(
      { name: name.trim() || undefined, file_name: file.name, ics: text },
      {
        onSuccess: (source) => {
          toast(
            `Imported ${plural(source.event_count, "event")} into “${source.name}”.${source.truncated ? " Only the first 2,000 were kept." : ""}`,
          );
          close();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Import a calendar"
      footer={
        <>
          <button type="button" className="button ghost" onClick={close}>
            Cancel
          </button>
          <button type="submit" form={formId} className="button primary" disabled={busy}>
            {busy ? <Spinner size={16} /> : null}
            Import
          </button>
        </>
      }
    >
      <form id={formId} className="stack" onSubmit={(event) => void submit(event)} noValidate>
        <p className="muted">
          Export your class schedule or personal calendar as an .ics file from Google Calendar, Outlook, Apple Calendar or your school's
          registration site. Events from last month to a year ahead are added; busy ones take time out of your plan.
        </p>
        {server.general ? <Alert>{server.general}</Alert> : null}
        <Field
          label="Calendar file (.ics)"
          type="file"
          accept=".ics,text/calendar"
          onChange={(event) => {
            const chosen = event.target.files?.[0] ?? null;
            setFile(chosen);
            setLocal({});
          }}
          error={fields.ics}
          data-autofocus
        />
        <Field
          label="Name (optional)"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={100}
          placeholder={file ? file.name.replace(/\.ics$/i, "") : "For example: Fall classes"}
          hint="Defaults to the name inside the file, or the file name."
          error={fields.name}
        />
      </form>
    </Dialog>
  );
}
