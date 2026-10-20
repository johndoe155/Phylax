import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const LEAVE_MS = 200; // a touch longer than the .18s pk-out animation (picker.css), so it is fully faded before it unmounts
const STOPS = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A small centred dialog for the "Log a shift" overlay: for the moments a picker is not enough and a field is needed.
 * It is built like Popover (picker/Popover.tsx) so the two feel like one family: portalled into the open dialog so
 * assistive tech keeps it inside the modal, a scrim that closes it, Escape closes only this panel (a capturing window
 * listener swallows the key before the overlay's own handler), Tab stays inside, focus goes to the first
 * [data-autofocus] element on open and returns to `returnFocusRef` on close. On a phone it sits near the top of the
 * screen rather than the bottom, so the on-screen keyboard never covers it.
 */
export function Modal({ open, label, onClose, returnFocusRef, className = "", children }: {
  open: boolean; label: string; onClose: () => void; returnFocusRef: RefObject<HTMLElement | null>; className?: string; children: ReactNode;
}) {
  const [present, setPresent] = useState(open);
  const ref = useRef<HTMLDivElement>(null);
  const rendered = open || present;

  useEffect(() => {
    if (open) { setPresent(true); return; }
    const id = setTimeout(() => setPresent(false), LEAVE_MS);
    return () => clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const back = returnFocusRef.current;
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); back?.focus({ preventScroll: true }); };
  }, [open, returnFocusRef, onClose]);

  if (!rendered) return null;

  const trap = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !ref.current) return;
    const stops = Array.from(ref.current.querySelectorAll<HTMLElement>(STOPS));
    if (!stops.length) return;
    const first = stops[0], last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const target = returnFocusRef.current?.closest<HTMLElement>('[role="dialog"]') ?? document.body;
  return createPortal(
    <>
      <div className={`pk-scrim pk-scrim-modal ${open ? "" : "is-leaving"}`} onPointerDown={onClose} aria-hidden="true" />
      <div ref={ref} className={`pk-pop pk-modal ${className} ${open ? "" : "is-leaving"}`} role="dialog" aria-modal="true" aria-label={label} onKeyDown={trap}>
        {children}
      </div>
    </>,
    target,
  );
}
