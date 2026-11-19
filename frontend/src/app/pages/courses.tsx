import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { isApiError } from "../api";
import { plural } from "../format";
import { CanvasLink } from "../preview";
import { BookIcon, ClipboardIcon, FolderIcon, PlusIcon } from "../icons";
import { CourseCard, FileTable } from "../lists";
import { useCourse, useCourses, useFiles, usePlanZone, useTasks } from "../queries";
import { useNow } from "../shell";
import { CourseSyllabus } from "../syllabus";
import { useTaskEditor } from "../tasks";
import { Alert, EmptyState, LoadMoreButton, PageHeader, QueryError, SkeletonList, usePages } from "../ui";
import { ChangeFeed, MarkAllReadButton } from "./changes";
import { CourseLifecycleButton, TermFilter, useTermParam } from "../courseTerms";
import { CourseTaskScopes, CourseTimeline } from "../courseViews";
import { FileTypeTabs, useFileTypeParam } from "../fileTypes";
import { useTermCourses } from "../parityQueries";

export function CoursesPage() {
  const term = useTermParam();
  const active = useTermCourses(term.termId);
  const [showArchived, setShowArchived] = useState(false);
  const archived = useCourses(true, showArchived);
  const filtered = term.termId !== null && term.termId !== "all";

  return (
    <div className="page">
      <PageHeader
        title="Courses"
        description="Courses you are enrolled in. Courses from terms that already ended are archived when first synced; archive or restore any course from its page."
      />
      <TermFilter termId={term.termId} terms={term.terms} onChange={term.setTerm} />
      {active.isPending ? <SkeletonList rows={3} label="Loading courses" /> : null}
      {active.isError ? <QueryError error={active.error} retry={() => active.refetch()} /> : null}
      {active.data?.length === 0 ? (
        <EmptyState icon={<BookIcon size={28} />} title={filtered ? "No active courses match this term" : "No active courses"}>
          {filtered ? "Choose another term, or show the archived courses below." : "Courses appear after a sync. If you archived them all, show the archived courses below."}
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
            {archived.isError ? <QueryError error={archived.error} retry={() => archived.refetch()} /> : null}
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
  { id: "timeline", label: "Timeline" },
  { id: "changes", label: "Changes" },
  { id: "files", label: "Files" },
  { id: "syllabus", label: "Syllabus" },
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
  if (tasks.data.length > 0) return <CourseTaskScopes courseId={courseId} archived={archived} now={now} />;
  return (
    <EmptyState icon={<ClipboardIcon size={28} />} title="No tasks" action={add}>
      This course has no assignments in Canvas yet. Add your own to plan study time for it.
    </EmptyState>
  );
}

function CourseFiles({ courseId }: { courseId: number }) {
  const [type, setType] = useFileTypeParam();
  const [pages, more] = usePages(`${courseId}|${type ?? ""}`);
  const files = useFiles({ courseId, type, pages });
  const tabs = <FileTypeTabs value={type} onChange={setType} />;
  if (files.isPending) {
    return (
      <>
        {tabs}
        <SkeletonList rows={4} label="Loading files" />
      </>
    );
  }
  if (files.isError) return <QueryError error={files.error} retry={() => files.refetch()} />;
  const { items, hasMore } = files.data;
  if (items.length === 0) {
    return (
      <>
        {tabs}
        <EmptyState icon={<FolderIcon size={28} />} title="No files">
          {type ? "No files of this type. Move a file here from its ⋯ menu." : "Files appear here when the course shares them in Canvas."}
        </EmptyState>
      </>
    );
  }
  return (
    <>
      {tabs}
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
  const zone = usePlanZone();
  const now = useNow();
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
  if (course.isError) return <QueryError error={course.error} retry={() => course.refetch()} />;
  const data = course.data;

  return (
    <div className="page">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to="/courses">Courses</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{data.display_code || data.code}</span>
      </nav>
      <PageHeader
        eyebrow={[data.display_code || data.code, data.section, data.term?.display_name ?? data.term?.name, data.archived ? "Archived" : "Active"]
          .filter(Boolean)
          .join(" · ")}
        title={data.name}
        description={`${plural(data.counts.open_tasks, "open task")} · ${plural(data.counts.files, "file")}`}
        actions={
          <>
            <CanvasLink href={data.html_url} className="button secondary" />
            <CourseLifecycleButton course={data} />
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
        {tab === "timeline" ? <CourseTimeline course={data} now={now} zone={zone} /> : null}
        {tab === "changes" ? (
          <>
            <div className="panel-toolbar">
              <MarkAllReadButton courseId={data.id} unreadCount={data.counts.unread_changes} />
            </div>
            <ChangeFeed courseId={data.id} />
          </>
        ) : null}
        {tab === "files" ? <CourseFiles courseId={data.id} /> : null}
        {tab === "syllabus" ? <CourseSyllabus courseId={data.id} /> : null}
      </section>
    </div>
  );
}
