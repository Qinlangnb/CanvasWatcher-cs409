import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertIcon, CheckIcon, CloseIcon } from "./icons";

type Tone = "success" | "error" | "info";
interface Toast {
  id: number;
  tone: Tone;
  text: string;
}

const ToastContext = createContext<(text: string, tone?: Tone) => void>(() => {});

/** Short confirmations ("Marked 4 changes as read") that also reach screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((toast) => toast.id !== id)), []);
  const show = useCallback((text: string, tone: Tone = "success") => {
    const id = nextId.current++;
    setToasts((list) => [...list.slice(-2), { id, tone, text }]);
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
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), toast.tone === "error" ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);
  return (
    <div className={`toast toast-${toast.tone}`}>
      {toast.tone === "error" ? <AlertIcon size={18} /> : <CheckIcon size={18} />}
      <p>{toast.text}</p>
      <button type="button" className="icon-button small" onClick={() => onDismiss(toast.id)} aria-label="Dismiss notification">
        <CloseIcon size={16} />
      </button>
    </div>
  );
}

export const useToast = () => useContext(ToastContext);
