import { useEffect, type RefObject } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

/** The warp plays over this much scrolling (px) once the bottom edge starts rising: 40% of the viewport height, kept
 * inside these bounds so a short landscape phone still sees it grow and a tall desktop doesn't drag it out. */
const MIN_RANGE = 160;
const MAX_RANGE = 360;
const RANGE_VH = 0.4;

/**
 * Scroll-linked "bulge" on the bottom edge of "The checks" (landing page, section 03).
 *
 * The section's bottom edge starts flat. As it scrolls up into view, an arch of the section's own colour grows out of
 * it and pushes down over the cream section below, so the edge reads as curving outwards. When the edge has risen
 * RANGE px the arch is at full depth and stays that way, however far the page is scrolled past it. Scrolling back up
 * plays it in reverse, flattening the edge again as the section leaves.
 *
 * How it is drawn: `.calendar-warp` (see index.css) is an absolutely positioned strip hanging off the section's
 * bottom edge, always at full depth. Its only content is a background: a circle of the section's colour whose lower
 * rim is the arch. Scroll progress picks the circle's radius and position so that the rim is a circular arc of the
 * current depth, running from one corner of the section to the other (for a curve this shallow it is
 * indistinguishable from a parabola). The strip never changes size, it is out of flow, and nothing around it moves.
 *
 * Why a gradient and not a path or a transform: the edge is very shallow and as high-contrast as it gets (ink on
 * cream), and a shallow edge crosses each pixel row over a long run. Drawn as a vector path it depends on the
 * device's edge antialiasing, and many phone GPUs only do a coarse version, which shows up as a staircase of tiny
 * rectangles. (Scaling a pre-rendered strip with a transform was worse: the browser rasterises it at its near-zero
 * starting size and stretches the bitmap.) A radial gradient is evaluated per pixel with a 1px soft rim, so the edge
 * is smooth on every device whatever its path antialiasing does.
 *
 * Depth is a CSS variable (`--warp-depth`, a clamp on the viewport width), so the curve scales with the screen; the
 * width and depth are read from the strip with a ResizeObserver, so rotation and resizing redraw it correctly.
 *
 * Timing: the range is measured from where the section's bottom edge will be once the checks' own scroll sequence
 * has the last item open, which is where the page is when the edge actually comes into view. (Measuring a collapsed
 * list would start the warp about one open item's height too early, and the list changes height as items open.)
 * It is re-measured on resize / font load (invalidateOnRefresh) and scrubbed with a little smoothing.
 *
 * With prefers-reduced-motion the edge simply stays flat.
 *
 * @param sectionRef the `<section id="checks">` element
 * @param warpRef    the `.calendar-warp` element inside it
 */
export function useChecksWarp(sectionRef: RefObject<HTMLElement | null>, warpRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const section = sectionRef.current;
    const warp = warpRef.current;
    if (!section || !warp) return;
    const list = section.querySelector<HTMLElement>(".calendar-list");

    // Document Y of the section's bottom edge with the last check open, whatever is open right now.
    const settledBottom = () => {
      let y = section.getBoundingClientRect().bottom + window.scrollY;
      if (list) {
        const details = list.querySelectorAll<HTMLElement>(".calendar-detail");
        const lastInner = details[details.length - 1]?.firstElementChild as HTMLElement | undefined;
        const openNow = list.querySelector<HTMLElement>('.calendar-item[data-open="true"] .calendar-detail');
        y += (lastInner?.scrollHeight ?? 0) - (openNow?.offsetHeight ?? 0);
      }
      return y;
    };
    // The edge enters at the bottom of the viewport; the arch is complete RANGE px of scrolling later.
    const start = () => settledBottom() - window.innerHeight;
    const range = () => Math.min(MAX_RANGE, Math.max(MIN_RANGE, window.innerHeight * RANGE_VH));

    // Strip size in px (read when it resizes, never per frame) and the current progress, 0 → 1.
    let width = 0;
    let depth = 0;
    let progress = 0;

    // A circle of radius r whose lowest point is d below the strip's top and which passes through both top corners:
    // (w/2)^2 + (r - d)^2 = r^2  →  r = (w^2/4 + d^2) / (2d). Its centre is r above that lowest point. The gradient
    // is solid inside the rim and fades to transparent over 1px across it, which is the edge's antialiasing.
    const draw = () => {
      const d = progress * depth;
      if (d < 0.3 || width <= 0) {
        warp.style.backgroundImage = "none"; // flat edge: paint nothing
        return;
      }
      const r = (width * width) / (8 * d) + d / 2;
      warp.style.backgroundImage =
        `radial-gradient(circle ${r.toFixed(2)}px at 50% ${(d - r).toFixed(2)}px, var(--ink) ${(r - 0.5).toFixed(2)}px, transparent ${(r + 0.5).toFixed(2)}px)`;
    };

    const resizeObserver = new ResizeObserver(() => {
      width = warp.offsetWidth;
      depth = warp.offsetHeight;
      draw();
    });
    resizeObserver.observe(warp);

    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      const arch = { p: 0 };
      gsap.to(arch, {
        p: 1,
        ease: "none", // the scroll position is the only easing
        onUpdate: () => { progress = arch.p; draw(); },
        scrollTrigger: {
          start, // absolute scroll positions, like the hero logo's trigger
          end: () => start() + range(),
          scrub: 0.5,
          invalidateOnRefresh: true,
        },
      });
      return () => { progress = 0; draw(); }; // flat edge again
    });

    // Web fonts change the height of everything above the edge, which moves the range.
    let cancelled = false;
    document.fonts?.ready.then(() => { if (!cancelled) ScrollTrigger.refresh(); });

    return () => {
      cancelled = true;
      mm.revert(); // kills the trigger and flattens the edge
      resizeObserver.disconnect();
      warp.style.backgroundImage = "";
    };
  }, [sectionRef, warpRef]);
}
