import { useLayoutEffect, type RefObject } from "react";
import gsap from "gsap";

/**
 * A number starts as its top edge reaches this far down the viewport. Expressed as an IntersectionObserver
 * rootMargin (the viewport's bottom edge is pulled up by 15%, so "top 85%").
 */
const ROOT_MARGIN = "0px 0px -15% 0px";
const COUNT_SECONDS = 1.3;
/** Delay between numbers that arrive on the same scroll tick (side by side on desktop). */
const STAGGER = 0.18;

/**
 * Section 04 "number rise": each `[data-count]` number rises into place while counting up from 0 to its value.
 *
 * WHY AN INTERSECTION OBSERVER (and not ScrollTrigger): ScrollTrigger caches each trigger's start position at refresh
 * time. Everything above this section keeps changing height without any refresh (The checks list opens/closes items
 * as you scroll, the Gap sequence's pin spacer is sized from CSS variables written after mount, fonts settle), so the
 * cached start drifts and the count-up fires while the numbers are still off screen. IntersectionObserver reads live
 * geometry, so it always fires when the number is really at the line. GSAP still does all the tweening.
 *
 * Staggering follows the scroll position: the observer reports every number that crosses the line in the same tick
 * together (the three side by side on desktop, staggered in DOM order, i.e. left to right), while stacked ones
 * (mobile) each start when their own block reaches the line. A target of 0 has nothing to count, so it simply rises
 * into place already showing 0, with the same timing as the others.
 *
 * Only the number's text node is rewritten (not the element), so React's reference to it stays valid. With
 * prefers-reduced-motion (or no IntersectionObserver), or once the numbers are already above the viewport, the final
 * values are just shown.
 */
export function useStatCountUp(gridRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const nums = Array.from(grid.querySelectorAll<HTMLElement>("[data-count]"));
    if (!nums.length) return;

    const target = (el: HTMLElement) => {
      const n = Math.round(Number(el.dataset.count));
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const textNode = (el: HTMLElement) => (el.firstChild?.nodeType === 3 ? el.firstChild : el.appendChild(document.createTextNode("")));
    const setText = (el: HTMLElement, v: number) => { textNode(el).nodeValue = String(v); };

    const mm = gsap.matchMedia();

    mm.add("(prefers-reduced-motion: no-preference)", () => {
      if (typeof IntersectionObserver === "undefined") return; // the final values simply stay

      const played = new Set<HTMLElement>();
      const pending = nums.filter((el) => el.getBoundingClientRect().bottom >= 0); // not already scrolled past

      nums.forEach((el) => setText(el, pending.includes(el) ? 0 : target(el)));
      gsap.set(pending, { autoAlpha: 0, yPercent: 35 });

      const play = (els: HTMLElement[]) => {
        els.forEach((el, i) => {
          played.add(el);
          const to = target(el);
          const counter = { v: 0 };
          gsap.to(el, { autoAlpha: 1, yPercent: 0, duration: 0.9, ease: "power3.out", delay: i * STAGGER });
          if (to > 0) {
            gsap.to(counter, {
              v: to,
              duration: COUNT_SECONDS,
              ease: "power2.out",
              delay: i * STAGGER,
              onUpdate: () => setText(el, Math.round(counter.v)),
              onComplete: () => setText(el, to),
            });
          }
        });
      };

      const land = (el: HTMLElement) => {
        // Jumped straight past (menu links): no animation to watch, just the final values.
        played.add(el);
        setText(el, target(el));
        gsap.set(el, { autoAlpha: 1, yPercent: 0 });
      };

      const observer = new IntersectionObserver(
        (entries) => {
          const due: HTMLElement[] = [];
          for (const entry of entries) {
            const el = entry.target as HTMLElement;
            if (played.has(el)) continue;
            if (entry.isIntersecting) {
              due.push(el);
            } else if (entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0)) {
              observer.unobserve(el);
              land(el);
            }
            // otherwise: still below the line, keep waiting
          }
          if (!due.length) return;
          due.forEach((el) => observer.unobserve(el));
          // Numbers that cross the line on the same tick are staggered in document order (left to right / top to bottom).
          due.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
          play(due);
        },
        { rootMargin: ROOT_MARGIN, threshold: 0 },
      );
      pending.forEach((el) => observer.observe(el));

      return () => {
        observer.disconnect();
        gsap.killTweensOf(pending);
        gsap.set(pending, { clearProps: "opacity,visibility,transform" });
        nums.forEach((el) => setText(el, target(el)));
      };
    });

    return () => mm.revert();
  }, [gridRef]);
}
