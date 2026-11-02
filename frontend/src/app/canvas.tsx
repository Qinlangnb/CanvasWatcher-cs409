import { useState, type FormEvent } from "react";
import { ApiError } from "./api";
import { plural } from "./format";
import { ExternalIcon } from "./icons";
import { useConnectCanvas } from "./queries";
import type { CanvasConnection, SyncRun } from "./types";
import { Alert, Field, PasswordField, Spinner } from "./ui";

export const DEFAULT_CANVAS_URL = "https://canvas.illinois.edu";

/** Canvas's own page for creating an access token, if the address looks usable. */
function tokenSettingsUrl(baseUrl: string): string | null {
  try {
    const url = new URL(/^https?:\/\//i.test(baseUrl.trim()) ? baseUrl.trim() : `https://${baseUrl.trim()}`);
    return url.protocol === "https:" ? `${url.origin}/profile/settings` : null;
  } catch {
    return null;
  }
}

export function ConnectCanvasForm({
  initialBaseUrl = DEFAULT_CANVAS_URL,
  submitLabel = "Connect Canvas",
  onConnected,
  onCancel,
}: {
  initialBaseUrl?: string;
  submitLabel?: string;
  onConnected: (result: { connection: CanvasConnection; sync_run: SyncRun | null }) => void;
  onCancel?: () => void;
}) {
  const connect = useConnectCanvas();
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [token, setToken] = useState("");
  const [localError, setLocalError] = useState<Record<string, string>>({});
  const error = connect.error instanceof ApiError ? connect.error : null;
  const fields = { ...error?.fields, ...localError };
  const settingsUrl = tokenSettingsUrl(baseUrl);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problems: Record<string, string> = {};
    if (!baseUrl.trim()) problems.base_url = "Enter your school's Canvas address.";
    if (!token.trim()) problems.access_token = "Paste the access token you created in Canvas.";
    setLocalError(problems);
    if (Object.keys(problems).length > 0) return;
    connect.mutate({ base_url: baseUrl, access_token: token }, { onSuccess: onConnected });
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {error && Object.keys(error.fields).length === 0 ? <Alert title="Canvas could not be connected">{error.message}</Alert> : null}

      <Field
        label="Canvas address"
        name="base_url"
        type="url"
        inputMode="url"
        autoComplete="url"
        value={baseUrl}
        onChange={(event) => setBaseUrl(event.target.value)}
        hint="The address you use to open Canvas. You can paste any Canvas page."
        error={fields.base_url}
      />

      <ol className="token-steps">
        <li>
          Open your Canvas{" "}
          {settingsUrl ? (
            <a href={settingsUrl} target="_blank" rel="noreferrer">
              account settings
              <ExternalIcon size={14} />
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          ) : (
            "account settings"
          )}
          .
        </li>
        <li>
          Under <strong>Approved Integrations</strong>, choose <strong>+ New Access Token</strong>.
        </li>
        <li>
          Enter <strong>CanvasWatcher</strong> as the purpose, generate the token and copy it.
        </li>
      </ol>

      <PasswordField
        label="Access token"
        name="access_token"
        autoComplete="off"
        spellCheck={false}
        value={token}
        onChange={(event) => setToken(event.target.value)}
        error={fields.access_token}
      />

      <p className="privacy-note">
        CanvasWatcher only reads your courses. The token is encrypted before it is stored, and you can disconnect at any time
        in Settings.
      </p>

      <div className="form-actions">
        <button type="submit" className="button primary" disabled={connect.isPending}>
          {connect.isPending ? <Spinner size={16} /> : null}
          {connect.isPending ? "Checking with Canvas…" : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className="button ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** Live status of a sync for the onboarding screen. */
export function SyncProgress({ run }: { run: SyncRun | null }) {
  if (!run || run.status === "running") {
    return (
      <div className="sync-progress" role="status">
        <Spinner size={28} />
        <div>
          <p className="sync-progress-title">Reading your courses from Canvas…</p>
          <p className="muted">This usually takes less than a minute. You can keep this page open.</p>
        </div>
      </div>
    );
  }
  if (run.status === "failed") {
    return <Alert title="The first sync did not finish">{run.error}</Alert>;
  }
  return (
    <Alert tone={run.status === "partial" ? "warning" : "success"} title={`Found ${plural(run.courses_synced, "course")}`}>
      {run.status === "partial" ? run.error : "Your assignments, files and announcements are ready."}
    </Alert>
  );
}
