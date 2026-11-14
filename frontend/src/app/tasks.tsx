// Working on tasks: the done checkbox, the task dialog (progress, estimate, notes, status) and the
// "New task" form. One editor lives in the app shell, so any task row can open it and its toasts
// outlive the row that started them.
import { createContext, useContext, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { TASK_TYPE_LABELS, formatDue, formatMinutes, plural } from "./format";
import { CanvasLink } from "./preview";
import { TASK_TYPES, defaultMinutes, isSubmitted, parseEstimate, problemsOf, remainingOf, taskChanges, taskDraft, type TaskDraft, type TaskStatus } from "./forms";
import { browserTimeZone, useCourses, useCreateTask, useDeleteTask, usePlanZone, useUpdateTask } from "./queries";
import { useToast } from "./toast";
import type { Task, TaskType } from "./types";
import { Alert, Badge, Dialog, Field, SelectField, Spinner, TextAreaField } from "./ui";
import { fromLocalInput } from "./zoned";

// --- Editor context ---

interface Editor {
  open: (task: Task) => void;
  create: (defaults?: { courseId?: number }) => void;
  /** Resolves once the lists show the new state. */
  setDone: (task: Task, done: boolean) => Promise<void>;
}

const EditorContext = createContext<Editor>({
  open: () => {},
  create: () => {},
  setDone: async () => {},
});

export const useTaskEditor = () => useContext(EditorContext);

type EditorState = { open: boolean; key: number } & ({ kind: "edit"; task: Task } | { kind: "new"; courseId?: number });

export function TaskEditorProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<EditorState | null>(null);
  const counter = useRef(0);
  const update = useUpdateTask();
  const toast = useToast();

  const editor = useMemo<Editor>(() => {
    const setDone = async (task: Task, done: boolean) => {
      try {
        await update.mutateAsync({ id: task.id, changes: { done } });
      } catch (error) {
        toast((error as Error).message, "error");
        return;
      }
      toast(done ? `Done: ${task.title}` : `Back on your list: ${task.title}`, "success", {
        label: "Undo",
        onClick: () => {
          update.mutateAsync({ id: task.id, changes: { done: !done } }).catch((error: Error) => toast(error.message, "error"));
        },
      });
    };
    return {
      // Each opening gets a fresh form (a new key); closing keeps it mounted so <dialog> can restore focus.
      open: (task) => setState({ kind: "edit", task, open: true, key: ++counter.current }),
      create: (defaults) => setState({ kind: "new", courseId: defaults?.courseId, open: true, key: ++counter.current }),
      setDone,
    };
    // `mutateAsync` and `toast` are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => setState((current) => (current ? { ...current, open: false } : current));

  return (
    <EditorContext.Provider value={editor}>
      {children}
      {state?.kind === "edit" ? <TaskDialog key={state.key} open={state.open} task={state.task} onClose={close} /> : null}
      {state?.kind === "new" ? <NewTaskDialog key={state.key} open={state.open} courseId={state.courseId} onClose={close} /> : null}
    </EditorContext.Provider>
  );
}

// --- Checkbox ---

export function TaskCheck({ task }: { task: Task }) {
  const editor = useTaskEditor();
  // Shows the new state at once; the server's answer replaces it when the lists refresh.
  const [pending, setPending] = useState<boolean | null>(null);
  const submitted = isSubmitted(task);
  const checked = pending ?? task.state === "done";
  return (
    <label className="task-check" title={submitted ? "Handed in on Canvas" : undefined}>
      <input
        type="checkbox"
        checked={checked}
        disabled={submitted || pending !== null}
        onChange={(event) => {
          const done = event.target.checked;
          setPending(done);
          void editor.setDone(task, done).finally(() => setPending(null));
        }}
      />
      <span className="visually-hidden">{submitted ? `${task.title}: handed in on Canvas` : `Done: ${task.title}`}</span>
    </label>
  );
}

// --- Shared form pieces ---

function StatusChoice({ value, onChange }: { value: TaskStatus; onChange: (status: TaskStatus) => void }) {
  const name = useId();
  const options: { value: TaskStatus; label: string }[] = [
    { value: "open", label: "To do" },
    { value: "done", label: "Done" },
    { value: "ignored", label: "Ignored" },
  ];
  return (
    <fieldset className="choice-group">
      <legend>Status</legend>
      <div className="choice-options">
        {options.map((option) => (
          <label key={option.value} className="choice">
            <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {value === "ignored" ? <p className="field-hint">Ignored tasks leave your plan and counts but stay in the course.</p> : null}
    </fieldset>
  );
}

function ProgressField({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const id = useId();
  return (
    <div className="field range-field">
      <label htmlFor={id}>
        Progress <output htmlFor={id}>{value}%</output>
      </label>
      <input id={id} type="range" min={0} max={100} step={5} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </div>
  );
}

function TypeOptions() {
  return (
    <>
      {TASK_TYPES.map((type) => (
        <option key={type} value={type}>
          {TASK_TYPE_LABELS[type]}
        </option>
      ))}
    </>
  );
}

function zoneHint(zone: string): string | undefined {
  return zone !== browserTimeZone() ? `In your planning time zone, ${zone.replaceAll("_", " ")}.` : undefined;
}

// --- Task dialog ---

function TaskDialog({ task, open, onClose }: { task: Task; open: boolean; onClose: () => void }) {
  const zone = usePlanZone();
  const update = useUpdateTask();
  const remove = useDeleteTask();
  const toast = useToast();
  const formId = useId();
  const [initial] = useState(() => taskDraft(task, zone));
  const [draft, setDraft] = useState(initial);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [discarding, setDiscarding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const personal = task.source === "personal";
  const submitted = isSubmitted(task);
  const set = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const pending = taskChanges(task, initial, draft, zone);
  const dirty = Object.keys(pending.changes).length > 0 || Object.keys(pending.errors).length > 0;
  const server = problemsOf(update.error);
  const fields = { ...server.fields, ...local };

  const estimate = parseEstimate(draft.estimate);
  const total = estimate.minutes ?? defaultMinutes(draft.type);
  const left = draft.status === "done" || submitted ? 0 : remainingOf(total, draft.progress);

  const requestClose = () => {
    if (update.isPending || remove.isPending) return;
    if (dirty && !discarding) setDiscarding(true);
    else onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = taskChanges(task, initial, draft, zone);
    setLocal(result.errors);
    if (Object.keys(result.errors).length > 0) return;
    if (Object.keys(result.changes).length === 0) {
      onClose();
      return;
    }
    update.mutate(
      { id: task.id, changes: result.changes },
      {
        onSuccess: () => {
          toast(`Saved: ${draft.title.trim() || task.title}`);
          onClose();
        },
      },
    );
  };

  const confirmDelete = () =>
    remove.mutate(task.id, {
      onSuccess: () => {
        toast(`Deleted: ${task.title}`);
        onClose();
      },
      onError: (error) => toast(error.message, "error"),
    });

  const footer = deleting ? (
    <>
      <p className="footer-question">Delete this task? This can't be undone.</p>
      <button type="button" className="button ghost" onClick={() => setDeleting(false)} disabled={remove.isPending}>
        Keep it
      </button>
      <button type="button" className="button danger" onClick={confirmDelete} disabled={remove.isPending}>
        {remove.isPending ? <Spinner size={16} /> : null}
        Delete task
      </button>
    </>
  ) : (
    <>
      {personal ? (
        <button type="button" className="button danger-ghost footer-start" onClick={() => setDeleting(true)}>
          Delete
        </button>
      ) : null}
      <button type="button" className="button ghost" onClick={requestClose}>
        Cancel
      </button>
      <button type="submit" form={formId} className="button primary" disabled={update.isPending}>
        {update.isPending ? <Spinner size={16} /> : null}
        Save
      </button>
    </>
  );

  return (
    <Dialog open={open} onClose={requestClose} title={personal ? "Edit task" : task.title} footer={footer}>
      <div className="stack">
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
        <p className="task-dialog-meta">
          <span className="course-chip">{task.course.code}</span>
          {personal ? <Badge>Your task</Badge> : <Badge tone="accent">From Canvas</Badge>}
          {personal ? null : <span>{TASK_TYPE_LABELS[task.type] ?? task.type}</span>}
          {personal ? null : <span>{formatDue(task.due_at, new Date(), zone)}</span>}
          {task.points_possible !== null ? <span>{plural(task.points_possible, "pt")}</span> : null}
          {task.html_url ? <CanvasLink href={task.html_url} iconSize={14} /> : null}
        </p>
        <form id={formId} className="stack" onSubmit={submit} noValidate>
          {server.general ? <Alert>{server.general}</Alert> : null}
          {personal ? (
            <>
              <Field label="Title" value={draft.title} onChange={(event) => set("title", event.target.value)} maxLength={200} error={fields.title} required />
              <div className="form-row">
                <SelectField label="Type" value={draft.type} onChange={(event) => set("type", event.target.value)} error={fields.type}>
                  <TypeOptions />
                </SelectField>
                <Field
                  label="Due"
                  type="datetime-local"
                  value={draft.due}
                  onChange={(event) => set("due", event.target.value)}
                  hint={zoneHint(zone)}
                  error={fields.due_at}
                />
              </div>
            </>
          ) : null}
          {submitted ? (
            <Alert tone="success" title="Handed in on Canvas">
              Canvas counts this as done, so it stays off your plan.
            </Alert>
          ) : (
            <StatusChoice value={draft.status} onChange={(status) => set("status", status)} />
          )}
          {submitted ? null : <ProgressField value={draft.progress} onChange={(value) => set("progress", value)} />}
          <Field
            label="Total time it takes, in minutes"
            inputMode="numeric"
            value={draft.estimate}
            onChange={(event) => set("estimate", event.target.value)}
            placeholder={String(defaultMinutes(draft.type))}
            hint={`From start to finish, including what you've done; progress takes off the done part. Leave empty to use ${formatMinutes(
              defaultMinutes(draft.type),
            )}, the usual time for ${(TASK_TYPE_LABELS[draft.type] ?? "this type").toLowerCase()}.`}
            error={fields.estimated_minutes}
          />
          <p className="muted" aria-live="polite">
            {left === 0 ? "Nothing left to do." : `About ${formatMinutes(left)} left of ${formatMinutes(total)}.`}
          </p>
          <TextAreaField label="Notes" value={draft.notes} onChange={(event) => set("notes", event.target.value)} maxLength={2000} error={fields.notes} />
        </form>
      </div>
    </Dialog>
  );
}

// --- New task ---

function NewTaskDialog({ open, courseId, onClose }: { open: boolean; courseId?: number; onClose: () => void }) {
  const zone = usePlanZone();
  const courses = useCourses();
  const create = useCreateTask();
  const toast = useToast();
  const formId = useId();
  const [course, setCourse] = useState(courseId ? String(courseId) : "");
  const [title, setTitle] = useState("");
  const [type, setType] = useState<TaskType>("homework");
  const [due, setDue] = useState("");
  const [estimate, setEstimate] = useState("");
  const [notes, setNotes] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const server = problemsOf(create.error);
  const fields = { ...server.fields, ...local };
  const list = courses.data ?? [];
  const chosen = course || (list.length === 1 ? String(list[0]?.id) : "");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problems: Record<string, string> = {};
    const parsed = parseEstimate(estimate);
    const dueAt = fromLocalInput(due, zone);
    if (!chosen) problems.course_id = "Choose a course.";
    if (!title.trim()) problems.title = "Give the task a title.";
    if (due && !dueAt) problems.due_at = "Enter a valid date and time.";
    if (parsed.error) problems.estimated_minutes = parsed.error;
    setLocal(problems);
    if (Object.keys(problems).length > 0) return;
    create.mutate(
      { course_id: Number(chosen), title: title.trim(), type, due_at: dueAt, estimated_minutes: parsed.minutes, notes: notes.trim() || null },
      {
        onSuccess: (task) => {
          toast(`Added: ${task.title}`);
          onClose();
        },
      },
    );
  };

  const dirty = Boolean(title.trim() || due || estimate || notes.trim());
  const [discarding, setDiscarding] = useState(false);
  const requestClose = () => {
    if (create.isPending) return;
    if (dirty && !discarding) setDiscarding(true);
    else onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      title="New task"
      footer={
        <>
          <button type="button" className="button ghost" onClick={requestClose}>
            Cancel
          </button>
          <button type="submit" form={formId} className="button primary" disabled={create.isPending || list.length === 0}>
            {create.isPending ? <Spinner size={16} /> : null}
            Add task
          </button>
        </>
      }
    >
      <form id={formId} className="stack" onSubmit={submit} noValidate>
        {discarding ? (
          <Alert
            tone="warning"
            title="Discard this task?"
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
        <p className="muted">For work Canvas doesn't list, like studying for a quiz or a reading. It joins your plan like any task.</p>
        {server.general ? <Alert>{server.general}</Alert> : null}
        {courses.data && list.length === 0 ? (
          <Alert tone="info" title="No active courses">
            Tasks belong to a course. Sync Canvas or restore an archived course first.
          </Alert>
        ) : null}
        <SelectField label="Course" value={chosen} onChange={(event) => setCourse(event.target.value)} error={fields.course_id} disabled={!courses.data}>
          <option value="" disabled>
            {courses.isPending ? "Loading courses…" : "Choose a course"}
          </option>
          {list.map((item) => (
            <option key={item.id} value={item.id}>
              {item.code} · {item.name}
            </option>
          ))}
        </SelectField>
        <Field label="Title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} error={fields.title} required data-autofocus />
        <div className="form-row">
          <SelectField label="Type" value={type} onChange={(event) => setType(event.target.value as TaskType)} error={fields.type}>
            <TypeOptions />
          </SelectField>
          <Field label="Due (optional)" type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} hint={zoneHint(zone)} error={fields.due_at} />
        </div>
        <Field
          label="Total time it takes, in minutes (optional)"
          inputMode="numeric"
          value={estimate}
          onChange={(event) => setEstimate(event.target.value)}
          placeholder={String(defaultMinutes(type))}
          hint={`Empty uses ${formatMinutes(defaultMinutes(type))}.`}
          error={fields.estimated_minutes}
        />
        <TextAreaField label="Notes (optional)" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} error={fields.notes} />
      </form>
    </Dialog>
  );
}
