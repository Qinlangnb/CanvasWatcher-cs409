import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { formatDateTime, formatShortDate } from "./format";
import { ExternalIcon, LockIcon } from "./icons";
import { useMe, usePreviewAvailability, useResetPreview, useSignOut, useStartPreview } from "./queries";
import { useToast } from "./toast";
import { Alert, Dialog, Spinner } from "./ui";

// Preview accounts: one per visitor, holding a copy of a real student's courses with their name and
// contact details taken out. Everything works on that copy except what needs Canvas itself, which is
// greyed out with PREVIEW_UNAVAILABLE. Deleted when the visitor ends the preview or after a week.

export const PREVIEW_UNAVAILABLE = "Preview account not available";

/** The sign-in page's way in without an account. Shown only when the server offers a preview. */
export function StartPreview() {
  const availability = usePreviewAvailability();
  const start = useStartPreview();
  if (!availability.data?.enabled) return null;
  const days = availability.data.lifetime_days;
  return (
    <div className="preview-start">
      <p className="divider-text">
        <span>or</span>
      </p>
      {start.error ? <Alert>{start.error.message}</Alert> : null}
      <button type="button" className="button secondary full" onClick={() => start.mutate()} disabled={start.isPending}>
        {start.isPending ? <Spinner size={16} /> : null}
        {start.isPending ? "Opening the preview…" : "Preview"}
      </button>
      <p className="preview-note">
        Look around with a real student's courses, with personal details removed. No account needed. Your changes are deleted
        when you end the preview or after {days} days.
      </p>
    </div>
  );
}

/** Copies the preview data again after a confirmation, then shows Today. */
export function ResetPreviewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const reset = useResetPreview();
  const toast = useToast();
  const navigate = useNavigate();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Reset the preview?"
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
                  toast("Preview reset.");
                },
                onError: (error) => toast(error.message, "error"),
              })
            }
          >
            {reset.isPending ? <Spinner size={16} /> : null}
            Reset preview
          </button>
        </>
      }
    >
      <p>Your changes to tasks, events, read changes and settings are thrown away, and the preview data is copied again.</p>
    </Dialog>
  );
}

/** Signing out of a preview deletes it, so it asks first. */
export function EndPreviewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const signOut = useSignOut();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="End the preview?"
      size="small"
      footer={
        <>
          <button type="button" className="button ghost" onClick={onClose}>
            Keep exploring
          </button>
          <button type="button" className="button danger" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
            {signOut.isPending ? <Spinner size={16} /> : null}
            End preview
          </button>
        </>
      }
    >
      <p>The preview account and everything you changed in it are deleted. This can't be undone. Create an account to keep your own data.</p>
    </Dialog>
  );
}

/** Shown above every page while a preview is signed in. */
export function PreviewBanner() {
  const me = useMe();
  const [dialog, setDialog] = useState<"reset" | "end" | null>(null);
  const expires = me.data?.preview_expires_at;
  if (!expires) return null;
  return (
    <div className="banner preview-banner">
      <Alert
        tone="info"
        title="Preview account"
        action={
          <div className="alert-buttons">
            <button type="button" className="button small secondary" onClick={() => setDialog("reset")}>
              Reset
            </button>
            <button type="button" className="button small ghost" onClick={() => setDialog("end")}>
              End preview
            </button>
          </div>
        }
      >
        <span title={formatDateTime(expires)}>
          A copy of a real student's courses with personal details removed. Deleted on {formatShortDate(expires)}
          <span className="preview-banner-extra"> or when you end the preview</span>.
        </span>
      </Alert>
      <ResetPreviewDialog open={dialog === "reset"} onClose={() => setDialog(null)} />
      <EndPreviewDialog open={dialog === "end"} onClose={() => setDialog(null)} />
    </div>
  );
}

/** Says why a greyed-out control does nothing, when it is clicked. */
export function usePreviewNotice(): () => void {
  const toast = useToast();
  return () => toast(`${PREVIEW_UNAVAILABLE}.`, "info");
}

/**
 * A greyed-out stand-in for something that needs Canvas itself. It looks like the real thing but is
 * marked unavailable to assistive technology and says why when clicked.
 */
export function UnavailableButton({ className, children }: { className: string; children: ReactNode }) {
  const notice = usePreviewNotice();
  return (
    <button type="button" className={`${className} preview-unavailable`} aria-disabled="true" title={PREVIEW_UNAVAILABLE} onClick={notice}>
      {children}
      <span className="visually-hidden"> ({PREVIEW_UNAVAILABLE})</span>
    </button>
  );
}

/** A greyed-out panel in place of something that needs Canvas itself, such as the syllabus. */
export function PreviewUnavailable({ children }: { children?: ReactNode }) {
  return (
    <div className="preview-locked" role="status">
      <LockIcon size={22} />
      <p className="preview-locked-title">{PREVIEW_UNAVAILABLE}</p>
      {children ? <p className="preview-locked-detail">{children}</p> : null}
    </div>
  );
}

/** "Open in Canvas", in a new tab. */
export function CanvasLink({ href, className, iconSize = 16 }: { href: string; className?: string; iconSize?: number }) {
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer">
      Open in Canvas
      <ExternalIcon size={iconSize} />
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}
