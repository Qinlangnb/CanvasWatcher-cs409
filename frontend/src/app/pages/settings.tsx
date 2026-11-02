import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "react-router";
import { ApiError } from "../api";
import { ConnectCanvasForm } from "../canvas";
import { formatDateTime, timeAgo } from "../format";
import { SyncIcon } from "../icons";
import { useChangePassword, useConnection, useDisconnectCanvas, useMe, useSignOut, useSync } from "../queries";
import { useNow } from "../shell";
import { useToast } from "../toast";
import { Alert, Badge, Dialog, PageHeader, PasswordField, Spinner } from "../ui";

function ProfileSection() {
  const me = useMe();
  const signOut = useSignOut();
  if (!me.data) return null;
  return (
    <section className="card settings-section" aria-labelledby="profile-heading">
      <h2 id="profile-heading">Profile</h2>
      <dl className="detail-list">
        <div>
          <dt>Username</dt>
          <dd>{me.data.username}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{me.data.email}</dd>
        </div>
        <div>
          <dt>Member since</dt>
          <dd>{formatDateTime(me.data.created_at)}</dd>
        </div>
      </dl>
      <div className="form-actions">
        <button type="button" className="button secondary" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
          Sign out
        </button>
      </div>
    </section>
  );
}

function CanvasSection() {
  const connection = useConnection();
  const sync = useSync();
  const disconnect = useDisconnectCanvas();
  const toast = useToast();
  const now = useNow(30_000);
  const location = useLocation();
  const rejected = connection.data?.status === "token_rejected";
  const [replacing, setReplacing] = useState(rejected);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (location.hash === "#canvas") document.getElementById("canvas")?.scrollIntoView({ block: "start" });
    if (rejected) setReplacing(true);
  }, [location.hash, rejected]);

  const data = connection.data;
  if (!data) return null;

  return (
    <section className="card settings-section" id="canvas" aria-labelledby="canvas-heading">
      <h2 id="canvas-heading">Canvas</h2>
      <dl className="detail-list">
        <div>
          <dt>Canvas address</dt>
          <dd>{new URL(data.base_url).host}</dd>
        </div>
        <div>
          <dt>Canvas account</dt>
          <dd>{data.canvas_user_name}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{rejected ? <Badge tone="danger">Needs a new token</Badge> : <Badge tone="success">Connected</Badge>}</dd>
        </div>
        <div>
          <dt>Last synced</dt>
          <dd>
            {sync.running ? (
              "Syncing now…"
            ) : (
              <time dateTime={data.last_synced_at ?? undefined} title={formatDateTime(data.last_synced_at)}>
                {timeAgo(data.last_synced_at, now)}
              </time>
            )}
          </dd>
        </div>
      </dl>
      <p className="muted">While you are connected, CanvasWatcher also checks Canvas for changes on its own.</p>

      {replacing ? (
        <div className="subsection">
          <h3>Replace access token</h3>
          {rejected ? (
            <Alert tone="warning">Canvas no longer accepts the saved token. It may have expired or been deleted in Canvas.</Alert>
          ) : null}
          <p className="muted">A token from a different Canvas account replaces everything synced so far.</p>
          <ConnectCanvasForm
            initialBaseUrl={data.base_url}
            submitLabel="Save new token"
            onConnected={() => {
              setReplacing(false);
              toast("Canvas reconnected. Syncing now.");
            }}
            onCancel={rejected ? undefined : () => setReplacing(false)}
          />
        </div>
      ) : (
        <div className="form-actions">
          <button
            type="button"
            className="button primary"
            disabled={sync.running}
            onClick={() => sync.start.mutate(undefined, { onError: (error) => toast(error.message, "error") })}
          >
            <SyncIcon size={18} className={sync.running ? "spin" : undefined} />
            {sync.running ? "Syncing…" : "Sync now"}
          </button>
          <button type="button" className="button secondary" onClick={() => setReplacing(true)}>
            Replace token
          </button>
          <button type="button" className="button danger-ghost" onClick={() => setConfirming(true)}>
            Disconnect
          </button>
        </div>
      )}

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Disconnect Canvas?"
        size="small"
        footer={
          <>
            <button type="button" className="button ghost" onClick={() => setConfirming(false)}>
              Keep connected
            </button>
            <button
              type="button"
              className="button danger"
              disabled={disconnect.isPending}
              onClick={() =>
                disconnect.mutate(undefined, {
                  onSuccess: () => toast("Canvas disconnected. Synced data was deleted."),
                  onError: (error) => toast(error.message, "error"),
                })
              }
            >
              {disconnect.isPending ? <Spinner size={16} /> : null}
              Disconnect and delete data
            </button>
          </>
        }
      >
        <p>
          CanvasWatcher deletes the saved token and everything synced from Canvas: courses, tasks, files and the change history.
          Your CanvasWatcher account stays, and you can connect again at any time.
        </p>
      </Dialog>
    </section>
  );
}

function PasswordSection() {
  const change = useChangePassword();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const apiError = change.error instanceof ApiError ? change.error : null;
  const fields: Record<string, string | undefined> = { ...apiError?.fields, ...local };
  if (apiError?.code === "WRONG_PASSWORD") fields.current_password = apiError.message;
  const general = apiError && Object.keys(apiError.fields).length === 0 && apiError.code !== "WRONG_PASSWORD" ? apiError.message : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problems: Record<string, string> = {};
    if (!current) problems.current_password = "Enter your current password.";
    if (next.length < 12) problems.new_password = "Use at least 12 characters.";
    else if (next !== confirm) problems.confirm_password = "The two new passwords do not match.";
    setLocal(problems);
    if (Object.keys(problems).length > 0) return;
    change.mutate(
      { current_password: current, new_password: next },
      {
        onSuccess: () => {
          setCurrent("");
          setNext("");
          setConfirm("");
          toast("Password changed. Other devices were signed out.");
        },
      },
    );
  };

  return (
    <section className="card settings-section" aria-labelledby="password-heading">
      <h2 id="password-heading">Password</h2>
      <form className="stack narrow" onSubmit={submit} noValidate>
        {general ? <Alert>{general}</Alert> : null}
        <PasswordField
          label="Current password"
          name="current_password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          error={fields.current_password}
        />
        <PasswordField
          label="New password"
          name="new_password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          hint="At least 12 characters. Changing it signs out your other devices."
          error={fields.new_password}
        />
        <PasswordField
          label="Confirm new password"
          name="confirm_password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          error={fields.confirm_password}
        />
        <div className="form-actions">
          <button type="submit" className="button primary" disabled={change.isPending}>
            {change.isPending ? <Spinner size={16} /> : null}
            Change password
          </button>
        </div>
      </form>
    </section>
  );
}

export function SettingsPage() {
  return (
    <div className="page">
      <PageHeader title="Settings" description="Your account and the Canvas connection." />
      <div className="settings-grid">
        <CanvasSection />
        <ProfileSection />
        <PasswordSection />
      </div>
    </div>
  );
}
