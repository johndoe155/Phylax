import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import "./MenuSketchLogo.css";
import v1 from "@/assets/phylax-sketch/phylax-variant-01-steady-hand-flick.svg?raw";
import v2 from "@/assets/phylax-sketch/phylax-variant-02-heavy-pressure.svg?raw";
import v3 from "@/assets/phylax-sketch/phylax-variant-03-loose-overshoot.svg?raw";
import v4 from "@/assets/phylax-sketch/phylax-variant-04-pencil-lifts.svg?raw";
import v5 from "@/assets/phylax-sketch/phylax-variant-05-construction-guides.svg?raw";
import v6 from "@/assets/phylax-sketch/phylax-variant-06-cross-hatch-accents.svg?raw";
import v7 from "@/assets/phylax-sketch/phylax-variant-07-ghost-erased-strokes.svg?raw";
import orderFile from "@/assets/phylax-sketch/frame-order-48.txt?raw";
import { HOLD_MS, TICK_SLACK_MS, auditOrder, cleanSketchSvg, parseOrder, quietStarts } from "@/lib/sketchFrames";

/** The seven drawings; drawing N is DRAWINGS[N - 1], which is how frame-order-48.txt numbers them. Inlined (not <img>) so
 * `currentColor` follows the menu's text colour. Each file's filter id is already unique, so all seven can share a document. */
const DRAWINGS = [v1, v2, v3, v4, v5, v6, v7].map(cleanSketchSvg);

/** The playing order. Numbers outside 1..7 are ignored, so a typo in the file can't blank the logo. */
const ORDER = parseOrder(orderFile).filter((n) => n >= 1 && n <= DRAWINGS.length);
/** Where a pass may start: only on a quiet drawing, so the menu never opens on the broken outline. */
const STARTS = quietStarts(ORDER);

if (import.meta.env.DEV) {
  const problems = auditOrder(ORDER);
  if (problems.length) console.warn("[MenuSketchLogo] frame-order-48.txt breaks the stop-motion rules:\n - " + problems.join("\n - "));
}

/** Matches the panel's close transition (the panel is `visibility: hidden` 0.7 s after `data-state` flips), so the lines keep
 * trembling while the menu sweeps away instead of freezing the instant it starts to close. */
const LINGER_MS = 700;

/**
 * The sketch logo above the menu links: a stop-motion "boiling line".
 *
 * All seven drawings stay mounted and a cut is a visibility flip (no fade), so no SVG or filter is ever re-created. The
 * flip is done on the DOM directly (`data-active`), not through React state, because it happens 12 times a second.
 *
 * Playback: 24 fps on twos (12 drawings/s), walking the order in lib/sketchFrames.ts / frame-order-48.txt in a loop. Every
 * time the menu opens, the pass starts at a random quiet spot in that loop, so no two openings begin the same way. The
 * order is cyclic, so any start point keeps all of its spacing rules, including across the seam.
 *
 * The loop is only running while the menu is open (plus the closing sweep). With `prefers-reduced-motion` it does not run
 * at all: the mark is a single, still drawing.
 */
export function MenuSketchLogo({ playing }: { playing: boolean }) {
  const frames = useRef<(HTMLElement | null)[]>([]);
  const shown = useRef(0);
  const [live, setLive] = useState(false);
  const [calm, setCalm] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  /** Cuts to a drawing (1-based). */
  const show = useCallback((drawing: number) => {
    if (drawing === shown.current) return;
    if (shown.current) frames.current[shown.current - 1]?.removeAttribute("data-active");
    frames.current[drawing - 1]?.setAttribute("data-active", "");
    shown.current = drawing;
  }, []);

  // Something is on screen from the very first paint; it is also the still drawing for reduced motion.
  useLayoutEffect(() => {
    show(ORDER[0] ?? 1);
  }, [show]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setCalm(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // `live` is `playing` with the closing sweep added on the end. Re-opening inside that window just cancels the timer,
  // so the loop carries on uninterrupted instead of restarting.
  useEffect(() => {
    if (playing) {
      setLive(true);
      return;
    }
    const timer = window.setTimeout(() => setLive(false), LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [playing]);

  useEffect(() => {
    if (calm) show(ORDER[0] ?? 1);
    if (!live || calm || ORDER.length < 2) return;

    let at = STARTS[Math.floor(Math.random() * STARTS.length)];
    show(ORDER[at]);

    // One step per tick at most, however late the tick: a stalled frame must never skip over a quiet drawing and put two
    // loud ones next to each other. After a long stall (a backgrounded tab) the clock re-anchors instead of catching up.
    let last = -1;
    let raf = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (last < 0) {
        last = now;
        return;
      }
      if (now - last < HOLD_MS - TICK_SLACK_MS) return;
      at = (at + 1) % ORDER.length;
      show(ORDER[at]);
      last = now - last > 2 * HOLD_MS ? now : last + HOLD_MS;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [live, calm, show]);

  // Decorative: the nav and the page already say "Phylax", and seven rotating labels would only be noise. Pointer events are
  // off in CSS so the drawing never gets in the way of a tap. `mx` joins the menu's fade-up, a beat before the first link.
  return (
    <div className="menu-sketch mx" style={{ "--d": ".3s" } as CSSProperties} aria-hidden="true">
      {DRAWINGS.map((svg, i) => (
        <span
          key={i}
          ref={(node: HTMLSpanElement | null) => {
            frames.current[i] = node;
          }}
          className="menu-sketch-frame"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ))}
    </div>
  );
}
