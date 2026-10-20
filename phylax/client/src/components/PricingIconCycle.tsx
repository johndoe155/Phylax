import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import logo from "@/assets/pricing-icons/0-phylax-logo.svg?raw";
import shield from "@/assets/pricing-icons/1-shield.svg?raw";
import calendar from "@/assets/pricing-icons/2-tear-off-calendar.svg?raw";
import key from "@/assets/pricing-icons/3-key.svg?raw";
import ticket from "@/assets/pricing-icons/4-ticket-stub.svg?raw";
import priceTag from "@/assets/pricing-icons/5-price-tag.svg?raw";
import { stripSvgScripts, withCalendarDay } from "@/lib/liveCalendar";
import { useLocalDay } from "@/hooks/useLocalDay";
import { usePricingLogoDraw } from "@/hooks/usePricingLogoDraw";

/** The six sketches, in loop order: the Phylax logo, then the shield, calendar, key, ticket and price tag. They are inlined
 * (not <img>) so `currentColor` follows the Templates -> Pricing colour morph, and so the whole set shares one document
 * (each file's filter / <use> ids are already unique).
 *
 * `stripSvgScripts`: markup set through dangerouslySetInnerHTML never runs its <script> tags, so the calendar's own
 * script (which only works when the file is opened or embedded standalone) is dropped here and the live date is written
 * into the calendar's markup from lib/liveCalendar.ts instead (see `icons` below). */
const ICONS = [logo, shield, calendar, key, ticket, priceTag].map((svg) => stripSvgScripts(svg));
const CALENDAR = 2;

/** How long each sketch is held before the next one snaps in. The swap itself is an instant cut (see index.css). */
const DWELL_MS = 450;

/**
 * One sketch at a time, centred above the "START FREE." heading.
 *
 * `running` is the hand-off from the scroll-driven colour morph (see usePricingMorph): it is false for as long as the
 * morph is anywhere short of complete, and the cycler holds - and snaps back to - the first sketch. It turns true the
 * moment the morph finishes; the first sketch then gets a full dwell and the loop runs 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 1...
 * until `running` goes false again (the visitor scrolled back up into the transition), which resets it to sketch 1.
 *
 * The first sketch (the logo) draws itself when it scrolls into view (usePricingLogoDraw). The loop is held until BOTH
 * the morph has finished and that drawing is complete, so no other sketch can appear before the logo is done.
 *
 * All sketches stay mounted and the swap is a hard cut (visibility flip, no fade), so it never has to re-create an SVG
 * or its filter. That also means the calendar's date is drawn once (and kept current) regardless of whether it is the
 * sketch on show, so it is already right the instant it snaps in.
 */
export function PricingIconCycle({ running }: { running: boolean }) {
  const [index, setIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const logoDrawn = usePricingLogoDraw(rootRef);
  const go = running && logoDrawn;

  // The viewer's local day of month (rolls over at local midnight). It is part of the calendar's markup, so the right
  // date is on the first paint and cannot be lost when the markup is re-applied.
  const day = useLocalDay();
  const icons = useMemo(() => ICONS.map((svg, i) => (i === CALENDAR ? withCalendarDay(svg, day) : svg)), [day]);

  // Resetting to the logo happens before paint (layout effect), so scrolling back up into the drawing never shows
  // another sketch for a frame or two while the logo redraws.
  useLayoutEffect(() => {
    if (!go) setIndex(0);
  }, [go]);

  useEffect(() => {
    if (!go) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % ICONS.length), DWELL_MS);
    return () => window.clearInterval(timer);
  }, [go]);

  // Decorative flourish: hidden from assistive tech (rotating, auto-changing labels would just be noise), and
  // pointer-events are off so the <title> inside each file can't pop a tooltip for whichever sketch sits on top.
  return (
    <div ref={rootRef} className="pricing-cycle" aria-hidden="true">
      {icons.map((svg, i) => (
        <span
          key={i}
          className="pricing-cycle-icon"
          data-active={i === index}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ))}
    </div>
  );
}
