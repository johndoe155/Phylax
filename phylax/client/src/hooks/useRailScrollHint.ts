import { useEffect, useState, type RefObject } from "react";

/** How far (px) the rail must have moved sideways before the visitor counts as having started to scroll it. */
const SCROLLED_PX = 6;

/**
 * Whether to show the "scroll" hint for a horizontally scrolling rail (Section 01's three illustrations).
 *
 * The hint is shown only while the rail really does scroll sideways (it only does on narrow screens; on a wide screen
 * all three cards are already on screen and there is nothing to scroll), and only until the visitor first scrolls it.
 * After that it stays gone for good, even if they scroll back.
 */
export function useRailScrollHint(ref: RefObject<HTMLElement | null>) {
  const [overflowing, setOverflowing] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const rail = ref.current;
    if (!rail) return;

    const measure = () => {
      const scrollable = getComputedStyle(rail).overflowX !== "visible";
      setOverflowing(scrollable && rail.scrollWidth - rail.clientWidth > SCROLLED_PX);
    };
    const onScroll = () => {
      // The rail only scrolls sideways. Anything that nudges it vertically (a focus scroll, a tiny overflow) is undone,
      // otherwise the card's edge gets clipped and the shift board's "fully in view" autoplay check flips.
      if (rail.scrollTop !== 0) rail.scrollTop = 0;
      if (Math.abs(rail.scrollLeft) > SCROLLED_PX) setScrolled(true);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(rail);
    Array.from<Element>(rail.children).forEach((child) => ro.observe(child));
    rail.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      rail.removeEventListener("scroll", onScroll);
    };
  }, [ref]);

  return overflowing && !scrolled;
}
