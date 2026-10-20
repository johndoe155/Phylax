import { useEffect, type RefObject } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

/** The words that take turns in the "How it works" headline ("Not another ___ "), in order. */
export const SCROLL_WORDS = ["calendar.", "schedule.", "roster.", "timesheet."] as const;

/**
 * Where on the scroll range (0..1) each swap happens: the midpoint of every swap in the old scrubbed timeline, which
 * gave the first and last word a shorter rest (0.6) than the ones in between (1) and each swap a roll of 0.45. One
 * entry per boundary, so there is one fewer than there are slots (the words plus the first one repeated at the end).
 */
const EDGE_HOLD = 0.6;
const HOLD = 1;
const ROLL = 0.45;
function swapBoundaries(slots: number): number[] {
  const mids: number[] = [];
  let t = EDGE_HOLD;
  for (let i = 1; i < slots; i++) {
    mids.push(t + ROLL / 2);
    t += ROLL + HOLD;
  }
  const total = t - HOLD + EDGE_HOLD; // the last swap's end, plus the rest on the repeated first word
  return mids.map((m) => m / total);
}

/** A swap is only reversed once the scroll has come back this far (in range progress) past the line that triggered it. */
const HYSTERESIS = 0.02;
/** Spring stiffness (rad/s) of the critically damped glide: ~0.65s to settle, no overshoot. */
const OMEGA = 10;
/** The fastest the stack may travel, in words per second, so a flick through all of them still reads as motion. */
const MAX_SPEED = 9;
/** Below these the stack is considered at rest and the loop stops. */
const REST_DIST = 0.0008;
const REST_SPEED = 0.01;
/** A frame this long (tab was in the background) is treated as this long, so the spring does not leap. */
const MAX_DT = 1 / 20;

/**
 * Scroll-driven word swap for the "Not another calendar." headline.
 *
 * `trackRef` is a vertical stack of the words with the first one repeated at the end (see ScrollWords.tsx); the
 * viewport onto it is exactly one word tall. The word advances as the headline travels up the screen,
 *
 *   calendar. → schedule. → roster. → timesheet. → calendar.
 *
 * and the closing repeat means the sequence leaves the way it arrived.
 *
 * Scroll and motion are deliberately decoupled. The old version scrubbed a timeline, so the stack's position was a
 * direct function of scrollTop: every wheel notch, momentum burst and direction change was drawn as it came, a swap
 * lasted only ~80px of scroll, and stopping mid-swap left the stack parked between two words. Now:
 *
 *  1. A ScrollTrigger (no scrub) only reports progress through the range. That progress picks a *target word*, with
 *     a little hysteresis, so scroll jitter around a boundary cannot make the target flap back and forth.
 *  2. A small requestAnimationFrame loop moves the stack towards the target with a critically damped spring. The
 *     motion is on the clock, not on the scroll: a swap always takes the same graceful ~0.65s, however fast or
 *     slowly the page is scrolled. Retargeting mid-flight (scrolling back, or on to the next word) keeps the
 *     stack's position *and velocity*, so reversals curve smoothly instead of snapping, and it always comes to rest
 *     exactly on a word. The spring is solved in closed form, so it is stable at any frame time.
 *  3. Words fade a little as they leave and arrive, and only `transform` and `opacity` are written (compositor-only).
 *     The loop runs only while the stack is moving; at rest nothing runs.
 *
 * The range runs from the headline coming up into the lower part of the screen to it nearly leaving at the top, so
 * every word gets a stretch of scroll to itself while the headline is actually readable. When the range is
 * (re)measured (load, resize, fonts) the stack jumps straight to the right word instead of gliding there.
 *
 * With prefers-reduced-motion nothing is created and the first word simply stays put.
 */
export function useScrollWords(triggerRef: RefObject<HTMLElement | null>, trackRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const trigger = triggerRef.current;
    const track = trackRef.current;
    if (!trigger || !track) return;
    const items = Array.from(track.children) as HTMLElement[];
    const slots = items.length; // the words, plus the first one again
    if (slots < 2) return;
    const step = 100 / slots; // one word, as a percentage of the track's own height
    const boundaries = swapBoundaries(slots);

    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      let target = 0; // the word index the scroll has chosen
      let pos = 0; // where the stack is, in words (fractional while moving)
      let vel = 0; // words per second
      let raf = 0;
      let last = 0;

      const render = () => {
        track.style.transform = `translate3d(0, ${(-pos * step).toFixed(4)}%, 0)`;
        for (let i = 0; i < slots; i++) {
          const d = Math.abs(pos - i);
          // Fully visible at rest, fading to 0 by the time a word is a full line away (it is clipped there anyway).
          items[i].style.opacity = d < 0.001 ? "" : Math.max(0, 1 - d * 0.9).toFixed(3);
        }
      };

      const frame = (now: number) => {
        const dt = Math.min((now - last) / 1000, MAX_DT);
        last = now;
        if (dt > 0) {
          // Closed-form critically damped spring: x'' = -2ωx' - ω²(x - target), from (pos, vel).
          const e = pos - target;
          const c2 = vel + OMEGA * e;
          const decay = Math.exp(-OMEGA * dt);
          pos = target + (e + c2 * dt) * decay;
          vel = (c2 - OMEGA * (e + c2 * dt)) * decay;
          if (vel > MAX_SPEED) vel = MAX_SPEED;
          else if (vel < -MAX_SPEED) vel = -MAX_SPEED;
        }
        if (Math.abs(pos - target) < REST_DIST && Math.abs(vel) < REST_SPEED) {
          pos = target;
          vel = 0;
          raf = 0;
          render();
          return;
        }
        render();
        raf = requestAnimationFrame(frame);
      };
      const wake = () => {
        if (raf) return;
        last = performance.now();
        raf = requestAnimationFrame(frame);
      };
      const snap = () => {
        cancelAnimationFrame(raf);
        raf = 0;
        pos = target;
        vel = 0;
        render();
      };

      // Scroll progress -> target word, with hysteresis (a swap forward needs the line + margin, back the line - margin).
      const choose = (progress: number) => {
        let next = target;
        while (next < slots - 1 && progress > boundaries[next] + HYSTERESIS) next++;
        while (next > 0 && progress < boundaries[next - 1] - HYSTERESIS) next--;
        return next;
      };

      const st = ScrollTrigger.create({
        trigger,
        start: "top 88%", // the headline has come up into the lower part of the screen
        end: "bottom 22%", // ...and is nearly at the top
        invalidateOnRefresh: true,
        onUpdate: (self) => {
          const next = choose(self.progress);
          if (next !== target) {
            target = next;
            wake();
          }
        },
        // Created, resized, fonts loaded, restored mid-page: show the right word at once rather than animating to it.
        onRefresh: (self) => {
          target = 0;
          target = choose(self.progress);
          snap();
        },
      });

      target = choose(st.progress); // in case the trigger was created already past its start
      snap();

      return () => {
        cancelAnimationFrame(raf);
        st.kill();
        track.style.transform = "";
        items.forEach((item) => { item.style.opacity = ""; });
      };
    });

    let cancelled = false;
    // Web fonts change the headline's height, and with it where the range starts and ends.
    document.fonts?.ready.then(() => { if (!cancelled) ScrollTrigger.refresh(); });

    return () => {
      cancelled = true;
      mm.revert(); // runs the cleanup above, killing the ScrollTrigger and the loop
    };
  }, [triggerRef, trackRef]);
}
