import { useLayoutEffect, type RefObject } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { morphPalette, rgbCss } from "@/lib/pricingMorph";
import { usePersistFn } from "@/hooks/usePersistFn";

gsap.registerPlugin(ScrollTrigger);

/** Drawn progress at or above this is treated as exactly 1. The ink layer's opacity is rounded to 4 decimals, so this is
 * visually identical to 1 - and it guarantees the morph reports "complete" even if the tween ends a float epsilon short. */
const COMPLETE_AT = 0.99995;
/** Once complete, the morph only reports "no longer complete" below this. A little slack under 1 so scroll-bounce or a
 * few pixels of jitter at the finish line doesn't flap whatever is keyed off completion; scrolling back into the
 * transition proper (a few percent of its range, i.e. ~12px at 800px viewport height) still releases it. */
const RELEASE_BELOW = 0.97;

/** The morph starts when the Pricing section's top edge reaches the bottom of the viewport and is complete when it
 * has risen to this fraction of the viewport height from the top. */
const END_AT = 0.25;
/** Seconds of easing between the scroll position and what is drawn, so wheel notches don't step the colours. */
const SMOOTHING = 0.3;

const VARS = ["--mx-fg", "--mx-muted", "--mx-accent", "--mx-line", "--mx-surface", "--mx-surface-fg"] as const;

/**
 * Scroll-driven colour morph across the Templates -> Pricing boundary, replacing the hard edge between them.
 *
 * ONE zone, ONE progress, ONE palette. `zone` wraps both sections; everything that changes colour is driven by the
 * same number p (0 -> 1) in the same function call, so the two sections cannot be out of step:
 *
 *   - Background: a single ink layer (`.mx-ink`) spanning the whole zone, whose OPACITY is p over the zone's cream
 *     base. Both sections are transparent and sit on top of it, so the viewport is always exactly one colour -
 *     Templates and Pricing included - and there is no seam, gradient or edge between them to keep in sync. Opacity
 *     on a promoted layer is composited on the GPU (no layout, no raster).
 *   - Text, hairlines, accents, icons (currentColor) and the template tiles' surface: CSS variables on the zone
 *     (--mx-fg, --mx-muted, --mx-accent, --mx-line, --mx-surface, --mx-surface-fg), recomputed from the same p by
 *     lib/pricingMorph as continuous, smooth functions of p (see that file for the model). Both sections read the
 *     variables, so Templates' heading/cards and Pricing's headline/links shift together, frame for frame.
 *
 * p is measured from the Pricing section's live bounding box, not from positions ScrollTrigger cached at refresh.
 * Sections above change height after load (the checks list opens as you scroll past it), which would otherwise start
 * the morph early and break the "starts as Templates' cream" guarantee. ScrollTrigger drives the updates; its
 * (padded) range only decides when to listen.
 *
 * The zone only gets `.is-morphing` (which is what makes the sections transparent and variable-driven) when motion is
 * allowed. Without JS, or with prefers-reduced-motion, the sections keep their own static cream / ink backgrounds.
 *
 * @param zoneRef    the element wrapping the Templates and Pricing sections
 * @param pricingRef the `<section id="pricing">` element (its position defines p)
 * @param inkRef     the `.mx-ink` layer inside the zone
 * @param onCompleteChange  called with true when the morph reaches 100% (the colours drawn are the final Pricing ones)
 *                   and with false when it is released again by scrolling back up into the transition. Fires only on
 *                   a change, driven by the same drawn progress as the colours. With reduced motion there is no morph,
 *                   so it never fires.
 */
export function usePricingMorph(
  zoneRef: RefObject<HTMLElement | null>,
  pricingRef: RefObject<HTMLElement | null>,
  inkRef: RefObject<HTMLElement | null>,
  onCompleteChange?: (complete: boolean) => void,
) {
  const notifyComplete = usePersistFn((complete: boolean) => onCompleteChange?.(complete));

  useLayoutEffect(() => {
    const zone = zoneRef.current;
    const pricing = pricingRef.current;
    const ink = inkRef.current;
    if (!zone || !pricing || !ink) return;

    let lastP = -1;
    let layered = false;
    let complete = false;
    const paint = (p: number) => {
      p = Math.min(1, Math.max(0, p));
      if (p >= COMPLETE_AT) p = 1;
      if (Math.abs(p - lastP) < 0.0002 && p !== 0 && p !== 1) return; // sub-perceptual change: skip the style write
      lastP = p;
      const nowComplete = complete ? p >= RELEASE_BELOW : p === 1;
      if (nowComplete !== complete) { complete = nowComplete; notifyComplete(complete); }
      const pal = morphPalette(p);
      ink.style.opacity = String(Math.round(p * 10000) / 10000);
      const wantLayer = p > 0 && p < 1;
      if (wantLayer !== layered) { layered = wantLayer; ink.style.willChange = wantLayer ? "opacity" : "auto"; }
      const style = zone.style;
      style.setProperty("--mx-fg", rgbCss(pal.fg));
      style.setProperty("--mx-muted", rgbCss(pal.muted));
      style.setProperty("--mx-accent", rgbCss(pal.accent));
      style.setProperty("--mx-line", rgbCss(pal.line));
      style.setProperty("--mx-surface", rgbCss(pal.surface));
      style.setProperty("--mx-surface-fg", rgbCss(pal.surfaceFg));
    };

    const mm = gsap.matchMedia();

    // Reduced motion: no scrubbing and no morph class - the sections keep their static backgrounds.
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      const state = { p: 0 };
      const render = () => paint(state.p);

      // Live progress: 0 while the section's top is at/below the viewport bottom, 1 once it is END_AT from the top.
      const measure = () => {
        const vh = window.innerHeight;
        const top = pricing.getBoundingClientRect().top;
        return Math.min(1, Math.max(0, (vh - top) / (vh * (1 - END_AT))));
      };
      const follow = () => {
        gsap.to(state, { p: measure(), duration: SMOOTHING, ease: "power2.out", overwrite: true, onUpdate: render });
      };
      const snap = () => {
        gsap.killTweensOf(state);
        state.p = measure();
        render();
      };

      zone.classList.add("is-morphing");
      snap(); // right now, before the first paint: a reload part-way down the page starts in the right colour

      const trigger = ScrollTrigger.create({
        trigger: pricing,
        // Padded by a viewport each way so a few hundred px of layout drift above can never leave us deaf.
        start: "top bottom+=100%",
        end: "bottom top-=100%",
        onUpdate: follow,
        onLeave: snap,
        onLeaveBack: snap,
        onRefresh: snap,
      });

      // Height changes above (checks list, late fonts/images) move the section without any scroll event.
      const main = zone.parentElement;
      const resizeObserver = main ? new ResizeObserver(follow) : null;
      if (main) resizeObserver?.observe(main);

      return () => {
        resizeObserver?.disconnect();
        trigger.kill();
        zone.classList.remove("is-morphing");
      };
    });

    return () => {
      mm.revert();
      lastP = -1;
      layered = false;
      if (complete) { complete = false; notifyComplete(false); }
      ink.style.opacity = "";
      ink.style.willChange = "";
      zone.classList.remove("is-morphing");
      VARS.forEach((name) => zone.style.removeProperty(name));
    };
  }, [zoneRef, pricingRef, inkRef]);
}
