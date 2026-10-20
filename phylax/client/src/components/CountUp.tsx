import { useEffect, useLayoutEffect, useRef } from "react";
import { COUNT_UP_MS, countAt, countTarget } from "@/lib/countUp";

/** The count starts once at least this much of the number is on screen. No root margin: a number at the very bottom of the page must still be able to start. */
const IN_VIEW: IntersectionObserverInit = { threshold: 0.6 };

/** Ids that have already counted up during this page load. A stat never replays, not even if it unmounts and mounts again (a list emptying and refilling). */
const played = new Set<string>();

type Phase = "waiting" | "running" | "done";
type Run = { phase: Phase; shown: number; from: number; to: number; t0: number | null; raf: number };

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Writes `n` into the live layer, and only when it changed (most frames in the long tail of the ease repeat the same integer). */
function paint(run: Run, el: HTMLElement | null, n: number) {
  if (run.shown === n || !el) return;
  run.shown = n;
  el.textContent = String(n);
}

/**
 * A whole number that rises from 0 to `value` the first time it is scrolled into view, and never again.
 *
 * LAYERS. The real number is always in the DOM, as a transparent "size" layer. It reserves the final width from the first paint (so the
 * text beside it, such as the H in "36H", never moves while the digits are added) and it is what screen readers read and what the
 * aria-live regions announce. On top of it sits an aria-hidden "live" layer, the one that counts. Its text is written straight to the
 * DOM from requestAnimationFrame, so a count never re-renders React, and a screen reader is not read thirty numbers a second.
 *
 * TRIGGER. An IntersectionObserver, disconnected the moment it fires. The run is driven by the frame clock (not a frame count), so
 * it takes the same time on a 60 Hz and a 120 Hz screen, and a tab that was hidden at the start just lands on the final value.
 *
 * AFTER THE COUNT. A later change of `value` (a shift added or cancelled, paging to another week, the minute tick) is shown as it is,
 * with no second count. Only a change *during* the count re-aims it, from the number on screen, so it never jumps.
 *
 * With prefers-reduced-motion, or no IntersectionObserver, the final value is simply shown.
 *
 * Built from <data> elements on purpose: it is the right element for a number, and no stylesheet targets it. The existing
 * `.stat-block span` rules (label type, 30px margin) would otherwise bleed into every <span> placed inside a stat's <strong>.
 *
 * `id` names the stat, so the once-only memory can tell stats apart. Keep it unique per stat and stable across renders.
 */
export function CountUp({ value, id, align = "start" }: { value: number; id: string; /** "end" keeps the digits against what follows them (a unit), so they grow leftwards. */ align?: "start" | "end" }) {
  const root = useRef<HTMLDataElement>(null);
  const live = useRef<HTMLDataElement>(null);
  const to = countTarget(value);
  const run = useRef<Run>({ phase: "waiting", shown: -1, from: 0, to, t0: null, raf: 0 });

  // Before paint, so there is never a frame that shows the final number and then drops to 0: the live layer starts at 0 (or at the
  // final value when there is nothing to watch), and follows later changes of the value.
  useLayoutEffect(() => {
    const r = run.current;
    r.to = to;
    if (r.phase === "waiting") {
      if (played.has(id) || reducedMotion() || typeof IntersectionObserver === "undefined") {
        r.phase = "done";
        paint(r, live.current, to);
      } else {
        paint(r, live.current, 0);
      }
    } else if (r.phase === "done") {
      paint(r, live.current, to);
    } else {
      r.from = r.shown; // mid-count: carry on from the number on screen toward the new target
      r.t0 = null;
    }
  }, [to, id]);

  useEffect(() => {
    const r = run.current;
    const el = root.current;
    let io: IntersectionObserver | undefined;

    const tick = (ts: number) => {
      r.t0 ??= ts;
      const progress = (ts - r.t0) / COUNT_UP_MS;
      paint(r, live.current, countAt(r.from, r.to, progress));
      if (progress < 1) r.raf = requestAnimationFrame(tick);
      else r.phase = "done";
    };

    if (r.phase === "running") {
      r.raf = requestAnimationFrame(tick); // effects were re-run mid-count (StrictMode), pick the count back up
    } else if (r.phase === "waiting" && el) {
      io = new IntersectionObserver((entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io?.disconnect();
        played.add(id);
        if (reducedMotion()) {
          r.phase = "done";
          paint(r, live.current, r.to);
          return;
        }
        r.phase = "running";
        r.from = 0;
        r.t0 = null;
        r.raf = requestAnimationFrame(tick);
      }, IN_VIEW);
      io.observe(el);
    }

    return () => {
      io?.disconnect();
      cancelAnimationFrame(r.raf);
    };
  }, [id]);

  return (
    <data ref={root} className={align === "end" ? "count-up count-up--end" : "count-up"} value={to}>
      <data className="count-up-size">{to}</data>
      <data className="count-up-live" aria-hidden="true" ref={live} />
    </data>
  );
}
