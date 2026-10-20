import { useEffect, useRef, type RefObject } from "react";
import { PhylaxMark } from "@/components/PhylaxMark";

/**
 * The footer's Phylax mark, which the visitor can drag around the cream panel.
 *
 * Input
 *  Pointer events for mouse, pen and touch. `touch-action: none` on the element hands every touch gesture to
 *  this code, so a finger drag moves the logo rather than scrolling the page. Default drag and text-selection
 *  behaviour is suppressed on the element.
 *
 * Containment
 *  Every position is clamped against the live bounding box of the cream content box (`boundsRef`), inset by
 *  a small margin so the mark never sits on the rounded corners. The clamp runs on every move and again when
 *  the window is resized, so the logo can never leave the box even if the layout changes under it.
 *
 * Magnetic tension
 *  The logo is tethered to its resting place (the centre point) by an invisible rubber band. The pointer's pull
 *  is passed through `tensionMap`, so the further the logo is dragged from the centre, the smaller the share of
 *  the pointer's travel it follows (strong near the centre, easing to roughly 40% far out). The logo therefore
 *  lags behind the pointer and feels like it is being pulled back. The mapping is a pure function of the
 *  pointer's pull, so moving the pointer back retraces the same positions. Where the clamp pins the logo against
 *  the panel edge, the pull is re-anchored to the pinned position so there is never a dead zone on the way back.
 *
 * Recoil
 *  On release the logo snaps a short way toward the centre on an under-damped spring, overshoots slightly,
 *  and settles. It then STAYS at the settled spot: nothing sends it home on release. A press mid-recoil takes
 *  over the logo where it is. Under `prefers-reduced-motion` the recoil is skipped and the logo stays put.
 *
 * Idle return
 *  Once the logo has been released away from its resting place, a timer starts. Any pointer or wheel activity
 *  inside the panel restarts it. When it runs out the logo glides back to rest. Pressing the logo again cancels
 *  the timer and any return in progress, and the drag resumes from wherever the logo has got to.
 *
 * Colour
 *  The mark is white with `mix-blend-mode: difference`, so every pixel shows the inverse of whatever is behind
 *  it. Over the cream panel that gives near-ink, over ink text it gives cream, and so on. The blend is applied
 *  by the compositor on the GPU, so it tracks the logo at full frame rate with no per-frame colour maths.
 *
 *  The panel background (the footer SVG pattern) must NOT take part in that blend, or the logo would change shade
 *  over every bar and gridline. So a "plate" sits directly under the logo: a copy of the mark in flat panel cream,
 *  layered above the background but below the text. The logo's blend backdrop is therefore flat cream wherever it
 *  covers the pattern (identical to the old plain panel) and the real text colour wherever it covers text. The plate
 *  is hidden by the logo itself, so nothing extra is visible. It is moved in lockstep with the logo.
 */

const IDLE_RETURN_MS = 4000; // inactivity before the logo glides home
const RETURN_MS = 750; // duration of the glide home
const RETURN_EASE = "cubic-bezier(.16,1,.3,1)"; // fast start, soft landing (matches the site's --ease curve)
const CONTAINMENT_INSET = 12; // px kept clear between the logo and the panel edge

// Magnetic tension: displayed offset m = d - S*d^2/(d + L), where d is the pointer's pull from the centre.
// The follow ratio is 1 at the centre and falls toward (1 - S) far out. Always increasing, so never reverses.
const TENSION_SCALE = 110; // L, px: how quickly resistance builds up
const TENSION_STRENGTH = 0.62; // S, 0..<1: how much of the pointer's travel is lost far from the centre

// Recoil on release: a short, snappy, under-damped spring toward the centre.
const RECOIL_FRACTION = 0.2; // share of the release distance recoiled toward the centre
const RECOIL_MAX_PX = 34; // cap, so a long drag still gives a short, sharp snap
const RECOIL_STIFFNESS = 900; // spring constant (ω ≈ 30 rad/s: a quick ~0.2s cycle)
const RECOIL_DAMPING = 22; // damping ratio ≈ 0.37: visible overshoot, settles in about 0.4s
const RECOIL_KICK = 10; // initial inward speed, per px of recoil distance (1/s), for an aggressive start
const RECOIL_TIMEOUT_MS = 1500; // hard stop in case the spring never quite settles

type Vec = { x: number; y: number };

/** Pointer pull distance -> displayed logo distance, both measured from the centre point. */
const tensionMap = (d: number) => d - (TENSION_STRENGTH * d * d) / (d + TENSION_SCALE);

/** Inverse of `tensionMap`: the pull needed to hold the logo at displayed distance m (closed-form quadratic). */
const tensionInverse = (m: number) => {
  if (m <= 0) return 0;
  const a = 1 - TENSION_STRENGTH;
  const q = TENSION_SCALE - m;
  const s = Math.sqrt(q * q + 4 * a * m * TENSION_SCALE);
  // Two algebraically equal forms; pick the one that avoids subtracting nearly equal numbers.
  return q >= 0 ? (2 * m * TENSION_SCALE) / (q + s) : (s - q) / (2 * a);
};

export function DraggableFooterLogo({ boundsRef }: { boundsRef: RefObject<HTMLElement | null> }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const plateRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrapRef.current;
    const plate = plateRef.current;
    const bounds = boundsRef.current;
    if (!el || !plate || !bounds) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Current translation from the resting place, in CSS pixels. This is the single source of truth; the
    // transform on the element is always written from it.
    const pos: Vec = { x: 0, y: 0 };
    // pullX0/pullY0 is the pointer-space pull (before tension) the logo had when the drag started or was last
    // re-anchored; the live pull is that plus the pointer's travel since startX/startY.
    const drag = { active: false, id: -1, startX: 0, startY: 0, pullX0: 0, pullY0: 0, lastX: 0, lastY: 0, raf: 0 };
    let idleTimer = 0;
    let returnTimer = 0;
    let recoilRaf = 0;

    // The logo and its plate always share one transform and one transition, so they can never drift apart.
    const write = () => {
      const t = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
      el.style.transform = t;
      plate.style.transform = t;
    };

    const setTransition = (value: string) => {
      el.style.transition = value;
      plate.style.transition = value;
    };

    // Reads the translation that is actually on screen right now, including a glide still in progress.
    // Used when a press lands mid-return, so the drag picks up exactly where the logo visibly is.
    const readCurrent = () => {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      pos.x = m.m41;
      pos.y = m.m42;
    };

    const stopRecoil = () => {
      if (recoilRaf) cancelAnimationFrame(recoilRaf);
      recoilRaf = 0;
    };

    // Snaps the logo a short way toward the centre on an under-damped spring, then leaves it where it settles.
    // `pos` is updated every frame, so a press mid-recoil (or the idle return) simply carries on from it.
    const startRecoil = () => {
      stopRecoil();
      if (reduced) return;
      const d = Math.hypot(pos.x, pos.y);
      const recoil = Math.min(RECOIL_MAX_PX, d * RECOIL_FRACTION);
      if (recoil < 1) return;
      const ux = pos.x / d;
      const uy = pos.y / d;
      const tx = pos.x - ux * recoil;
      const ty = pos.y - uy * recoil;
      let vx = -ux * recoil * RECOIL_KICK;
      let vy = -uy * recoil * RECOIL_KICK;
      const t0 = performance.now();
      let last = t0;
      setTransition("none");

      const step = (now: number) => {
        let dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
        last = now;
        // Fixed sub-steps keep the integration stable however long a frame took.
        while (dt > 0) {
          const h = Math.min(dt, 1 / 240);
          vx += (-RECOIL_STIFFNESS * (pos.x - tx) - RECOIL_DAMPING * vx) * h;
          vy += (-RECOIL_STIFFNESS * (pos.y - ty) - RECOIL_DAMPING * vy) * h;
          pos.x += vx * h;
          pos.y += vy * h;
          dt -= h;
        }
        const settled =
          Math.abs(pos.x - tx) + Math.abs(pos.y - ty) < 0.05 && Math.abs(vx) + Math.abs(vy) < 4;
        if (settled || now - t0 > RECOIL_TIMEOUT_MS) {
          pos.x = tx;
          pos.y = ty;
          recoilRaf = 0;
        } else {
          recoilRaf = requestAnimationFrame(step);
        }
        write();
      };
      recoilRaf = requestAnimationFrame(step);
    };

    const cancelTimers = () => {
      clearTimeout(idleTimer);
      clearTimeout(returnTimer);
      idleTimer = 0;
      returnTimer = 0;
    };

    // The rectangle the logo may occupy, expressed as the translation range [min, max] on each axis. The current
    // on-screen rect minus the current translation gives the resting position, which stays correct while the page
    // scrolls under a drag.
    const translationRange = () => {
      const rect = el.getBoundingClientRect();
      const box = bounds.getBoundingClientRect();
      const restLeft = rect.left - pos.x;
      const restTop = rect.top - pos.y;
      const left = box.left + CONTAINMENT_INSET;
      const right = box.right - CONTAINMENT_INSET;
      const top = box.top + CONTAINMENT_INSET;
      const bottom = box.bottom - CONTAINMENT_INSET;
      return {
        minX: left - restLeft,
        maxX: right - rect.width - restLeft,
        minY: top - restTop,
        maxY: bottom - rect.height - restTop,
      };
    };

    const clamp = (v: number, min: number, max: number) => {
      // If the box is smaller than the logo (should not happen at any real size), centre the logo in it.
      if (min > max) return (min + max) / 2;
      return Math.min(max, Math.max(min, v));
    };

    const clampToBounds = () => {
      if (pos.x === 0 && pos.y === 0) return;
      const r = translationRange();
      pos.x = clamp(pos.x, r.minX, r.maxX);
      pos.y = clamp(pos.y, r.minY, r.maxY);
      write();
    };

    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = 0;
      if (drag.active || (pos.x === 0 && pos.y === 0)) return;
      idleTimer = window.setTimeout(sendHome, IDLE_RETURN_MS);
    };

    const sendHome = () => {
      idleTimer = 0;
      if (drag.active || (pos.x === 0 && pos.y === 0)) return;
      stopRecoil();
      pos.x = 0;
      pos.y = 0;
      if (reduced) {
        setTransition("none");
        write();
        return;
      }
      setTransition(`transform ${RETURN_MS}ms ${RETURN_EASE}`);
      write();
      // Once the glide has finished, drop the transition so drags are never laggy.
      returnTimer = window.setTimeout(() => {
        returnTimer = 0;
        setTransition("none");
      }, RETURN_MS + 50);
    };

    // Applies the latest pointer position, at most once per frame.
    const applyDrag = () => {
      drag.raf = 0;
      const r = translationRange();
      const dx = drag.lastX - drag.startX;
      const dy = drag.lastY - drag.startY;
      // Where the pointer has pulled to, and where the rubber band lets the logo follow to.
      const pullX = drag.pullX0 + dx;
      const pullY = drag.pullY0 + dy;
      const pull = Math.hypot(pullX, pullY);
      const k = pull > 0 ? tensionMap(pull) / pull : 0;
      const wantX = pullX * k;
      const wantY = pullY * k;
      pos.x = clamp(wantX, r.minX, r.maxX);
      pos.y = clamp(wantY, r.minY, r.maxY);
      if (pos.x !== wantX || pos.y !== wantY) {
        // Pinned against the panel edge: re-anchor the pull to the pinned position, so pulling back responds at once.
        const m = Math.hypot(pos.x, pos.y);
        const j = m > 0 ? tensionInverse(m) / m : 0;
        drag.pullX0 = pos.x * j - dx;
        drag.pullY0 = pos.y * j - dy;
      }
      write();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault(); // no native drag ghost, no text selection
      const gliding = returnTimer !== 0;
      cancelTimers();
      stopRecoil(); // pos is kept current by the recoil, so the drag picks up from wherever it got to

      // A press during a glide home takes over the logo at its current on-screen position.
      if (gliding) {
        readCurrent();
        setTransition("none");
        write();
      }

      drag.active = true;
      drag.id = e.pointerId;
      drag.startX = drag.lastX = e.clientX;
      drag.startY = drag.lastY = e.clientY;
      // Start from the pull that would hold the logo exactly where it is now, so the grab never makes it jump.
      const here = Math.hypot(pos.x, pos.y);
      const j = here > 0 ? tensionInverse(here) / here : 0;
      drag.pullX0 = pos.x * j;
      drag.pullY0 = pos.y * j;
      el.setPointerCapture(e.pointerId);
      el.classList.add("is-dragging");
    };

    const onPointerMove = (e: PointerEvent) => {
      if (drag.active && e.pointerId === drag.id) {
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        if (!drag.raf) drag.raf = requestAnimationFrame(applyDrag);
        return;
      }
      // Any other pointer activity inside the panel counts as the visitor being around, so it restarts the timer.
      if (!drag.active) {
        clearTimeout(idleTimer);
        armIdle();
      }
    };

    const endDrag = (e: PointerEvent) => {
      if (!drag.active || e.pointerId !== drag.id) return;
      // Flush the last pointer position so the release lands exactly where the pointer did.
      if (drag.raf) {
        cancelAnimationFrame(drag.raf);
        drag.raf = 0;
      }
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      applyDrag();
      drag.active = false;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      el.classList.remove("is-dragging");
      startRecoil();
      armIdle();
    };

    // A press on the panel but off the logo is still activity; a press on the logo is handled by onPointerDown.
    const onPointerDownActivity = () => {
      if (!drag.active) {
        clearTimeout(idleTimer);
        armIdle();
      }
    };

    const onWheel = () => {
      if (!drag.active) armIdle();
    };

    const onResize = () => clampToBounds();

    // Prevent native image/link dragging and text selection from starting over the logo, on every browser.
    const onDragStart = (e: Event) => e.preventDefault();
    const onSelectStart = (e: Event) => e.preventDefault();

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
    el.addEventListener("dragstart", onDragStart);
    el.addEventListener("selectstart", onSelectStart);
    // Pointer events bubble from the logo, so listening on the panel covers both the logo and the rest of it.
    // Activity across the whole panel (not only the logo) resets the idle timer.
    bounds.addEventListener("pointermove", onPointerMove);
    bounds.addEventListener("pointerdown", onPointerDownActivity);
    bounds.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("resize", onResize);

    return () => {
      cancelTimers();
      stopRecoil();
      cancelAnimationFrame(drag.raf);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointerup", endDrag);
      el.removeEventListener("pointercancel", endDrag);
      el.removeEventListener("dragstart", onDragStart);
      el.removeEventListener("selectstart", onSelectStart);
      bounds.removeEventListener("pointermove", onPointerMove);
      bounds.removeEventListener("pointerdown", onPointerDownActivity);
      bounds.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", onResize);
    };
  }, [boundsRef]);

  return (
    <div className="footer-logo-slot" role="presentation">
      <div ref={plateRef} className="footer-logo-plate" aria-hidden="true">
        <PhylaxMark className="footer-logo-svg" />
      </div>
      <div ref={wrapRef} className="footer-logo-drag" role="presentation">
        <PhylaxMark className="footer-logo-svg" />
      </div>
    </div>
  );
}
