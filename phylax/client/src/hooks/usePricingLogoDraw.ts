import { useLayoutEffect, useState, type RefObject } from "react";
import { watchLogoScroll } from "@/lib/pricingLogoDraw";

/**
 * The Pricing logo sketch draws itself as the visitor scrolls down to it (and un-draws as they scroll back up):
 * rectangle A's four sides, then rectangle B's, then the hatching. See lib/pricingLogoDraw.ts.
 *
 * Returns `true` while the logo is completely drawn, which PricingIconCycle uses to hold the rest of the sketch loop
 * until the logo is complete (and to reset it when the visitor scrolls back up into the drawing).
 *
 * The drawing is a pure function of scroll position, so it is deliberately NOT gated on prefers-reduced-motion
 * (nothing moves unless the visitor scrolls) and does not depend on an IntersectionObserver, a timeline or a plugin.
 */
export function usePricingLogoDraw(rootRef: RefObject<HTMLElement | null>): boolean {
  const [done, setDone] = useState(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      setDone(true);
      return;
    }
    return watchLogoScroll(root, () => root.querySelector<SVGSVGElement>("svg.logo-mark"), setDone);
  }, [rootRef]);

  return done;
}
