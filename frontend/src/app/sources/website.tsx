// Course websites: the add/edit form (with Test connection), the NTLM sign-in form on the card, and
// the card's status line and pending resources. Registered with the sources registry at the bottom.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { problemsOf } from "../forms";
import { formatDateTime } from "../format";
import { useCourseTerms } from "../parityQueries";
import { UnavailableButton } from "../preview";
import { useCourses } from "../queries";
import { useToast } from "../toast";
import { Alert, Dialog, Field, PasswordField, SelectField, Spinner } from "../ui";
import {
  pendingNote,
  websiteCredentialLine,
  websiteDraft,
  websiteNetworkChanged,
  websitePayload,
  type SourceConnection,
  type WebsiteDraft,
} from "./model";
import { useForgetWebsitePassword, useSaveWebsite, useSourcesLocked, useTestWebsite, useWebsiteCredential, useWebsiteDetails } from "./queries";
import { registerSourceUi, type AddFormProps, type CardExtrasProps, type EditDialogProps } from "./registry";

/** Use an existing term, or type a new one (the original's TermPicker). */
function TermPicker({
  terms,
  value,
  onChange,
  keepHint,
}: {
  terms: string[];
  value: string;
  onChange: (value: string) => void;
  /** Editing a course with no term: blank keeps it unchanged. */
  keepHint: boolean;
}) {
  const name = useId();
  const [mode, setMode] = useState<"existing" | "new">(terms.includes(value) ? "existing" : "new");
  return (
    <fieldset className="choice-group term-picker">
      <legend>Term</legend>
      <div className="choice-options">
        <label className="choice">
          <input
            type="radio"
            name={name}
            checked={mode === "existing"}
            disabled={terms.length === 0}
            onChange={() => {
              setMode("existing");
              onChange(terms[0] ?? "");
            }}
          />
          Use existing term
        </label>
        <label className="choice">
          <input
            type="radio"
            name={name}
            checked={mode === "new"}
            onChange={() => {
              setMode("new");
              onChange("");
            }}
          />
          Create new term
        </label>
      </div>
      {mode === "existing" ? (
        <SelectField label="Existing term" value={value} onChange={(event) => onChange(event.target.value)}>
          {terms.map((term) => (
            <option key={term} value={term}>
              {term}
            </option>
          ))}
        </SelectField>
      ) : (
        <Field
          label="New term name"
          value={value}
          placeholder="Fall 2026"
          required={!keepHint}
          onChange={(event) => onChange(event.target.value)}
          hint={keepHint ? "Leave blank to keep the existing course term unchanged." : undefined}
        />
      )}
    </fieldset>
  );
}

/**
 * Add or edit a course website. Test connection never saves; saving changed access settings probes
 * them first, and a new password only replaces a working one once it is verified.
 */
export function WebsiteForm({ source, onDone }: { source: SourceConnection | null; onDone: (source: SourceConnection) => void }) {
  const details = useWebsiteDetails(source?.id ?? null);
  const termsQuery = useCourseTerms();
  if (source && details.isPending) return <Spinner label="Loading the website settings" />;
  if (source && details.isError) return <Alert>{details.error.message}</Alert>;
  if (!source && termsQuery.isPending) return <Spinner label="Loading terms" />;
  const terms = (termsQuery.data ?? []).map((term) => term.display_name);
  const defaultTerm = termsQuery.data?.find((term) => term.is_default)?.display_name ?? terms[0] ?? "";
  return <WebsiteFormBody key={source?.id ?? "new"} source={source} details={details.data ?? null} terms={terms} defaultTerm={defaultTerm} onDone={onDone} />;
}

function WebsiteFormBody({
  source,
  details,
  terms,
  defaultTerm,
  onDone,
}: {
  source: SourceConnection | null;
  details: ReturnType<typeof useWebsiteDetails>["data"] | null;
  terms: string[];
  defaultTerm: string;
  onDone: (source: SourceConnection) => void;
}) {
  const editing = source !== null;
  const initial = useMemo(() => websiteDraft(source, details, defaultTerm), [source, details, defaultTerm]);
  const [draft, setDraft] = useState<WebsiteDraft>(initial);
  const storedUsername = details?.credential?.username ?? null;
  const [username, setUsername] = useState(storedUsername ?? "");
  const [password, setPassword] = useState("");
  const [existingCourse, setExistingCourse] = useState("");
  const courses = useCourses(false, !editing);
  const save = useSaveWebsite();
  const test = useTestWebsite();
  const toast = useToast();
  const composing = useRef(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const problems = problemsOf(save.error ?? test.error);
  const ntlm = draft.authentication_method === "ntlm";
  const ownsCourse = !editing || details?.course?.owned !== false;
  const linking = !editing && existingCourse !== "";
  const dirty = !editing || JSON.stringify(draft) !== JSON.stringify(initial) || password !== "" || username.trim() !== (storedUsername ?? "");
  const busy = save.isPending || test.isPending;

  const set = (key: keyof WebsiteDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setResult(null);
  };

  const body = (testOnly: boolean) => {
    const payload = websitePayload(draft, initial, { username, password, storedUsername }, { editing, testOnly });
    return linking ? { ...payload, course_id: Number(existingCourse), course_code: undefined, course_name: undefined, term: undefined } : payload;
  };

  const runTest = () => {
    if (busy) return;
    save.reset();
    setResult(null);
    test.mutate(
      { id: source?.id ?? null, body: body(true) },
      { onSuccess: (verification) => setResult({ ok: verification.verified || !ntlm, text: verification.message }) },
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || composing.current || !dirty) return;
    test.reset();
    setResult(null);
    save.mutate(
      { id: source?.id ?? null, body: body(false) },
      {
        onSuccess: (saved) => {
          setPassword("");
          toast(editing ? "Website saved." : "Website added. Use Sync now to read it.");
          onDone(saved.source);
        },
      },
    );
  };

  return (
    <form
      className="stack website-form"
      onSubmit={submit}
      noValidate
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={() => (composing.current = false)}
    >
      {problems.general ? <Alert>{problems.general}</Alert> : null}
      {!editing ? (
        <SelectField label="Course" value={existingCourse} onChange={(event) => setExistingCourse(event.target.value)} error={problems.fields.course_id}>
          <option value="">Create a course for this website</option>
          {courses.data?.map((course) => (
            <option key={course.id} value={course.id}>
              Add to {course.code} · {course.name}
            </option>
          ))}
        </SelectField>
      ) : null}
      {!linking && ownsCourse ? (
        <>
          <Field
            label="Subject / Course code"
            required
            placeholder="TEST 101"
            value={draft.course_code}
            onChange={(event) => set("course_code", event.target.value)}
            error={problems.fields.course_code}
            data-autofocus
          />
          <Field
            label="Description"
            required
            placeholder="Short course title or description"
            value={draft.course_name}
            onChange={(event) => set("course_name", event.target.value)}
            error={problems.fields.course_name}
          />
          <TermPicker terms={terms} value={draft.term} onChange={(value) => set("term", value)} keepHint={editing && !initial.term} />
        </>
      ) : null}
      <Field
        label="Course website URL"
        type="url"
        inputMode="url"
        required
        placeholder="https://courses.example.edu/course/"
        value={draft.base_url}
        onChange={(event) => set("base_url", event.target.value)}
        error={problems.fields.base_url}
      />
      <SelectField
        label="Authentication"
        value={draft.authentication_method}
        onChange={(event) => {
          set("authentication_method", event.target.value);
          setPassword("");
        }}
      >
        <option value="none">Public</option>
        <option value="ntlm">NTLM (username and password)</option>
      </SelectField>
      {ntlm ? (
        <>
          <Field
            label="Username"
            autoComplete="username"
            placeholder="Your website account (domain\username if required)"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            error={problems.fields.username}
          />
          <PasswordField
            label="Password"
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={problems.fields.password}
            hint={
              editing
                ? "Storage follows the server credential policy. Leave blank to keep a matching saved password. Label-only edits do not need a password."
                : "Storage follows the server credential policy. Public pages alone do not verify protected access."
            }
          />
          {details?.credential?.last_error_code === "protected_access_not_verified" ? (
            <p className="inline-note">Public website reachable. Protected access not yet verified.</p>
          ) : null}
          <details className="advanced-import">
            <summary>Advanced access settings</summary>
            <div className="stack">
              <Field
                label="Protected resource path (optional, usually detected)"
                placeholder="Leave empty to use the course website path"
                value={draft.protected_path_prefix}
                onChange={(event) => set("protected_path_prefix", event.target.value)}
                error={problems.fields.protected_path_prefix}
              />
              <Field
                label="Protected test page (optional)"
                type="url"
                inputMode="url"
                value={draft.probe_url}
                onChange={(event) => set("probe_url", event.target.value)}
                error={problems.fields.probe_url}
              />
              <p className="muted">Existing narrow scopes are retained. Credentials are never sent outside this source's trusted path and origin.</p>
            </div>
          </details>
        </>
      ) : null}
      <details className="advanced-import">
        <summary>Advanced source settings</summary>
        <div className="stack">
          <Field
            label="Source label"
            placeholder={`${draft.course_code || "Course"} Site`}
            value={draft.name}
            onChange={(event) => set("name", event.target.value)}
            error={problems.fields.name}
          />
          <Field
            label="Discovery path limit"
            type="number"
            inputMode="numeric"
            min={1}
            max={10000}
            value={draft.discovery_path_limit}
            onChange={(event) => set("discovery_path_limit", event.target.value)}
            error={problems.fields.discovery_path_limit}
            hint="Most pages and files read per sync (1 to 10000)."
          />
          <Field
            label="Monday of week 1 (optional)"
            type="date"
            value={draft.week_1_monday}
            onChange={(event) => set("week_1_monday", event.target.value)}
            error={problems.fields.week_1_monday}
            hint="Turns a homework schedule table on the website into date-only tasks."
          />
        </div>
      </details>
      <p className="muted">Test connection does not save. Saving changed access settings verifies them again before replacing the working configuration.</p>
      {result ? (
        <p className={result.ok ? "inline-note" : "form-error"} role={result.ok ? "status" : "alert"}>
          {result.text}
        </p>
      ) : null}
      <div className="form-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={runTest}>
          {test.isPending ? <Spinner size={16} /> : null}
          {test.isPending ? "Checking…" : "Test connection"}
        </button>
        <button type="submit" className="button primary" disabled={busy || !dirty}>
          {save.isPending ? <Spinner size={16} /> : null}
          {save.isPending ? (editing && websiteNetworkChanged(initial, draft) ? "Verifying…" : "Saving…") : "Save website"}
        </button>
      </div>
    </form>
  );
}

function WebsiteAddForm({ onDone }: AddFormProps) {
  return <WebsiteForm source={null} onDone={onDone} />;
}

export function WebsiteEditDialog({ source, open, onClose }: EditDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Edit course website">
      {open ? <WebsiteForm source={source} onDone={onClose} /> : null}
    </Dialog>
  );
}

/** Signs the website in again; pending protected resources are retried right after. */
function WebsiteCredentialForm({ source, username: stored }: { source: SourceConnection; username: string | null }) {
  const credential = useWebsiteCredential();
  const [username, setUsername] = useState(stored ?? "");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const problems = problemsOf(credential.error);
  useEffect(() => {
    if (stored) setUsername((current) => current || stored);
  }, [stored]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setMessage(null);
    credential.mutate(
      { id: source.id, username, password },
      {
        onSuccess: (result) => {
          setPassword("");
          const synced = result.sync && result.sync.state === "READY";
          setMessage(
            result.verification?.verified
              ? { ok: true, text: synced ? "Verified and synchronized." : "Verified. Pending resources are retried on the next sync." }
              : { ok: false, text: result.verification?.message ?? "Verification failed." },
          );
        },
      },
    );
  };
  return (
    <form className="stack website-credential-form" onSubmit={submit} noValidate>
      {problems.general ? <Alert>{problems.general}</Alert> : null}
      <Field label="Username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} error={problems.fields.username} />
      <PasswordField label="Password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} error={problems.fields.password} />
      {message ? (
        <p className={message.ok ? "inline-note" : "form-error"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="button primary small" disabled={!password || !username.trim() || credential.isPending}>
          {credential.isPending ? <Spinner size={14} /> : null}
          {credential.isPending ? "Verifying…" : "Verify and sync"}
        </button>
      </div>
    </form>
  );
}

/** The website card: course line with pending resources, credential status, Edit and Authenticate. */
function WebsiteCardExtras({ source }: CardExtrasProps) {
  const details = useWebsiteDetails(source.id);
  const locked = useSourcesLocked();
  const forget = useForgetWebsitePassword();
  const [editing, setEditing] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const data = details.data;
  const ntlm = (data?.config.authentication_method ?? source.config_json.authentication_method) === "ntlm";
  const pending = data?.pending ?? [];
  return (
    <div className="stack website-card">
      <p className="muted">
        {data?.course ? `${data.course.code} · ${data.course.name}` : source.course_id ? "Course-linked source" : "Account-level source"}
        {pendingNote(pending)}
      </p>
      {ntlm ? (
        <p className="inline-note" role="status">
          {websiteCredentialLine(data)}
          {data?.credential?.verified_at && data.credential.present ? ` Last verified ${formatDateTime(data.credential.verified_at)}.` : ""} This website uses
          its own NTLM credentials; Canvas or Gradescope browser sign-in does not authenticate it.
        </p>
      ) : null}
      <div className="form-actions">
        {locked ? (
          <UnavailableButton className="button secondary small">Edit</UnavailableButton>
        ) : (
          <button type="button" className="button secondary small" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        {ntlm ? (
          locked ? (
            <UnavailableButton className="button secondary small">Authenticate</UnavailableButton>
          ) : (
            <button type="button" className="button secondary small" aria-expanded={authOpen} onClick={() => setAuthOpen((open) => !open)}>
              {authOpen ? "Hide authentication" : "Authenticate"}
            </button>
          )
        ) : null}
        {ntlm && data?.credential?.present && !locked ? (
          <button type="button" className="button ghost small" disabled={forget.isPending} onClick={() => forget.mutate(source.id)}>
            Forget password
          </button>
        ) : null}
      </div>
      {authOpen && !locked ? <WebsiteCredentialForm source={source} username={data?.credential?.username ?? null} /> : null}
      {pending.length > 0 ? (
        <details className="diagnostics pending-resources">
          <summary>Pending resources ({pending.length})</summary>
          <p className="muted">Retried first on the next sync{ntlm ? ", and right after you sign in again" : ""}.</p>
          <ul>
            {pending.map((row) => (
              <li key={row.id}>
                <span className="pending-title">{row.title || row.url}</span>{" "}
                <span className="muted">
                  {row.state.replaceAll("_", " ").toLowerCase()}
                  {row.last_error_code ? ` · ${row.last_error_code}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <WebsiteEditDialog source={source} open={editing} onClose={() => setEditing(false)} />
    </div>
  );
}

registerSourceUi("website", {
  AddForm: WebsiteAddForm,
  CardExtras: WebsiteCardExtras,
  EditDialog: WebsiteEditDialog,
  authNote: (source) =>
    source.config_json.authentication_method === "ntlm"
      ? "NTLM authentication · Storage follows the server credential policy above."
      : "Public website · no sign-in needed.",
});
