import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { isComplete, offsetFor, progressOf, readIntent, trackFor, type Intent } from "@/lib/swipeCancel";
import { usePersistFn } from "@/hooks/usePersistFn";

// Keep in step with dashboard.css (.swipe): the slide-out, then the height collapse that closes the gap.
const SLIDE_MS = 260;
const COLLAPSE_MS = 340;

type Gesture = { id: number; x: number; y: number; origin: number; anchor: number; track: number; intent: Intent; done: boolean };

/**
 * A row that is cancelled by dragging it left along a fixed track. The row follows the finger one to one and a blue
 * "Cancel shift" panel is uncovered behind it. The drag is fully reversible: let go, or drag back toward where it began,
 * and the row returns. Nothing is cancelled until the row has travelled the whole track (see lib/swipeCancel.ts for the
 * thresholds and why speed alone never counts); only then does it slide off, close its gap and call `onCancel`.
 *
 * Vertical scrolling stays with the browser (`touch-action: pan-y`); a gesture that starts out vertical or diagonal is
 * handed back to the page and never turns into a swipe. A drag suppresses the click that would follow it, so letting go
 * over the × button does not also press it. The × button stays as the keyboard and precision route.
 *
 * While a gesture runs, the row's position is written straight to CSS variables (--sx offset in px, --p progress 0 to 1)
 * and its phase to data-state (idle, drag, commit, collapse). No React re-render happens per pointer move.
 */
export function SwipeToCancel({ label = "Cancel shift", className = "", onCancel, children }: {
  label?: string; className?: string; onCancel: () => void; children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const swallowClick = useRef(false);
  const timers = useRef<number[]>([]);
  const cancel = usePersistFn(onCancel);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const phase = (state: string) => { if (root.current) root.current.dataset.state = state; };
  const place = (offset: number, track: number) => {
    const el = root.current;
    if (!el) return;
    el.style.setProperty("--sx", String(offset));
    el.style.setProperty("--p", String(progressOf(offset, track)));
  };

  const lock = (g: Gesture, el: HTMLElement) => {
    el.setPointerCapture(g.id);
    phase("drag");
    window.getSelection()?.removeAllRanges(); // a mouse drag began as a text selection
  };

  const commit = (g: Gesture, el: HTMLElement) => {
    g.done = true;
    if (el.hasPointerCapture(g.id)) el.releasePointerCapture(g.id);
    const r = root.current;
    if (!r) return;
    place(-r.offsetWidth, g.track);
    r.style.setProperty("--p", "1");
    phase("commit");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { cancel(); return; }
    timers.current.push(window.setTimeout(() => {
      r.style.height = `${r.offsetHeight}px`; // collapse needs a pixel height to animate from
      void r.offsetHeight;
      phase("collapse");
      r.style.height = "0px";
      timers.current.push(window.setTimeout(() => cancel(), COLLAPSE_MS));
    }, SLIDE_MS));
  };

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (gesture.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    const r = root.current;
    if (!r || r.dataset.state === "commit" || r.dataset.state === "collapse") return;
    // Caught while still settling back? Pick up from where the row is rather than where it was going.
    const origin = Math.min(0, e.currentTarget.getBoundingClientRect().left - r.getBoundingClientRect().left);
    const caught = origin < -1;
    const g: Gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, origin: caught ? origin : 0, anchor: 0, track: trackFor(r.offsetWidth), intent: caught ? "swipe" : "pending", done: false };
    gesture.current = g;
    if (caught) { place(g.origin, g.track); lock(g, e.currentTarget); }
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.done || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (g.intent === "pending") {
      const next = readIntent(dx, dy);
      if (next === "pending") return;
      if (next === "ignore") { gesture.current = null; return; }
      g.intent = "swipe";
      g.anchor = dx; // the row starts to move from here, so there is no jump when the gesture locks on
      lock(g, e.currentTarget);
    }
    const offset = offsetFor(g.origin, dx - g.anchor, g.track);
    place(offset, g.track);
    if (isComplete(progressOf(offset, g.track))) commit(g, e.currentTarget);
  };

  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.id) return;
    if (g.intent === "swipe") {
      swallowClick.current = true;
      timers.current.push(window.setTimeout(() => { swallowClick.current = false; }, 80));
      if (!g.done) { phase("idle"); place(0, g.track); } // released short of the end: the row eases back
    }
    if (!g.done) gesture.current = null;
  };

  return (
    <div ref={root} className={`swipe ${className}`} data-state="idle">
      <div className="swipe-under" aria-hidden="true">
        <span className="swipe-cue"><X size={14} strokeWidth={1.5} />{label}</span>
      </div>
      <div
        className="swipe-surface"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onClickCapture={(e) => { if (swallowClick.current) { e.preventDefault(); e.stopPropagation(); } }}
      >
        {children}
      </div>
    </div>
  );
}
