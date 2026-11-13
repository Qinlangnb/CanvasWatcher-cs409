import { useState } from "react";
import { apiHref } from "./api";
import { CanvasLink } from "./demo";
import { timeAgo } from "./format";
import { BookIcon, DownloadIcon, ExternalIcon } from "./icons";
import { useSyllabus } from "./queries";
import type { SyllabusBlock, SyllabusSource } from "./types";
import { EmptyState, QueryError, SkeletonList } from "./ui";

const KIND_LABEL: Record<SyllabusSource["kind"], string> = {
  syllabus: "Canvas Syllabus tab",
  page: "Canvas page",
  file: "Course file",
  link: "Outside link",
};

/** Tables keep their rows and header cells, so an exam reads next to its date; wide ones scroll on phones. */
function SyllabusTable({ block }: { block: Extract<SyllabusBlock, { type: "table" }> }) {
  const head = block.rows.slice(0, block.header_rows);
  const body = block.rows.slice(block.header_rows);
  return (
    <div className="syllabus-table-wrap" role="region" aria-label={block.caption ?? "Syllabus table"} tabIndex={0}>
      <table className="syllabus-table">
        {block.caption ? <caption>{block.caption}</caption> : null}
        {head.length > 0 ? (
          <thead>
            {head.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <th key={c} scope="col">
                    {cell}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
        ) : null}
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) =>
                block.row_headers && c === 0 ? (
                  <th key={c} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={c}>{cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SyllabusBlocks({ blocks }: { blocks: SyllabusBlock[] }) {
  return (
    <div className="syllabus-body">
      {blocks.map((block, index) => {
        if (block.type === "table") return <SyllabusTable key={index} block={block} />;
        if (block.type === "heading") {
          return block.level <= 2 ? <h3 key={index}>{block.text}</h3> : <h4 key={index}>{block.text}</h4>;
        }
        return <p key={index}>{block.text}</p>;
      })}
    </div>
  );
}

function SourceCard({ source }: { source: SyllabusSource }) {
  return (
    <article className="syllabus-card" aria-labelledby="syllabus-title">
      <header className="syllabus-head">
        <div>
          <p className="eyebrow">{KIND_LABEL[source.kind]}</p>
          <h2 id="syllabus-title">{source.title}</h2>
          <p className="syllabus-why">
            Found because: {source.reasons.join(", ")}
            {source.updated_at ? ` · updated ${timeAgo(source.updated_at)}` : null}
          </p>
        </div>
        {source.download_url ? (
          <a className="button small secondary" href={apiHref(source.download_url)} target="_blank" rel="noreferrer">
            <DownloadIcon size={16} />
            Download
          </a>
        ) : source.kind === "link" && source.html_url ? (
          <a className="button small secondary" href={source.html_url} target="_blank" rel="noreferrer">
            Open link
            <ExternalIcon size={16} />
          </a>
        ) : source.html_url ? (
          <CanvasLink href={source.html_url} className="button small secondary" />
        ) : null}
      </header>
      {source.blocks.length > 0 ? (
        <SyllabusBlocks blocks={source.blocks} />
      ) : (
        <p className="muted">
          {source.kind === "file"
            ? "CanvasWatcher does not read file contents. Download the file to read it."
            : "This syllabus is on another site. Open the link to read it."}
        </p>
      )}
    </article>
  );
}

/** The course syllabus, wherever the instructor put it: Syllabus tab, a page, a file or a module link. */
export function CourseSyllabus({ courseId }: { courseId: number }) {
  const syllabus = useSyllabus(courseId);
  const [picked, setPicked] = useState(0);
  if (syllabus.isPending) return <SkeletonList rows={4} label="Looking for the syllabus" />;
  if (syllabus.isError) {
    return <QueryError title="The syllabus didn't load" error={syllabus.error} retry={() => void syllabus.refetch()} />;
  }
  const { sources } = syllabus.data;
  if (sources.length === 0) {
    return (
      <EmptyState icon={<BookIcon size={28} />} title="No syllabus found">
        Checked the Canvas Syllabus tab, Pages, Modules and Files. If the instructor shares it another way, it will not show here.
      </EmptyState>
    );
  }
  const index = Math.min(picked, sources.length - 1);
  const current = sources[index] as SyllabusSource;
  return (
    <div className="syllabus">
      {sources.length > 1 ? (
        <div className="syllabus-sources" role="group" aria-label="Syllabus sources">
          {sources.map((source, i) => (
            <button
              key={`${source.kind}-${source.title}-${i}`}
              type="button"
              className="syllabus-source"
              aria-pressed={i === index}
              onClick={() => setPicked(i)}
            >
              <span className="syllabus-source-kind">{KIND_LABEL[source.kind]}</span>
              <span className="syllabus-source-title">{source.title}</span>
            </button>
          ))}
        </div>
      ) : null}
      <SourceCard source={current} />
    </div>
  );
}
