import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { apiHref } from "./api";
import {
  TASK_TYPE_LABELS,
  dayOffset,
  dueHint,
  fieldLabel,
  formatBytes,
  formatDateTime,
  formatDue,
  formatFieldValue,
  formatLongDate,
  formatMinutes,
  formatShortDate,
  plural,
  timeAgo,
} from "./format";
import { CanvasLink, UnavailableButton } from "./preview";
import { ChevronRightIcon, ClipboardIcon, DownloadIcon, FileIcon, MegaphoneIcon } from "./icons";
import { useChange, useIsPreview, useMarkRead, usePlanZone } from "./queries";
import { TaskCard } from "./taskCard";
import { TaskCheck, useTaskEditor } from "./tasks";
import type { Change, ChangeDetail, ChangeKind, ContentValue, Course, CourseFile, Task } from "./types";
import { Badge, Dialog, QueryError, SkeletonList } from "./ui";
import { FileMenu } from "./fileTypes";
import { formatTaskDue } from "./taskExtras";
import { FILE_TYPE_LABELS } from "./taskHelpers";
import { useIsWorking } from "./workTimer";

// --- Courses ---

export function CourseCard({ course }: { course: Course }) {
  const { open_tasks, unread_changes, files } = course.counts;
  return (
    <li className="course-card">
      <Link to={`/courses/${course.id}`} className="course-card-link">
        <span className="course-code">{course.display_code || course.code}</span>
        <span className="course-name">{course.name}</span>
        {course.term ? <span className="course-term">{course.term.display_name || course.term.name}</span> : null}
        <span className="course-section">{course.section ?? "Section not specified"}</span>
      </Link>
      <dl className="course-stats">
        <div>
          <dt>Open tasks</dt>
          <dd>{open_tasks}</dd>
        </div>
        <div className={unread_changes ? "highlight" : undefined}>
          <dt>New changes</dt>
          <dd>{unread_changes}</dd>
        </div>
        <div>
          <dt>Files</dt>
          <dd>{files}</dd>
        </div>
      </dl>
    </li>
  );
}

// --- Tasks ---

/** A badge for finished work: what Canvas says, or the student's own checkmark. */
function doneLabel(task: Task): string {
  if (task.submission_state === "graded") return "Graded";
  if (task.completed_at) return "Done";
  return "Submitted";
}

export function TaskRow({
  task,
  now,
  showCourse = true,
  extra,
  showHint = true,
  anchorId,
  details,
}: {
  task: Task;
  now: Date;
  showCourse?: boolean;
  extra?: ReactNode;
  /** False when `extra` already says how urgent the task is. */
  showHint?: boolean;
  anchorId?: string;
  /** With details, the title opens the task in place instead of the editor. */
  details?: { open: boolean; onToggle: () => void; content: ReactNode };
}) {
  const zone = usePlanZone();
  const editor = useTaskEditor();
  const open = task.state === "open" || task.state === "overdue";
  const hint = open && showHint ? dueHint(task.due_at, now, zone) : null;
  const working = useIsWorking(task.id);
  const panelId = `task-details-${task.id}${anchorId ? "-plan" : ""}`;
  return (
    <li id={anchorId} className={`task-row state-${task.state}${details?.open ? " expanded" : ""}`}>
      <span className={`task-marker type-${task.type}`} aria-hidden="true" />
      <TaskCheck task={task} />
      <div className="task-main">
        <p className="task-title">
          {details ? (
            <button
              type="button"
              className="task-open"
              onClick={details.onToggle}
              aria-expanded={details.open}
              aria-controls={details.open ? panelId : undefined}
            >
              {task.title}
              <ChevronRightIcon size={16} className="task-open-chevron" aria-hidden="true" />
            </button>
          ) : (
            <button type="button" className="task-open" onClick={() => editor.open(task)}>
              {task.title}
            </button>
          )}
        </p>
        <p className="task-meta">
          {showCourse ? <span className="course-chip">{task.course.code}</span> : null}
          <span>{TASK_TYPE_LABELS[task.type] ?? task.type}</span>
          {task.source === "personal" ? <span>Your task</span> : null}
          {task.points_possible !== null ? <span>{plural(task.points_possible, "pt")}</span> : null}
          {open && task.progress > 0 ? <span>{task.progress}% done</span> : null}
          {open ? <span>{formatMinutes(task.remaining_minutes)} left</span> : null}
          {working ? <Badge tone="accent">Working on</Badge> : null}
        </p>
        {extra}
      </div>
      <div className="task-due">
        <time dateTime={task.due_at ?? undefined}>{formatTaskDue(task, now, zone)}</time>
        {task.state === "done" ? <Badge tone="success">{doneLabel(task)}</Badge> : null}
        {task.state === "ignored" ? <Badge>Ignored</Badge> : null}
        {hint ? <Badge tone={hint.tone}>{hint.label}</Badge> : null}
      </div>
      {details?.open ? (
        <div className="task-row-details" id={panelId}>
          {details.content}
        </div>
      ) : null}
    </li>
  );
}

/** A task row whose title opens its details (TaskCard) in place, like Today's "Due next week". */
export function ExpandableTaskRow(props: Omit<Parameters<typeof TaskRow>[0], "details"> & { actions?: ReactNode }) {
  const { actions, ...row } = props;
  const zone = usePlanZone();
  const [open, setOpen] = useState(false);
  return (
    <TaskRow
      {...row}
      details={{
        open,
        onToggle: () => setOpen((current) => !current),
        content: <TaskCard task={row.task} now={row.now} zone={zone} actions={actions} />,
      }}
    />
  );
}

export function TaskList({
  tasks,
  now,
  showCourse = true,
  expandable = false,
  actions,
}: {
  tasks: Task[];
  now: Date;
  showCourse?: boolean;
  /** Titles open the task in place instead of the editor. */
  expandable?: boolean;
  /** Quick buttons under each row, such as Ignore. */
  actions?: (task: Task) => ReactNode;
}) {
  const extra = (task: Task) => (actions ? <p className="task-quick">{actions(task)}</p> : undefined);
  return (
    <ul className="task-list">
      {tasks.map((task) =>
        expandable ? (
          <ExpandableTaskRow key={task.id} task={task} now={now} showCourse={showCourse} extra={extra(task)} />
        ) : (
          <TaskRow key={task.id} task={task} now={now} showCourse={showCourse} extra={extra(task)} />
        ),
      )}
    </ul>
  );
}

/** Tasks of one course in the order a student works through them. */
export function GroupedTasks({ tasks, now, actions }: { tasks: Task[]; now: Date; actions?: (task: Task) => ReactNode }) {
  const overdue = tasks.filter((task) => task.state === "overdue");
  const upcoming = tasks.filter((task) => task.state === "open" && task.due_at);
  const undated = tasks.filter((task) => task.state === "open" && !task.due_at);
  const done = tasks.filter((task) => task.state === "done" || task.state === "ignored");
  const section = (title: string, list: Task[], tone?: string) =>
    list.length > 0 ? (
      <section className={`task-group${tone ? ` ${tone}` : ""}`} aria-label={title}>
        <h3>
          {title} <span className="count">{list.length}</span>
        </h3>
        <TaskList tasks={list} now={now} showCourse={false} actions={actions} />
      </section>
    ) : null;
  return (
    <div className="task-groups">
      {section("Overdue", overdue, "danger")}
      {section("Upcoming", upcoming)}
      {section("No due date", undated)}
      {done.length > 0 ? (
        <details className="task-group done">
          <summary>
            <h3>
              Done <span className="count">{done.length}</span>
            </h3>
          </summary>
          <TaskList tasks={done} now={now} showCourse={false} />
        </details>
      ) : null}
    </div>
  );
}

// --- Changes ---

const KIND_ICONS: Record<ChangeKind, typeof FileIcon> = {
  assignment: ClipboardIcon,
  file: FileIcon,
  announcement: MegaphoneIcon,
};


function dayHeading(iso: string, now: Date): string {
  const offset = dayOffset(new Date(iso), now);
  if (offset === 0) return "Today";
  if (offset === -1) return "Yesterday";
  return formatLongDate(new Date(iso));
}

export function ChangeList({
  changes,
  now,
  onOpen,
  showCourse = true,
}: {
  changes: Change[];
  now: Date;
  onOpen: (id: number) => void;
  showCourse?: boolean;
}) {
  const groups: { heading: string; items: Change[] }[] = [];
  for (const change of changes) {
    const heading = dayHeading(change.detected_at, now);
    const group = groups.at(-1);
    if (group?.heading === heading) group.items.push(change);
    else groups.push({ heading, items: [change] });
  }
  return (
    <div className="change-groups">
      {groups.map((group) => (
        <section key={group.heading} aria-label={group.heading}>
          <h3 className="day-heading">{group.heading}</h3>
          <ul className="change-list">
            {group.items.map((change) => {
              const KindIcon = KIND_ICONS[change.kind];
              return (
                <li key={change.id} className={`change-row category-${change.category}${change.read ? "" : " unread"}`}>
                  <span className={`change-icon kind-${change.kind} type-${change.change_type}`} aria-hidden="true">
                    <KindIcon size={18} />
                  </span>
                  <button type="button" className="change-open" onClick={() => onOpen(change.id)}>
                    <span className="change-summary">
                      {change.read ? null : <span className="visually-hidden">Unread: </span>}
                      {change.ai_summary ?? change.summary}
                    </span>
                    <span className="change-meta">
                      <span className={`category-badge category-${change.category}`}>{change.event_label}</span>
                      {showCourse ? <span className="course-chip">{change.course.code}</span> : null}
                      <time dateTime={change.detected_at}>{timeAgo(change.detected_at, now)}</time>
                    </span>
                  </button>
                  <ReadToggle change={change} />
                  {change.read ? null : <span className="unread-dot" aria-hidden="true" />}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Inline "Mark read" / "Mark unread" on every change row. */
function ReadToggle({ change }: { change: Change }) {
  const markRead = useMarkRead();
  return (
    <button
      type="button"
      className="button small ghost change-read-toggle"
      disabled={markRead.isPending}
      onClick={() => markRead.mutate({ id: change.id, read: !change.read })}
    >
      {change.read ? "Mark unread" : "Mark read"}
      <span className="visually-hidden">: {change.summary}</span>
    </button>
  );
}

const SEVERITY_TONES = { low: "neutral", medium: "accent", high: "warning", critical: "danger" } as const;

/** Before and after as text, with the raw values and the app's own bookkeeping folded away. */
function ChangeSnapshots({ detail }: { detail: ChangeDetail }) {
  return (
    <>
      {detail.before_text || detail.after_text ? (
        <div className="snapshot-grid">
          {detail.before_text ? (
            <section aria-label="Before">
              <h3>Before</h3>
              <pre className="snapshot-text">{detail.before_text}</pre>
            </section>
          ) : null}
          {detail.after_text ? (
            <section aria-label="After">
              <h3>After</h3>
              <pre className="snapshot-text">{detail.after_text}</pre>
            </section>
          ) : null}
        </div>
      ) : null}
      <details className="raw-metadata">
        <summary>Raw metadata</summary>
        <pre>{JSON.stringify({ before: detail.before, after: detail.after }, null, 2)}</pre>
      </details>
      <details className="raw-metadata">
        <summary>Internal metadata</summary>
        <pre>{JSON.stringify({ ...detail.internals, review: detail.review }, null, 2)}</pre>
      </details>
    </>
  );
}

function LongValue({ field, value }: { field: string; value: ContentValue | undefined }) {
  const text = formatFieldValue(field, value);
  return text.length > 160 ? <div className="long-value">{text}</div> : <>{text}</>;
}

/** Details of one change. Opening it marks it as read. */
export function ChangeDialog({ id, onClose }: { id: number | null; onClose: () => void }) {
  const change = useChange(id);
  const markRead = useMarkRead();
  const detail = change.data;

  useEffect(() => {
    if (detail && !detail.read && !markRead.isPending) markRead.mutate({ id: detail.id, read: true });
    // Only when a newly loaded change is unread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id]);

  let body: ReactNode = <SkeletonList rows={2} label="Loading change" />;
  if (change.isError) body = <QueryError error={change.error} retry={() => change.refetch()} />;
  if (detail) {
    const fields =
      detail.change_type === "updated" ? detail.fields : Object.keys((detail.change_type === "removed" ? detail.before : detail.after) ?? {});
    body = (
      <div className="stack">
        <p className="change-detail-meta">
          <Badge tone={detail.change_type === "removed" ? "danger" : detail.change_type === "created" ? "success" : "accent"}>
            {detail.change_type === "created" ? "New" : detail.change_type === "removed" ? "Removed" : "Updated"}
          </Badge>
          <span className={`category-badge category-${detail.category}`}>{detail.event_label}</span>
          <Link to={`/courses/${detail.course.id}`} onClick={onClose}>
            {detail.course.code}
          </Link>
          <span>Detected {formatDateTime(detail.detected_at)}</span>
        </p>
        <p className="change-detail-summary">{detail.summary}</p>
        {detail.review?.status === "ready" ? (
          <div className="change-review">
            {detail.review.severity ? <Badge tone={SEVERITY_TONES[detail.review.severity]}>{detail.review.severity}</Badge> : null}
            <span>
              AI review: {detail.review.notify_user ? "worth your attention." : "no action needed."} {detail.review.reason}
            </span>
          </div>
        ) : null}
        {fields.length > 0 ? (
          <table className="diff-table">
            <caption className="visually-hidden">What changed</caption>
            <thead>
              <tr>
                <th scope="col">Field</th>
                {detail.change_type === "updated" ? <th scope="col">Before</th> : null}
                <th scope="col">{detail.change_type === "updated" ? "After" : "Value"}</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((field) => (
                <tr key={field}>
                  <th scope="row">{fieldLabel(field)}</th>
                  {detail.change_type === "updated" ? (
                    <td className="before">
                      <LongValue field={field} value={detail.before?.[field]} />
                    </td>
                  ) : null}
                  <td className={detail.change_type === "updated" ? "after" : undefined}>
                    <LongValue field={field} value={(detail.change_type === "removed" ? detail.before : detail.after)?.[field]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <ChangeSnapshots detail={detail} />
        {detail.related_task ? (
          <div className="related-task">
            <h3>Assignment</h3>
            <TaskList tasks={[detail.related_task]} now={new Date()} showCourse={false} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Dialog
      open={id !== null}
      onClose={onClose}
      title={detail?.title ?? "Change"}
      footer={
        detail ? (
          <>
            <button
              type="button"
              className="button ghost"
              disabled={markRead.isPending}
              onClick={() => {
                markRead.mutate({ id: detail.id, read: false });
                onClose();
              }}
            >
              Mark as unread
            </button>
            {detail.html_url ? <CanvasLink href={detail.html_url} className="button primary" /> : null}
          </>
        ) : null
      }
    >
      {body}
    </Dialog>
  );
}

// --- Files ---

/** Downloads come from Canvas each time, which a preview can't reach, so there the button is greyed out. */
function DownloadButton({ file }: { file: CourseFile }) {
  const preview = useIsPreview();
  const label = (
    <>
      <DownloadIcon size={16} />
      Download
      <span className="visually-hidden"> {file.name}</span>
    </>
  );
  if (preview) return <UnavailableButton className="button small secondary">{label}</UnavailableButton>;
  return (
    <a className="button small secondary" href={apiHref(file.download_url)} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

export function FileTable({ files, showCourse = true }: { files: CourseFile[]; showCourse?: boolean }) {
  return (
    <table className="file-table">
      <caption className="visually-hidden">Course files</caption>
      <thead>
        <tr>
          <th scope="col">Name</th>
          {showCourse ? <th scope="col">Course</th> : null}
          <th scope="col">Size</th>
          <th scope="col">Updated</th>
          <th scope="col">
            <span className="visually-hidden">Download</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {files.map((file) => (
          <tr key={file.id}>
            <th scope="row" className="file-name">
              <FileIcon size={18} />
              <span>
                {file.name}
                <span className="file-type">
                  {FILE_TYPE_LABELS[file.type] ?? "Other"}
                  {/* Course-website files are kept here; one that came back as a sign-in page can't be downloaded. */}
                  {file.source === "website" ? " · Website" : ""}
                  {file.integrity_status === "INVALID_DOWNLOAD" ? " · not a valid download" : ""}
                </span>
              </span>
            </th>
            {showCourse ? (
              <td data-label="Course">
                <span className="course-chip">{file.course.code}</span>
              </td>
            ) : null}
            <td data-label="Size">{formatBytes(file.size_bytes)}</td>
            <td data-label="Updated">
              {file.updated_at ? (
                <time dateTime={file.updated_at} title={formatDateTime(file.updated_at)}>
                  {formatShortDate(file.updated_at)}
                </time>
              ) : (
                "—"
              )}
            </td>
            <td className="file-action">
              <DownloadButton file={file} />
              <FileMenu file={file} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
