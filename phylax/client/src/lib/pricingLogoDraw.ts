/**
 * Scroll-scrubbed self-drawing for the Pricing logo sketch (assets/pricing-icons/0-phylax-logo.svg).
 *
 * The drawing follows where the logo is on screen: scroll down and it draws, scroll back up and it un-draws. It has no
 * timeline, no plugin, no IntersectionObserver and no media-query gate, so there is no "start" event that can be
 * missed. Every stroke is revealed by writing `stroke-dashoffset` on the real <path>; the dash length is MEASURED with
 * getTotalLength().
 *
 * Smoothness (scroll-v5):
 *  - The scroll position is only the TARGET. What is drawn eases toward it (exponential, time-constant
 *    SMOOTHING_SECONDS, never overshoots), so wheel notches, flings, direction reversals and layout shifts above the
 *    logo glide instead of stepping. The ease is skipped for prefers-reduced-motion (the drawing then tracks scroll 1:1).
 *  - Only strokes whose drawn state actually changed are written. Mid-draw a frame touches the handful of strokes that
 *    are in motion, not all of them, and an idle page writes nothing - every write re-rasterises the SVG's pencil filter.
 *  - Strokes are blanked with the dash offset alone. They no longer toggle `visibility`: a path's own `visibility:
 *    visible` overrides a hidden ancestor, which let half-drawn strokes show through whenever PricingIconCycle was
 *    displaying another sketch.
 *  - "Done" has hysteresis (RELEASE_BELOW), and the logo is held fully drawn inside that band, so a pixel or two of
 *    scroll jitter at the finish line cannot flap the sketch loop or redraw the last hatch strokes.
 *
 * Hardening (each one closes a way a draw can silently do nothing):
 *  - The SVG and its paths are re-resolved on every update, so if React re-creates the markup the draw rebinds.
 *  - Paths that cannot be measured yet (not laid out) are retried; if measuring is impossible they fall back to
 *    `pathLength="1"` normalisation instead of being skipped.
 *  - Styles are written with `!important`, so a stylesheet rule cannot override them.
 *  - State is re-applied from scroll events, resize, layout changes AND a slow poll, so a scroller that does not fire
 *    window scroll events (or a missed event) cannot leave it stuck.
 *  - The logo always completes: if the page cannot scroll far enough to lift it to DRAW_END, the end point moves down.
 *  - Open DevTools -> `document.querySelector('.pricing-cycle').dataset.logoDraw` shows the live state, and
 *    `window.__logoDraw` exposes it; add `?logodebug` to the URL for an on-screen readout.
 */

export const LOGO_DRAW_VERSION = "scroll-v5";

/** The logo starts drawing when its top edge is this far down the viewport (fraction of viewport height)... */
export const DRAW_START = 0.9;
/** ...and is completely drawn when its top edge has risen to this fraction. */
export const DRAW_END = 0.5;

/** The sequence, in "seconds" of a virtual timeline that the scroll progress is mapped onto. */
export const SEQUENCE = {
  rectA: { at: 0, each: 0.32, stagger: 0.26, eased: true },
  rectB: { at: 0.55, each: 0.32, stagger: 0.26, eased: true },
  hatch: { at: 1.45, each: 0.16, stagger: 0.025, eased: false },
} as const;

/** Time constant (seconds) of the ease between the scroll position and what is drawn: ~63% of a jump is covered in this
 * long, ~95% in three times it. Short enough to feel attached to the scroll, long enough to hide wheel notches. */
export const SMOOTHING_SECONDS = 0.12;
/** Once complete the logo only counts as "not done" again below this (slack so a few px of jitter at the finish line
 * does not flap whatever is keyed off completion). Scrolling back up into the drawing proper still releases it. */
export const RELEASE_BELOW = 0.98;
/** A drawn progress this close to its target is snapped onto it (a small fraction of a pixel of scroll, under 0.05 SVG units of stroke tip). */
const SETTLE_EPSILON = 0.0001;
/** Longest frame the ease integrates over; after a stall (tab asleep, long task) it catches up over a few frames. */
const MAX_FRAME_SECONDS = 0.1;

const easeInOutQuad = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export interface Stroke {
  path: SVGGeometryElement;
  length: number;
  pad: number;
  at: number;
  each: number;
  eased: boolean;
  /** What was last written to the element ("done" = styles removed, else the dash offset); lets unchanged strokes be skipped. */
  applied: string | null;
}

/** Pairs the i-th path of every pass (main + loose) of one rectangle, so both passes of a side draw together. */
function sidesOf(svg: SVGSVGElement, cls: string): SVGGeometryElement[][] {
  const passes = Array.from(svg.querySelectorAll<SVGElement>(`.${cls}`));
  if (!passes.length) return [];
  const lists = passes.map((g) => Array.from(g.querySelectorAll<SVGGeometryElement>("path")));
  const count = Math.min(...lists.map((l) => l.length));
  return Array.from({ length: count }, (_, i) => lists.map((l) => l[i]));
}

/** Measures every drawable path and schedules it on the virtual timeline. */
export function collectStrokes(svg: SVGSVGElement): { strokes: Stroke[]; total: number; unmeasured: number } {
  const groups = [
    { sides: sidesOf(svg, "logo-a"), ...SEQUENCE.rectA },
    { sides: sidesOf(svg, "logo-b"), ...SEQUENCE.rectB },
    { sides: Array.from(svg.querySelectorAll<SVGGeometryElement>(".logo-hatch path")).map((p) => [p]), ...SEQUENCE.hatch },
  ];
  const strokes: Stroke[] = [];
  let total = 0;
  let unmeasured = 0;
  for (const { sides, at, each, stagger, eased } of groups) {
    sides.forEach((paths, i) => {
      const start = at + i * stagger;
      for (const path of paths) {
        let length = 0;
        try {
          length = path.getTotalLength();
        } catch {
          length = 0;
        }
        let pad: number;
        if (Number.isFinite(length) && length > 0) {
          // A round cap sticks out half a stroke-width past a dash end, so even a zero-length dash would show as a
          // dot. Starting the offset this much further out keeps the path blank until its own draw begins.
          const width = parseFloat(getComputedStyle(path).strokeWidth) || 2;
          pad = Math.max(2, width) + 0.5;
        } else {
          // Cannot be measured right now: let the browser normalise the path to length 1 instead of skipping it.
          unmeasured++;
          path.setAttribute("pathLength", "1");
          length = 1;
          pad = 0.5; // normalised units: half the path, comfortably more than a round cap even on the shortest hatch line
        }
        strokes.push({ path, length, pad, at: start, each, eased, applied: null });
        total = Math.max(total, start + each);
      }
    });
  }
  return { strokes, total, unmeasured };
}

const set = (el: SVGElement, prop: string, value: string) => el.style.setProperty(prop, value, value ? "important" : "");

/**
 * Writes the drawing state for progress p (0..1). At 0 every stroke is blank; at 1 the styles are removed entirely.
 * A stroke whose state is unchanged since its last write is skipped (pass `force` to rewrite everything, e.g. to repair
 * styles something else wiped). Blank strokes are blank because their dash sits wholly before the start of the path
 * (offset = length + pad); there is deliberately no `visibility` toggle, see the header.
 */
export function applyProgress(strokes: Stroke[], total: number, p: number, force = false): void {
  const time = clamp01(p) * total;
  for (const s of strokes) {
    const raw = clamp01((time - s.at) / s.each);
    const local = s.eased ? easeInOutQuad(raw) : raw;
    const el = s.path;
    if (raw >= 1) {
      if (!force && s.applied === "done") continue;
      s.applied = "done";
      set(el, "stroke-dasharray", "");
      set(el, "stroke-dashoffset", "");
    } else {
      // dash = the whole path; the gap is long enough that the start offset still lands inside a gap (blank).
      const offset = ((s.length + s.pad) * (1 - local)).toFixed(3);
      if (!force && s.applied === offset) continue;
      s.applied = offset;
      set(el, "stroke-dasharray", `${s.length} ${2 * s.length + 2 * s.pad}`);
      set(el, "stroke-dashoffset", `${offset}px`);
    }
  }
}

function clearStrokes(strokes: Stroke[]): void {
  for (const s of strokes) {
    set(s.path, "stroke-dasharray", "");
    set(s.path, "stroke-dashoffset", "");
    s.applied = null;
    if (s.path.getAttribute("pathLength") === "1") s.path.removeAttribute("pathLength");
  }
}

/** Forgets what was written to any stroke whose inline style no longer says so (wiped or overwritten by something else),
 * so the next applyProgress rewrites exactly those and leaves the rest alone. Cheap reads only. */
export function invalidateWiped(strokes: Stroke[]): void {
  for (const s of strokes) {
    if (s.applied === null) continue;
    const dashoffset = s.path.style.getPropertyValue("stroke-dashoffset");
    // The browser re-serialises what was written ("13.000px" reads back as "13px"), so compare numbers, not strings.
    const intact = s.applied === "done" ? dashoffset === "" : Math.abs(parseFloat(dashoffset) - parseFloat(s.applied)) < 0.0015;
    if (!intact) s.applied = null;
  }
}

/** Moves `current` toward `target` by an exponential ease over `dt` seconds. Never overshoots, is continuous when the
 * target reverses, and lands exactly on the target once within SETTLE_EPSILON. A non-finite `current` snaps. */
export function easeToward(current: number, target: number, dt: number, tau: number = SMOOTHING_SECONDS): number {
  if (!Number.isFinite(current)) return target;
  if (!(dt > 0)) return current;
  const next = current + (target - current) * (1 - Math.exp(-Math.min(dt, MAX_FRAME_SECONDS) / tau));
  return Math.abs(target - next) < SETTLE_EPSILON ? target : next;
}

/** Whether the logo counts as completely drawn at drawn-progress p: reached at exactly 1, released only below RELEASE_BELOW. */
export function isLogoDone(p: number, wasDone: boolean): boolean {
  return wasDone ? p >= RELEASE_BELOW : p >= 1;
}

/** 0 while the logo is still below DRAW_START, 1 once its top has risen to `end` (viewport fractions), linear between. */
export function scrollProgress(top: number, viewportHeight: number, end: number = DRAW_END): number {
  return clamp01((viewportHeight * DRAW_START - top) / (viewportHeight * (DRAW_START - end)));
}

/**
 * Binds the drawing to scrolling. Applies the right state immediately (before the first paint, so a reload part-way down
 * the page is correct), then follows scroll / resize / layout changes / a poll tick: each measures the logo's live
 * position (the target) and eases what is drawn toward it, one frame at a time, until it arrives. `onDone` is told true
 * when the logo is fully drawn and false again when the visitor scrolls back up into it. `resolveSvg` is called on every
 * update so a re-created SVG is picked up. Returns a cleanup that restores the untouched static SVG.
 */
export function watchLogoScroll(
  root: HTMLElement,
  resolveSvg: () => SVGSVGElement | null,
  onDone: (done: boolean) => void,
): () => void {
  let svg: SVGSVGElement | null = null;
  let strokes: Stroke[] = [];
  let total = 0;
  let done: boolean | null = null;
  let raf = 0;
  let shown = NaN; // the progress currently drawn (NaN: nothing drawn yet, so the first measurement is taken as-is)
  let lastFrame = 0; // timestamp of the previous animating frame, 0 when idle
  let verify = false; // set by the poll tick: this frame first repairs any stroke whose styles something else wiped
  let lastLabel = -1;
  const debug = /[?&]logodebug\b/.test(window.location.search);
  let hud: HTMLElement | null = null;
  const reduced = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

  const bind = () => {
    if (strokes.length) clearStrokes(strokes);
    svg = resolveSvg();
    strokes = [];
    total = 0;
    if (!svg) return;
    const found = collectStrokes(svg);
    strokes = found.strokes;
    total = found.total;
    console.info(`[logo-draw ${LOGO_DRAW_VERSION}] bound: ${strokes.length} strokes, ${found.unmeasured} unmeasured`);
  };

  const frame = (now: number) => {
    raf = 0;
    const live = resolveSvg();
    // (Re)bind when the SVG was replaced, or its paths were detached (React re-set the markup).
    if (live !== svg || !strokes.length || !strokes[0].path.isConnected) bind();
    if (!svg || !strokes.length) {
      if (done !== true) {
        done = true;
        onDone(true); // nothing drawable: never hold the sketch loop back
      }
      return;
    }
    const rect = root.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (!vh || (!rect.width && !rect.height)) return; // not laid out: keep the last state

    // The logo must always be able to finish: if the page cannot scroll far enough to lift it to DRAW_END, finish
    // as soon as it is as high as the page will ever let it get.
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - vh);
    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    const topAtMaxScroll = rect.top - (maxScroll - scrollY);
    const end = Math.max(DRAW_END, Math.min(DRAW_START - 0.05, (topAtMaxScroll + 8) / vh));

    // Where the scroll position says the drawing should be, and how far the drawing gets toward it this frame.
    const target = scrollProgress(rect.top, vh, end);
    const dt = lastFrame ? (now - lastFrame) / 1000 : 1 / 60;
    shown = reduced?.matches ? target : easeToward(shown, target, dt);
    const settled = shown === target;
    lastFrame = settled ? 0 : now;

    const nowDone = isLogoDone(shown, done === true);
    // Inside the release band a completed logo stays exactly complete.
    if (verify) invalidateWiped(strokes);
    verify = false;
    applyProgress(strokes, total, nowDone ? 1 : shown);
    if (nowDone !== done) {
      done = nowDone;
      onDone(nowDone);
    }
    if (!settled) schedule(); // keep gliding until the drawing has caught up with the scroll position

    (window as unknown as { __logoDraw?: unknown }).__logoDraw = {
      version: LOGO_DRAW_VERSION,
      p: shown,
      target,
      top: rect.top,
      vh,
      strokes: strokes.length,
    };
    // The readable label is a DOM write, so it is only refreshed when the drawn percentage changes (or on settle).
    const pct = Math.round(shown * 100);
    if (pct !== lastLabel || settled) {
      const label = `${LOGO_DRAW_VERSION} p=${shown.toFixed(3)} target=${target.toFixed(3)} top=${Math.round(rect.top)} vh=${vh} strokes=${strokes.length}`;
      if (root.dataset.logoDraw !== label) root.dataset.logoDraw = label;
      lastLabel = pct;
      if (debug) {
        if (!hud) {
          hud = document.createElement("div");
          hud.style.cssText =
            "position:fixed;left:8px;bottom:8px;z-index:99999;padding:6px 8px;font:11px/1.3 monospace;color:#fff;background:rgba(200,0,60,.85);border-radius:4px;pointer-events:none";
          document.body.appendChild(hud);
        }
        hud.textContent = label;
      }
    }
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };

  frame(performance.now()); // synchronously, before the first paint
  // capture: also hears scrolling of any inner scroller, not just the window.
  window.addEventListener("scroll", schedule, { passive: true, capture: true });
  window.addEventListener("resize", schedule);
  window.addEventListener("pageshow", schedule);
  document.addEventListener("visibilitychange", schedule);
  // Layout above Pricing changes height without any scroll event (checks list, late fonts): follow it.
  const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
  resizeObserver?.observe(document.documentElement);
  // Safety net for scrollers that move content without firing scroll events (smooth-scroll libraries, transforms).
  // It also has strokes whose inline styles were wiped repaired within a poll interval (only those are rewritten).
  const poll = window.setInterval(() => {
    if (document.hidden) return;
    verify = true;
    schedule();
  }, 200);

  return () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    window.clearInterval(poll);
    window.removeEventListener("scroll", schedule, { capture: true });
    window.removeEventListener("resize", schedule);
    window.removeEventListener("pageshow", schedule);
    document.removeEventListener("visibilitychange", schedule);
    resizeObserver?.disconnect();
    clearStrokes(strokes);
    hud?.remove();
    delete root.dataset.logoDraw;
  };
}
