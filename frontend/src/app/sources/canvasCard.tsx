import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../api";
import { formatDateTime } from "../format";
import { ExternalIcon } from "../icons";
import { UnavailableButton } from "../preview";
import { useToast } from "../toast";
import { Alert, Badge, Dialog, Field, PasswordField, SelectField, Spinner, TextAreaField } from "../ui";
import { BrowserSignIn } from "./broker";
import {
  METHOD_LABELS,
  METHOD_ORDER,
  slotDetail,
  sourceTone,
  TONE_BADGE,
  type CanvasAuthStatus,
  type CanvasMethod,
  type SourceConnection,
} from "./model";
import {
  useClearCredentials,
  useImportPat,
  useImportSession,
  useOAuthCapability,
  useRemoveMethod,
  useSourcesLocked,
  useStartOAuth,
  useUpdateSource,
  useVerifyMethod,
} from "./queries";

const errorText = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

/** The Canvas source: its sign-in methods, browser sign-in and the advanced imports. */
export function CanvasSourceCard({ source, status, onEdit }: { source: SourceConnection; status: CanvasAuthStatus | undefined; onEdit: () => void }) {
  const [advanced, setAdvanced] = useState(false);
  const state = status?.connection_state ?? "AUTH_REQUIRED";
  return (
    <article className="source-card" aria-labelledby={`source-${source.id}`}>
      <header className="source-card-head">
        <div>
          <p className="eyebrow">Canvas</p>
          <h3 id={`source-${source.id}`}>{source.name}</h3>
          <p className="source-url">{source.base_url}</p>
        </div>
        <Badge tone={TONE_BADGE[sourceTone(source.enabled ? state : "DISABLED")]}>{(source.enabled ? state : "DISABLED").replaceAll("_", " ")}</Badge>
      </header>
      <p className="muted">
        Account-level source{status?.account_display_name ? ` · ${status.account_display_name}` : ""}
        {source.enabled ? "" : " · turned off, sync skips it"}
      </p>
      <div className="form-actions">
        <button type="button" className="button secondary small" onClick={onEdit}>
          Edit
        </button>
      </div>
      <div className="subsection">
        <h4>Sign in with your browser</h4>
        <p className="muted">
          Sign in on the official Canvas page. The local broker transfers the session automatically; no Cookie or cURL import is needed.
        </p>
        <BrowserSignIn provider="canvas" credentialId={source.id} />
      </div>
      <CanvasOAuthSignIn />
      {status ? <CanvasCredentialSlots status={status} onImportPat={() => setAdvanced(true)} /> : null}
      <AdvancedCanvasImport open={advanced} onToggle={setAdvanced} baseUrl={source.base_url} />
    </article>
  );
}

/** "Authorize with Canvas OAuth" when this server has a Canvas developer key. */
export function CanvasOAuthSignIn() {
  const capability = useOAuthCapability();
  const start = useStartOAuth();
  const locked = useSourcesLocked();
  const [message, setMessage] = useState<string | null>(null);
  if (!capability.data) return null;
  if (!capability.data.configured) {
    return <p className="inline-note">Canvas OAuth is not configured by this installation. Browser sign-in and advanced PAT remain available.</p>;
  }
  const authorize = () => {
    // Opened before the request so the browser treats it as a direct result of the click.
    const popup = window.open("", "_blank");
    if (!popup) {
      setMessage("Allow the sign-in popup and retry.");
      return;
    }
    popup.opener = null;
    start.mutate(undefined, {
      onSuccess: ({ authorization_url }) => {
        popup.location.href = authorization_url;
        setMessage("Complete Canvas authorization in the new window, then refresh credential status.");
      },
      onError: (error) => {
        popup.close();
        setMessage(errorText(error));
      },
    });
  };
  return (
    <div className="subsection">
      <h4>Canvas OAuth</h4>
      <div className="form-actions">
        {locked ? (
          <UnavailableButton className="button secondary">Authorize with Canvas OAuth</UnavailableButton>
        ) : (
          <button type="button" className="button secondary" onClick={authorize} disabled={start.isPending}>
            {start.isPending ? <Spinner size={16} /> : null}
            Authorize with Canvas OAuth
          </button>
        )}
      </div>
      {message ? (
        <p className="inline-note" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

/** One row per method: Current or Backup, its state, expiry or last check, and Remove. */
export function CanvasCredentialSlots({ status, onImportPat }: { status: CanvasAuthStatus; onImportPat: () => void }) {
  const remove = useRemoveMethod();
  const verify = useVerifyMethod();
  const clear = useClearCredentials();
  const locked = useSourcesLocked();
  const toast = useToast();
  const [clearing, setClearing] = useState(false);
  const fail = (error: unknown) => toast(errorText(error), "error");

  return (
    <div className="subsection credential-slots">
      <h4>Sign-in methods</h4>
      <p className="muted">
        Connection: {status.connection_state.replaceAll("_", " ").toLowerCase()}
        {status.effective_method ? ` via ${METHOD_LABELS[status.effective_method]}` : ""} · Automatic backup:{" "}
        {status.backup_ready ? "Ready" : "Unavailable"}
      </p>
      {status.fallback ? (
        <p className="inline-note">
          Switched from {METHOD_LABELS[status.fallback.from as CanvasMethod] ?? status.fallback.from} to{" "}
          {METHOD_LABELS[status.fallback.to as CanvasMethod] ?? status.fallback.to} on {formatDateTime(status.fallback.at)}.
        </p>
      ) : null}
      <ul className="slot-list">
        {METHOD_ORDER.map((method) => {
          const slot = status.credentials[method];
          const current = status.effective_method === method;
          const state = slot?.present ? slot.state : (slot?.state ?? "MISSING");
          return (
            <li key={method} className="slot-row">
              <div className="slot-text">
                <p className="slot-name">
                  {METHOD_LABELS[method]} <span className="muted">· {current ? "Current" : "Backup"}</span>{" "}
                  <Badge tone={TONE_BADGE[sourceTone(state)]}>{state}</Badge>
                  {method === "pat" && slot?.present && slot.expiration_state && ["warning", "urgent", "critical"].includes(slot.expiration_state) ? (
                    <Badge tone={slot.expiration_state === "warning" ? "warning" : "danger"}>
                      {slot.days_remaining === 1 ? "1 day left" : `${slot.days_remaining} days left`}
                    </Badge>
                  ) : null}
                </p>
                <p className="muted slot-detail">{slotDetail(method, slot, formatDateTime)}</p>
              </div>
              <div className="slot-actions">
                {locked ? (
                  <UnavailableButton className="button small ghost">Remove</UnavailableButton>
                ) : (
                  <>
                    {method === "pat" ? (
                      <button type="button" className="button small secondary" onClick={onImportPat}>
                        Import / Replace
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="button small ghost"
                      disabled={!slot?.present || verify.isPending}
                      onClick={() =>
                        verify.mutate(method, {
                          onSuccess: (result) => toast(result.verified ? `${METHOD_LABELS[method]} verified.` : `${METHOD_LABELS[method]} no longer works and was removed.`, result.verified ? "success" : "error"),
                          onError: fail,
                        })
                      }
                    >
                      Verify
                    </button>
                    <button
                      type="button"
                      className="button small danger-ghost"
                      disabled={!slot?.present || remove.isPending}
                      onClick={() =>
                        remove.mutate({ method, generation: slot.generation }, { onSuccess: () => toast(`${METHOD_LABELS[method]} removed.`), onError: fail })
                      }
                    >
                      Remove<span className="visually-hidden"> {METHOD_LABELS[method]}</span>
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="muted">Default priority: OAuth → PAT → Browser Session. Credentials are independently verified.</p>
      <div className="form-actions">
        {locked ? (
          <UnavailableButton className="button danger-ghost">Clear all credentials</UnavailableButton>
        ) : (
          <button type="button" className="button danger-ghost" onClick={() => setClearing(true)}>
            Clear all credentials
          </button>
        )}
      </div>
      <Dialog
        open={clearing}
        onClose={() => setClearing(false)}
        title="Clear all Canvas credentials?"
        size="small"
        footer={
          <>
            <button type="button" className="button ghost" onClick={() => setClearing(false)}>
              Keep them
            </button>
            <button
              type="button"
              className="button danger"
              disabled={clear.isPending}
              onClick={() =>
                clear.mutate(undefined, {
                  onSuccess: () => {
                    setClearing(false);
                    toast("Canvas credentials cleared. Course data was kept.");
                  },
                  onError: fail,
                })
              }
            >
              {clear.isPending ? <Spinner size={16} /> : null}
              Clear all credentials
            </button>
          </>
        }
      >
        <p>Every Canvas sign-in method is removed. Cached course data will be preserved, and you can sign in again at any time.</p>
      </Dialog>
    </div>
  );
}

/** Advanced: import a PAT, or a browser session copied as cURL (deprecated; the broker does this for you). */
export function AdvancedCanvasImport({ open, onToggle, baseUrl }: { open: boolean; onToggle: (open: boolean) => void; baseUrl: string }) {
  const pat = useImportPat();
  const session = useImportSession();
  const locked = useSourcesLocked();
  const [tab, setTab] = useState<"pat" | "session">("pat");
  const [address, setAddress] = useState(baseUrl);
  const [token, setToken] = useState("");
  const [expires, setExpires] = useState("");
  const [cookies, setCookies] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const mutation = tab === "pat" ? pat : session;
  const fields = mutation.error instanceof ApiError ? mutation.error.fields : {};
  const secret = tab === "pat" ? token : cookies;

  useEffect(() => setAddress(baseUrl), [baseUrl]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!secret.trim() || mutation.isPending) return;
    setResult(null);
    const done = {
      onSuccess: (outcome: { verified: boolean }) => {
        setResult({ ok: outcome.verified, text: outcome.verified ? "Verified and synchronized." : "Verification failed." });
        setToken("");
        setCookies("");
      },
      onError: (error: unknown) => {
        setResult({ ok: false, text: errorText(error) });
        setCookies("");
      },
    };
    if (tab === "pat") pat.mutate({ base_url: address, token, expiration_date: expires || null }, done);
    else session.mutate({ base_url: address, session_import: cookies }, done);
  };

  return (
    <details className="subsection advanced-import" open={open} onToggle={(event) => onToggle((event.target as HTMLDetailsElement).open)}>
      <summary>Advanced: PAT / deprecated manual session import</summary>
      {locked ? (
        <p className="inline-note">Preview account not available.</p>
      ) : (
        <form className="stack" onSubmit={submit} noValidate>
          <div className="segmented" role="tablist" aria-label="Import method">
            <button type="button" role="tab" aria-selected={tab === "pat"} className={tab === "pat" ? "active" : undefined} onClick={() => setTab("pat")}>
              PAT
            </button>
            <button type="button" role="tab" aria-selected={tab === "session"} className={tab === "session" ? "active" : undefined} onClick={() => setTab("session")}>
              Deprecated manual session import
            </button>
          </div>
          <Field label="Canvas base URL" type="url" inputMode="url" value={address} onChange={(event) => setAddress(event.target.value)} error={fields.base_url} />
          {tab === "pat" ? (
            <>
              <PasswordField label="Canvas API token" autoComplete="off" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)} error={fields.token} />
              <Field
                label="Expiration date"
                type="date"
                value={expires}
                onChange={(event) => setExpires(event.target.value)}
                hint="Optional. The token counts as expired at the end of this day in your time zone; you are reminded 7, 3 and 1 days before."
                error={fields.expiration_date}
              />
            </>
          ) : (
            <>
              <details className="import-guide">
                <summary>How to get a Browser Session (copy as cURL)</summary>
                <ol>
                  <li>Sign in to Canvas in your browser and open your Dashboard.</li>
                  <li>Press F12, open the Network tab and reload the page.</li>
                  <li>
                    Right-click a request to your Canvas site and choose Copy → <strong>Copy as cURL (bash)</strong>, not PowerShell.
                  </li>
                  <li>Paste it below and choose Verify and sync.</li>
                </ol>
                <p className="muted">
                  The request must include a Cookie (<code>-b</code> or a Cookie header). It signs in as you: never share it.{" "}
                  <a href="https://developer.chrome.com/docs/devtools/network/reference#copy" target="_blank" rel="noreferrer">
                    Chrome DevTools copy guide
                    <ExternalIcon size={14} />
                    <span className="visually-hidden"> (opens in a new tab)</span>
                  </a>
                </p>
              </details>
              <TextAreaField
                label="Cookie header or copied cURL"
                spellCheck={false}
                autoComplete="off"
                value={cookies}
                onChange={(event) => setCookies(event.target.value)}
                error={fields.session_import}
                rows={5}
              />
            </>
          )}
          {result ? <Alert tone={result.ok ? "success" : "error"}>{result.text}</Alert> : null}
          <div className="form-actions">
            <button type="submit" className="button primary" disabled={!secret.trim() || mutation.isPending}>
              {mutation.isPending ? <Spinner size={16} /> : null}
              {mutation.isPending ? "Verifying…" : "Verify and sync"}
            </button>
          </div>
        </form>
      )}
    </details>
  );
}

/** Edit the Canvas source: name, address (probed before it replaces the old one) and default method. */
/** What the Base URL field allows: an account signed in on one Canvas site can't move to another. */
export function canvasAddressHint(bound: boolean): string {
  return bound
    ? "Signed in to an account on this Canvas site, so the address can't change here. To use a different Canvas site, use Disconnect and delete data in the Canvas section below (it deletes everything synced from Canvas), then add Canvas again with the new address."
    : "No account is signed in yet, so you can change the address. Sign in afterwards.";
}

export function CanvasEditDialog({
  source,
  status,
  open,
  onClose,
}: {
  source: SourceConnection;
  status: CanvasAuthStatus | undefined;
  open: boolean;
  onClose: () => void;
}) {
  const update = useUpdateSource();
  const toast = useToast();
  const [name, setName] = useState(source.name);
  const [baseUrl, setBaseUrl] = useState(source.base_url);
  const [method, setMethod] = useState<string>(status?.preferred_method ?? "");
  const fields = update.error instanceof ApiError ? update.error.fields : {};
  const general = update.error && Object.keys(fields).length === 0 ? update.error.message : null;
  // A signed-in account belongs to its Canvas site; another site means Disconnect and delete data first.
  const bound = Boolean(status?.account_id);

  useEffect(() => {
    if (!open) return;
    setName(source.name);
    setBaseUrl(source.base_url);
    setMethod(status?.preferred_method ?? "");
    update.reset();
    // Only when the dialog opens: reset the form from the saved source.
  }, [open]);

  const save = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      {
        id: source.id,
        name: name.trim() || source.name,
        ...(!bound && baseUrl.trim() !== source.base_url ? { base_url: baseUrl.trim() } : {}),
        default_auth_method: (method || null) as CanvasMethod | null,
      },
      {
        onSuccess: () => {
          toast("Source saved.");
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit source"
      footer={
        <>
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="canvas-edit-form" className="button primary" disabled={update.isPending}>
            {update.isPending ? <Spinner size={16} /> : null}
            Save source
          </button>
        </>
      }
    >
      <form id="canvas-edit-form" className="stack" onSubmit={save} noValidate>
        {general ? <Alert title="Probe failed">{general}</Alert> : null}
        <Field label="Name" value={name} onChange={(event) => setName(event.target.value)} error={fields.name} data-autofocus />
        <Field
          label="Base URL"
          type="url"
          inputMode="url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          readOnly={bound}
          error={fields.base_url}
          hint={canvasAddressHint(bound)}
        />
        <SelectField label="Default authentication" value={method} onChange={(event) => setMethod(event.target.value)}>
          <option value="">Automatic (OAuth → PAT → Browser session)</option>
          <option value="pat">PAT</option>
          <option value="browser_session">Browser session</option>
        </SelectField>
        <p className="muted">Source identity and history are preserved. If the probe fails, the existing working URL remains active.</p>
      </form>
    </Dialog>
  );
}
