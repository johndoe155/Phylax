import { useEffect, type RefObject } from "react";

/**
 * Makes a CSS-animated marquee react to scroll direction: scrolling down keeps its normal flow, scrolling up
 * reverses it. The direction sticks until the visitor scrolls the other way.
 *
 * It drives the running CSS animation through the Web Animations API (`playbackRate` 1 <-> -1), so the track keeps
 * its current position and just turns around: no jump, no restart. The rate is eased towards its target a little
 * each frame, so the track slows, turns and speeds up again instead of snapping. If the animation is absent (for
 * example `prefers-reduced-motion` turns it off in CSS) the hook does nothing.
 */

const SCROLL_DEADZONE = 2; // px of travel ignored, so trackpad jitter can't flip the direction
const EASE = 0.12; // fraction of the remaining distance covered per frame
const LOOP_HEADROOM = 10000; // iterations of lead given to the animation so reversing can never reach time 0

export function useScrollReactiveMarquee(trackRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof track.getAnimations !== "function") return;

    let target = 1; // 1 = normal flow, -1 = reversed
    let rate = 1;
    let raf = 0;
    let lastY = window.scrollY;
    let prepared: Animation | null = null;

    // A CSS animation starts at time 0 and plays in reverse only until it gets back there, where (with no fill mode)
    // it would switch itself off. Moving the clock forward by whole iterations leaves the visible position
    // unchanged but makes that effectively unreachable.
    const getAnimation = () => {
      const anim = track.getAnimations()[0] ?? null;
      if (anim && anim !== prepared) {
        prepared = anim;
        const duration = anim.effect?.getComputedTiming().duration;
        if (typeof duration === "number" && duration > 0) {
          anim.currentTime = Number(anim.currentTime ?? 0) + duration * LOOP_HEADROOM;
        }
      }
      return anim;
    };

    const tick = () => {
      rate += (target - rate) * EASE;
      if (Math.abs(target - rate) < 0.01) rate = target;
      const anim = getAnimation();
      if (anim) anim.playbackRate = rate;
      raf = rate === target ? 0 : requestAnimationFrame(tick);
    };

    const onScroll = () => {
      // Clamp to the real scroll range so iOS rubber-banding past either end isn't read as a direction change.
      const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const y = Math.min(Math.max(window.scrollY, 0), maxY);
      const dy = y - lastY;
      if (Math.abs(dy) < SCROLL_DEADZONE) return;
      lastY = y;
      const next = dy < 0 ? -1 : 1;
      if (next === target) return;
      target = next;
      if (!raf) raf = requestAnimationFrame(tick);
    };

    getAnimation();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
      const anim = track.getAnimations()[0];
      if (anim) anim.playbackRate = 1;
    };
  }, [trackRef]);
}
