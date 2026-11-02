import { useEffect, useState } from "react";
import { plural } from "../format";
import { FolderIcon, SearchIcon } from "../icons";
import { FileTable } from "../lists";
import { useCourses, useFiles } from "../queries";
import { Alert, EmptyState, PageHeader, SkeletonList } from "../ui";

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function FilesPage() {
  const [text, setText] = useState("");
  const [courseId, setCourseId] = useState<number | undefined>();
  const q = useDebounced(text.trim(), 250);
  const courses = useCourses();
  const files = useFiles({ courseId, q: q || undefined });
  const filtered = Boolean(q || courseId);

  return (
    <div className="page">
      <PageHeader title="Files" description="Files shared in your courses. Downloads come straight from Canvas." />
      <form className="toolbar" role="search" onSubmit={(event) => event.preventDefault()}>
        <label className="search-field">
          <span className="visually-hidden">Search files by name</span>
          <SearchIcon size={18} />
          <input type="search" placeholder="Search by file name" value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <label className="select-field">
          <span>Course</span>
          <select value={courseId ?? ""} onChange={(event) => setCourseId(Number(event.target.value) || undefined)}>
            <option value="">All courses</option>
            {courses.data?.map((course) => (
              <option key={course.id} value={course.id}>
                {course.code}
              </option>
            ))}
          </select>
        </label>
      </form>

      <section className="card" aria-label="Files">
        {files.isPending ? <SkeletonList rows={5} label="Loading files" /> : null}
        {files.isError ? <Alert>{files.error.message}</Alert> : null}
        {files.data ? (
          <p className="result-count" role="status">
            {filtered ? `${plural(files.data.length, "file")} found` : plural(files.data.length, "file")}
          </p>
        ) : null}
        {files.data?.length === 0 ? (
          <EmptyState icon={<FolderIcon size={28} />} title={filtered ? "No matching files" : "No files yet"}>
            {filtered ? "Try a shorter name or another course." : "Files appear here when your courses share them in Canvas."}
          </EmptyState>
        ) : null}
        {files.data && files.data.length > 0 ? <FileTable files={files.data} /> : null}
      </section>
    </div>
  );
}
