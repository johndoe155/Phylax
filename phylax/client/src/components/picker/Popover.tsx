import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const LEAVE_MS = 200; // a touch longer than the .18s pk-out animation (picker.css), so it is fully faded before it unmounts

/**
 * Floating panel for the pickers. It is portalled into the open dialog (the "Log a shift" overlay) so assistive tech
 * still treats it as part of the modal, and it is placed with position: fixed from the trigger's rect: below when it
 * fits, above when that is roomier, always clamped inside the viewport. On a phone, picker.css turns it into a sheet.
 *
 * Escape closes only the panel: a capturing window listener swallows the key before the overlay's own Escape handler.
 * Focus moves to the first [data-autofocus] element on open and returns to the trigger on close.
 */
export function Popover({ open, anchorRef, label, onClose, className = "", scrimClass = "pk-scrim", popClass = "pk-pop", children }: {
  open: boolean; anchorRef: RefObject<HTMLElement | null>; label: string; onClose: () => void; className?: string;
  /** Class names for the scrim and the panel. Another stylesheet can supply its own look (the account page does) and keep the placement, focus and Escape handling. */
  scrimClass?: string; popClass?: string; children: ReactNode;
}) {
  const [present, setPresent] = useState(open);
  const ref = useRef<HTMLDivElement>(null);
  const rendered = open || present;

  useEffect(() => {
    if (open) { setPresent(true); return; }
    const id = setTimeout(() => setPresent(false), LEAVE_MS);
    return () => clearTimeout(id);
  }, [open]);

  useLayoutEffect(() => {
    const pop = ref.current, anchor = anchorRef.current;
    if (!rendered || !pop || !anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      pop.style.setProperty("--pk-aw", `${Math.round(a.width)}px`); // the trigger's width, for panels that size themselves to it
      const w = pop.offsetWidth, h = pop.offsetHeight;
      const vw = document.documentElement.clientWidth, vh = window.innerHeight;
      const gap = 8, edge = 12;
      const below = vh - a.bottom - gap - edge, above = a.top - gap - edge;
      const up = h > below && above > below;
      const left = Math.min(Math.max(a.left, edge), Math.max(edge, vw - w - edge));
      const top = Math.min(Math.max(up ? a.top - gap - h : a.bottom + gap, edge), Math.max(edge, vh - h - edge));
      pop.style.setProperty("--pk-x", `${Math.round(left)}px`);
      pop.style.setProperty("--pk-y", `${Math.round(top)}px`);
      pop.style.setProperty("--pk-ox", `${Math.round(Math.min(Math.max(a.left + 24 - left, 0), w))}px`);
      pop.dataset.side = up ? "top" : "bottom";
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true); // the overlay scrolls, not the window
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [rendered, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const trigger = anchorRef.current;
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); trigger?.focus({ preventScroll: true }); };
  }, [open, anchorRef, onClose]);

  if (!rendered) return null;

  // Keeps Tab inside the panel while it is open.
  const trap = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !ref.current) return;
    const stops = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), input:not([disabled])'));
    if (!stops.length) return;
    const first = stops[0], last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const target = anchorRef.current?.closest<HTMLElement>('[role="dialog"]') ?? document.body;
  return createPortal(
    <>
      <div className={`${scrimClass} ${open ? "" : "is-leaving"}`} onPointerDown={onClose} aria-hidden="true" />
      <div ref={ref} className={`${popClass} ${className} ${open ? "" : "is-leaving"}`} role="dialog" aria-label={label} onKeyDown={trap}>
        {children}
      </div>
    </>,
    target,
  );
}
