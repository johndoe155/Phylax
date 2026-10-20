import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import "../../login.css";
import "../../onboarding.css";
import type { PendingSignup } from "@/lib/auth";
import { IconUserPlus } from "./icons";

const EXIT_MS = 380; // a touch longer than the .34s exit in onboarding.css, so the dialog is fully gone before it unmounts

/** The sentence under the title: says which identity has no account, in the person's own terms. */
function describe(pending: PendingSignup): ReactNode {
  if (pending.method === "passkey") return "No Phylax account is linked to a passkey on this device. Do you want to create one?";
  if (!pending.email) return "There's no Phylax account for this email. Do you want to create one?";
  return <>There's no Phylax account for <strong>{pending.email}</strong>. Do you want to create one with this email?</>;
}

/**
 * The question a standard sign-in (passkey, email) asks before it starts the account sequence: "Create an account?".
 * Apple and Google never show it, they go straight in. Controlled by `pending`: a value opens it, null closes it.
 *
 * It lives inside the page's `.lg` element (so it reads the page's tokens) and is a modal alert dialog: the page puts
 * `inert` on everything else while it is open, so focus cannot leave it; Escape and "Not now" decline; the scrim does
 * not (a choice this small should be an explicit one). Focus lands on "Create account" and goes back to where it was.
 */
export function CreateAccountDialog({ pending, onConfirm, onDecline }: {
  pending: PendingSignup | null;
  onConfirm: () => void;
  onDecline: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const lastPending = useRef<PendingSignup | null>(null);
  const [present, setPresent] = useState(false); // stays true through the exit animation
  const open = pending !== null;
  if (pending) lastPending.current = pending; // the copy stays readable while the dialog fades out

  useEffect(() => {
    if (open) {
      setPresent(true);
      returnFocus.current = document.activeElement;
      const frame = window.requestAnimationFrame(() => confirmRef.current?.focus({ preventScroll: true }));
      return () => window.cancelAnimationFrame(frame);
    }
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
    const timer = window.setTimeout(() => setPresent(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onDecline(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onDecline]);

  const shown = pending ?? lastPending.current;
  if (!shown || (!open && !present)) return null;

  return (
    <div className="ob-modal" data-state={open ? "open" : "closing"}>
      <div className="ob-scrim" aria-hidden="true" />
      <div className="ob-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} inert={!open}>
        <div className="ob-dialog-icon" aria-hidden="true"><IconUserPlus /></div>
        <h2 className="ob-dialog-title" id={titleId}>Create an account?</h2>
        <p className="ob-dialog-body" id={bodyId}>{describe(shown)}</p>
        <button ref={confirmRef} type="button" className="ob-dialog-btn" data-variant="solid" onClick={onConfirm}>Create account</button>
        <button type="button" className="ob-dialog-btn" data-variant="ghost" onClick={onDecline}>Not now</button>
      </div>
    </div>
  );
}
