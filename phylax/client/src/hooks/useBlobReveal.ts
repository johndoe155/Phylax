import { useEffect, type RefObject } from "react";

/**
 * Liquid "blob" reveal. While a finger is down (touch / pen) or the mouse hovers over `sectionRef`,
 * a blob follows it and `maskRef` — an inverted copy of the section — is clipped to that blob.
 * Everything is driven by clip-path: path(), so no canvas and no extra DOM.
 *
 * Dynamics
 *  - Head: a damped spring chases the finger (second order, so velocity is continuous: it eases in, glides and
 *    settles with a tiny overshoot instead of the constant-speed pull of a plain lerp).
 *  - Body: a short chain of nodes, each chasing the one in front. Quick movement stretches the blob out behind
 *    the finger and it then pulls back together under it. Every link has a soft length limit (rubber that gets
 *    stiffer), and the blob thins as it stretches so it keeps its volume.
 *  - Surface: a ring of coupled springs around the blob is kicked by the head's *acceleration*. Starting, stopping
 *    and turning make the liquid slosh against the movement and ripple round the edge before it settles.
 *  - Radius: a spring too, so the blob pops open with an overshoot and wobbles shut.
 *
 * Outline (why it can't get "hard angles")
 *  The shape is the union of circles swept along the chain, read out as a radius for each of RING angles around a
 *  centre point inside it, then smoothed. A shape described by one radius per angle cannot fold over itself or
 *  cross its own edge, however violently the chain is thrown around, and smoothing the radius profile rounds any
 *  crease where the body bends into a soft fillet. (The previous version offset the outline sideways from the
 *  chain; when a quick reversal bent the chain tighter than the blob is wide, the two sides crossed over and
 *  produced spikes and bow-ties.)
 *
 * Timing
 *  The simulation advances in fixed 1/240 s steps from real elapsed time, so dropped frames, 90/120/144 Hz screens
 *  and bursty touch events change how often it is drawn, not how it behaves.
 *
 * Touch is tracked with touch events, not pointer events: the moment a swipe turns into a native page scroll the
 * browser fires `pointercancel` and stops sending pointer events, but touch events keep flowing until the finger
 * actually lifts. That is what keeps the blob alive during a swipe.
 */

// ── tuning ──────────────────────────────────────────────────────────────────────────────────────
const NODES = 9;             // chain length (head = 0)
const SPINE = 28;            // circles swept along the body, spaced evenly by arc length so the edge is smooth
const DENSE = 8;             // spline samples per link used to measure that arc length
const RING = 64;             // outline samples. More = rounder tip, slightly more path to build each frame
const STEP = 1 / 240;        // physics step, seconds
const MAX_FRAME = 0.05;      // never simulate more than this much real time in one frame (after a stall)

const MAX_STRETCH = 1.75;    // longest body length (head → tail node) in blob radii
const HEAD_OMEGA = 19;       // head spring stiffness (rad/s). Higher = snappier
const HEAD_ZETA = 0.82;      // head spring damping. <1 lets it glide a hair past the finger and settle
const BODY_RATE = [19.8, 5.7] as const; // how fast the first … last body node chases the one ahead (1/s): the lag is what stretches the blob
const TAIL_TAPER = 0.5;      // how much thinner the tail gets when fully stretched
const THINNING = 0.16;       // whole blob thins a little as it stretches (the liquid keeps its volume)

const RADIUS_OMEGA = 22;     // radius spring: pop-open speed
const OPEN_ZETA = 0.4;       // …with a little overshoot
const CLOSE_ZETA = 0.7;      // …and a softer landing when closing

const SLOSH_OMEGA = 17;      // surface ring: natural frequency (rad/s) of each point
const SLOSH_COUPLE = 520;    // how strongly neighbouring surface points drag each other (ripples travel round the edge)
const SLOSH_ZETA = 0.22;     // damping: lower = more ripples before it settles
const SLOSH_GAIN = 0.3;      // how hard acceleration kicks the surface (acceleration ÷ blob radius, times this)
const SLOSH_MAX = 0.26;      // surface displacement limit, fraction of radius
const FILL_PASSES = 4;       // one-sided passes that fill the concave notch where the body meets the head (never trims a tip)
const SMOOTH_PASSES = 2;     // then [1 2 1] passes over the radius profile: round what is left into soft fillets

type Pt = [number, number];

// Closed smooth curve through the points (Catmull-Rom converted to cubic Béziers).
function smoothPath(p: Pt[]): string {
  const n = p.length;
  const f = (v: number) => v.toFixed(1);
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + "Z";
}

const RING_UX = Float64Array.from({ length: RING }, (_, k) => Math.cos((k / RING) * Math.PI * 2));
const RING_UY = Float64Array.from({ length: RING }, (_, k) => Math.sin((k / RING) * Math.PI * 2));

export function useBlobReveal(sectionRef: RefObject<HTMLElement | null>, maskRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const section = sectionRef.current;
    const mask = maskRef.current;
    if (!section || !mask) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const hasPath = typeof CSS !== "undefined" && CSS.supports("clip-path", 'path("M0 0")');
    const hasTouchEvents = "ontouchstart" in window;

    // The whole simulation runs in viewport (client) coordinates, so when the page scrolls under a finger the
    // blob stretches after the finger instead of being glued to the hero. It is converted to hero-local
    // coordinates only when the path is written.
    const s = {
      active: false, running: false, raf: 0, last: 0, acc: 0, R: 160,
      tx: 0, ty: 0,                                           // finger / pointer target
      x: new Float64Array(NODES), y: new Float64Array(NODES), // chain positions, node 0 = head
      vx: 0, vy: 0, ax: 0, ay: 0,                             // head velocity + acceleration (acceleration drives the slosh)
      hr: 0, hv: 0,                                           // blob radius + radius velocity
      stretch: 0,                                             // 0 = round … 1 = fully stretched
      slosh: new Float64Array(RING), sloshV: new Float64Array(RING), // surface displacement (fraction of R) + velocity
    };

    // scratch buffers, reused every frame
    const sx = new Float64Array(SPINE), sy = new Float64Array(SPINE), sr = new Float64Array(SPINE);
    const smx = new Float64Array(NODES), smy = new Float64Array(NODES);
    const DN = (NODES - 1) * DENSE + 1;
    const dx = new Float64Array(DN), dy = new Float64Array(DN), dl = new Float64Array(DN); // dense spline + cumulative length
    const prof = new Float64Array(RING), prof2 = new Float64Array(RING);
    const pts: Pt[] = Array.from({ length: RING }, () => [0, 0] as Pt);

    const setTarget = (clientX: number, clientY: number) => {
      s.tx = clientX;
      s.ty = clientY;
      const rect = section.getBoundingClientRect();
      s.R = Math.min(220, Math.max(120, Math.min(rect.width, rect.height) * 0.22));
    };

    const stop = () => {
      s.running = false;
      cancelAnimationFrame(s.raf);
      s.slosh.fill(0); s.sloshV.fill(0);
      mask.style.visibility = "hidden"; // hidden layers cost nothing to paint
    };

    // ── physics ─────────────────────────────────────────────────────────────────────────────────
    const step = () => {
      const { x, y, slosh, sloshV } = s;

      // 1. Head: damped spring toward the finger.
      if (reduced) {
        x[0] = s.tx; y[0] = s.ty; s.vx = s.vy = s.ax = s.ay = 0;
      } else {
        s.ax = HEAD_OMEGA * HEAD_OMEGA * (s.tx - x[0]) - 2 * HEAD_ZETA * HEAD_OMEGA * s.vx;
        s.ay = HEAD_OMEGA * HEAD_OMEGA * (s.ty - y[0]) - 2 * HEAD_ZETA * HEAD_OMEGA * s.vy;
        s.vx += s.ax * STEP; s.vy += s.ay * STEP;
        x[0] += s.vx * STEP; y[0] += s.vy * STEP;
      }

      // 2. Body: each node chases the one ahead (lag = stretch), with a soft length limit per link: lengths ease
      //    toward `seg` (a tanh squash) instead of hitting a wall, so it feels like rubber that gets stiffer.
      const seg = (s.R * MAX_STRETCH) / (NODES - 1);
      for (let i = 1; i < NODES; i++) {
        if (reduced) { x[i] = x[0]; y[i] = y[0]; continue; }
        const rate = BODY_RATE[0] + (BODY_RATE[1] - BODY_RATE[0]) * ((i - 1) / (NODES - 2));
        const k = 1 - Math.exp(-rate * STEP);
        x[i] += (x[i - 1] - x[i]) * k;
        y[i] += (y[i - 1] - y[i]) * k;
        const dx = x[i] - x[i - 1], dy = y[i] - y[i - 1], d = Math.hypot(dx, dy);
        if (d > 1e-3) {
          const nd = seg * Math.tanh(d / seg);
          x[i] = x[i - 1] + (dx * nd) / d;
          y[i] = y[i - 1] + (dy * nd) / d;
        }
      }

      // stretch = how far the tail has been pulled from the head (end to end, so a bent body doesn't read as "very stretched")
      const target = reduced ? 0 : Math.min(1, Math.hypot(x[0] - x[NODES - 1], y[0] - y[NODES - 1]) / (seg * (NODES - 1)));
      s.stretch += (target - s.stretch) * (1 - Math.exp(-12 * STEP));

      // 3. Radius: a spring, so the blob pops open with a little overshoot and wobbles shut.
      const goal = s.active ? s.R : 0;
      if (reduced) {
        s.hr = goal; s.hv = 0;
      } else {
        const zeta = s.active ? OPEN_ZETA : CLOSE_ZETA;
        s.hv += (RADIUS_OMEGA * RADIUS_OMEGA * (goal - s.hr) - 2 * zeta * RADIUS_OMEGA * s.hv) * STEP;
        s.hr += s.hv * STEP;
        if (s.hr < 0) { s.hr = 0; s.hv = 0; }
      }

      // 4. Surface slosh: liquid pushes back against acceleration (bulges on the side the blob is accelerating
      //    away from), and each point drags its neighbours so the disturbance runs round the edge as a ripple.
      if (!reduced) {
        const norm = 1 / Math.max(60, s.R); // acceleration relative to blob size, so big and small blobs feel alike
        for (let k = 0; k < RING; k++) {
          const l = slosh[(k + RING - 1) % RING], r = slosh[(k + 1) % RING];
          const push = -SLOSH_GAIN * norm * (s.ax * RING_UX[k] + s.ay * RING_UY[k]); // bulge opposite the acceleration
          const a = -SLOSH_OMEGA * SLOSH_OMEGA * slosh[k]
            + SLOSH_COUPLE * (l + r - 2 * slosh[k])
            - 2 * SLOSH_ZETA * SLOSH_OMEGA * sloshV[k]
            + push;
          sloshV[k] += a * STEP;
        }
        for (let k = 0; k < RING; k++) {
          slosh[k] = Math.max(-SLOSH_MAX, Math.min(SLOSH_MAX, slosh[k] + sloshV[k] * STEP));
        }
      }
    };

    // ── drawing ─────────────────────────────────────────────────────────────────────────────────
    const tick = (now: number) => {
      const frame = Math.min(MAX_FRAME, Math.max(0, (now - (s.last || now)) / 1000));
      s.last = now;
      s.acc += frame;
      while (s.acc >= STEP) { step(); s.acc -= STEP; }

      const rect = section.getBoundingClientRect();
      const onScreen = rect.bottom > 0 && rect.top < window.innerHeight; // no point building paths nobody can see
      if (onScreen && s.hr > 0.5) {
        if (hasPath) mask.style.clipPath = `path("${buildOutline(rect.left, rect.top, now / 1000)}")`;
        else mask.style.clipPath = `circle(${s.hr.toFixed(1)}px at ${(s.x[0] - rect.left).toFixed(1)}px ${(s.y[0] - rect.top).toFixed(1)}px)`;
      } else if (s.hr <= 0.5) {
        mask.style.clipPath = "circle(0px)";
      }

      if (!s.active && s.hr < 0.5 && Math.abs(s.hv) < 0.05) { stop(); return; }
      s.raf = requestAnimationFrame(tick);
    };

    /**
     * Blob outline: union of circles along the (smoothed, interpolated) spine → one radius per angle round a centre
     * point inside the shape → wobble + slosh → smooth → closed Catmull-Rom curve.
     */
    const buildOutline = (ox: number, oy: number, t: number): string => {
      const { x, y } = s;
      const e = s.stretch;
      const wobble = reduced ? 0 : 1;

      // Spine: light smoothing of the chain (ends pinned) so a sharply bent body doesn't make a sharply bent edge…
      for (let i = 0; i < NODES; i++) { smx[i] = x[i]; smy[i] = y[i]; }
      for (let pass = 0; pass < 2; pass++) {
        let px = smx[0], py = smy[0];
        for (let i = 1; i < NODES - 1; i++) {
          const cx = smx[i], cy = smy[i];
          smx[i] = cx * 0.5 + (px + smx[i + 1]) * 0.25;
          smy[i] = cy * 0.5 + (py + smy[i + 1]) * 0.25;
          px = cx; py = cy;
        }
      }
      // …then interpolated (Catmull-Rom) and re-sampled into SPINE circles evenly spaced by arc length. Spacing by
      // length rather than by node means nodes bunching up behind a slow tail can't make a fat lump there: the
      // radius profile always tapers smoothly from head to tail tip.
      for (let j = 0; j < DN; j++) {
        const u = j / DENSE, i1 = Math.min(NODES - 2, Math.floor(u)), f = u - i1;
        const i0 = Math.max(0, i1 - 1), i2 = i1 + 1, i3 = Math.min(NODES - 1, i1 + 2);
        const f2 = f * f, f3 = f2 * f;
        const w0 = -0.5 * f3 + f2 - 0.5 * f, w1 = 1.5 * f3 - 2.5 * f2 + 1, w2 = -1.5 * f3 + 2 * f2 + 0.5 * f, w3 = 0.5 * f3 - 0.5 * f2;
        dx[j] = smx[i0] * w0 + smx[i1] * w1 + smx[i2] * w2 + smx[i3] * w3;
        dy[j] = smy[i0] * w0 + smy[i1] * w1 + smy[i2] * w2 + smy[i3] * w3;
        dl[j] = j === 0 ? 0 : dl[j - 1] + Math.hypot(dx[j] - dx[j - 1], dy[j] - dy[j - 1]);
      }
      const total = dl[DN - 1];
      const baseR = s.hr * (1 - THINNING * e);
      for (let j = 0, d = 1; j < SPINE; j++) {
        const back = j / (SPINE - 1); // 0 at head … 1 at tail tip
        const at = back * total;
        while (d < DN - 1 && dl[d] < at) d++;
        const span = dl[d] - dl[d - 1], f = span > 1e-6 ? Math.min(1, Math.max(0, (at - dl[d - 1]) / span)) : 0;
        sx[j] = dx[d - 1] + (dx[d] - dx[d - 1]) * f;
        sy[j] = dy[d - 1] + (dy[d] - dy[d - 1]) * f;
        sr[j] = baseR * (1 - TAIL_TAPER * e * Math.pow(back, 0.85));
      }

      // Centre of the radial read-out: a point on the spine a little behind the head (it is inside its own circle,
      // so every ray finds an edge).
      const cj = Math.round((SPINE - 1) * 0.42);
      const cx = sx[cj], cy = sy[cj];

      // Radius per angle = farthest point where the ray leaves the union of circles.
      for (let k = 0; k < RING; k++) {
        const ux = RING_UX[k], uy = RING_UY[k];
        let best = sr[cj];
        for (let j = 0; j < SPINE; j++) {
          const wx = sx[j] - cx, wy = sy[j] - cy;
          const b = wx * ux + wy * uy;
          const c = wx * uy - wy * ux;
          const disc = sr[j] * sr[j] - c * c;
          if (disc > 0) {
            const tt = b + Math.sqrt(disc);
            if (tt > best) best = tt;
          }
        }
        // Idle wobble (anchored to world angle, so it doesn't spin with the direction of travel) + surface slosh.
        let r = best;
        if (wobble) {
          const th = (k / RING) * Math.PI * 2;
          const w = 0.09 * Math.sin(t * 1.3 + 2 * th) + 0.06 * Math.sin(t * 2.1 - 3 * th + 1.7) + 0.035 * Math.sin(t * 1.7 + 5 * th);
          r += (w * (1 - 0.5 * e) + s.slosh[k]) * baseR;
        }
        prof[k] = r;
      }

      // Fill the notch where the body meets the head: a few one-sided passes lift any point that sits below the
      // average of its neighbours (concave), and leave convex points, like the tail tip, exactly where they are.
      let a = prof, b2 = prof2;
      for (let pass = 0; pass < FILL_PASSES; pass++) {
        for (let k = 0; k < RING; k++) b2[k] = Math.max(a[k], 0.5 * (a[(k + RING - 1) % RING] + a[(k + 1) % RING]));
        const tmp = a; a = b2; b2 = tmp;
      }
      // Then round off whatever creases are left: smooth the radius profile round the ring.
      for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
        for (let k = 0; k < RING; k++) b2[k] = 0.25 * a[(k + RING - 1) % RING] + 0.5 * a[k] + 0.25 * a[(k + 1) % RING];
        const tmp = a; a = b2; b2 = tmp;
      }

      for (let k = 0; k < RING; k++) {
        const r = Math.max(a[k], baseR * 0.3);
        pts[k][0] = cx + RING_UX[k] * r - ox;
        pts[k][1] = cy + RING_UY[k] * r - oy;
      }
      return smoothPath(pts);
    };

    const start = () => {
      if (s.hr < 1) { // fully closed: open right under the finger instead of flying in from the last spot
        for (let i = 0; i < NODES; i++) { s.x[i] = s.tx; s.y[i] = s.ty; }
        s.vx = s.vy = s.ax = s.ay = 0;
        s.hv = 0; s.stretch = 0;
        s.slosh.fill(0); s.sloshV.fill(0);
      }
      s.active = true;
      mask.style.visibility = "visible";
      if (!s.running) {
        s.running = true;
        s.last = 0; s.acc = 0;
        s.raf = requestAnimationFrame(tick);
      }
    };

    const release = () => { s.active = false; };

    // ── mouse / pen / touch-without-touch-events: pointer events ────────────────────────────────
    // Touch goes through the touch events below whenever the browser has them.
    const viaTouchEvents = (e: PointerEvent) => hasTouchEvents && e.pointerType === "touch";
    const onDown = (e: PointerEvent) => { if (viaTouchEvents(e)) return; setTarget(e.clientX, e.clientY); start(); };
    const onMove = (e: PointerEvent) => {
      if (viaTouchEvents(e)) return;
      if (e.pointerType === "mouse") { setTarget(e.clientX, e.clientY); if (!s.active) start(); } // mouse: hover is enough
      else if (s.active) setTarget(e.clientX, e.clientY);                                        // pen: only while pressed
    };
    const onUp = (e: PointerEvent) => { if (!viaTouchEvents(e) && e.pointerType !== "mouse") release(); };
    const onCancel = (e: PointerEvent) => { if (!viaTouchEvents(e)) release(); };
    const onLeave = (e: PointerEvent) => { if (e.pointerType === "mouse") release(); };

    // ── touch: keeps reporting the finger after the browser starts scrolling the page ───────────
    let touchId: number | null = null;
    const find = (list: TouchList): Touch | null => {
      for (let i = 0; i < list.length; i++) if (list[i].identifier === touchId) return list[i];
      return null;
    };
    const onTouchStart = (e: TouchEvent) => {
      if (touchId !== null) return; // already following a finger; extra fingers are ignored
      const touch = e.changedTouches[0];
      if (!touch) return;
      touchId = touch.identifier;
      setTarget(touch.clientX, touch.clientY);
      start();
    };
    const onTouchMove = (e: TouchEvent) => {
      if (touchId === null) return;
      const touch = find(e.touches);
      if (touch) setTarget(touch.clientX, touch.clientY);
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (touchId === null || !find(e.changedTouches)) return;
      touchId = null;
      release();
    };

    const opts: AddEventListenerOptions = { passive: true }; // never block native scrolling
    section.addEventListener("pointerdown", onDown);
    section.addEventListener("pointermove", onMove);
    section.addEventListener("pointerup", onUp);
    section.addEventListener("pointercancel", onCancel);
    section.addEventListener("pointerleave", onLeave);
    section.addEventListener("touchstart", onTouchStart, opts);
    section.addEventListener("touchmove", onTouchMove, opts);
    section.addEventListener("touchend", onTouchEnd, opts);
    section.addEventListener("touchcancel", onTouchEnd, opts);

    return () => {
      section.removeEventListener("pointerdown", onDown);
      section.removeEventListener("pointermove", onMove);
      section.removeEventListener("pointerup", onUp);
      section.removeEventListener("pointercancel", onCancel);
      section.removeEventListener("pointerleave", onLeave);
      section.removeEventListener("touchstart", onTouchStart);
      section.removeEventListener("touchmove", onTouchMove);
      section.removeEventListener("touchend", onTouchEnd);
      section.removeEventListener("touchcancel", onTouchEnd);
      cancelAnimationFrame(s.raf);
    };
  }, [sectionRef, maskRef]);
}
