import { useEffect, type RefObject } from "react";
import { FOOTER_ART } from "@/lib/footerBackground";
import { computeBarShift, easeToward, scrollProgress } from "@/lib/footerShift";

/** The bars live inside the panel's own background SVG; scoping the query to it keeps every other SVG untouched. */
const BARS = ":scope > .footer-shape-bg .footer-shape-bar";
/** Time constant, in seconds, of the smoothing between the scroll position and the bars, so wheel notches ease instead of stepping. */
const SMOOTHING = 0.18;
/** Quiet period after the last resize / rotation before the bars are re-measured. */
const RECALC_DELAY_MS = 150;

/**
 * Scroll-driven parallax for the horizontal bars in the footer panel's background artwork.
 *
 * While the footer scrolls into view the bars slide sideways: bars that start in the left half move right, bars that
 * start in the right half move left, so the stack closes in towards the middle. Scrolling back up reverses it. Each bar
 * sits at `progress * travel` along a straight line (lib/footerShift.ts): nothing clamps it part-way.
 *
 * Progress is 0 until the panel's top edge reaches the bottom of the viewport and 1 when the page can scroll no further,
 * a straight line in between. It is computed FROM THE LIVE LAYOUT on every frame (panel position, scroll position,
 * viewport height, page height) rather than cached when the page loaded. So it cannot go stale: a font or image that
 * loads late, content that reflows, or a phone's address bar sliding in and out (which changes the viewport height, and so
 * how far the page can scroll) all move the range with them, and the bars still reach their end position exactly at the
 * end of the page, never before it.
 *
 * What the travel distance is, and why it is not just a fraction of the panel's width: see computeBarShift.
 *
 * Performance:
 * - The only property written is `transform: translateX()`. Nothing that triggers layout is touched, and the bars'
 *   geometry never changes.
 * - Reads and writes are separated. `measure()` (panel size, `getBBox`) runs on mount and after a resize only. Each frame
 *   reads the panel's rect and the scroll metrics first, then writes the transforms, so a scroll tick cannot thrash layout.
 * - Scroll events only schedule a frame; at most one runs per display frame, and none while the bars are at rest.
 * - Bars are only hinted with `will-change: transform` while they are moving.
 * - Note: SVG children are painted inside their parent SVG's layer, so the browser repaints that (small, flat) SVG per
 *   frame rather than moving separate GPU layers. That is the cost of animating inside an SVG and is cheap here.
 *
 * Accessibility: with `prefers-reduced-motion: reduce` the animation is never started and the bars stay where they were
 * drawn. The preference is watched live, so toggling it undoes or starts the effect.
 *
 * `ready` must be true once the bars are in the DOM (FooterShape renders them only after it has measured itself).
 */
export function useFooterShiftBars(panelRef: RefObject<HTMLElement | null>, ready: boolean) {
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || !ready) return;
    const bars = Array.from(panel.querySelectorAll<SVGGraphicsElement>(BARS));
    if (!bars.length) return;

    const travel = bars.map(() => 0); // signed distance each bar covers by the end of the range, in artwork units
    let shown = 0; // progress currently applied to the bars, 0..1 (eased towards the live scroll progress)

    /** Writes only. Artwork units are what CSS `px` means inside the artwork's SVG, so no conversion is needed. */
    const apply = () => {
      for (let i = 0; i < bars.length; i++) bars[i].style.transform = `translateX(${(shown * travel[i]).toFixed(2)}px)`;
    };

    /** Reads only: where the live scroll position is within the range, 0..1. */
    const liveProgress = () => {
      const y = window.scrollY;
      const viewportHeight = window.innerHeight;
      const panelTop = panel.getBoundingClientRect().top + y;
      const maxScroll = document.documentElement.scrollHeight - viewportHeight;
      return scrollProgress(y, panelTop, viewportHeight, maxScroll);
    };

    /** Reads first, writes second. */
    const measure = () => {
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      if (!width || !height) return;
      // The artwork is drawn with `slice`: scaled until it covers the panel, then centred and cropped.
      const scale = Math.max(width / FOOTER_ART.width, height / FOOTER_ART.height);
      const visibleWidth = width / scale; // artwork units actually on screen
      const boxes = bars.map((bar) => bar.getBBox()); // untransformed, so a bar mid-animation still reports its home
      for (let i = 0; i < bars.length; i++) {
        const { side, travel: distance } = computeBarShift(boxes[i].x, boxes[i].width, FOOTER_ART.width / 2, visibleWidth);
        travel[i] = distance;
        bars[i].dataset.shiftSide = side;
      }
    };

    const hint = (active: boolean) => {
      for (const bar of bars) bar.style.willChange = active ? "transform" : "";
    };

    /** Starts the effect; returns the function that undoes it. */
    const run = () => {
      let raf = 0;
      let last = 0;
      let timer = 0;

      const tick = (now: number) => {
        raf = 0;
        const target = liveProgress();
        const dt = last ? Math.min((now - last) / 1000, 0.1) : 1 / 60; // a long gap (background tab) must not jump the easing
        last = now;
        shown = easeToward(shown, target, dt, SMOOTHING);
        apply();
        if (shown !== target) raf = requestAnimationFrame(tick);
        else {
          last = 0;
          hint(false);
        }
      };
      /** Schedules a frame (if one is not already due) in which the bars catch up with the live scroll position. */
      const kick = () => {
        if (raf) return;
        hint(true);
        raf = requestAnimationFrame(tick);
      };

      // Start from the live position, with no easing, so a reload part-way down the page shows the right frame at once.
      measure();
      shown = liveProgress();
      apply();

      /** Re-measure after the layout settles (rotation, resize, a web font reflowing the panel), then catch up. */
      const recalc = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          measure();
          kick();
        }, RECALC_DELAY_MS);
      };

      window.addEventListener("scroll", kick, { passive: true });
      // Resizes (including a phone's address bar changing the viewport height) change the range at once, so catch up now,
      // and re-measure the bars once the size stops changing.
      window.addEventListener("resize", kick, { passive: true });
      window.addEventListener("resize", recalc);
      window.addEventListener("orientationchange", recalc);
      window.visualViewport?.addEventListener("resize", kick);
      // Also catches size changes that aren't window resizes. The observer reports once as soon as it starts watching;
      // that first report is skipped because we have just measured.
      let primed = false;
      const observer = new ResizeObserver(() => {
        if (primed) recalc();
        primed = true;
      });
      observer.observe(panel);
      let cancelled = false;
      document.fonts?.ready.then(() => {
        if (!cancelled) recalc();
      });

      // Runs when the effect is torn down and whenever the reduced-motion preference turns on: back to the drawn, static state.
      return () => {
        cancelled = true;
        if (raf) cancelAnimationFrame(raf);
        window.clearTimeout(timer);
        window.removeEventListener("scroll", kick);
        window.removeEventListener("resize", kick);
        window.removeEventListener("resize", recalc);
        window.removeEventListener("orientationchange", recalc);
        window.visualViewport?.removeEventListener("resize", kick);
        observer.disconnect();
        for (const bar of bars) {
          bar.style.removeProperty("transform");
          bar.style.removeProperty("will-change");
          bar.removeAttribute("data-shift-side");
        }
      };
    };

    const motionOk = window.matchMedia("(prefers-reduced-motion: no-preference)");
    let stop: (() => void) | null = null;
    const sync = () => {
      if (motionOk.matches && !stop) stop = run();
      else if (!motionOk.matches && stop) {
        stop();
        stop = null;
      }
    };
    motionOk.addEventListener("change", sync);
    sync();

    return () => {
      motionOk.removeEventListener("change", sync);
      stop?.();
    };
  }, [panelRef, ready]);
}
