import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useNavigate } from "react-router";
import { formatDateTime, timeAgo } from "../format";
import { CloseIcon, SyncIcon } from "../icons";
import { UnavailableButton } from "../preview";
import { Spinner } from "../ui";
import {
  authenticationLabel,
  diagnosticLine,
  quickPanelPosition,
  sourceState,
  sourceSubtitle,
  stateLabel,
  sourceTone,
  syncFeedback,
  TONE_DOT,
  type CanvasAuthStatus,
  type SourceConnection,
} from "./model";
import "./plugins";
import { useCanvasStatus, useSources, useSourcesLocked, useSyncSource } from "./queries";

/** Stacked layers: where the data comes from. */
function LayersIcon() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </svg>
  );
}

/** The sidebar's SOURCES list: one row per connection with its status, and a quick panel per row. */
export function SourcesList() {
  const sources = useSources();
  const status = useCanvasStatus();
  const [open, setOpen] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  if (!sources.data || sources.data.length === 0) return null;
  const selected = sources.data.find((source) => source.id === open?.id) ?? null;
  return (
    <div className="sources-nav">
      <p className="sources-nav-title">Sources</p>
      <ul>
        {sources.data.map((source) => {
          const tone = sourceTone(sourceState(source, status.data));
          return (
            <li key={source.id}>
              <button
                type="button"
                className="source-row"
                aria-expanded={open?.id === source.id}
                aria-haspopup="dialog"
                onClick={(event) => {
                  const anchor = event.currentTarget;
                  setOpen((current) => (current?.id === source.id ? null : { id: source.id, anchor }));
                }}
              >
                <span className={`status-dot ${TONE_DOT[tone]}`} aria-hidden="true" />
                <span className="source-row-text">
                  <span className="source-row-name">{source.name}</span>
                  <span className="source-row-sub">{sourceSubtitle(source, status.data)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {selected && open ? (
        <QuickPanel sources={[selected]} canvas={status.data} anchor={{ current: open.anchor }} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  );
}

/** Phones: a top-bar button with the worst status, opening every source in a bottom sheet. */
export function SourcesButton() {
  const sources = useSources();
  const status = useCanvasStatus();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (!sources.data || sources.data.length === 0) return null;
  const tones = sources.data.map((source) => sourceTone(sourceState(source, status.data)));
  const worst = tones.includes("danger") ? "danger" : tones.includes("warning") ? "warning" : "active";
  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon-button sources-button"
        aria-label={`Sources (${worst === "active" ? "all working" : "needs attention"})`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <LayersIcon />
        <span className={`status-dot ${TONE_DOT[worst]}`} aria-hidden="true" />
      </button>
      {open ? <QuickPanel sources={sources.data} canvas={status.data} anchor={button} onClose={() => setOpen(false)} sheet /> : null}
    </>
  );
}

/**
 * Status, authentication, last sync and health of one or more sources, with Sync now and Manage. Beside
 * its row above 820px, a bottom sheet below. Escape or a click outside closes it.
 */
function QuickPanel({
  sources,
  canvas,
  anchor,
  onClose,
  sheet = false,
}: {
  sources: SourceConnection[];
  canvas: CanvasAuthStatus | undefined;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  sheet?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const place = () => {
      const row = anchor.current?.getBoundingClientRect();
      const box = panel.current?.getBoundingClientRect();
      if (!row || !box || sheet) return setPosition(null);
      // The beside-the-row panel is 360px wide (see .quick-panel), whatever it measured as a sheet.
      const size = { width: Math.min(360, window.innerWidth - 24), height: box.height };
      setPosition(quickPanelPosition(row, size, { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, sheet]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      close.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    panel.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [anchor]);

  const title = sources.length === 1 ? sources[0]?.name : "Sources";
  return (
    <div
      ref={panel}
      className={`quick-panel${position ? " quick-panel-beside" : " quick-panel-sheet"}`}
      style={position ? { left: position.left, top: position.top } : undefined}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
    >
      <header className="quick-panel-head">
        <div>
          <p className="eyebrow">Source</p>
          <h2>{title}</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
      </header>
      {sources.map((source) => (
        <SourceDetails key={source.id} source={source} canvas={canvas} showName={sources.length > 1} onNavigate={onClose} />
      ))}
    </div>
  );
}

function SourceDetails({
  source,
  canvas,
  showName,
  onNavigate,
}: {
  source: SourceConnection;
  canvas: CanvasAuthStatus | undefined;
  showName: boolean;
  onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const sync = useSyncSource();
  const locked = useSourcesLocked();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const state = sourceState(source, canvas);
  const diagnostics = source.health_diagnostics ?? [];

  const run = () => {
    setMessage(null);
    sync.mutate(source, {
      onSuccess: (result) => {
        if (source.source_type === "canvas") setMessage({ ok: true, text: "Sync started. Results appear when it finishes." });
        else {
          const feedback = syncFeedback(result);
          setMessage({ ok: feedback.ok, text: feedback.message });
        }
      },
      onError: (error) => setMessage({ ok: false, text: syncFeedback(null, error).message }),
    });
  };

  return (
    <div className="quick-panel-source">
      {showName ? <h3>{source.name}</h3> : null}
      <dl className="quick-panel-list">
        <div>
          <dt>Status</dt>
          <dd>
            <span className={`status-dot ${TONE_DOT[sourceTone(state)]}`} aria-hidden="true" /> {stateLabel(state)}
          </dd>
        </div>
        <div>
          <dt>Authentication</dt>
          <dd>{authenticationLabel(source, canvas)}</dd>
        </div>
        <div>
          <dt>Last sync</dt>
          <dd>
            {source.last_success_at ? (
              <time dateTime={source.last_success_at} title={formatDateTime(source.last_success_at)}>
                {timeAgo(source.last_success_at)}
              </time>
            ) : (
              "No successful sync yet"
            )}
          </dd>
        </div>
      </dl>
      {source.health_summary ? <p className="muted">{source.health_summary}</p> : null}
      {diagnostics.length > 0 ? (
        <details className="diagnostics">
          <summary>Advanced resource diagnostics</summary>
          <ul>
            {diagnostics.map((row, index) => (
              <li key={index}>{diagnosticLine(row)}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {message ? (
        <p className={message.ok ? "inline-note" : "form-error"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      ) : null}
      <div className="form-actions">
        {locked ? (
          <UnavailableButton className="button small secondary">
            <SyncIcon size={16} />
            Sync now
          </UnavailableButton>
        ) : (
          <button type="button" className="button small secondary" onClick={run} disabled={sync.isPending || !source.enabled || !source.supported}>
            {sync.isPending ? <Spinner size={14} /> : <SyncIcon size={16} />}
            {sync.isPending ? "Syncing…" : "Sync now"}
          </button>
        )}
        <button
          type="button"
          className="button small ghost"
          onClick={() => {
            onNavigate();
            navigate(`/settings?edit=${encodeURIComponent(source.id)}#sources`);
          }}
        >
          Manage
        </button>
      </div>
    </div>
  );
}
