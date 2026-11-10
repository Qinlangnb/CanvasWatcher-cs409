import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { formatDateTime, formatShortDate } from "./format";
import { ExternalIcon } from "./icons";
import { useDemoAvailability, useIsDemo, useMe, useResetDemo, useSignOut, useStartDemo } from "./queries";
import { useToast } from "./toast";
import { Alert, Dialog, Spinner } from "./ui";

// Demo accounts: one per visitor, filled with sample data, deleted when the visitor ends the demo or after a week.

/** The sign-in page's way in for people without Canvas. Shown only when the server offers demos. */
export function TryDemo() {
  const availability = useDemoAvailability();
  const start = useStartDemo();
  if (!availability.data?.enabled) return null;
  const days = availability.data.lifetime_days;
  return (
    <div className="demo-start">
      <p className="divider-text">
        <span>or</span>
      </p>
      {start.error ? <Alert>{start.error.message}</Alert> : null}
      <button type="button" className="button secondary full" onClick={() => start.mutate()} disabled={start.isPending}>
        {start.isPending ? <Spinner size={16} /> : null}
        {start.isPending ? "Setting up your demo…" : "Try a demo"}
      </button>
      <p className="demo-note">
        Explore with sample courses. No Canvas account needed. The demo is deleted when you end it or after {days} days.
      </p>
    </div>
  );
}

/** Puts the sample data back after a confirmation, then shows Today. */
export function ResetDemoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const reset = useResetDemo();
  const toast = useToast();
  const navigate = useNavigate();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Reset the sample data?"
      size="small"
      footer={
        <>
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            disabled={reset.isPending}
            onClick={() =>
              reset.mutate(undefined, {
                onSuccess: () => {
                  onClose();
                  navigate("/");
                  toast("Sample data reset.");
                },
                onError: (error) => toast(error.message, "error"),
              })
            }
          >
            {reset.isPending ? <Spinner size={16} /> : null}
            Reset sample data
          </button>
        </>
      }
    >
      <p>Tasks, events, read changes and settings go back to fresh sample data, with due dates counted from today.</p>
    </Dialog>
  );
}

/** Signing out of a demo deletes it, so it asks first. */
export function EndDemoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const signOut = useSignOut();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="End the demo?"
      size="small"
      footer={
        <>
          <button type="button" className="button ghost" onClick={onClose}>
            Keep exploring
          </button>
          <button type="button" className="button danger" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
            {signOut.isPending ? <Spinner size={16} /> : null}
            End demo and delete data
          </button>
        </>
      }
    >
      <p>The demo account and everything you did in it are deleted. This can't be undone. Create an account to keep your own data.</p>
    </Dialog>
  );
}

/** Shown above every page while a demo is signed in. */
export function DemoBanner() {
  const me = useMe();
  const [dialog, setDialog] = useState<"reset" | "end" | null>(null);
  const expires = me.data?.demo_expires_at;
  if (!expires) return null;
  return (
    <div className="banner demo-banner">
      <Alert
        tone="info"
        title="Demo account"
        action={
          <div className="alert-buttons">
            <button type="button" className="button small secondary" onClick={() => setDialog("reset")}>
              Reset data
            </button>
            <button type="button" className="button small ghost" onClick={() => setDialog("end")}>
              End demo
            </button>
          </div>
        }
      >
        <span title={formatDateTime(expires)}>
          Sample data only. Deleted on {formatShortDate(expires)}
          <span className="demo-banner-extra"> or when you end the demo</span>.
        </span>
      </Alert>
      <ResetDemoDialog open={dialog === "reset"} onClose={() => setDialog(null)} />
      <EndDemoDialog open={dialog === "end"} onClose={() => setDialog(null)} />
    </div>
  );
}

/** "Open in Canvas". A demo has no Canvas site, so there it explains instead of opening a page that doesn't exist. */
export function CanvasLink({ href, className, iconSize = 16 }: { href: string; className?: string; iconSize?: number }) {
  const demo = useIsDemo();
  const toast = useToast();
  const label: ReactNode = (
    <>
      Open in Canvas
      <ExternalIcon size={iconSize} />
    </>
  );
  if (demo) {
    return (
      <button
        type="button"
        className={className ?? "link-button"}
        onClick={() => toast("Demo items have no Canvas page. In your own account this opens the item in Canvas.", "info")}
      >
        {label}
      </button>
    );
  }
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer">
      {label}
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}
