// Task pieces from the original app: progress saved with a revision check, Reopen, quick Ignore,
// completion notes, assignment downloads, date-only deadlines, and a card that opens its source.
import { useEffect, useId, useRef, useState, type PointerEvent, type MouseEvent } from "react";
import { isApiError } from "./api";
import { formatDue } from "./format";
import { isSubmitted } from "./forms";
import { DownloadIcon } from "./icons";
import { fileDownloadLink, useSaveProgress } from "./parityQueries";
import { useUpdateTask } from "./queries";
import { CONTROL_SELECTOR, DATE_ONLY_NOTE, DRAG_THRESHOLD_PX, taskTarget, withoutTime } from "./taskHelpers";
import { useToast } from "./toast";
import type { Task, TaskAttachment } from "./types";
import { Spinner } from "./ui";
import { forgetProgress, rememberProgress, useIsWorking } from "./workTimer";

export const CONFLICT_MESSAGE = "Task changed elsewhere; refreshed the saved state.";

/** "Fri, Nov 7, 11:59 PM", or "Fri, Nov 7 · Time not specified by source" for a date-only deadline. */
export function formatTaskDue(task: Pick<Task, "due_at" | "deadline_precision">, now: Date, zone: string): string {
  const label = formatDue(task.due_at, now, zone);
  return task.deadline_precision === "date_only" ? `${withoutTime(label)} · ${DATE_ONLY_NOTE}` : label;
}

/** Progress in 1% steps, saved with the task's revision when let go; 100 completes the task. */
export function RevisionProgress({ task }: { task: Task }) {
  const save = useSaveProgress();
  const toast = useToast();
  const working = useIsWorking(task.id);
  const id = useId();
  const [value, setValue] = useState(task.progress);
  const actionAt = useRef(new Date().toISOString());
  useEffect(() => setValue(task.progress), [task.progress, task.state_revision]);
  const commit = () => {
    if (value === task.progress) return;
    save.mutate(
      { task, progress: value, actionAt: actionAt.current },
      {
        onSuccess: (result) => {
          forgetProgress(task.id);
          if (!result.applied) {
            setValue(result.task.progress);
            toast(CONFLICT_MESSAGE, "info");
          } else if (value === 100) toast(`Done: ${task.title}`, "success");
        },
        onError: (error) => {
          // While the timer runs, its heartbeat keeps trying to save this.
          if (working && isApiError(error, 0)) rememberProgress(task.id, value);
          toast(value === 100 ? "Completion not saved; please retry." : error.message, "error");
        },
      },
    );
  };
  return (
    <div className="field range-field task-card-progress" data-task-control>
      <label htmlFor={id}>
        Progress <output htmlFor={id}>{value}%</output>
        {save.isPending ? <Spinner size={14} /> : null}
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        onChange={(event) => {
          actionAt.current = new Date().toISOString();
          setValue(Number(event.target.value));
        }}
        onPointerUp={commit}
        onKeyUp={(event) => {
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) commit();
        }}
        onBlur={commit}
      />
    </div>
  );
}

/** Reopens work completed here (Canvas submissions stay as Canvas says). */
export function ReopenButton({ task }: { task: Task }) {
  const save = useSaveProgress();
  const toast = useToast();
  if (!task.completed_at || isSubmitted(task)) return null;
  return (
    <button
      type="button"
      className="button small ghost"
      disabled={save.isPending}
      onClick={() =>
        save.mutate(
          { task, progress: 99, reopen: true, actionAt: new Date().toISOString() },
          {
            onSuccess: (result) => toast(result.applied ? `Reopened: ${task.title}` : CONFLICT_MESSAGE, result.applied ? "success" : "info"),
            onError: (error) => toast(error.message, "error"),
          },
        )
      }
    >
      Reopen<span className="visually-hidden"> {task.title}</span>
    </button>
  );
}

/** Ignore or Undo ignore in one click. */
export function IgnoreButton({ task }: { task: Task }) {
  const update = useUpdateTask();
  const toast = useToast();
  const ignored = task.state === "ignored";
  if (!ignored && task.state !== "open" && task.state !== "overdue") return null;
  return (
    <button
      type="button"
      className="button small ghost"
      disabled={update.isPending}
      onClick={() =>
        update.mutate(
          { id: task.id, changes: { ignored: !ignored } },
          {
            onSuccess: () => toast(ignored ? `Back on your list: ${task.title}` : `Ignored: ${task.title}`, "success"),
            onError: (error) => toast(error.message, "error"),
          },
        )
      }
    >
      {ignored ? "Undo ignore" : "Ignore"}
      <span className="visually-hidden"> {task.title}</span>
    </button>
  );
}

/** How finished work was finished; local completion never hands anything in. */
export function CompletionNote({ task }: { task: Task }) {
  if (task.state !== "done") return null;
  const upstream = isSubmitted(task);
  const status =
    task.submission_state === "graded" ? "Graded" : upstream ? "Submission confirmed" : task.source === "canvas" ? "Submission not confirmed" : null;
  return (
    <p className="completion-note">
      <strong>{upstream ? "Completed upstream" : "Local work complete"}</strong>
      {status ? <span className={`submission-status${upstream ? " confirmed" : ""}`}>{status}</span> : null}
      {upstream ? null : <span className="muted">Local completion does not submit to any provider.</span>}
    </p>
  );
}

/** "Download assignment" for the files the description links to; a select picks one of several. */
export function AssignmentDownload({ files }: { files: TaskAttachment[] }) {
  const toast = useToast();
  const [selected, setSelected] = useState(files[0]?.file_id ?? 0);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  const chosen = files.find((file) => file.file_id === selected) ?? files[0];
  if (!chosen) return null;
  const download = async () => {
    setBusy(true);
    try {
      const link = await fileDownloadLink(chosen.file_id);
      if (!mounted.current) return;
      const anchor = document.createElement("a");
      anchor.href = link.url;
      anchor.rel = "noreferrer";
      anchor.download = chosen.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      toast(`Download started: ${chosen.filename}`, "success");
    } catch (error) {
      if (!mounted.current) return;
      toast(
        isApiError(error, 404) ? "Assignment file is no longer available. Sync and try again." : (error as Error).message || "Assignment download failed. Please try again.",
        "error",
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="assignment-files" data-task-control>
      {files.length > 1 ? (
        <select aria-label="Assignment file" value={chosen.file_id} disabled={busy} onChange={(event) => setSelected(Number(event.target.value))}>
          {files.map((file) => (
            <option key={file.file_id} value={file.file_id}>
              {file.filename}
            </option>
          ))}
        </select>
      ) : null}
      <button type="button" className="button small secondary" disabled={busy} aria-busy={busy} title={chosen.filename} onClick={() => void download()}>
        {busy ? <Spinner size={14} /> : <DownloadIcon size={14} />}
        {busy ? "Downloading…" : "Download assignment"}
      </button>
    </div>
  );
}

/**
 * Click handlers that open the task's source in a new tab from anywhere on its card, except on
 * controls, after a drag of more than 6px, or when text was selected.
 */
export function useCardOpen(task: Pick<Task, "source_url">) {
  const gesture = useRef({ x: 0, y: 0, blocked: true });
  const target = taskTarget(task);
  if (!target) return { target: null, handlers: {} };
  const isControl = (element: EventTarget | null) => element instanceof Element && element.closest(CONTROL_SELECTOR) !== null;
  return {
    target,
    handlers: {
      onPointerDownCapture: (event: PointerEvent<HTMLElement>) => {
        gesture.current = { x: event.clientX, y: event.clientY, blocked: event.button !== 0 || isControl(event.target) };
      },
      onPointerMoveCapture: (event: PointerEvent<HTMLElement>) => {
        if (event.buttons && Math.hypot(event.clientX - gesture.current.x, event.clientY - gesture.current.y) > DRAG_THRESHOLD_PX) {
          gesture.current.blocked = true;
        }
      },
      onPointerCancel: () => {
        gesture.current.blocked = true;
      },
      onClick: (event: MouseEvent<HTMLElement>) => {
        if (gesture.current.blocked || isControl(event.target) || window.getSelection()?.toString()) return;
        window.open(target, "_blank", "noopener,noreferrer");
      },
    },
  };
}
