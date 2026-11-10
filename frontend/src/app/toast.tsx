import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertIcon, CheckIcon, CloseIcon } from "./icons";

type Tone = "success" | "error" | "info";

/** A one-click follow-up, such as Undo. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: number;
  tone: Tone;
  text: string;
  action?: ToastAction;
}

type Show = (text: string, tone?: Tone, action?: ToastAction) => void;

const ToastContext = createContext<Show>(() => {});

/** Short confirmations ("Marked 4 changes as read") that also reach screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((toast) => toast.id !== id)), []);
  const show = useCallback<Show>((text, tone = "success", action) => {
    const id = nextId.current++;
    setToasts((list) => [...list.slice(-2), { id, tone, text, action }]);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-region" role="region" aria-label="Notifications">
        <div aria-live="polite" aria-atomic="false">
          {toasts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    // A toast stays while the pointer or focus is on it; one with a follow-up stays longer.
    if (paused) return;
    const timer = setTimeout(() => onDismiss(toast.id), toast.tone === "error" || toast.action ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [toast, onDismiss, paused]);
  return (
    <div
      className={`toast toast-${toast.tone}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {toast.tone === "success" ? <CheckIcon size={18} /> : <AlertIcon size={18} />}
      <p>{toast.text}</p>
      {toast.action ? (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action?.onClick();
            onDismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button type="button" className="icon-button small" onClick={() => onDismiss(toast.id)} aria-label="Dismiss notification">
        <CloseIcon size={16} />
      </button>
    </div>
  );
}

export const useToast = () => useContext(ToastContext);
