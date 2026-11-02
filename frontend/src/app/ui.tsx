import {
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { AlertIcon, CheckIcon, CloseIcon, EyeIcon, EyeOffIcon } from "./icons";

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · CanvasWatcher`;
  }, [title]);
}

/** Moves focus to the page heading when `key` changes (not on first render), as a full page load would. */
export function useFocusHeading(key: unknown) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    document.querySelector<HTMLElement>("[data-page-heading]")?.focus();
  }, [key]);
}

/** The page's heading. Receives focus after navigation so screen readers announce the new page. */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  documentTitle,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  /** The browser tab's title when it should differ from the heading. */
  documentTitle?: string;
}) {
  usePageTitle(documentTitle ?? title);
  return (
    <header className="page-header">
      <div className="page-header-text">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1 tabIndex={-1} data-page-heading>
          {title}
        </h1>
        {description ? <p className="page-description">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  error?: string;
  /** Rendered inside the input's box, after it (for example a show-password toggle). */
  trailing?: ReactNode;
};

export function Field({ label, hint, error, trailing, id, className, ...input }: FieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  return (
    <div className={`field${error ? " has-error" : ""}${className ? ` ${className}` : ""}`}>
      <label htmlFor={inputId}>{label}</label>
      {hint ? (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      <div className="input-box">
        <input
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
          {...input}
        />
        {trailing}
      </div>
      {error ? (
        <p className="field-error" id={errorId}>
          <AlertIcon size={16} />
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function PasswordField(props: Omit<FieldProps, "type" | "trailing">) {
  const [visible, setVisible] = useState(false);
  return (
    <Field
      {...props}
      type={visible ? "text" : "password"}
      trailing={
        <button
          type="button"
          className="input-action"
          onClick={() => setVisible((value) => !value)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
        >
          {visible ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
        </button>
      }
    />
  );
}

export function Alert({
  tone = "error",
  title,
  children,
  action,
}: {
  tone?: "error" | "warning" | "info" | "success";
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`alert alert-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span className="alert-icon">{tone === "success" ? <CheckIcon size={18} /> : <AlertIcon size={18} />}</span>
      <div className="alert-body">
        {title ? <p className="alert-title">{title}</p> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {action ? <div className="alert-action">{action}</div> : null}
    </div>
  );
}

export function Spinner({ label, size = 18 }: { label?: string; size?: number }) {
  return (
    <span className="spinner-wrap" role={label ? "status" : undefined}>
      <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />
      {label ? <span className="visually-hidden">{label}</span> : null}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function SkeletonList({ rows = 4, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton-list" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-row" key={index}>
          <span className="skeleton skeleton-title" />
          <span className="skeleton skeleton-line" />
        </div>
      ))}
    </div>
  );
}

/** A modal built on <dialog>: the browser traps focus, closes on Esc and restores focus on close. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = "medium",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "small" | "medium";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dialog dialog-${size}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the <dialog> itself.
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="dialog-panel">
        <header className="dialog-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer ? <footer className="dialog-footer">{footer}</footer> : null}
      </div>
    </dialog>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "accent" | "danger" | "warning" | "success"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
