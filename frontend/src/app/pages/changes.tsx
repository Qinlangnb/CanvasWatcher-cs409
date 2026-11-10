import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { plural } from "../format";
import { BellIcon, CheckIcon } from "../icons";
import { ChangeDialog, ChangeList } from "../lists";
import { useChanges, useCourses, useMarkAllRead, useUnreadCount } from "../queries";
import { useNow } from "../shell";
import { useToast } from "../toast";
import { EmptyState, PageHeader, QueryError, SkeletonList, Spinner } from "../ui";

/** Changes newest first, loaded a page at a time, with the detail dialog. */
export function ChangeFeed({ courseId, unread = false }: { courseId?: number; unread?: boolean }) {
  const now = useNow();
  const [pages, setPages] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const changes = useChanges({ courseId, unread, pages });

  useEffect(() => setPages(1), [courseId, unread]);

  if (changes.isPending) return <SkeletonList rows={4} label="Loading changes" />;
  if (changes.isError) return <QueryError error={changes.error} retry={() => changes.refetch()} />;
  const { items, hasMore } = changes.data;
  const loadingMore = changes.isPlaceholderData;

  return (
    <>
      {items.length === 0 ? (
        <EmptyState icon={<BellIcon size={28} />} title={unread ? "No unread changes" : "No changes yet"}>
          {unread
            ? "You have seen everything. Switch to All to look back."
            : "CanvasWatcher records a change when a due date, file or announcement differs from the last sync."}
        </EmptyState>
      ) : (
        <ChangeList changes={items} now={now} onOpen={setOpen} showCourse={courseId === undefined} />
      )}
      {hasMore ? (
        <div className="load-more">
          <button type="button" className="button secondary" onClick={() => setPages((count) => count + 1)} disabled={loadingMore}>
            {loadingMore ? <Spinner size={16} /> : null}
            {loadingMore ? "Loading…" : "Load older changes"}
          </button>
        </div>
      ) : null}
      <ChangeDialog id={open} onClose={() => setOpen(null)} />
    </>
  );
}

/** "Mark all as read", for every course or one. */
export function MarkAllReadButton({ courseId, unreadCount }: { courseId?: number; unreadCount: number }) {
  const markAll = useMarkAllRead();
  const toast = useToast();
  return (
    <button
      type="button"
      className="button secondary"
      disabled={unreadCount === 0 || markAll.isPending}
      onClick={() =>
        markAll.mutate(courseId, {
          onSuccess: ({ updated }) => toast(`Marked ${plural(updated, "change")} as read.`),
          onError: (error) => toast(error.message, "error"),
        })
      }
    >
      <CheckIcon size={18} />
      Mark all as read
    </button>
  );
}

export function ChangesPage() {
  const [params, setParams] = useSearchParams();
  const unread = params.get("show") === "unread";
  const courseId = Number(params.get("course")) || undefined;
  const courses = useCourses();
  const unreadCount = useUnreadCount();
  const courseUnread = courses.data?.find((course) => course.id === courseId)?.counts.unread_changes;
  const count = courseId ? (courseUnread ?? 0) : (unreadCount.data?.count ?? 0);

  const update = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  };

  return (
    <div className="page">
      <PageHeader
        title="Changes"
        description="Everything CanvasWatcher noticed in your courses, newest first."
        actions={<MarkAllReadButton courseId={courseId} unreadCount={count} />}
      />
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Show">
          <button type="button" aria-pressed={!unread} onClick={() => update({ show: undefined })}>
            All
          </button>
          <button type="button" aria-pressed={unread} onClick={() => update({ show: "unread" })}>
            Unread{count ? <span className="count">{count}</span> : null}
          </button>
        </div>
        <label className="select-field">
          <span>Course</span>
          <select value={courseId ?? ""} onChange={(event) => update({ course: event.target.value || undefined })}>
            <option value="">All courses</option>
            {courses.data?.map((course) => (
              <option key={course.id} value={course.id}>
                {course.code}
              </option>
            ))}
          </select>
        </label>
      </div>
      <section className="card" aria-label="Change list">
        <ChangeFeed courseId={courseId} unread={unread} />
      </section>
    </div>
  );
}
