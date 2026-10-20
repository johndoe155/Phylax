import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** success: cream. error: ink with the marching outline. info: a plain heads-up (something isn't available yet), ink with a hairline. */
export type ToastTone = "success" | "error" | "info";
export interface ToastInput {
  tone: ToastTone;
  message: string;
  /** One optional follow-up, e.g. "Confirm it's you" on a re-authentication error. */
  action?: { label: string; onClick: () => void };
}
interface Toast extends ToastInput { id: number; leaving: boolean }

const SUCCESS_MS = 4600;
const ERROR_MS = 9000;
const LEAVE_MS = 360; // a touch longer than the .32s exit in account.css, so it is gone before it unmounts
const MAX_VISIBLE = 3;

const ToastContext = createContext<(toast: ToastInput) => void>(() => {});
export const useToast = () => useContext(ToastContext);

function ToastItem({ toast, onClose }: { toast: Toast; onClose: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || toast.leaving) return;
    const timer = window.setTimeout(() => onClose(toast.id), toast.tone === "error" ? ERROR_MS : SUCCESS_MS);
    return () => window.clearTimeout(timer);
  }, [paused, toast.id, toast.leaving, toast.tone, onClose]);

  return (
    <div
      className="ac-toast"
      data-tone={toast.tone}
      data-leaving={toast.leaving || undefined}
      role={toast.tone === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {toast.tone === "error" && <svg className="ac-dash" aria-hidden="true" focusable="false"><rect width="100%" height="100%" rx="0" ry="0" /></svg>}
      <span className="ac-toast-dot" aria-hidden="true" />
      <p className="ac-toast-text">{toast.message}</p>
      {toast.action && (
        <button type="button" className="ac-toast-act" onClick={() => { toast.action?.onClick(); onClose(toast.id); }}>{toast.action.label}</button>
      )}
      <button type="button" className="ac-toast-x" aria-label="Dismiss message" onClick={() => onClose(toast.id)}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  );
}

/** Messages for the whole account page: results of every save, send and verify, success and failure alike. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const timers = useRef<number[]>([]);

  const close = useCallback((id: number) => {
    setToasts((all) => all.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    timers.current.push(window.setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), LEAVE_MS));
  }, []);

  const push = useCallback((input: ToastInput) => {
    const id = next.current++;
    setToasts((all) => {
      // The same message twice in a row is one message.
      if (all.some((t) => !t.leaving && t.message === input.message && t.tone === input.tone)) return all;
      const live = all.filter((t) => !t.leaving);
      const trimmed = live.length >= MAX_VISIBLE ? live.slice(live.length - MAX_VISIBLE + 1) : live;
      return [...trimmed, { ...input, id, leaving: false }];
    });
  }, []);

  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="ac-toasts" aria-label="Messages">
        {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} onClose={close} />)}
      </div>
    </ToastContext.Provider>
  );
}
