// Views ported from the original app: the swimlane timeline (Calendar and a course's Timeline tab)
// and a course's tasks by scope, Active / Completed / Ignored, with one-click Ignore and Reopen.
import { useMemo, useRef, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router";
import { ClipboardIcon, PlusIcon } from "./icons";
import { ExpandableTaskRow, GroupedTasks } from "./lists";
import { useCourses, useTasks } from "./queries";
import { SwimlaneTimeline } from "./swimlane";
import { IgnoreButton, ReopenButton } from "./taskExtras";
import { useTaskEditor } from "./tasks";
import type { Course, Task } from "./types";
import { EmptyState, QueryError, SkeletonList } from "./ui";

const DAY_MS = 86_400_000;

/** Due dates from a week back onward: the timeline's window starts 7 days before today. */
function useTimelineTasks(courseId?: number) {
  const dueAfter = useMemo(() => new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS - 8 * DAY_MS).toISOString(), []);
  return useTasks({ courseId, status: "all", dueAfter });
}

const visible = (task: Task) => task.state !== "removed" && task.due_at !== null;
const laneOf = (course: Pick<Course, "id" | "code"> & Partial<Pick<Course, "display_code">>) => ({
  id: course.id,
  label: course.display_code || course.code,
});

export function CalendarSwimlane({ now, zone }: { now: Date; zone: string }) {
  const tasks = useTimelineTasks();
  const courses = useCourses();
  if (tasks.isPending || courses.isPending) return <SkeletonList rows={4} label="Loading the timeline" />;
  if (tasks.isError) return <QueryError title="Your tasks didn't load" error={tasks.error} retry={() => void tasks.refetch()} />;
  if (courses.isError) return <QueryError title="Your courses didn't load" error={courses.error} retry={() => void courses.refetch()} />;
  const dated = tasks.data.filter(visible);
  if (dated.length === 0) {
    return (
      <EmptyState icon={<ClipboardIcon size={28} />} title="Nothing on the timeline">
        Tasks with due dates from the past week onward appear here, one lane per course.
      </EmptyState>
    );
  }
  return (
    <div className="swimlane-wrap">
      <p className="muted">Drag to scroll. Select a dot to open the assignment, or a course code to open the course.</p>
      <SwimlaneTimeline tasks={dated} lanes={courses.data.map(laneOf)} now={now} zone={zone} />
    </div>
  );
}

export function CourseTimeline({ course, now, zone }: { course: Course; now: Date; zone: string }) {
  const tasks = useTimelineTasks(course.id);
  if (tasks.isPending) return <SkeletonList rows={3} label="Loading the timeline" />;
  if (tasks.isError) return <QueryError title="Tasks didn't load" error={tasks.error} retry={() => void tasks.refetch()} />;
  const dated = tasks.data.filter(visible);
  if (dated.length === 0) return <p className="muted">No due dates from the past week onward.</p>;
  return (
    <div className="swimlane-wrap compact">
      <SwimlaneTimeline tasks={dated} lanes={[laneOf(course)]} now={now} zone={zone} />
    </div>
  );
}

const SCOPES = [
  { id: "active", label: "Active" },
  { id: "completed", label: "Completed" },
  { id: "ignored", label: "Ignored" },
] as const;
type Scope = (typeof SCOPES)[number]["id"];

const inScope = (task: Task, scope: Scope) =>
  scope === "active" ? task.state === "open" || task.state === "overdue" : scope === "completed" ? task.state === "done" : task.state === "ignored";

/** A course's tasks by scope (?scope= in the URL), each row with its quick action. */
export function CourseTaskScopes({ courseId, archived, now }: { courseId: number; archived: boolean; now: Date }) {
  const tasks = useTasks({ courseId, status: "all" });
  const editor = useTaskEditor();
  const [search, setSearch] = useSearchParams();
  const scope: Scope = SCOPES.find((item) => item.id === search.get("scope"))?.id ?? "active";
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const choose = (next: Scope) => {
    const params = new URLSearchParams(search);
    if (next === "active") params.delete("scope");
    else params.set("scope", next);
    setSearch(params, { replace: true });
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = SCOPES.findIndex((item) => item.id === scope);
    const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: SCOPES.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = SCOPES[(target + SCOPES.length) % SCOPES.length]!;
    choose(next.id);
    refs.current[next.id]?.focus();
  };
  const add = archived ? null : (
    <button type="button" className="button small secondary" onClick={() => editor.create({ courseId })}>
      <PlusIcon size={16} />
      Add a task
    </button>
  );
  if (tasks.isPending) return <SkeletonList rows={4} label="Loading tasks" />;
  if (tasks.isError) return <QueryError title="Tasks didn't load" error={tasks.error} retry={() => void tasks.refetch()} />;
  const listed = tasks.data.filter((task) => inScope(task, scope));
  const counts = Object.fromEntries(SCOPES.map((item) => [item.id, tasks.data.filter((task) => inScope(task, item.id)).length]));

  return (
    <>
      <div className="panel-toolbar task-scope-bar">
        <div className="tabs task-scope-tabs" role="tablist" aria-label="Which tasks" onKeyDown={keyDown}>
          {SCOPES.map((item) => (
            <button
              key={item.id}
              ref={(element) => {
                refs.current[item.id] = element;
              }}
              type="button"
              role="tab"
              aria-selected={item.id === scope}
              tabIndex={item.id === scope ? 0 : -1}
              onClick={() => choose(item.id)}
            >
              {item.label}
              {counts[item.id] ? <span className="count">{counts[item.id]}</span> : null}
            </button>
          ))}
        </div>
        {add}
      </div>
      {listed.length === 0 ? (
        <EmptyState icon={<ClipboardIcon size={28} />} title={scope === "active" ? "No open tasks" : scope === "completed" ? "Nothing completed yet" : "No ignored tasks"}>
          {scope === "active" ? "Everything here is done or ignored. Add your own task to plan study time for this course." : "Tasks move here as you work through the course."}
        </EmptyState>
      ) : scope === "active" ? (
        <GroupedTasks tasks={listed} now={now} actions={(task) => <IgnoreButton task={task} />} />
      ) : (
        <ul className="task-list">
          {listed.map((task) => (
            <ExpandableTaskRow
              key={task.id}
              task={task}
              now={now}
              showCourse={false}
              extra={<p className="task-quick">{scope === "ignored" ? <IgnoreButton task={task} /> : <ReopenButton task={task} />}</p>}
            />
          ))}
        </ul>
      )}
    </>
  );
}
