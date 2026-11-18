import { useEffect, useState } from "react";
import { plural } from "../format";
import { FolderIcon, SearchIcon } from "../icons";
import { FileTable } from "../lists";
import { useCourses, useFiles } from "../queries";
import { EmptyState, LoadMoreButton, PageHeader, QueryError, SkeletonList, usePages } from "../ui";
import { FileTypeTabs, useFileTypeParam } from "../fileTypes";

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
  const [type, setType] = useFileTypeParam();
  const [pages, more] = usePages(`${courseId ?? ""}|${q}|${type ?? ""}`);
  const files = useFiles({ courseId, q: q || undefined, type, pages });
  const filtered = Boolean(q || courseId || type);
  const items = files.data?.items;
  const hasMore = files.data?.hasMore ?? false;
  // With more pages to load the total is unknown, so the count says how many are shown.
  const count = items ? `${plural(items.length, "file")}${hasMore ? " shown" : filtered ? " found" : ""}` : null;

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
      <FileTypeTabs value={type} onChange={setType} />

      <section className="card" aria-label="Files">
        {files.isPending ? <SkeletonList rows={5} label="Loading files" /> : null}
        {files.isError ? <QueryError error={files.error} retry={() => files.refetch()} /> : null}
        {count ? (
          <p className="result-count" role="status">
            {count}
          </p>
        ) : null}
        {items?.length === 0 ? (
          <EmptyState icon={<FolderIcon size={28} />} title={filtered ? "No matching files" : "No files yet"}>
            {filtered ? "Try a shorter name, another course or another type." : "Files appear here when your courses share them in Canvas."}
          </EmptyState>
        ) : null}
        {items && items.length > 0 ? <FileTable files={items} /> : null}
        {hasMore ? (
          <LoadMoreButton loading={files.isPlaceholderData} onClick={more}>
            Load more files
          </LoadMoreButton>
        ) : null}
      </section>
    </div>
  );
}
