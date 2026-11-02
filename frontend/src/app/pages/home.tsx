import { useState } from "react";
import { Link } from "react-router";
import { formatLongDate, plural } from "../format";
import { BellIcon, BookIcon, ClipboardIcon } from "../icons";
import { ChangeDialog, ChangeList, CourseCard, TaskList } from "../lists";
import { useChanges, useConnection, useCourses, useMe, useTasks } from "../queries";
import { useNow } from "../shell";
import type { Task } from "../types";
import { Alert, EmptyState, PageHeader, SkeletonList } from "../ui";

const WEEK = 7 * 24 * 60 * 60_000;
const HOME_TASKS = 8;
const HOME_CHANGES = 5;

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Overdue work and anything due in the next seven days. */
export function dueSoon(tasks: Task[], now: Date): Task[] {
  return tasks.filter((task) => task.state === "overdue" || (task.due_at !== null && new Date(task.due_at).getTime() - now.getTime() < WEEK));
}

function SectionHeader({ id, title, link }: { id: string; title: string; link?: { to: string; label: string } }) {
  return (
    <div className="section-header">
      <h2 id={id}>{title}</h2>
      {link ? <Link to={link.to}>{link.label}</Link> : null}
    </div>
  );
}

export function HomePage() {
  const me = useMe();
  const now = useNow();
  const connection = useConnection();
  const tasks = useTasks({ status: "open" });
  const changes = useChanges({ unread: true, pages: 1 });
  const courses = useCourses();
  const [openChange, setOpenChange] = useState<number | null>(null);

  const soon = tasks.data ? dueSoon(tasks.data, now) : [];
  const overdue = soon.filter((task) => task.state === "overdue").length;
  const unread = changes.data?.items ?? [];
  const firstSync = connection.data?.syncing && !connection.data.last_synced_at;

  return (
    <div className="page">
      <PageHeader
        eyebrow={formatLongDate(now)}
        title={`${greeting(now)}, ${me.data?.username ?? ""}`}
        documentTitle="Home"
        description={
          tasks.data && changes.data
            ? `${plural(soon.length - overdue, "task")} due this week${overdue ? `, ${overdue} overdue` : ""} · ${plural(
                unread.length,
                "new change",
              )}${changes.data.hasMore ? "+" : ""}`
            : undefined
        }
      />
      {firstSync ? (
        <Alert tone="info" title="Your first sync is still running">
          Courses and tasks will appear here as soon as it finishes.
        </Alert>
      ) : null}

      <div className="home-grid">
        <section className="card" aria-labelledby="due-soon">
          <SectionHeader id="due-soon" title="Due soon" />
          {tasks.isPending ? <SkeletonList rows={3} label="Loading tasks" /> : null}
          {tasks.isError ? <Alert>{tasks.error.message}</Alert> : null}
          {tasks.data && soon.length === 0 ? (
            <EmptyState icon={<ClipboardIcon size={28} />} title="Nothing due this week">
              Enjoy the breathing room. New assignments show up here after each sync.
            </EmptyState>
          ) : null}
          {soon.length > 0 ? <TaskList tasks={soon.slice(0, HOME_TASKS)} now={now} /> : null}
          {soon.length > HOME_TASKS ? (
            <p className="more-note">And {plural(soon.length - HOME_TASKS, "more task")}. Open a course to see all of its work.</p>
          ) : null}
        </section>

        <section className="card" aria-labelledby="new-changes">
          <SectionHeader id="new-changes" title="New changes" link={{ to: "/changes", label: "See all changes" }} />
          {changes.isPending ? <SkeletonList rows={3} label="Loading changes" /> : null}
          {changes.isError ? <Alert>{changes.error.message}</Alert> : null}
          {changes.data && unread.length === 0 ? (
            <EmptyState icon={<BellIcon size={28} />} title="You're up to date">
              When something changes in Canvas, it appears here.
            </EmptyState>
          ) : null}
          {unread.length > 0 ? <ChangeList changes={unread.slice(0, HOME_CHANGES)} now={now} onOpen={setOpenChange} /> : null}
        </section>
      </div>

      <section aria-labelledby="your-courses">
        <SectionHeader id="your-courses" title="Your courses" link={{ to: "/courses", label: "Manage courses" }} />
        {courses.isPending ? <SkeletonList rows={2} label="Loading courses" /> : null}
        {courses.isError ? <Alert>{courses.error.message}</Alert> : null}
        {courses.data?.length === 0 && !firstSync ? (
          <EmptyState icon={<BookIcon size={28} />} title="No active courses">
            CanvasWatcher shows courses you are enrolled in this term. Archived courses are under Courses.
          </EmptyState>
        ) : null}
        {courses.data && courses.data.length > 0 ? (
          <ul className="course-grid">
            {courses.data.map((course) => (
              <CourseCard key={course.id} course={course} />
            ))}
          </ul>
        ) : null}
      </section>

      <ChangeDialog id={openChange} onClose={() => setOpenChange(null)} />
    </div>
  );
}
