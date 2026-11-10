import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router";
import { ApiError } from "../api";
import { ConnectCanvasForm } from "../canvas";
import { EndDemoDialog } from "../demo";
import { ImportCalendarDialog } from "../events";
import { formatDateTime, formatMinuteOfDay, formatMinutes, plural, syncOutcome, timeAgo } from "../format";
import { SyncIcon, UploadIcon } from "../icons";
import {
  browserTimeZone,
  useCalendarSources,
  useChangePassword,
  useConnection,
  useDeleteCalendarSource,
  useDisconnectCanvas,
  useIsDemo,
  useMe,
  useSettings,
  useSignOut,
  useSync,
  useUpdateSettings,
} from "../queries";
import { useNow } from "../shell";
import { useToast } from "../toast";
import type { CalendarSource, PlanSettings } from "../types";
import { Alert, Badge, Dialog, PageHeader, PasswordField, QueryError, SelectField, SkeletonList, Spinner } from "../ui";

function ProfileSection() {
  const me = useMe();
  const signOut = useSignOut();
  const [ending, setEnding] = useState(false);
  if (!me.data) return null;
  const demoExpires = me.data.demo_expires_at;
  return (
    <section className="card settings-section" aria-labelledby="profile-heading">
      <h2 id="profile-heading">Profile</h2>
      <dl className="detail-list">
        <div>
          <dt>Username</dt>
          <dd>{me.data.username}</dd>
        </div>
        {demoExpires ? (
          <div>
            <dt>Account</dt>
            <dd>
              <Badge tone="accent">Demo</Badge> Deleted on {formatDateTime(demoExpires)}
            </dd>
          </div>
        ) : (
          <div>
            <dt>Email</dt>
            <dd>{me.data.email}</dd>
          </div>
        )}
        <div>
          <dt>{demoExpires ? "Started" : "Member since"}</dt>
          <dd>{formatDateTime(me.data.created_at)}</dd>
        </div>
      </dl>
      <div className="form-actions">
        {demoExpires ? (
          <button type="button" className="button secondary" onClick={() => setEnding(true)}>
            End demo
          </button>
        ) : (
          <button type="button" className="button secondary" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
            Sign out
          </button>
        )}
      </div>
      <EndDemoDialog open={ending} onClose={() => setEnding(false)} />
    </section>
  );
}

function CanvasSection() {
  const connection = useConnection();
  const sync = useSync();
  const disconnect = useDisconnectCanvas();
  const demo = useIsDemo();
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
  const last = sync.run && sync.run.status !== "running" ? syncOutcome(sync.run) : null;

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
        {last && sync.run ? (
          <div>
            <dt>Latest sync</dt>
            <dd className="last-run">
              <Badge tone={last.tone}>{last.label}</Badge>
              <span>
                {sync.run.trigger === "scheduled" ? "Automatic" : "Started by you"},{" "}
                <time dateTime={sync.run.finished_at ?? sync.run.started_at} title={formatDateTime(sync.run.finished_at ?? sync.run.started_at)}>
                  {timeAgo(sync.run.finished_at ?? sync.run.started_at, now)}
                </time>
                : {plural(sync.run.courses_synced, "course")} checked, {last.detail.toLowerCase().startsWith("nothing") ? "nothing new" : plural(sync.run.changes_detected, "change")}
              </span>
            </dd>
          </div>
        ) : null}
      </dl>
      {last && last.tone !== "success" && sync.run?.error ? (
        <Alert tone={last.tone === "danger" ? "error" : "warning"} title={last.label}>
          {sync.run.error}
        </Alert>
      ) : null}
      {demo ? (
        <Alert tone="info" title="This demo isn't connected to a real Canvas">
          The courses, tasks, files and changes are sample data. Sync now finishes at once and finds nothing new. Create an account
          to connect your own Canvas with an access token.
        </Alert>
      ) : (
        <p className="muted">While you are connected, CanvasWatcher also checks Canvas for changes on its own.</p>
      )}

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
          {demo ? null : (
            <>
              <button type="button" className="button secondary" onClick={() => setReplacing(true)}>
                Replace token
              </button>
              <button type="button" className="button danger-ghost" onClick={() => setConfirming(true)}>
                Disconnect
              </button>
            </>
          )}
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

const GOAL_CHOICES = [30, 45, 60, 90, 120, 150, 180, 210, 240, 300, 360, 420, 480, 600];

/** Every half hour, plus `current` when it's off the grid (set through the API). */
function halfHours(from: number, to: number, current: number): number[] {
  const values = new Set<number>([current]);
  for (let minute = from; minute <= to; minute += 30) values.add(minute);
  return [...values].sort((a, b) => a - b);
}

function zoneNames(current: string): string[] {
  let names: string[] = [];
  try {
    names = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    names = [];
  }
  const device = browserTimeZone();
  return [...new Set([current, ...(device ? [device] : []), ...names])].sort();
}

function StudyPlanForm({ settings }: { settings: PlanSettings }) {
  const update = useUpdateSettings();
  const toast = useToast();
  const [draft, setDraft] = useState(settings);
  const device = browserTimeZone();
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const fields = update.error instanceof ApiError ? update.error.fields : {};
  const general = update.error && Object.keys(fields).length === 0 ? update.error.message : null;
  const tooShort = draft.study_end_minute - draft.study_start_minute < 15;
  const set = <K extends keyof PlanSettings>(key: K, value: PlanSettings[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (tooShort) return;
    const changes: Partial<PlanSettings> = {};
    for (const key of Object.keys(draft) as (keyof PlanSettings)[]) {
      if (draft[key] !== settings[key]) Object.assign(changes, { [key]: draft[key] });
    }
    update.mutate(changes, { onSuccess: () => toast("Study plan saved. Today's plan is updated.") });
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {general ? <Alert>{general}</Alert> : null}
      <SelectField
        label="Time zone"
        value={draft.time_zone}
        onChange={(event) => set("time_zone", event.target.value)}
        error={fields.time_zone}
        hint="Days, due dates and your study window follow this zone."
      >
        {zoneNames(draft.time_zone).map((zone) => (
          <option key={zone} value={zone}>
            {zone.replaceAll("_", " ")}
          </option>
        ))}
      </SelectField>
      {device && device !== draft.time_zone ? (
        <p className="inline-note">
          This device is set to {device.replaceAll("_", " ")}.{" "}
          <button type="button" className="link-button" onClick={() => set("time_zone", device)}>
            Use it
          </button>
        </p>
      ) : null}
      <SelectField
        label="Daily study goal"
        value={draft.daily_study_minutes}
        onChange={(event) => set("daily_study_minutes", Number(event.target.value))}
        error={fields.daily_study_minutes}
        hint="The most Today's plan asks of you in one day."
      >
        {[...new Set([...GOAL_CHOICES, draft.daily_study_minutes])]
          .sort((a, b) => a - b)
          .map((minutes) => (
            <option key={minutes} value={minutes}>
              {formatMinutes(minutes)}
            </option>
          ))}
      </SelectField>
      <div className="form-row">
        <SelectField
          label="Study from"
          value={draft.study_start_minute}
          onChange={(event) => set("study_start_minute", Number(event.target.value))}
          error={fields.study_start_minute}
        >
          {halfHours(0, 1410, draft.study_start_minute).map((minute) => (
            <option key={minute} value={minute}>
              {formatMinuteOfDay(minute)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Until"
          value={draft.study_end_minute}
          onChange={(event) => set("study_end_minute", Number(event.target.value))}
          error={tooShort ? "End your study window at least 15 minutes after it starts." : fields.study_end_minute}
        >
          {halfHours(30, 1440, draft.study_end_minute).map((minute) => (
            <option key={minute} value={minute}>
              {formatMinuteOfDay(minute)}
            </option>
          ))}
        </SelectField>
      </div>
      <p className="muted">
        The plan only uses free time inside this window. Busy events from your <Link to="/calendar">calendar</Link> don't count as free.
      </p>
      <div className="form-actions">
        <button type="submit" className="button primary" disabled={!dirty || update.isPending || tooShort}>
          {update.isPending ? <Spinner size={16} /> : null}
          Save study plan
        </button>
        {dirty ? (
          <button type="button" className="button ghost" onClick={() => setDraft(settings)} disabled={update.isPending}>
            Undo changes
          </button>
        ) : null}
      </div>
    </form>
  );
}

function StudyPlanSection() {
  const settings = useSettings();
  return (
    <section className="card settings-section" id="study-plan" aria-labelledby="study-plan-heading">
      <h2 id="study-plan-heading">Study plan</h2>
      {settings.isPending ? <SkeletonList rows={3} label="Loading your study plan" /> : null}
      {settings.isError ? <QueryError error={settings.error} retry={() => void settings.refetch()} /> : null}
      {/* A fresh form whenever the saved settings change. */}
      {settings.data ? <StudyPlanForm key={JSON.stringify(settings.data)} settings={settings.data} /> : null}
    </section>
  );
}

function CalendarsSection() {
  const sources = useCalendarSources();
  const remove = useDeleteCalendarSource();
  const toast = useToast();
  const now = useNow();
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<CalendarSource | null>(null);

  return (
    <section className="card settings-section" id="calendars" aria-labelledby="calendars-heading">
      <h2 id="calendars-heading">Calendars</h2>
      <p className="muted">
        Imported .ics files. To update one, remove it and import a new export. Events you add by hand live on the{" "}
        <Link to="/calendar">Calendar</Link> page.
      </p>
      {sources.isPending ? <SkeletonList rows={2} label="Loading calendars" /> : null}
      {sources.isError ? <QueryError error={sources.error} retry={() => void sources.refetch()} /> : null}
      {sources.data?.length === 0 ? <p className="inline-note">No calendars imported yet.</p> : null}
      {sources.data && sources.data.length > 0 ? (
        <ul className="source-list">
          {sources.data.map((source) => (
            <li key={source.id}>
              <div className="source-text">
                <p className="source-name">{source.name}</p>
                <p className="muted">
                  {plural(source.event_count, "event")} · imported{" "}
                  <time dateTime={source.imported_at} title={formatDateTime(source.imported_at)}>
                    {timeAgo(source.imported_at, now)}
                  </time>
                  {source.file_name ? ` from ${source.file_name}` : ""}
                </p>
              </div>
              <button type="button" className="button small danger-ghost" onClick={() => setRemoving(source)}>
                Remove<span className="visually-hidden"> {source.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="form-actions">
        <button type="button" className="button secondary" onClick={() => setImporting(true)}>
          <UploadIcon size={18} />
          Import .ics
        </button>
      </div>

      <ImportCalendarDialog open={importing} onClose={() => setImporting(false)} />
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove “${removing?.name ?? ""}”?`}
        size="small"
        footer={
          <>
            <button type="button" className="button ghost" onClick={() => setRemoving(null)}>
              Keep it
            </button>
            <button
              type="button"
              className="button danger"
              disabled={remove.isPending}
              onClick={() =>
                removing &&
                remove.mutate(removing.id, {
                  onSuccess: () => {
                    toast(`Removed ${removing.name}.`);
                    setRemoving(null);
                  },
                  onError: (error) => toast(error.message, "error"),
                })
              }
            >
              {remove.isPending ? <Spinner size={16} /> : null}
              Remove calendar
            </button>
          </>
        }
      >
        <p>
          Its {plural(removing?.event_count ?? 0, "event")} leave your calendar and stop taking time from your plan. Events you added by hand
          stay.
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
  const location = useLocation();
  const demo = useIsDemo();
  useEffect(() => {
    // #canvas is handled by its section, which may first open the token form.
    if (location.hash && location.hash !== "#canvas") document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [location.hash]);
  return (
    <div className="page">
      <PageHeader title="Settings" description="Your study plan, calendars, account and the Canvas connection." />
      <div className="settings-grid">
        <StudyPlanSection />
        <CalendarsSection />
        <CanvasSection />
        <ProfileSection />
        {demo ? null : <PasswordSection />}
      </div>
    </div>
  );
}
