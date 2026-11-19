// A task opened in place: when it's due, its score, how long is left and why, the time used so
// far, progress, and the assignment's description from Canvas. Used time and progress save here
// without opening the full editor.
import { useEffect, useId, useState, type ReactNode } from "react";
import { useReestimate, useTaskSummary } from "./aiApi";
import { TASK_TYPE_LABELS, formatDateTime, formatMinutes, plural } from "./format";
import { isSubmitted, parseSpent } from "./forms";
import { CheckIcon } from "./icons";
import { CanvasLink } from "./preview";
import { useAiStatus, useIsPreview, useTaskDetail, useUpdateTask } from "./queries";
import { useTaskEditor } from "./tasks";
import { useToast } from "./toast";
import type { Task } from "./types";
import { Badge, Spinner } from "./ui";
import { AssignmentDownload, CompletionNote, ReopenButton, RevisionProgress, formatTaskDue, useCardOpen } from "./taskExtras";
import { WorkControl, useRunningMinutes } from "./workTimer";
import { PROVIDER_LABELS, hasProviderFacts, sourceFactsTitle, submissionLabel } from "./sources/model";
import { useSources, useTaskProviderFacts } from "./sources/queries";

function basisLabel(task: Task): string {
  if (task.remaining_basis === "pace") return "at your pace so far";
  if (task.remaining_basis === "estimate") return "your estimate";
  if (task.remaining_basis === "ai") return "AI estimate";
  return `usual for ${(TASK_TYPE_LABELS[task.type] ?? "this type").toLowerCase()}`;
}

function scoreText(task: Task): string | null {
  if (task.excused) return "Excused";
  if (task.score === null) return null;
  const points = task.points_possible !== null ? ` / ${task.points_possible}` : "";
  const grade = task.grade && task.grade !== String(task.score) ? ` (${task.grade})` : "";
  return `${task.score}${points}${grade}`;
}

function submissionText(task: Task): string | null {
  if (task.source !== "canvas") return null;
  if (task.submission_state === "graded") return "Graded";
  if (task.submission_state === "submitted" || task.submission_state === "pending_review") return "Submitted";
  return "Not submitted";
}

/**
 * Minutes used so far: timer sessions plus a manual correction. Typing a total and saving it changes
 * only the correction; session history stays as recorded.
 */
function UsedTime({ task }: { task: Task }) {
  const update = useUpdateTask();
  const toast = useToast();
  const id = useId();
  const used = task.spent_minutes + useRunningMinutes(task.id);
  const [value, setValue] = useState(String(used));
  useEffect(() => setValue(String(used)), [used]);
  const parsed = parseSpent(value);
  const dirty = !parsed.error && parsed.minutes !== used;
  const save = () => {
    if (!dirty) return;
    update.mutate(
      { id: task.id, changes: { spent_minutes: parsed.minutes } },
      {
        onSuccess: () => toast("Used time corrected without rewriting session history.", "success"),
        onError: (error) => toast(error.message, "error"),
      },
    );
  };
  return (
    <div className="task-card-used">
      <label htmlFor={id} className="visually-hidden">
        Minutes used on {task.title}
      </label>
      <input
        id={id}
        className="task-card-minutes"
        type="number"
        inputMode="numeric"
        min={0}
        step={5}
        value={value}
        aria-invalid={parsed.error ? true : undefined}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            save();
          }
        }}
      />
      <span className="task-card-unit">min</span>
      <button
        type="button"
        className="button small primary task-card-save"
        disabled={!dirty || update.isPending}
        onClick={save}
        aria-label="Save time used"
        title="Save time used"
      >
        {update.isPending ? <Spinner size={14} /> : <CheckIcon size={16} />}
      </button>
      {parsed.error ? <span className="field-error">{parsed.error}</span> : null}
    </div>
  );
}

/** The AI's short summary of the Canvas description; nothing at all when no AI is available. */
function AiSummary({ task }: { task: Task }) {
  const ai = useAiStatus();
  const summary = useTaskSummary(task.id, task.source === "canvas" && Boolean(ai.data?.enabled));
  const data = summary.data;
  if (!data || data.status === "unavailable") return null;
  return (
    <div className="task-card-summary" aria-live="polite">
      <span className="task-card-summary-label">AI summary</span>
      {data.status === "ready" ? <p>{data.summary}</p> : null}
      {data.status === "pending" ? (
        <p className="muted">
          <Spinner size={14} /> Summarizing the description…
        </p>
      ) : null}
      {data.status === "failed" ? <p className="muted">No summary this time. Read the description below.</p> : null}
    </div>
  );
}

/** Asks for a fresh AI estimate of a Canvas task; shown while the AI's estimate sets the time left. */
function Reestimate({ task }: { task: Task }) {
  const reestimate = useReestimate();
  const toast = useToast();
  const preview = useIsPreview();
  const ai = useAiStatus();
  if (task.source !== "canvas" || task.remaining_basis !== "ai" || preview || !ai.data?.enabled) return null;
  return (
    <button
      type="button"
      className="button small ghost"
      disabled={reestimate.isPending}
      onClick={() =>
        reestimate.mutate(task.id, {
          onSuccess: () => toast("Asking AI for a new estimate…", "success"),
          onError: (error) => toast(error.message, "error"),
        })
      }
    >
      Re-estimate
    </button>
  );
}

/** What Canvas and Gradescope each say about the task, once a Gradescope assignment is bound to it. */
function SourceFacts({ task }: { task: Task }) {
  const sources = useSources();
  const watched = Boolean(sources.data?.some((source) => source.source_type === "gradescope"));
  const facts = useTaskProviderFacts(task.id, watched && (task.source === "canvas" || task.source === "gradescope"));
  if (!facts.data || !hasProviderFacts(facts.data)) return null;
  return (
    <details className="provider-facts">
      <summary>{sourceFactsTitle(facts.data)}</summary>
      <ul>
        {facts.data.provider_facts.map((row) => (
          <li key={`${row.provider}-${row.source_item_id}`}>
            <strong>{PROVIDER_LABELS[row.provider] ?? row.provider}</strong>
            <Badge tone={row.submission_state === "graded" || row.submission_state === "submitted" ? "success" : "neutral"}>
              {submissionLabel(row.submission_state)}
            </Badge>
            <span>Due: {row.due_at ? formatDateTime(row.due_at) : "unknown"}</span>
            {row.late_due_at ? <span>Late cutoff: {formatDateTime(row.late_due_at)}</span> : null}
            {row.score !== null && row.score !== undefined ? (
              <span>
                Score: {row.score}
                {row.max_score !== null && row.max_score !== undefined ? ` / ${row.max_score}` : ""}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function TaskCard({ task, now, zone, actions }: { task: Task; now: Date; zone: string; actions?: ReactNode }) {
  const editor = useTaskEditor();
  const detail = useTaskDetail(task.id, task.source === "canvas");
  const submitted = isSubmitted(task);
  const done = task.state === "done";
  const score = scoreText(task);
  const submission = submissionText(task);
  const description = detail.data?.description;
  const attachments = detail.data?.attachments ?? [];
  const card = useCardOpen(task);
  return (
    <div className={`task-card${card.target ? " has-task-target" : ""}`} {...card.handlers}>
      <WorkControl task={task} />
      <CompletionNote task={task} />
      <dl className="task-card-facts">
        <div>
          <dt>Due</dt>
          <dd>{formatTaskDue(task, now, zone)}</dd>
        </div>
        {task.points_possible !== null || submission ? (
          <div>
            <dt>{score ? "Score" : "Points"}</dt>
            <dd>
              {score ?? (task.points_possible !== null ? plural(task.points_possible, "pt") : "—")}
              {submission ? <Badge tone={submitted ? "success" : "neutral"}>{submission}</Badge> : null}
            </dd>
          </div>
        ) : null}
        {done ? null : (
          <div>
            <dt>Time left</dt>
            <dd>
              {formatMinutes(task.remaining_minutes)} <span className="muted">· {basisLabel(task)}</span>
            </dd>
          </div>
        )}
        <div>
          <dt>Time used</dt>
          <dd>
            <UsedTime task={task} />
          </dd>
        </div>
      </dl>
      {submitted || done ? null : <RevisionProgress task={task} />}
      <AiSummary task={task} />
      <SourceFacts task={task} />
      {task.source === "canvas" ? (
        <details className="task-card-description">
          <summary>Assignment description</summary>
          {detail.isPending ? <Spinner size={16} label="Loading the description" /> : null}
          {detail.data ? <p className="pre-wrap">{description ?? "Canvas has no description for this assignment."}</p> : null}
        </details>
      ) : null}
      {task.notes ? <p className="task-card-notes pre-wrap">{task.notes}</p> : null}
      <div className="task-card-actions">
        {actions}
        {attachments.length > 0 ? <AssignmentDownload files={attachments} /> : null}
        <ReopenButton task={task} />
        <Reestimate task={task} />
        <button type="button" className="button small ghost" onClick={() => editor.open(task)}>
          Edit
        </button>
        {task.html_url ? <CanvasLink href={task.html_url} className="button small ghost" iconSize={14} /> : null}
      </div>
    </div>
  );
}
