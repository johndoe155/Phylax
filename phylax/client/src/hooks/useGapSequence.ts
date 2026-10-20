import { useEffect, type RefObject } from "react";

/**
 * Scroll-driven timeline for "One night, two apps", plus the "curtain" hand-off to "The gap".
 *
 * The section is a stack of three layers (see GapSequence.tsx / the "gap sequence" block in index.css):
 *
 *   .gap-stage    the illustration, position: sticky, one viewport tall: the fixed background canvas
 *   .gap-space    an empty scroll spacer under the stage: the extra distance the stage stays pinned
 *   .gap-curtain  "The gap" copy, a full-viewport panel that scrolls up over the pinned stage
 *
 * Scroll position is the only clock, so everything is a 1:1 scrub (no snapping, no timers). The merge is bound to
 * scroll from the first pixel of the grid that enters the viewport: it starts when the top of the grid (the time
 * axis and the three app rows, in their split state) reaches MERGE_ENTER of the way down the viewport (1 = the
 * bottom edge, so as soon as any part of either half is on screen). Until then nothing moves, so the first thing
 * seen is always the split grid, then the merge, then the bars: no phase is skipped or already under way when
 * the grid appears. The merge and the first bar outlines play while the grid scrolls up to the pin. The stage
 * pins when the section's top reaches the top of the viewport; the later steps play while it is pinned, the
 * finished diagram holds for a beat, and only then does the curtain start to rise.
 *
 * The timeline is measured in *steps*: one step is one `--gap-phase` of scrolling (about 30% of the viewport
 * height), a single flick or a few wheel notches. Each of the five steps plays one whole phase. Each phase's
 * progress (0 → 1) is written to a CSS custom property on the section; index.css turns those into transforms,
 * clip-paths and dash offsets. Scrolling back up plays everything in reverse.
 *
 *   (A) split layout: the grid content cut in two far-apart halves    the opening state (before the merge),
 *       (edge to edge, partly clipped by the viewport), enlarged,      held until the grid enters the viewport
 *       schedule hidden
 *   1   the two grid halves slide together and shrink back to their   --merge  (one whole, distinct gesture;
 *       natural size, merging into the unified grid, centred in the    not skipped, nothing else before it).
 *       card. Translation and scale both follow --merge, so they       It starts MERGE_ENTER of the way down the
 *       finish together, where step 1 has always ended.                viewport and ends exactly where it always did.
 *   2   bar 1 / bar 2: outlines (staggered), fills, then the label writes itself out, character by character
 *       (each character traces its outline, then fills: --b1-text / --b2-text, see WriteText in GapSequence.tsx)
 *   3   bars duplicate down into the Phylax lane; their intersection takes the overlap colour
 *   4   overlap bar: outline, then a marker hatch fills it: one pen stroke zigzagging across the box in
 *       alternating diagonal lines (--clash-fill, see lib/clashHatch.ts). The moment that fill reaches 100% the
 *       section is flagged data-clash-filled and the box's main motion, the marching stripes, begins (a CSS clock)
 *   5   "OVERLAP · 6A–7A" label, then the supporting line
 *
 * The step clock (and with it the pin, the spacer and steps 2–5) is anchored where it always was, at CLOCK_START.
 * Only the merge reaches back before that anchor, to MERGE_ENTER, so it is spread over a longer stretch of scroll
 * while still finishing at the same scroll position as before. The complex sequence (2–5) only begins once the
 * merge is complete: step 2 starts exactly where the merge ends. Nothing but the merge is visible before step 2, and the finished state holds for a short tail while
 * still pinned, then the curtain (pure CSS, native scroll) rises over it.
 */

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
// A gentler ease-out for the merge: it now spans a longer, edge-to-edge travel, and a cubic would spend most of it
// in the first moments of scroll. The quadratic still lands softly (zero speed at the end) but stays parallax-like.
const easeOutQuad = (t: number) => 1 - (1 - t) * (1 - t);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const linear = (t: number) => t;

/** The merge is the very first thing on the timeline (the split layout is the pre-scroll opening state, so the
 * first scroll gesture is one whole, distinct merge), and the finished diagram holds after step 5 (in steps). */
const LEAD = 0;
const TAIL = 0.4;
const STEPS = 5;
/** Total scroll distance of the timeline in steps. Written to --gap-span, which sizes the spacer in index.css. */
const SPAN = LEAD + STEPS + TAIL;
/** Where the step clock is anchored, as a fraction of the viewport height from the top: step 1 (the merge) used to
 * begin when the top of the grid (`.gap-lanes`, the split illustration) reached this line, so the merge *ends* one
 * step later. Everything after the merge (steps 2–5, the pin spacer, the curtain) is measured from this anchor, so
 * it must not move: that is what keeps the merge finishing at the same scroll position as before. The distance
 * scrolled before the pin is the lead-in; it is measured, not hard-coded (it depends on where the grid sits in the
 * stage), and written to --gap-lead so the CSS spacer is sized from the same number. */
const CLOCK_START = 0.85;
/** Where the merge starts, on the same scale: the grid's top edge at this fraction of the viewport height. 1 is the
 * bottom edge of the viewport, i.e. the merge is bound to scroll the instant any part of either half (the halves
 * share one top edge) enters the viewport. The scroll between this line and CLOCK_START is added in front of
 * step 1, so the merge is stretched, not moved: it still ends where step 1 ends. */
const MERGE_ENTER = 1;

/** The overlap box's hatch progress. At exactly 1 the draw is complete and the stripes may move (see `write`). */
const CLASH_FILL = "--clash-fill";

type Phase = { v: string; step: 1 | 2 | 3 | 4 | 5; from: number; to: number; ease: (t: number) => number };

// `from`/`to` are fractions (0 → 1) of that phase's own step. Everything for a step finishes by ~0.9 of it
// (the merge runs its full step), so the phase is complete a moment before the next gesture begins, and
// nothing from a later step starts early.
const PHASES: Phase[] = [
  // 1. merge: the two grid halves slide together (and shrink to their natural size) into the unified grid. It is
  //    not listed here: it starts before the step clock does (see MERGE_ENTER), so it is written by `write` from
  //    its own, longer window, which ends where this step would have ended (t = LEAD + 1).

  // 2. outlines: bar 2 starts drawing before bar 1's outline finishes
  { v: "--b1-line", step: 2, from: 0.0, to: 0.38, ease: linear },
  { v: "--b2-line", step: 2, from: 0.14, to: 0.52, ease: linear },
  //    bar 1 fills the moment its outline closes, its text follows; bar 2 does the same on its own outline. The text
  //    is written, not faded, so it gets a longer window (linear: the pen moves at the speed of the scroll)
  { v: "--b1-fill", step: 2, from: 0.38, to: 0.6, ease: easeOut },
  { v: "--b1-text", step: 2, from: 0.52, to: 0.9, ease: linear },
  { v: "--b2-fill", step: 2, from: 0.52, to: 0.74, ease: easeOut },
  { v: "--b2-text", step: 2, from: 0.64, to: 0.99, ease: linear },

  // 3. duplication and migration, one bar right after the other, then the overlap colour
  { v: "--dup1", step: 3, from: 0.0, to: 0.5, ease: easeInOut },
  { v: "--dup2", step: 3, from: 0.38, to: 0.88, ease: easeInOut },
  { v: "--tint", step: 3, from: 0.76, to: 0.96, ease: easeOut },

  // 4. overlap bar: outline, then the marker hatch (linear: a pen moves at a steady speed)
  { v: "--clash-line", step: 4, from: 0.0, to: 0.55, ease: linear },
  { v: CLASH_FILL, step: 4, from: 0.5, to: 0.95, ease: linear },

  // 5. caption: label first, supporting line right behind it
  { v: "--flag", step: 5, from: 0.0, to: 0.5, ease: easeOut },
  { v: "--note", step: 5, from: 0.35, to: 0.9, ease: easeOut },
];

/** The merge's window on the step clock: it ends where step 1 always ended, and starts `mergeFrom` (≤ LEAD, measured
 * from MERGE_ENTER) earlier. Written to --merge, which drives both the translation and the scale of the halves. */
const MERGE_TO = LEAD + 1;

// Resolve each phase's step-relative window to absolute positions on the step clock.
const TIMELINE = PHASES.map(({ v, step, from, to, ease }) => ({
  v,
  ease,
  from: LEAD + (step - 1) + from,
  to: LEAD + (step - 1) + to,
}));

export function useGapSequence(
  sectionRef: RefObject<HTMLElement | null>,
  stageRef: RefObject<HTMLElement | null>,
  spaceRef: RefObject<HTMLElement | null>,
  lanesRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const section = sectionRef.current;
    const stage = stageRef.current;
    const space = spaceRef.current;
    const lanes = lanesRef.current;
    if (!section || !stage || !space || !lanes) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let last = -1;
    // Scroll distance between the step clock starting and the pin beginning, in px (see CLOCK_START).
    let lead = 0;
    // How much earlier than the step clock the merge starts, in px of scroll (see MERGE_ENTER).
    let early = 0;

    // `t` is the scroll position on the step clock (-early → SPAN); `mergeFrom` is where the merge starts on it.
    const write = (t: number, mergeFrom: number) => {
      section.style.setProperty("--merge", easeOutQuad(clamp01((t - mergeFrom) / (MERGE_TO - mergeFrom))).toFixed(4));
      let clashFill = 0;
      for (const { v, from, to, ease } of TIMELINE) {
        // Round exactly as the CSS variable is written, so "complete" below means what the screen shows.
        const progress = Number(ease(clamp01((t - from) / (to - from))).toFixed(4));
        section.style.setProperty(v, String(progress));
        if (v === CLASH_FILL) clashFill = progress;
      }
      // Trigger: the overlap box's marching stripes (its main motion) start only once the diagonal marker fill is
      // 100% drawn, and stop again if the scroll takes the fill back below it. CSS does the rest (index.css, E).
      const filled = clashFill >= 1 ? "true" : "false";
      if (section.dataset.clashFilled !== filled) section.dataset.clashFilled = filled;
    };

    // Distance each duplicate travels: from its source lane's track down to the Phylax lane's track.
    // The grid is rendered once per pane (two complementary clips of the same content), so any one pane
    // carries the full geometry; measure the left pane.
    const measure = () => {
      // The grid's top edge, measured from the stage's top: the same whether the stage is pinned or not.
      const lanesStart = lanes.getBoundingClientRect().top - stage.getBoundingClientRect().top;
      lead = Math.max(0, CLOCK_START * stage.offsetHeight - lanesStart);
      section.style.setProperty("--gap-lead", `${lead}px`);
      // The section's top edge is at `lead` when the step clock starts. The grid's top edge reaches MERGE_ENTER of the
      // way down the viewport when the section's top is at this much (the stage sits at the section's top until the
      // pin), so the merge starts that much scroll earlier.
      early = Math.max(0, MERGE_ENTER * window.innerHeight - lanesStart - lead);
      const tracks = section.querySelectorAll<HTMLElement>(".gap-pane-left .lane-track");
      if (tracks.length < 3) return;
      // Measure in layout space (offsetTop), never with getBoundingClientRect: the panes are scaled (and moved) by
      // the merge, and a bounding rect includes that transform. The duplicates are translated inside the pane, in
      // its own unscaled units, so a rect measured while the pane is enlarged (or from a resize mid-merge) would
      // overshoot by the current scale and park the clones above their sources. The tracks share one offsetParent
      // (the positioned pane), so their offsetTop difference is the true layout distance at any scale.
      const target = tracks[2].offsetTop;
      section.style.setProperty("--dy1", `${tracks[0].offsetTop - target}px`);
      section.style.setProperty("--dy2", `${tracks[1].offsetTop - target}px`);
    };

    const update = () => {
      frame = 0;
      if (reduced.matches) {
        if (last !== SPAN) { write(SPAN, 0); last = SPAN; }
        return;
      }
      // Before the pin the stage sits at the section's top edge, so that edge's distance from the top of the
      // viewport is the scroll clock: `lead` at the step clock's anchor (t = 0), 0 when the pin begins, then
      // -spacer at the end of the hold (t = SPAN). The merge also runs on it, from `early` px before the anchor
      // (t < 0) when the grid first enters the viewport, so t may go negative, down to the merge's start.
      const distance = lead + space.offsetHeight;
      const stepPx = distance / SPAN;
      const mergeFrom = stepPx > 0 ? -early / stepPx : 0;
      const raw = stepPx > 0 ? (lead - section.getBoundingClientRect().top) / stepPx : SPAN;
      const t = Math.min(SPAN, Math.max(mergeFrom, raw));
      if (t === last) return;
      last = t;
      write(t, mergeFrom);
    };

    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const onResize = () => { measure(); last = -1; schedule(); };

    // The spacer's height is derived from --gap-span (and --gap-lead, measured below), so one step is always one
    // --gap-phase of scrolling.
    section.style.setProperty("--gap-span", String(SPAN));
    measure();
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", onResize);
    reduced.addEventListener("change", onResize);
    // Fonts and layout settling can move the lanes after mount.
    const observer = new ResizeObserver(onResize);
    observer.observe(stage);
    observer.observe(space);
    document.fonts?.ready.then(onResize);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", onResize);
      reduced.removeEventListener("change", onResize);
      observer.disconnect();
    };
  }, [sectionRef, stageRef, spaceRef]);
}
