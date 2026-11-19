// Gradescope and PrairieLearn: the add form, and on the Gradescope card Discover courses → link to a
// course here → Sync mapped courses, plus the task mappings the sync could not decide on its own.
// Both are read-only and sign in through the Local Auth Broker.
import { useState, type FormEvent } from "react";
import { problemsOf } from "../forms";
import { formatDateTime } from "../format";
import { UnavailableButton } from "../preview";
import { useCourses } from "../queries";
import { Alert, Field, SelectField, Spinner } from "../ui";
import { PRAIRIELEARN_NOTE, PROVIDER_DEFAULT_URLS, syncFeedback, type ProviderAssignmentRow, type ProviderCourse, type ProviderType } from "./model";
import {
  useCourseMappings,
  useCreateProviderSource,
  useDiscoverCourses,
  useMapCourse,
  useMapTask,
  useProviderAssignments,
  useSourcesLocked,
  useSyncSource,
  useUnmapCourse,
} from "./queries";
import { registerSourceUi, type AddFormProps, type CardExtrasProps } from "./registry";

/** Adds a Gradescope or PrairieLearn instance; signing in happens on its card afterwards. */
function ProviderAddForm({ provider, onDone }: AddFormProps & { provider: ProviderType }) {
  const create = useCreateProviderSource();
  const courses = useCourses(false, provider === "gradescope");
  const [baseUrl, setBaseUrl] = useState(PROVIDER_DEFAULT_URLS[provider]);
  const [course, setCourse] = useState("");
  const problems = problemsOf(create.error);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    create.mutate({ type: provider, base_url: baseUrl.trim(), course_id: course ? Number(course) : null }, { onSuccess: (source) => onDone(source) });
  };
  return (
    <form className="stack" onSubmit={submit} noValidate>
      {problems.general ? <Alert>{problems.general}</Alert> : null}
      <Field
        label="Provider instance URL"
        type="url"
        inputMode="url"
        required
        value={baseUrl}
        onChange={(event) => setBaseUrl(event.target.value)}
        error={problems.fields.base_url}
        data-autofocus
      />
      {provider === "gradescope" ? (
        <SelectField label="Optional Canvas course for LTI sign-in" value={course} onChange={(event) => setCourse(event.target.value)} error={problems.fields.course_id}>
          <option value="">Direct Gradescope / school SSO</option>
          {courses.data?.map((row) => (
            <option key={row.id} value={row.id}>
              {row.code} · {row.name}
            </option>
          ))}
        </SelectField>
      ) : null}
      <p className="muted">Read-only integration. After saving, sign in through the Local Auth Broker; passwords and MFA stay on the official website.</p>
      {provider === "prairielearn" ? <p className="inline-note">Student assessment parsing is not yet verified with an enrolled course.</p> : null}
      <div className="form-actions">
        <button type="submit" className="button primary" disabled={create.isPending}>
          {create.isPending ? <Spinner size={16} /> : null}
          {create.isPending ? "Saving…" : "Add source"}
        </button>
      </div>
    </form>
  );
}

/** One discovered Gradescope course: link it to a course here. */
function DiscoveredCourse({ sourceId, row, locked }: { sourceId: string; row: ProviderCourse; locked: boolean }) {
  const courses = useCourses();
  const map = useMapCourse();
  const [choice, setChoice] = useState(row.mapped_course_id ? String(row.mapped_course_id) : "");
  const [done, setDone] = useState(row.mapped_course_id !== null);
  const linked = courses.data?.find((course) => course.id === Number(choice));
  return (
    <li className="provider-course">
      <p className="provider-course-name">
        <strong>{row.course_code}</strong> · {row.name}
        {row.term ? ` · ${row.term}` : ""}
      </p>
      {done ? (
        <p className="inline-note">Linked to {linked ? `${linked.code} · ${linked.name}` : "a course"}.</p>
      ) : (
        <div className="provider-course-map">
          <SelectField label="Link to existing course" value={choice} disabled={map.isPending || locked} onChange={(event) => setChoice(event.target.value)}>
            <option value="">Choose the matching course</option>
            {courses.data?.map((course) => (
              <option key={course.id} value={course.id}>
                {course.code} · {course.term?.display_name ?? course.name}
              </option>
            ))}
          </SelectField>
          {locked ? (
            <UnavailableButton className="button secondary small">Confirm course mapping</UnavailableButton>
          ) : (
            <button
              type="button"
              className="button secondary small"
              disabled={!choice || map.isPending}
              onClick={() =>
                map.mutate(
                  { id: sourceId, provider_course_id: row.external_id, course_id: Number(choice), course_code: row.course_code, name: row.name },
                  { onSuccess: () => setDone(true) },
                )
              }
            >
              {map.isPending ? <Spinner size={14} /> : null}
              Confirm course mapping
            </button>
          )}
          {map.error ? (
            <p className="form-error" role="alert">
              {map.error.message}
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}

/** An assignment the sync could not match on its own: pick its task, or keep it separate. */
function TaskMapping({ sourceId, row, locked }: { sourceId: string; row: ProviderAssignmentRow; locked: boolean }) {
  const mapTask = useMapTask();
  const [choice, setChoice] = useState(row.candidates[0] ? String(row.candidates[0].id) : "separate");
  const confirm = () =>
    mapTask.mutate({ id: sourceId, provider_course_id: row.provider_course_id, assignment_id: row.assignment_id, task_id: choice === "separate" ? null : Number(choice) });
  return (
    <li className="provider-course">
      <p className="provider-course-name">
        <strong>{row.title}</strong>
        {row.due_at ? <span className="muted"> · due {formatDateTime(row.due_at)}</span> : null}
      </p>
      <div className="provider-course-map">
        <SelectField label="Matching task" value={choice} disabled={mapTask.isPending || locked} onChange={(event) => setChoice(event.target.value)}>
          {row.candidates.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
              {task.due_at ? ` · ${formatDateTime(task.due_at)}` : ""}
            </option>
          ))}
          <option value="separate">Keep as its own task</option>
        </SelectField>
        {locked ? (
          <UnavailableButton className="button secondary small">Confirm</UnavailableButton>
        ) : (
          <button type="button" className="button secondary small" disabled={mapTask.isPending} onClick={confirm}>
            {mapTask.isPending ? <Spinner size={14} /> : null}
            Confirm
          </button>
        )}
      </div>
      {mapTask.error ? (
        <p className="form-error" role="alert">
          {mapTask.error.message}
        </p>
      ) : null}
    </li>
  );
}

/** The Gradescope card: Discover courses, Sync mapped courses, linked courses and task mappings. */
function GradescopeCourses({ source }: CardExtrasProps) {
  const locked = useSourcesLocked();
  const discover = useDiscoverCourses();
  const sync = useSyncSource();
  const mappings = useCourseMappings(source.id);
  const unmap = useUnmapCourse();
  const pending = useProviderAssignments(source.id, true, (mappings.data?.mappings.length ?? 0) > 0);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const rows = discover.data;
  const linked = mappings.data?.mappings ?? [];

  const runSync = () => {
    setMessage(null);
    sync.mutate(source, {
      onSuccess: (result) => {
        const feedback = syncFeedback(result);
        setMessage({ ok: feedback.ok, text: feedback.ok ? feedback.message : feedback.message || "Some provider rows could not be verified; existing data was preserved." });
      },
      onError: (error) => setMessage({ ok: false, text: error.message }),
    });
  };

  return (
    <section className="stack provider-courses" aria-label="Provider course mapping">
      <div className="form-actions">
        {locked ? (
          <>
            <UnavailableButton className="button secondary small">Discover courses</UnavailableButton>
            <UnavailableButton className="button secondary small">Sync mapped courses</UnavailableButton>
          </>
        ) : (
          <>
            <button type="button" className="button secondary small" disabled={discover.isPending || !source.enabled} onClick={() => discover.mutate(source.id)}>
              {discover.isPending ? <Spinner size={14} /> : null}
              Discover courses
            </button>
            <button type="button" className="button secondary small" disabled={sync.isPending || !source.enabled || linked.length === 0} onClick={runSync}>
              {sync.isPending ? <Spinner size={14} /> : null}
              {sync.isPending ? "Syncing…" : "Sync mapped courses"}
            </button>
          </>
        )}
      </div>
      {discover.error ? (
        <p className="form-error" role="alert">
          {discover.error.message}
        </p>
      ) : null}
      {message ? (
        <p className={message.ok ? "inline-note" : "form-error"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      ) : null}
      {rows?.length === 0 ? <p className="muted">No student courses were visible. Existing courses were not removed.</p> : null}
      {rows && rows.length > 0 ? (
        <ul className="provider-course-list">
          {rows.map((row) => (
            <DiscoveredCourse key={row.external_id} sourceId={source.id} row={row} locked={locked} />
          ))}
        </ul>
      ) : null}
      {linked.length > 0 ? (
        <div className="subsection">
          <h4>Linked courses</h4>
          <ul className="provider-course-list">
            {linked.map((row) => (
              <li key={row.provider_course_id} className="provider-course provider-course-linked">
                <span>
                  {row.course_code} · {row.name}
                </span>
                {locked ? null : (
                  <button
                    type="button"
                    className="button ghost small"
                    disabled={unmap.isPending}
                    onClick={() => unmap.mutate({ id: source.id, providerCourseId: row.provider_course_id })}
                  >
                    Unlink
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {pending.data && pending.data.length > 0 ? (
        <div className="subsection">
          <h4>Confirm task mappings</h4>
          <p className="muted">These Gradescope assignments look like more than one of your tasks, or like one only by name. Choose the task each one is.</p>
          <ul className="provider-course-list">
            {pending.data.map((row) => (
              <TaskMapping key={row.id} sourceId={source.id} row={row} locked={locked} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function PrairieLearnNote() {
  return <p className="inline-note">{PRAIRIELEARN_NOTE}</p>;
}

registerSourceUi("gradescope", {
  AddForm: (props) => <ProviderAddForm {...props} provider="gradescope" />,
  CardExtras: GradescopeCourses,
});

registerSourceUi("prairielearn", {
  AddForm: (props) => <ProviderAddForm {...props} provider="prairielearn" />,
  CardExtras: PrairieLearnNote,
});
