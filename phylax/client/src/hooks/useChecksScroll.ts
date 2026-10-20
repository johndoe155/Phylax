import { useEffect, useRef, type RefObject } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

/** Height of the fixed nav (.global-nav). The last step never lands under it. */
const NAV_H = 76;
/** Where the list's top edge is, as a fraction of the viewport height from the top, when item 1 opens (below the midpoint). */
const FIRST = 0.68;
/** Where it is when the last item opens (upper part of the screen). The steps in between are spaced evenly. */
const LAST = 0.2;
/** Scroll distance between two steps is kept inside this range (px), so short screens still get a readable beat per
 * item and tall screens don't make the person scroll half a page for each one. */
const MIN_STEP = 80;
const MAX_STEP = 240;

/**
 * Scroll-linked sequence for "The checks" (landing page, section 03): exactly one item is open at a time, and
 * scrolling down walks through them.
 *
 *   list top crosses FIRST of the viewport height   → item 1 opens
 *   list keeps rising, passes the halfway step      → item 1 closes, item 2 opens
 *   list rises to the last step                     → item 2 closes, item 3 opens (and stays open as the list leaves)
 *
 * Direction: scroll position is the only source of truth, so scrolling back up simply plays it in reverse
 * (3 → 2 → 1 → all closed once the list drops back below the first step). Because nothing depends on what happened
 * before, it is also correct after a reload mid-page, an anchor jump or a fast fling (it lands on the right item
 * instead of replaying every step).
 *
 * Clicking a row still works. A manual choice stands until the scroll position next crosses a step, so the person
 * can read or reopen something without it being snatched away on the very next frame.
 *
 * Responsive: the thresholds are fractions of the viewport height (re-measured on resize / orientation change via
 * invalidateOnRefresh), with the distance between steps clamped to MIN_STEP..MAX_STEP and the last step kept clear
 * of the nav, so a 360px-tall landscape phone and a 1080px desktop both get an even three-step progression.
 *
 * Performance: ScrollTrigger caches the step positions at refresh, so a scroll tick is a subtraction and a compare,
 * with no layout reads. React is only told when the item actually changes.
 *
 * Scroll anchoring: opening an item grows the list. Chrome/Android would answer by scrolling to keep whatever is
 * below the list in place, which slides the list upward under the finger and can trip the next step on its own. While
 * the list is on screen, anchoring is switched off on the page root and restored when it leaves.
 *
 * With prefers-reduced-motion the list is manual only (click to open), like the rest of the page's scroll effects.
 *
 * @param listRef  the `.calendar-list` element (its top edge is what the thresholds track)
 * @param count    number of items
 * @param onIndex  called with the index to open, or -1 for "none open"; only when it changes
 */
export function useChecksScroll(listRef: RefObject<HTMLElement | null>, count: number, onIndex: (index: number) => void) {
  const onIndexRef = useRef(onIndex);
  onIndexRef.current = onIndex;

  useEffect(() => {
    const list = listRef.current;
    if (!list || count < 1) return;
    const root = document.documentElement;
    const lastIndex = count - 1;

    const firstY = () => window.innerHeight * FIRST;
    // Distance from the viewport top to the last step: wanted spot, but with the step size and the nav respected.
    const lastY = () => {
      const first = firstY();
      const wanted = Math.max(window.innerHeight * LAST, NAV_H + 16);
      const span = Math.min(MAX_STEP * lastIndex, Math.max(MIN_STEP * lastIndex, first - wanted));
      return first - span;
    };

    let current = -1; // what we last asked for; the initial React state is "none open"
    const sync = (self: ScrollTrigger) => {
      const span = self.end - self.start;
      // Unclamped progress: < 0 before the first step, > 1 once past the last one.
      const raw = span > 0 ? (self.scroll() - self.start) / span : self.scroll() < self.start ? -1 : 1;
      const index = raw < 0 ? -1 : Math.min(lastIndex, Math.floor(raw * lastIndex + 1e-6));
      if (index === current) return;
      current = index;
      onIndexRef.current(index);
    };

    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      // Step 1 is where the list's top is at firstY(), the last step where it is at lastY(); the ones between split
      // that distance evenly (item k opens at k / (count - 1) of the way).
      ScrollTrigger.create({
        trigger: list,
        start: () => `top ${firstY()}px`,
        end: () => `top ${lastY()}px`,
        invalidateOnRefresh: true, // re-measure on resize / orientation change / font load
        onUpdate: sync,
        onToggle: sync,
        onRefresh: sync, // lands on the right item after a reload or anchor jump
      });

      // Keep the browser from "helping" while the list changes height (see above).
      const holdAnchor = (self: ScrollTrigger) => { root.style.overflowAnchor = self.isActive ? "none" : ""; };
      ScrollTrigger.create({
        trigger: list,
        start: "top bottom",
        end: "bottom top",
        onToggle: holdAnchor,
        onRefresh: holdAnchor,
      });

      return () => { root.style.overflowAnchor = ""; };
    });

    // Web fonts change the height of everything above the list, which moves the step positions.
    let cancelled = false;
    document.fonts?.ready.then(() => { if (!cancelled) ScrollTrigger.refresh(); });

    return () => {
      cancelled = true;
      mm.revert(); // kills both triggers and restores overflow-anchor
    };
  }, [listRef, count]);
}
