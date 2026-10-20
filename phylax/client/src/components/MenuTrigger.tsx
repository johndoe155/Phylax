import { useId, useLayoutEffect, useRef, useState, type MouseEvent, type Ref } from "react";
import { CENTER, CLIP_R, GLYPH_TRANSFORM, OUTLINE_R, RING_R, TriggerEngine, VIEW, staticGlyph } from "@/lib/triggerMotion";

/** How long the coloured fill (the disc) lingers after the menu closes. The icon does NOT wait: it resets at once. 4–6 s by design. */
export const CLOSE_LINGER_MS = 5000;

interface MenuTriggerProps {
  open: boolean;
  onToggle: () => void;
  controls: string;
  ref?: Ref<HTMLButtonElement>;
  lingerMs?: number;
}

/**
 * Menu button: two-stroke <-> X morph (each stroke slides along a looped path), plus a two-stage fill that grows out of the pointer.
 *
 * COLOUR. There is no colour logic in JS. The button uses the same mechanism as the header logo: cream drawn with
 * `mix-blend-mode: difference`, so the compositor shows the inverse of whatever is behind it, per pixel, on every frame
 * (scrolling, section changes, the hero's inverted blob...). Nothing is sampled and nothing needs updating when the
 * site's background changes. Because a blend only sees what is beneath it, the button is three fixed layers rather
 * than one element:
 *
 *   base   z 51  blended   the resting ring and the disc (cream, so the disc is the inverse of the page).
 *   cover  z 52  normal    the sweep that grows out of the pointer, then lifts away. Always the global ink colour
 *                          (`--ink`); it must NOT be blended, since ink under `difference` would just show the page.
 *   mark   z 53  blended   the glyph, and the real <button> (the only thing that takes pointer events). Same colour
 *                          as the header logo, so it reads on the ink sweep and as a knock-out on the disc.
 *
 * Two things follow the menu's real state (`open`, which also drives aria-*), on two different clocks:
 *
 *   glyph  follows `open` immediately, both ways. Close the menu and the X turns straight back into the two
 *          strokes; click again (even while the fill is still lingering) and the full strokes-to-X animation runs.
 *   fill   turns on with `open` and turns off only `lingerMs` after `open` does (`held`). Opening plays two stages:
 *          the ink sweep grows out of the pointer, then retracts upward in one round curve to unveil the disc,
 *          outlining it only while it does. Re-opening during the linger just cancels the pending release:
 *          the fill is already in its open state, so it stays exactly as it is.
 *
 * The button must not sit inside another stacking context that has its own blend, or it would blend against that
 * instead of the page. It is rendered as a sibling of the header for the same reason the header is a sibling of <main>.
 */
export function MenuTrigger({ open, onToggle, controls, ref, lingerMs = CLOSE_LINGER_MS }: MenuTriggerProps) {
  const btn = useRef<HTMLButtonElement | null>(null);
  const upper = useRef<SVGPathElement>(null);
  const lower = useRef<SVGPathElement>(null);
  const fill = useRef<SVGPathElement>(null);
  const cover = useRef<SVGPathElement>(null);
  const lift = useRef<SVGPathElement>(null);
  const ring = useRef<SVGCircleElement>(null);
  const engine = useRef<TriggerEngine | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [held, setHeld] = useState(open);
  const uid = `mt-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  // Each layer is its own <svg>, so each one that clips carries its own circle clip.
  const baseClipId = `${uid}-base`, coverClipId = `${uid}-clip`, liftClipId = `${uid}-lift`;

  const setRefs = (node: HTMLButtonElement | null) => {
    btn.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) (ref as { current: HTMLButtonElement | null }).current = node;
  };

  // Engine lifetime.
  useLayoutEffect(() => {
    if (!upper.current || !lower.current || !fill.current || !cover.current || !lift.current || !ring.current) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    const e = new TriggerEngine(
      { upper: upper.current, lower: lower.current, fill: fill.current, cover: cover.current, lift: lift.current, ring: ring.current },
      calm.matches,
    );
    engine.current = e;
    const onCalm = () => e.setCalm(calm.matches);
    calm.addEventListener("change", onCalm);
    return () => {
      calm.removeEventListener("change", onCalm);
      e.destroy();
      engine.current = null;
    };
  }, []);

  // The state machine. Two clocks hang off `open`:
  //   · the glyph answers immediately, in both directions;
  //   · the fill answers immediately on the way in, and `lingerMs` late on the way out.
  // Every run of this effect first cancels any pending release, which is what makes a click during the linger safe:
  // the disc is still fully up (`fillOn` in the engine is still true), so nothing is replayed or reset, the strokes
  // simply wind into an X on top of it.
  const seen = useRef<TriggerEngine | null>(null);
  useLayoutEffect(() => {
    const e = engine.current;
    if (!e) return;
    clearTimeout(timer.current);

    if (seen.current !== e) {
      // First run for this engine (mount, or a dev-mode remount): adopt the current state with no animation.
      seen.current = e;
      if (open) { e.jump(true); setHeld(true); }
      return;
    }

    if (open) {
      e.setGlyph(true);
      e.setFill(true);
      setHeld(true);
    } else {
      e.setGlyph(false); // the X turns back into the two strokes now, not after the linger
      timer.current = setTimeout(() => {
        setHeld(false);
        e.setFill(false);
      }, lingerMs);
    }
    return () => clearTimeout(timer.current);
  }, [open, lingerMs]);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Grow the disc from where the pointer landed. Keyboard activation (detail 0) grows from the centre.
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.detail > 0 && rect.width > 0) {
      engine.current?.setOrigin(((event.clientX - rect.left) / rect.width) * VIEW, ((event.clientY - rect.top) / rect.height) * VIEW);
    } else {
      engine.current?.setOrigin(CENTER, CENTER);
    }
    onToggle();
  };

  const viewBox = `0 0 ${VIEW} ${VIEW}`;

  return (
    <>
      {/* mark · z 53 · blended. The real button: glyph only. Listed first so the layers below can react to its
          :hover / :active / :focus-visible with the general-sibling combinator (stacking is set by z-index, not DOM order). */}
      <button
        ref={setRefs}
        type="button"
        className="morph-trigger"
        data-held={held ? "true" : "false"}
        onClick={handleClick}
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls={controls}
        aria-haspopup="dialog"
      >
        <svg viewBox={viewBox} aria-hidden="true" focusable="false">
          <g className="mt-glyph" transform={GLYPH_TRANSFORM}>
            <path ref={upper} d={staticGlyph.upper} />
            <path ref={lower} d={staticGlyph.lower} />
          </g>
        </svg>
      </button>

      {/* base · z 51 · blended. The resting outline, and the disc complete from the first instant of opening but hidden
          under the cover until it is unveiled. The disc is drawn over the ring, so the ring is gone while it is up. */}
      <div className="mt-layer mt-layer-base" aria-hidden="true">
        <svg viewBox={viewBox} focusable="false">
          <defs>
            <clipPath id={baseClipId}><circle cx={CENTER} cy={CENTER} r={CLIP_R} /></clipPath>
          </defs>
          <circle className="mt-ring" cx={CENTER} cy={CENTER} r={RING_R} />
          <g clipPath={`url(#${baseClipId})`}><path ref={fill} className="mt-fill" d="" /></g>
        </svg>
      </div>

      {/* cover · z 52 · NOT blended. The ink sweep: grows out of the pointer over the base layer, then retracts upward. */}
      <div className="mt-layer mt-layer-cover" aria-hidden="true">
        <svg viewBox={viewBox} focusable="false">
          <defs>
            {/* The cover may reach the ring (and a hair beyond). */}
            <clipPath id={coverClipId}><circle cx={CENTER} cy={CENTER} r={CLIP_R} /></clipPath>
            {/* Stage 2: the part of the cover that is still showing; its lower edge is one round curve that rises. */}
            <clipPath id={liftClipId}><path ref={lift} d="" /></clipPath>
          </defs>
          <g clipPath={`url(#${coverClipId})`}>
            <g clipPath={`url(#${liftClipId})`}><path ref={cover} className="mt-cover" d="" /></g>
          </g>
          {/* Stage 2 only: a thin outline of the cover around the disc's rim, gone the moment the lift ends. Same colour
              as the cover, so it is invisible until the rising edge uncovers it. */}
          <circle ref={ring} className="mt-ring-open" cx={CENTER} cy={CENTER} r={OUTLINE_R} opacity="0" />
        </svg>
      </div>
    </>
  );
}
