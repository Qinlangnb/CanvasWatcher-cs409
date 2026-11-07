import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { isApiError } from "../api";
import { plural } from "../format";
import { CanvasLink } from "../demo";
import { BookIcon, ClipboardIcon, FolderIcon, PlusIcon } from "../icons";
import { CourseCard, FileTable, GroupedTasks } from "../lists";
import { useArchiveCourse, useCourse, useCourses, useFiles, useTasks } from "../queries";
import { useNow } from "../shell";
import { useTaskEditor } from "../tasks";
import { useToast } from "../toast";
import { Alert, EmptyState, LoadMoreButton, PageHeader, QueryError, SkeletonList, Spinner, usePages } from "../ui";
import { ChangeFeed, MarkAllReadButton } from "./changes";

export function CoursesPage() {
  const active = useCourses();
  const [showArchived, setShowArchived] = useState(false);
  const archived = useCourses(true, showArchived);

  return (
    <div className="page">
      <PageHeader title="Courses" description="Courses you are enrolled in this term. Archive a course to hide it everywhere." />
      {active.isPending ? <SkeletonList rows={3} label="Loading courses" /> : null}
      {active.isError ? <Alert>{active.error.message}</Alert> : null}
      {active.data?.length === 0 ? (
        <EmptyState icon={<BookIcon size={28} />} title="No active courses">
          Courses appear after a sync. If you archived them all, show the archived courses below.
        </EmptyState>
      ) : null}
      {active.data && active.data.length > 0 ? (
        <ul className="course-grid">
          {active.data.map((course) => (
            <CourseCard key={course.id} course={course} />
          ))}
        </ul>
      ) : null}

      <section className="archived-section" aria-labelledby="archived-heading">
        <div className="section-header">
          <h2 id="archived-heading">Archived</h2>
          <button type="button" className="button ghost small" aria-expanded={showArchived} onClick={() => setShowArchived((value) => !value)}>
            {showArchived ? "Hide archived courses" : "Show archived courses"}
          </button>
        </div>
        {showArchived ? (
          <>
            {archived.isPending ? <SkeletonList rows={2} label="Loading archived courses" /> : null}
            {archived.isError ? <Alert>{archived.error.message}</Alert> : null}
            {archived.data?.length === 0 ? <p className="muted">You have not archived any courses.</p> : null}
            {archived.data && archived.data.length > 0 ? (
              <ul className="course-grid archived">
                {archived.data.map((course) => (
                  <CourseCard key={course.id} course={course} />
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </section>
    </div>
  );
}

const TABS = [
  { id: "tasks", label: "Tasks" },
  { id: "changes", label: "Changes" },
  { id: "files", label: "Files" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** WAI-ARIA tabs: arrow keys, Home and End move between tabs; the panel follows the selection. */
function Tabs({
  idBase,
  current,
  counts,
  onSelect,
}: {
  idBase: string;
  current: TabId;
  counts: Partial<Record<TabId, number>>;
  onSelect: (tab: TabId) => void;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((tab) => tab.id === current);
    const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = TABS[(target + TABS.length) % TABS.length]!;
    onSelect(next.id);
    refs.current[next.id]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label="Course sections" onKeyDown={keyDown}>
      {TABS.map((tab) => (
        <button
          key={tab.id}
          ref={(element) => {
            refs.current[tab.id] = element;
          }}
          type="button"
          role="tab"
          id={`${idBase}-tab-${tab.id}`}
          aria-selected={tab.id === current}
          aria-controls={`${idBase}-panel`}
          tabIndex={tab.id === current ? 0 : -1}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
          {counts[tab.id] ? <span className="count">{counts[tab.id]}</span> : null}
        </button>
      ))}
    </div>
  );
}

function CourseTasks({ courseId, archived }: { courseId: number; archived: boolean }) {
  const now = useNow();
  const tasks = useTasks({ courseId, status: "all" });
  const editor = useTaskEditor();
  const add = archived ? null : (
    <button type="button" className="button small secondary" onClick={() => editor.create({ courseId })}>
      <PlusIcon size={16} />
      Add a task
    </button>
  );
  if (tasks.isPending) return <SkeletonList rows={4} label="Loading tasks" />;
  if (tasks.isError) return <QueryError title="Tasks didn't load" error={tasks.error} retry={() => void tasks.refetch()} />;
  if (tasks.data.length === 0) {
    return (
      <EmptyState icon={<ClipboardIcon size={28} />} title="No tasks" action={add}>
        This course has no assignments in Canvas yet. Add your own to plan study time for it.
      </EmptyState>
    );
  }
  return (
    <>
      {add ? <div className="panel-toolbar">{add}</div> : null}
      <GroupedTasks tasks={tasks.data} now={now} />
    </>
  );
}

function CourseFiles({ courseId }: { courseId: number }) {
  const [pages, more] = usePages(String(courseId));
  const files = useFiles({ courseId, pages });
  if (files.isPending) return <SkeletonList rows={4} label="Loading files" />;
  if (files.isError) return <Alert>{files.error.message}</Alert>;
  const { items, hasMore } = files.data;
  if (items.length === 0) {
    return (
      <EmptyState icon={<FolderIcon size={28} />} title="No files">
        Files appear here when the course shares them in Canvas.
      </EmptyState>
    );
  }
  return (
    <>
      <FileTable files={items} showCourse={false} />
      {hasMore ? (
        <LoadMoreButton loading={files.isPlaceholderData} onClick={more}>
          Load more files
        </LoadMoreButton>
      ) : null}
    </>
  );
}

export function CourseDetailPage() {
  const params = useParams();
  const id = Number(params.courseId);
  const course = useCourse(Number.isInteger(id) && id > 0 ? id : 0);
  const [search, setSearch] = useSearchParams();
  const archive = useArchiveCourse();
  const toast = useToast();
  const idBase = useId();
  const tab: TabId = TABS.find((item) => item.id === search.get("tab"))?.id ?? "tasks";

  if (!(id > 0) || isApiError(course.error, 404)) {
    return (
      <div className="page">
        <PageHeader title="Course not found" />
        <EmptyState icon={<BookIcon size={28} />} title="This course is not in your list" action={<Link to="/courses">Back to courses</Link>}>
          It may have been removed after you disconnected Canvas or switched accounts.
        </EmptyState>
      </div>
    );
  }
  if (course.isPending) return <SkeletonList rows={4} label="Loading course" />;
  if (course.isError) return <Alert>{course.error.message}</Alert>;
  const data = course.data;

  const toggleArchive = () =>
    archive.mutate(
      { id: data.id, archived: !data.archived },
      {
        onSuccess: (updated) =>
          toast(updated.archived ? `${updated.code} archived. Its tasks and changes are hidden.` : `${updated.code} restored.`),
        onError: (error) => toast(error.message, "error"),
      },
    );

  return (
    <div className="page">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to="/courses">Courses</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{data.code}</span>
      </nav>
      <PageHeader
        eyebrow={[data.code, data.term?.name].filter(Boolean).join(" · ")}
        title={data.name}
        description={`${plural(data.counts.open_tasks, "open task")} · ${plural(data.counts.files, "file")}`}
        actions={
          <>
            <CanvasLink href={data.html_url} className="button secondary" />
            <button type="button" className="button ghost" onClick={toggleArchive} disabled={archive.isPending}>
              {archive.isPending ? <Spinner size={16} /> : null}
              {data.archived ? "Restore course" : "Archive course"}
            </button>
          </>
        }
      />
      {data.archived ? (
        <Alert tone="info" title="This course is archived">
          Its tasks and changes are hidden from Today, the calendar and Changes. Restore it to see them there again.
        </Alert>
      ) : null}

      <Tabs
        idBase={idBase}
        current={tab}
        counts={{ tasks: data.counts.open_tasks, changes: data.counts.unread_changes }}
        onSelect={(next) => setSearch(next === "tasks" ? {} : { tab: next }, { replace: true })}
      />
      <section className="card tab-panel" role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-tab-${tab}`} tabIndex={0}>
        {tab === "tasks" ? <CourseTasks courseId={data.id} archived={data.archived} /> : null}
        {tab === "changes" ? (
          <>
            <div className="panel-toolbar">
              <MarkAllReadButton courseId={data.id} unreadCount={data.counts.unread_changes} />
            </div>
            <ChangeFeed courseId={data.id} />
          </>
        ) : null}
        {tab === "files" ? <CourseFiles courseId={data.id} /> : null}
      </section>
    </div>
  );
}
