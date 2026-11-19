// File types on the Files page and a course's Files tab: tabs that filter by type (kept in the URL
// as ?type=) and a per-file ⋯ menu with Download and "Move to…".
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router";
import { apiHref } from "./api";
import { useClassifyFile } from "./parityQueries";
import { UnavailableButton } from "./preview";
import { useIsPreview } from "./queries";
import { FILE_TYPES, FILE_TYPE_LABELS } from "./taskHelpers";
import { useToast } from "./toast";
import type { CourseFile, FileType } from "./types";

const TYPE_TABS = ["all", ...FILE_TYPES] as const;

/** The type picked in the URL, or undefined for all files. */
export function useFileTypeParam(): [FileType | undefined, (type: FileType | undefined) => void] {
  const [search, setSearch] = useSearchParams();
  const raw = search.get("type");
  const type = (FILE_TYPES as readonly string[]).includes(raw ?? "") ? (raw as FileType) : undefined;
  const set = (next: FileType | undefined) => {
    const params = new URLSearchParams(search);
    if (next) params.set("type", next);
    else params.delete("type");
    setSearch(params, { replace: true });
  };
  return [type, set];
}

/** Tabs filtering files by type; arrow keys, Home and End move between them. */
export function FileTypeTabs({ value, onChange }: { value: FileType | undefined; onChange: (type: FileType | undefined) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const current = value ?? "all";
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TYPE_TABS.indexOf(current);
    const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TYPE_TABS.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = TYPE_TABS[(target + TYPE_TABS.length) % TYPE_TABS.length] ?? "all";
    onChange(next === "all" ? undefined : next);
    refs.current[next]?.focus();
  };
  return (
    <div className="tabs file-type-tabs" role="tablist" aria-label="File type" onKeyDown={keyDown}>
      {TYPE_TABS.map((type) => (
        <button
          key={type}
          ref={(element) => {
            refs.current[type] = element;
          }}
          type="button"
          role="tab"
          aria-selected={type === current}
          tabIndex={type === current ? 0 : -1}
          onClick={() => onChange(type === "all" ? undefined : type)}
        >
          {type === "all" ? "All" : FILE_TYPE_LABELS[type]}
        </button>
      ))}
    </div>
  );
}

/** ⋯ menu for one file: Download, and Move to another type. Closes on Escape or a click outside. */
export function FileMenu({ file }: { file: CourseFile }) {
  const [open, setOpen] = useState(false);
  const preview = useIsPreview();
  const classify = useClassifyFile();
  const toast = useToast();
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    root.current?.querySelector<HTMLElement>(".file-menu-item")?.focus();
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const move = (type: FileType) => {
    setOpen(false);
    classify.mutate(
      { id: file.id, type },
      {
        onSuccess: () => toast(`Moved ${file.name} to ${FILE_TYPE_LABELS[type]}`, "success"),
        onError: (error) => toast(`Move file failed: ${error.message}`, "error"),
      },
    );
  };

  return (
    <div className="file-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="icon-button file-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`More actions for ${file.name}`}
        disabled={classify.isPending}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <div className="file-menu-list" role="menu" id={menuId} aria-label={file.name}>
          {preview ? (
            <UnavailableButton className="file-menu-item">Download</UnavailableButton>
          ) : (
            <a role="menuitem" className="file-menu-item" href={apiHref(file.download_url)} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
              Download
            </a>
          )}
          <span className="file-menu-heading" role="presentation">
            Move to…
          </span>
          {FILE_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              role="menuitemradio"
              aria-checked={file.type === type}
              className="file-menu-item"
              onClick={() => move(type)}
            >
              {FILE_TYPE_LABELS[type]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
