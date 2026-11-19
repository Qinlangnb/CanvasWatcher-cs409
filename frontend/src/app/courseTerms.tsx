// Course terms and lifecycle: the term filter on the Courses page (kept in the URL as ?term=) and
// archive / restore with a confirmation. Restoring queues a sync to reconcile the course.
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useCourseLifecycle, useCourseTerms } from "./parityQueries";
import { useToast } from "./toast";
import type { Course, CourseTerm } from "./types";
import { Dialog, Spinner } from "./ui";

/** The term in the URL; with none there, the default term (or "all") is put there. */
export function useTermParam(): { termId: string | null; terms: CourseTerm[] | undefined; setTerm: (id: string) => void } {
  const [search, setSearch] = useSearchParams();
  const terms = useCourseTerms();
  const termId = search.get("term");
  useEffect(() => {
    if (termId || !terms.data) return;
    const fallback = terms.data.find((term) => term.is_default)?.term_id ?? "all";
    const next = new URLSearchParams(search);
    next.set("term", fallback);
    setSearch(next, { replace: true });
  }, [termId, terms.data, search, setSearch]);
  const setTerm = (id: string) => {
    const next = new URLSearchParams(search);
    next.set("term", id);
    setSearch(next, { replace: true });
  };
  // Until the terms load, nothing is asked for, so the list doesn't flash every term first.
  return { termId: termId ?? (terms.isError ? "all" : null), terms: terms.data, setTerm };
}

export function TermFilter({ termId, terms, onChange }: { termId: string | null; terms: CourseTerm[] | undefined; onChange: (id: string) => void }) {
  const withCourses = (terms ?? []).filter((term) => term.active_course_count > 0);
  return (
    <form className="toolbar term-filter" onSubmit={(event) => event.preventDefault()}>
      <label className="select-field">
        <span>Term</span>
        <select value={termId ?? "all"} onChange={(event) => onChange(event.target.value)} disabled={!terms}>
          <option value="all">All active terms</option>
          {withCourses.map((term) => (
            <option key={term.term_id} value={term.term_id}>
              {term.display_name} ({term.active_course_count})
            </option>
          ))}
          {termId && termId !== "all" && !withCourses.some((term) => term.term_id === termId) ? (
            <option value={termId}>{terms?.find((term) => term.term_id === termId)?.display_name ?? termId} (0)</option>
          ) : null}
        </select>
      </label>
    </form>
  );
}

/** Archive (after a confirmation) or "Restore and reconcile". */
export function CourseLifecycleButton({ course }: { course: Course }) {
  const lifecycle = useCourseLifecycle();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const label = course.display_code || course.code;
  const run = (archive: boolean) =>
    lifecycle.mutate(
      { id: course.id, archive },
      {
        onSuccess: (updated) => {
          setConfirming(false);
          if (archive) toast("Course archived. Local history and files were preserved.", "success");
          else toast(updated.reconciliation_queued ? `${label} restored. Reconciliation queued.` : `${label} restored.`, "success");
        },
        onError: (error) => toast(archive ? error.message : `Restore failed: ${error.message}`, "error"),
      },
    );
  if (course.archived) {
    return (
      <button type="button" className="button ghost" onClick={() => run(false)} disabled={lifecycle.isPending}>
        {lifecycle.isPending ? <Spinner size={16} /> : null}
        Restore and reconcile
      </button>
    );
  }
  return (
    <>
      <button type="button" className="button ghost" onClick={() => setConfirming(true)} disabled={lifecycle.isPending}>
        Archive course
      </button>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Archive this course?"
        size="small"
        footer={
          <>
            <button type="button" className="button ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="button primary" disabled={lifecycle.isPending} onClick={() => run(true)}>
              {lifecycle.isPending ? <Spinner size={16} /> : null}
              Archive
            </button>
          </>
        }
      >
        <p>
          {label} leaves Today, the calendar, Changes and Files. Its tasks, history and files are kept, and you can restore it any time.
        </p>
      </Dialog>
    </>
  );
}
