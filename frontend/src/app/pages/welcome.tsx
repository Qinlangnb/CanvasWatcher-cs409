import { useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { ConnectCanvasForm, SyncProgress } from "../canvas";
import { BellIcon, ClipboardIcon, FolderIcon, LogoMark } from "../icons";
import { useConnection, useMe, useSignOut, useSync } from "../queries";
import { FullPageLoader } from "../shell";
import { useFocusHeading, usePageTitle } from "../ui";

const STEPS = ["Welcome", "Connect Canvas", "First sync"] as const;

function StepIndicator({ current }: { current: number }) {
  return (
    <ol className="steps" aria-label="Setup progress">
      {STEPS.map((label, index) => (
        <li
          key={label}
          className={index < current ? "done" : index === current ? "current" : undefined}
          aria-current={index === current ? "step" : undefined}
        >
          <span className="step-number" aria-hidden="true">
            {index + 1}
          </span>
          <span>
            {label}
            {index < current ? <span className="visually-hidden"> (done)</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** First-run setup: what CanvasWatcher does, connecting Canvas, and the first sync. */
export function WelcomePage() {
  const me = useMe();
  const connection = useConnection();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  // The shell is not mounted here, so this page refreshes the data when the first sync ends.
  const sync = useSync(() => {});
  usePageTitle(STEPS[step]);
  useFocusHeading(step);

  if (connection.isPending) return <FullPageLoader />;
  // Someone who arrives already connected has nothing to set up. (Later steps connect on purpose.)
  if (connection.data && step === 0) return <Navigate to="/" replace />;

  const run = sync.run;
  const finished = run !== null && run.status !== "running";

  return (
    <div className="onboarding">
      <header className="onboarding-header">
        <p className="brand">
          <LogoMark />
          <span>CanvasWatcher</span>
        </p>
        <button type="button" className="button ghost small" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
          Sign out
        </button>
      </header>
      <main className="onboarding-main" id="main">
        <StepIndicator current={step} />
        <div className="onboarding-card">
          {step === 0 ? (
            <>
              <h1 tabIndex={-1} data-page-heading>
                Welcome, {me.data?.username}
              </h1>
              <p className="lead">CanvasWatcher keeps an eye on your Canvas courses and tells you what changed.</p>
              <ul className="feature-list">
                <li>
                  <ClipboardIcon />
                  <div>
                    <strong>All your deadlines</strong>
                    <p>Assignments from every course, sorted by when they are due.</p>
                  </div>
                </li>
                <li>
                  <BellIcon />
                  <div>
                    <strong>Changes, explained</strong>
                    <p>When a due date moves or a file is replaced, you see exactly what changed.</p>
                  </div>
                </li>
                <li>
                  <FolderIcon />
                  <div>
                    <strong>Files in one place</strong>
                    <p>Search course files across all classes and download them directly.</p>
                  </div>
                </li>
              </ul>
              <div className="form-actions">
                <button type="button" className="button primary" onClick={() => setStep(1)}>
                  Get started
                </button>
              </div>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <h1 tabIndex={-1} data-page-heading>
                Connect your Canvas account
              </h1>
              <p className="lead">CanvasWatcher reads your courses with a personal access token that you create in Canvas.</p>
              <ConnectCanvasForm onConnected={() => setStep(2)} onCancel={() => setStep(0)} />
            </>
          ) : null}

          {step === 2 ? (
            <>
              <h1 tabIndex={-1} data-page-heading>
                {finished ? "You're all set" : "Syncing your courses"}
              </h1>
              {connection.data ? (
                <p className="lead">
                  Connected to <strong>{new URL(connection.data.base_url).host}</strong> as {connection.data.canvas_user_name}.
                </p>
              ) : null}
              <SyncProgress run={run} />
              <div className="form-actions">
                <button type="button" className="button primary" onClick={() => navigate("/", { replace: true })}>
                  {finished ? "Go to your dashboard" : "Continue while it syncs"}
                </button>
              </div>
            </>
          ) : null}
        </div>
      </main>
    </div>
  );
}
