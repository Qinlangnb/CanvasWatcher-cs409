import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ApiError } from "../api";
import { DEFAULT_CANVAS_URL } from "../canvas";
import { PlusIcon } from "../icons";
import { UnavailableButton } from "../preview";
import { SyncIcon } from "../icons";
import { Alert, Badge, Dialog, EmptyState, Field, QueryError, SkeletonList, Spinner } from "../ui";
import { AuthBrokerPanel, BrowserSignIn } from "./broker";
import { CanvasEditDialog, CanvasSourceCard } from "./canvasCard";
import { SOURCE_TYPE_LABELS, sourceState, sourceTone, syncFeedback, TONE_BADGE, type SourceConnection, type SourceType } from "./model";
import "./plugins";
import { useCanvasStatus, useCreateCanvasSource, useCredentialStorage, useDeleteSource, useSources, useSourcesLocked, useSyncSource } from "./queries";
import { COMING_SOON, SOURCE_TYPES, sourceUi } from "./registry";

/** Where credentials live. Here they are always sealed in the database. */
export function CredentialStorageNotice() {
  const storage = useCredentialStorage();
  let text: string;
  if (storage.isPending) text = "Checking credential storage…";
  else if (storage.isError) text = storage.error.message;
  else if (storage.data.mode === "server_encrypted") {
    text =
      "Server storage enabled: credentials are encrypted and restored after restart. Expired or revoked sessions may still require sign-in. Removing a credential also removes its saved copy.";
  } else text = "Memory-only credentials: sign in again after a backend restart.";
  return (
    <p className="storage-notice" role="status">
      {text}
    </p>
  );
}

/** Settings → Sources: every connection, the Local Auth Broker and the Add New Source wizard. */
export function SourcesSection() {
  const sources = useSources();
  const status = useCanvasStatus();
  const locked = useSourcesLocked();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();

  // ?edit=<id> (from the sidebar's Manage) opens that source's editor once.
  useEffect(() => {
    const id = params.get("edit");
    if (!id || !sources.data) return;
    if (sources.data.some((source) => source.id === id)) setEditing(id);
    document.getElementById("sources")?.scrollIntoView({ block: "start" });
    const next = new URLSearchParams(params);
    next.delete("edit");
    setParams(next, { replace: true, preventScrollReset: true });
  }, [params, sources.data, setParams]);

  const editingSource = sources.data?.find((source) => source.id === editing) ?? null;
  const EditDialog = editingSource && editingSource.source_type !== "canvas" ? sourceUi(editingSource.source_type)?.EditDialog : undefined;

  return (
    <section className="card settings-section sources-section" id="sources" aria-labelledby="sources-heading">
      <div className="sources-head">
        <div>
          <p className="eyebrow">Sources</p>
          <h2 id="sources-heading">Configured connections</h2>
          <p className="muted">Edit safely: a changed address is probed before it replaces the working configuration.</p>
        </div>
        {locked ? (
          <UnavailableButton className="button primary">
            <PlusIcon size={18} />
            Add New Source
          </UnavailableButton>
        ) : (
          <button type="button" className="button primary" onClick={() => setAdding(true)}>
            <PlusIcon size={18} />
            Add New Source
          </button>
        )}
      </div>
      <CredentialStorageNotice />
      <AuthBrokerPanel />
      {sources.isPending ? <SkeletonList rows={2} label="Loading sources" /> : null}
      {sources.isError ? <QueryError error={sources.error} retry={() => void sources.refetch()} /> : null}
      {sources.data?.length === 0 ? (
        <EmptyState title="No sources configured">Add Canvas or a course website when you are ready.</EmptyState>
      ) : null}
      {sources.data && sources.data.length > 0 ? (
        <div className="source-connection-grid">
          {sources.data.map((source) =>
            source.source_type === "canvas" ? (
              <CanvasSourceCard key={source.id} source={source} status={status.data} onEdit={() => setEditing(source.id)} />
            ) : (
              <ConnectionCard key={source.id} source={source} />
            ),
          )}
        </div>
      ) : null}
      <AddSourceDialog open={adding} onClose={() => setAdding(false)} hasCanvas={Boolean(sources.data?.some((source) => source.source_type === "canvas"))} />
      {editingSource?.source_type === "canvas" ? (
        <CanvasEditDialog source={editingSource} status={status.data} open onClose={() => setEditing(null)} />
      ) : null}
      {editingSource && EditDialog && !locked ? <EditDialog source={editingSource} open onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

/** A course website, Gradescope or PrairieLearn connection; its details come from the registered module. */
function ConnectionCard({ source }: { source: SourceConnection }) {
  const ui = sourceUi(source.source_type);
  const provider = source.source_type === "gradescope" || source.source_type === "prairielearn";
  const state = sourceState(source, null);
  return (
    <article className="source-card" aria-labelledby={`source-${source.id}`}>
      <header className="source-card-head">
        <div>
          <p className="eyebrow">{provider ? "Read-only source" : SOURCE_TYPE_LABELS[source.source_type]}</p>
          <h3 id={`source-${source.id}`}>{source.name}</h3>
          <p className="source-url">{source.base_url}</p>
        </div>
        <Badge tone={TONE_BADGE[sourceTone(state)]}>{state.replaceAll("_", " ")}</Badge>
      </header>
      <p className="muted">
        {ui?.authNote?.(source) ??
          (provider
            ? "Browser authentication · Storage follows the server credential policy above."
            : source.course_id
              ? "Course-linked source"
              : "Account-level source")}
      </p>
      {provider && source.supported ? <BrowserSignIn provider={source.source_type} credentialId={source.id} /> : null}
      {ui?.CardExtras ? <ui.CardExtras source={source} /> : null}
      {!source.supported ? <p className="inline-note">{COMING_SOON}.</p> : null}
      {source.supported ? <ConnectionActions source={source} /> : null}
    </article>
  );
}

/** Sync now (records health and diagnostics like the scheduler) and Remove, for every non-Canvas source. */
function ConnectionActions({ source }: { source: SourceConnection }) {
  const locked = useSourcesLocked();
  const sync = useSyncSource();
  const remove = useDeleteSource();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = () => {
    setMessage(null);
    sync.mutate(source, {
      onSuccess: (result) => {
        const feedback = syncFeedback(result);
        setMessage({ ok: feedback.ok, text: feedback.message });
      },
      onError: (error) => setMessage({ ok: false, text: syncFeedback(null, error).message }),
    });
  };
  // The Gradescope card has its own "Sync mapped courses"; PrairieLearn has nothing to sync yet.
  const syncable = source.source_type === "website";
  return (
    <>
      {message ? (
        <p className={message.ok ? "inline-note" : "form-error"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      ) : null}
      <div className="form-actions source-card-actions">
        {locked ? (
          <>
            {syncable ? (
              <UnavailableButton className="button secondary small">
                <SyncIcon size={16} />
                Sync now
              </UnavailableButton>
            ) : null}
            <UnavailableButton className="button ghost small">Remove</UnavailableButton>
          </>
        ) : (
          <>
            {syncable ? (
              <button type="button" className="button secondary small" onClick={run} disabled={sync.isPending || !source.enabled}>
                {sync.isPending ? <Spinner size={14} /> : <SyncIcon size={16} />}
                {sync.isPending ? "Syncing…" : "Sync now"}
              </button>
            ) : null}
            <button type="button" className="button ghost small" onClick={() => setConfirming(true)}>
              Remove
            </button>
          </>
        )}
      </div>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Remove ${source.name}?`}
        size="small"
        footer={
          <>
            <button type="button" className="button ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate(source.id, { onSuccess: () => setConfirming(false) })}
            >
              {remove.isPending ? <Spinner size={16} /> : null}
              Remove source
            </button>
          </>
        }
      >
        <p>
          {source.source_type === "website"
            ? "Its saved password, pages and downloaded files are deleted. A course this website created is removed with it."
            : "Its saved browser session, course links and source facts are deleted, with the tasks it created. Your other tasks stay."}
        </p>
        {remove.error ? <Alert>{remove.error.message}</Alert> : null}
      </Dialog>
    </>
  );
}

/** The wizard: choose a type, then its form. */
function AddSourceDialog({ open, onClose, hasCanvas }: { open: boolean; onClose: () => void; hasCanvas: boolean }) {
  const [type, setType] = useState<SourceType | null>(null);
  useEffect(() => {
    if (open) setType(null);
  }, [open]);
  const info = SOURCE_TYPES.find((row) => row.type === type);
  const ui = type && type !== "canvas" ? sourceUi(type) : null;
  return (
    <Dialog open={open} onClose={onClose} title={info ? `Add ${info.label}` : "Choose source type"}>
      <p className="eyebrow">Add New Source</p>
      {type === null ? (
        <div className="source-type-grid">
          {SOURCE_TYPES.map((row) => (
            <button key={row.type} type="button" className="source-type" onClick={() => setType(row.type)}>
              <strong>{row.label}</strong>
              <span>{row.description}</span>
              {row.type !== "canvas" && !sourceUi(row.type)?.AddForm ? <Badge>{COMING_SOON}</Badge> : null}
            </button>
          ))}
        </div>
      ) : type === "canvas" ? (
        hasCanvas ? (
          <Alert tone="info">Canvas is already set up. Edit the existing Canvas source instead.</Alert>
        ) : (
          <CanvasSourceForm onDone={onClose} />
        )
      ) : ui?.AddForm ? (
        <ui.AddForm onDone={onClose} onCancel={() => setType(null)} />
      ) : (
        <div className="stack">
          <Alert tone="info" title={COMING_SOON}>
            {info?.label} sources are being added in this release. Canvas works now.
          </Alert>
        </div>
      )}
      {type !== null ? (
        <div className="form-actions">
          <button type="button" className="button ghost" onClick={() => setType(null)}>
            Back
          </button>
        </div>
      ) : null}
    </Dialog>
  );
}

/** Adds the Canvas source; sign-in happens on its card afterwards. */
export function CanvasSourceForm({ onDone, stay = false }: { onDone: (source: SourceConnection) => void; stay?: boolean }) {
  const create = useCreateCanvasSource();
  const navigate = useNavigate();
  const [name, setName] = useState("Canvas");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_CANVAS_URL);
  const fields = create.error instanceof ApiError ? create.error.fields : {};
  const general = create.error && Object.keys(fields).length === 0 ? create.error.message : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name: name.trim() || undefined, base_url: baseUrl },
      {
        onSuccess: (source) => {
          onDone(source);
          if (!stay) navigate("/settings#sources");
        },
      },
    );
  };
  return (
    <form className="stack" onSubmit={submit} noValidate>
      {general ? <Alert>{general}</Alert> : null}
      <Field label="Name" value={name} onChange={(event) => setName(event.target.value)} error={fields.name} data-autofocus />
      <Field label="Base URL" type="url" inputMode="url" required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} error={fields.base_url} />
      <div className="form-actions">
        <button type="submit" className="button primary" disabled={create.isPending}>
          {create.isPending ? <Spinner size={16} /> : null}
          {create.isPending ? "Creating…" : "Create source"}
        </button>
      </div>
    </form>
  );
}
