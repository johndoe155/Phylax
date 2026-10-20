/**
 * Motion engine for the menu trigger. No framework, no dependencies: it owns one progress track (the glyph) and three
 * eased tracks (the fill) and writes SVG path data straight to the DOM from a single requestAnimationFrame loop
 * (no React re-renders).
 *
 * The glyph and the fill are two independent machines:
 *
 *   glyph  two bars <-> X                         setGlyph(open)   follows the menu's real state, immediately
 *   fill   two-stage ink sweep + disc             setFill(on)      follows the menu's real state, but is told to
 *                                                                  release later (the close linger)
 *
 * Fill, opening:   stage 1  `g`  the ink sweep grows out of the pointer (organic, curved edge) and swallows the ring
 *                  stage 2  `l`  once stage 1 has all but landed, the sweep's lower edge rises in one round
 *                                curve, unveiling the disc `b` that was beneath it all along. While it rises it
 *                                leaves a thin outline of itself around the rim of the disc; the moment the rise is over
 *                                that outline fades out (fast), leaving just the disc.
 * Fill, closing:   the disc shrinks away toward the pointer, revealing the resting ring.
 *
 * All geometry lives in the button's 40×40 viewBox; the glyph is drawn in the reference footage's pixels (see the
 * glyph section) and scaled into it.
 */

/* ───────────────────────────── geometry ───────────────────────────── */

export const VIEW = 40;
export const CENTER = VIEW / 2;
/** Outline ring radius (the button's "border"). */
export const RING_R = 19.4;
/** The sweep is clipped to this radius: 1.25 units past the ring's outer edge, so the resting ring is fully covered. */
export const CLIP_R = 21.2;
/** Stage 2's outline: a ring hugging the inside of the disc's edge (its outer edge is exactly CLIP_R). */
export const OUTLINE_R = CLIP_R - 0.7;

type Pt = [number, number];

const f = (n: number) => Math.round(n * 100) / 100;

/* ───────────────────────────── glyph ───────────────────────────── */

/**
 * The glyph is two strokes. Each is a "trim path": a fixed curve with a visible window [tail, head] (arc length) that
 * slides along it. At rest the window covers the bar; the head runs on round a loop (upper stroke) or round a squared
 * hook (lower stroke) and the tail follows, until each window has settled onto the straight arm of the X.
 *
 * Every number in this section was measured off the reference footage and is kept in the footage's own pixels, so it
 * can be checked against it: the reference button is a 140 px box, the origin below is its centre, y points down.
 * The glyph group scales those pixels into the 40-unit viewBox (GLYPH_TRANSFORM), and the stroke width in the CSS
 * (`.mt-glyph path`, 5.6) is in the same pixels.
 */
export const REF_BOX = 140;
export const GLYPH_SCALE = VIEW / REF_BOX;
export const GLYPH_TRANSFORM = `translate(${CENTER} ${CENTER}) scale(${GLYPH_SCALE})`;

interface Seg {
  /** Arc length at the start of this piece, and its own length. */
  at: number;
  len: number;
  a: Pt;
  b: Pt;
  /** Present on circular pieces. `da` > 0 turns clockwise on screen (SVG sweep-flag 1). */
  arc?: { c: Pt; r: number; a0: number; da: number };
}

class TrimPath {
  length = 0;
  private segs: Seg[] = [];
  private cur: Pt;
  constructor(start: Pt) { this.cur = start; }

  line(to: Pt) {
    const len = Math.hypot(to[0] - this.cur[0], to[1] - this.cur[1]);
    if (len < 1e-9) return this;
    this.segs.push({ at: this.length, len, a: this.cur, b: to });
    this.length += len;
    this.cur = to;
    return this;
  }
  arc(c: Pt, r: number, a0: number, da: number) {
    const len = Math.abs(da) * r;
    const b: Pt = [c[0] + r * Math.cos(a0 + da), c[1] + r * Math.sin(a0 + da)];
    this.segs.push({ at: this.length, len, a: this.cur, b, arc: { c, r, a0, da } });
    this.length += len;
    this.cur = b;
    return this;
  }

  private along(s: Seg, d: number): Pt {
    const k = s.len ? d / s.len : 0;
    if (!s.arc) return [s.a[0] + (s.b[0] - s.a[0]) * k, s.a[1] + (s.b[1] - s.a[1]) * k];
    const t = s.arc.a0 + s.arc.da * k;
    return [s.arc.c[0] + s.arc.r * Math.cos(t), s.arc.c[1] + s.arc.r * Math.sin(t)];
  }

  pointAt(s: number): Pt {
    const at = Math.min(this.length, Math.max(0, s));
    const seg = this.segs.find((g) => at <= g.at + g.len + 1e-9) ?? this.segs[this.segs.length - 1];
    return this.along(seg, at - seg.at);
  }

  /** SVG path data for the stretch of the curve between two arc lengths (exact lines and arcs, no sampling). */
  slice(s0: number, s1: number): string {
    const lo = Math.max(0, Math.min(s0, s1)), hi = Math.min(this.length, Math.max(s0, s1));
    let d = "";
    for (const s of this.segs) {
      const from = Math.max(lo, s.at), to = Math.min(hi, s.at + s.len);
      if (to - from < 1e-6) continue;
      const p0 = this.along(s, from - s.at), p1 = this.along(s, to - s.at);
      if (!d) d = `M${f(p0[0])} ${f(p0[1])}`;
      if (s.arc) {
        const swept = ((to - from) / s.len) * s.arc.da;
        d += `A${f(s.arc.r)} ${f(s.arc.r)} 0 ${Math.abs(swept) > Math.PI ? 1 : 0} ${s.arc.da > 0 ? 1 : 0} ${f(p1[0])} ${f(p1[1])}`;
      } else {
        d += `L${f(p1[0])} ${f(p1[1])}`;
      }
    }
    if (d) return d;
    const p = this.pointAt(lo);
    return `M${f(p[0])} ${f(p[1])}L${f(p[0])} ${f(p[1])}`;
  }
}

/** A polyline whose interior corners are rounded off with circular arcs (radii[i] is the radius at point i + 1). */
function filleted(pts: Pt[], radii: number[]): TrimPath {
  const path = new TrimPath(pts[0]);
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1], r = radii[i - 1];
    const ul = Math.hypot(a[0] - b[0], a[1] - b[1]), vl = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const u: Pt = [(a[0] - b[0]) / ul, (a[1] - b[1]) / ul], v: Pt = [(c[0] - b[0]) / vl, (c[1] - b[1]) / vl];
    const ang = Math.acos(u[0] * v[0] + u[1] * v[1]); // interior angle at the corner
    const tl = r / Math.tan(ang / 2); // corner to the points where the arc touches the two sides
    const p1: Pt = [b[0] + u[0] * tl, b[1] + u[1] * tl];
    const p2: Pt = [b[0] + v[0] * tl, b[1] + v[1] * tl];
    const k = r / Math.sin(ang / 2) / Math.hypot(u[0] + v[0], u[1] + v[1]);
    const cen: Pt = [b[0] + (u[0] + v[0]) * k, b[1] + (u[1] + v[1]) * k];
    const a0 = Math.atan2(p1[1] - cen[1], p1[0] - cen[0]);
    let da = Math.atan2(p2[1] - cen[1], p2[0] - cen[0]) - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    path.line(p1).arc(cen, r, a0, da);
  }
  return path.line(pts[pts.length - 1]);
}

/** Visible length of each stroke at rest (the bars) and in the X (the arms). */
const BAR = 34.5;
/** Two bars, one step apart and mirrored about the centre: upper one to the right, lower one to the left. */
const UP_Y = -8.06, UP_X0 = -4.55; // upper bar: height, and its left end
const LO_Y = 12.2, LO_X0 = 4.55; // lower bar: height, and its right end
/** The X: arms cross at (0.5, 0.5). Each stroke's path ends at the far tip of its arm. */
const UP_TIP: Pt = [-11.7, 12.7]; // the "/" arm, ending bottom-left
const LO_TIP: Pt = [12.7, 12.7]; // the "\" arm, ending bottom-right
const LOOP_R = 8.653;

/**
 * Upper stroke: the bar, then it rolls up and over anticlockwise (225°) and comes back down-left across itself along
 * the "/" arm. The loop's radius is set so that the arm it lands on passes through the crossing of the X.
 */
const UPPER = new TrimPath([UP_X0, UP_Y])
  .line([UP_X0 + BAR, UP_Y])
  .arc([UP_X0 + BAR, UP_Y - LOOP_R], LOOP_R, Math.PI / 2, -(Math.PI * 5) / 4)
  .line(UP_TIP);

/** Lower stroke: the bar slides out to the left, turns up and over in a squared-off hook, then runs down the "\" arm. */
const LOWER = filleted([[LO_X0, LO_Y], [-41.93, LO_Y], [-41.93, -27.77], [-27.77, -27.77], LO_TIP], [7.64, 8.17, 5.31]);

/**
 * Where each window [tail, head] stands at each step of the footage (arc length in px along its path). The footage
 * is sampled at a fixed interval, so the poses are evenly spaced in time; the gaps between them are what give the
 * motion its rhythm: the upper bar's head hooks up first while the lower one barely stirs, then both strokes swing
 * out together (the lower one rising into its hook as the upper one closes its loop), hold for a beat, resolve into
 * the X (overshooting the final arm length), and finally the tails snap in to leave the X at its resting size.
 */
const POSES = {
  upTail: [0, 0, 0, 0, 3.1, 5.1, 5.1, 10.9, 64.9, 68.1, UPPER.length - BAR],
  upHead: [BAR, 58.8, 58.8, 66.2, 111.3, 112.8, 112.8, 116.2, UPPER.length, UPPER.length, UPPER.length],
  loTail: [0, 0, 0, 0, 28.9, 39, 39, 57, 100, 101.8, LOWER.length - BAR],
  loHead: [BAR, 37.2, 37.2, 38.7, 96, 103.4, 103.3, 117.1, 148.1, 149.2, LOWER.length],
};
/** Time between two poses. Together with the pose count this is the length of the whole open. */
const POSE_MS = 80;

/**
 * Monotone cubic through evenly spaced values (Fritsch–Carlson): hits every pose exactly, never overshoots between
 * them, and flattens out wherever the footage holds still. `u` is in pose units, 0..n-1.
 */
function monotone(ys: number[]): (u: number) => number {
  const n = ys.length;
  const d = ys.slice(1).map((y, i) => y - ys[i]);
  const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const end = (d0: number, d1: number) => {
    const m = (3 * d0 - d1) / 2;
    if (sign(m) !== sign(d0)) return 0;
    return sign(d0) !== sign(d1) && Math.abs(m) > 3 * Math.abs(d0) ? 3 * d0 : m;
  };
  const m: number[] = new Array(n);
  m[0] = end(d[0], d[1]);
  m[n - 1] = end(d[n - 2], d[n - 3]);
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]);
  return (u) => {
    const i = Math.min(n - 2, Math.max(0, Math.floor(u)));
    const x = Math.min(1, Math.max(0, u - i)), x2 = x * x, x3 = x2 * x;
    return (2 * x3 - 3 * x2 + 1) * ys[i] + (x3 - 2 * x2 + x) * m[i] + (-2 * x3 + 3 * x2) * ys[i + 1] + (x3 - x2) * m[i + 1];
  };
}

const upTail = monotone(POSES.upTail), upHead = monotone(POSES.upHead);
const loTail = monotone(POSES.loTail), loHead = monotone(POSES.loHead);
const LAST_POSE = POSES.upTail.length - 1;
/** Opening plays the footage's timing; closing runs it backwards, a little quicker. */
const GLYPH_OPEN_MS = LAST_POSE * POSE_MS;
const GLYPH_CLOSE_MS = GLYPH_OPEN_MS * 0.8;

const mixPt = (a: Pt, b: Pt, p: number): Pt => [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p];
const lineD = (a: Pt, b: Pt) => `M${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}`;
// Reduced motion: no loops; each stroke simply turns from its bar into its arm.
const CALM = {
  up: { t0: [UP_X0, UP_Y] as Pt, h0: [UP_X0 + BAR, UP_Y] as Pt, t1: UPPER.pointAt(UPPER.length - BAR), h1: UP_TIP },
  lo: { t0: [LO_X0, LO_Y] as Pt, h0: [LO_X0 - BAR, LO_Y] as Pt, t1: LOWER.pointAt(LOWER.length - BAR), h1: LO_TIP },
};

/** Path data for both strokes at glyph progress `q` (0 = bars, 1 = X). */
export function glyphPaths(q: number, calm = false) {
  const p = Math.min(1, Math.max(0, q));
  if (calm) {
    return {
      upper: lineD(mixPt(CALM.up.t0, CALM.up.t1, p), mixPt(CALM.up.h0, CALM.up.h1, p)),
      lower: lineD(mixPt(CALM.lo.t0, CALM.lo.t1, p), mixPt(CALM.lo.h0, CALM.lo.h1, p)),
    };
  }
  const u = p * LAST_POSE;
  return { upper: UPPER.slice(upTail(u), upHead(u)), lower: LOWER.slice(loTail(u), loHead(u)) };
}

const circle = (cx: number, cy: number, r: number) =>
  `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(r * 2)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-r * 2)} 0Z`;

const BLOB_POINTS = 12;

/** Closed Catmull-Rom spline through `BLOB_POINTS` points whose radii wobble: a round shape that isn't quite round. */
function blobPath(cx: number, cy: number, r: number, wobble: number, seeds: number[]): string {
  const pts: Pt[] = [];
  for (let i = 0; i < BLOB_POINTS; i++) {
    const a = (i / BLOB_POINTS) * Math.PI * 2;
    const rr = r * (1 + wobble * seeds[i]);
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < BLOB_POINTS; i++) {
    const p0 = pts[(i - 1 + BLOB_POINTS) % BLOB_POINTS], p1 = pts[i], p2 = pts[(i + 1) % BLOB_POINTS], p3 = pts[(i + 2) % BLOB_POINTS];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + "Z";
}

/** Low-frequency noise around the circle, so the lobes are broad and soft rather than spiky. */
function makeSeeds(): number[] {
  const p1 = Math.random() * Math.PI * 2, p2 = Math.random() * Math.PI * 2;
  return Array.from({ length: BLOB_POINTS }, (_, i) => {
    const a = (i / BLOB_POINTS) * Math.PI * 2;
    return 0.62 * Math.sin(2 * a + p1) + 0.38 * Math.sin(3 * a + p2);
  });
}

/* ───────────────────────────── easing ───────────────────────────── */

function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-5) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 24; i++) {
      if (sx(t) < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

// Stage 1 (sweep out): fast attack, long soft landing. Stage 2 (lift): a committed rise that eases out.
// Closing (disc in): gentle start, committed finish.
const EASE_GROW = cubicBezier(0.16, 0.84, 0.2, 1);
const EASE_LIFT = cubicBezier(0.5, 0, 0.18, 1);
const EASE_CLOSE = cubicBezier(0.6, 0, 0.25, 1);
const GROW_MS = 560;
const LIFT_MS = 800;
const CLOSE_MS = 780;
const CALM_MS = 180;
/** How long the stage-2 outline takes to disappear once the lift has finished: effectively instant. */
const RING_FADE_MS = 110;
/** Stage 2 starts as soon as stage 1's eased progress passes this: "almost instantaneously after" the sweep expands. */
const LIFT_AT = 0.9;

/** Radius of the arc that forms the lifting edge. Large against the 40-unit button, so it reads as one soft round curve. */
const EDGE_R = 34;
/** Where the lowest point of the edge sits at the start (just below the button) and the end (just above it). */
const EDGE_FROM = VIEW + 2.5;
const EDGE_TO = -3;

/**
 * The region of the button that is still covered by the sweep while it retracts upward: everything above an
 * edge that is a single circular arc, bowing downward (the middle trails, the sides lift first), like the underside
 * of a big drop being drawn up. `l` = 0 puts the edge below the button (nothing uncovered), `l` = 1 above it
 * (everything uncovered). Used as a clip path on the third-colour layer.
 */
function liftRegion(l: number, calm: boolean): string {
  const y = EDGE_FROM + (EDGE_TO - EDGE_FROM) * l; // the lowest point of the edge
  const x0 = -6, x1 = VIEW + 6, half = (x1 - x0) / 2;
  if (calm) return `M${x0} ${f(y)}H${x1}V-20H${x0}Z`; // reduced motion: a straight edge, no curve
  const rise = EDGE_R - Math.sqrt(EDGE_R * EDGE_R - half * half); // how far the ends sit above the lowest point
  return `M${x0} ${f(y - rise)}A${EDGE_R} ${EDGE_R} 0 0 0 ${x1} ${f(y - rise)}V-20H${x0}Z`;
}
const EVERYTHING = "M-20 -20H60V60H-20Z";

/** A value that is eased from wherever it currently is. Re-targeting mid-flight continues from the present value. */
class Track {
  x = 0;
  private tw: { from: number; to: number; elapsed: number; dur: number; ease: (x: number) => number } | null = null;
  go(to: number, dur: number, ease: (x: number) => number) {
    if (dur <= 0) { this.snap(to); return; }
    this.tw = { from: this.x, to, elapsed: 0, dur, ease };
  }
  step(ms: number) {
    const t = this.tw;
    if (!t) return;
    t.elapsed += ms;
    const k = Math.min(1, t.elapsed / t.dur);
    this.x = t.from + (t.to - t.from) * t.ease(k);
    if (k >= 1) { this.x = t.to; this.tw = null; }
  }
  stop() { this.tw = null; }
  snap(v: number) { this.x = v; this.tw = null; }
  get busy() { return this.tw !== null; }
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Fill wobble: swells mid-flight and is gone by the time the edge has passed the ring, so the end state is a true circle. */
const wobbleAt = (p: number, calm: boolean) => (calm ? 0 : 0.2 * Math.sin(Math.PI * p) ** 1.4 * (1 - p) ** 0.5);

/* ───────────────────────────── engine ───────────────────────────── */

export interface EngineEls {
  /** The two strokes: the upper bar (loops into the "/" arm) and the lower bar (hooks into the "\" arm). */
  upper: SVGPathElement;
  lower: SVGPathElement;
  /** The disc (beneath the sweep; the one the glyph finally sits on). */
  fill: SVGPathElement;
  /** The ink-sweep layer that grows out of the pointer and then retracts upward. */
  cover: SVGPathElement;
  /** The <path> inside the clipPath that decides how much of `cover` is still showing during stage 2. */
  lift: SVGPathElement;
  /** The thin outline the sweep leaves around the disc while it lifts away (stage 2 only). */
  ring: SVGElement;
}

export class TriggerEngine {
  // Glyph. q: progress along the open animation, 0 = bars, 1 = X. Always linear; the easing is in the poses.
  private q = new Track();
  // Fill. b: disc size. g: sweep growth. l: sweep upward retraction.
  private b = new Track();
  private g = new Track();
  private l = new Track();
  private fillOn = false;
  /**
   * True from a fresh opening until stage 2 begins. The disc exists in full from the first instant (stage 2 only
   * unveils it), so without this gate it shows around the still-tiny sweep and the button flashes the disc's
   * colour before the sweep has arrived. While gated the disc is simply not drawn.
   */
  private discGated = false;
  /** Stage 2 is armed and waits for stage 1 to reach LIFT_AT. */
  private liftPending = false;
  /** The stage-2 outline: opacity track, and whether it is currently meant to be on (from lift start until lift end). */
  private rr = new Track();
  private ringOn = false;
  private origin: Pt = [CENTER, CENTER];
  private bOrigin: Pt = [CENTER, CENTER];
  private gOrigin: Pt = [CENTER, CENTER];
  private seedsB = makeSeeds();
  private seedsG = makeSeeds();
  private raf = 0;
  private last = 0;
  private settledCb: (() => void) | null = null;
  private calm = false;

  constructor(private els: EngineEls, calm = false) {
    this.setCalm(calm);
    this.render();
  }

  /** Reduced-motion: the strokes turn straight from bars into the X in a short linear move (no loops), and the fill is a short linear fade-grow, no wobble. */
  setCalm(calm: boolean) {
    this.calm = calm;
    this.render();
  }

  /** Where the fill grows from, in the button's 40×40 space. Defaults to the centre (keyboard activation). */
  setOrigin(x: number, y: number) {
    this.origin = [Math.min(VIEW, Math.max(0, x)), Math.min(VIEW, Math.max(0, y))];
  }

  /**
   * Glyph only: bars <-> X. Independent of the fill, so the X can turn back into the bars the instant the
   * menu closes while the disc is still lingering, and can wind back into an X while the disc is still there.
   * Opening plays the footage's timing; closing runs it backwards. Re-targeting mid-flight continues from where the
   * strokes are, taking only as long as the remaining distance needs.
   */
  setGlyph(open: boolean) {
    const target = open ? 1 : 0;
    const full = this.calm ? CALM_MS : open ? GLYPH_OPEN_MS : GLYPH_CLOSE_MS;
    this.q.go(target, full * Math.abs(target - this.q.x), (x) => x);
    this.kick();
  }

  /**
   * Fill only. `on` runs the staged sequence (ink sweep out, then it lifts away to unveil the disc and leave
   * its outline); `off` shrinks the disc away. Calling it again with the state it is already heading for is a no-op,
   * so a click that lands during the close linger (the fill is still `on`) changes nothing here.
   * `onSettled` fires once everything has come to rest (used to release the frozen colours).
   */
  setFill(on: boolean, onSettled?: () => void) {
    if (on === this.fillOn) {
      if (!on) onSettled?.();
      return;
    }
    this.fillOn = on;
    this.settledCb = on ? null : onSettled ?? null;
    if (on) {
      const ms = (full: number) => (this.calm ? CALM_MS : full);
      if (this.b.x < 0.001) {
        // Fresh start: the disc sits complete underneath; the sweep is what the person sees arrive.
        this.bOrigin = this.origin;
        this.seedsB = makeSeeds();
        this.b.snap(1);
        this.discGated = true;
      } else {
        // Re-opened while the disc was still shrinking: it grows back from wherever it is.
        this.b.go(1, ms(GROW_MS) * Math.max(0.25, 1 - this.b.x), EASE_GROW);
      }
      const coverLive = this.g.x > 0.001 && this.l.x < 0.999;
      if (!coverLive) {
        this.gOrigin = this.origin;
        this.seedsG = makeSeeds();
        this.g.snap(0);
        this.l.snap(0);
        this.ringOn = false;
        this.rr.snap(0);
      }
      this.l.stop();
      this.g.go(1, ms(GROW_MS) * Math.max(0.25, 1 - this.g.x), this.calm ? (x) => x : EASE_GROW);
      this.liftPending = true;
    } else {
      this.liftPending = false;
      this.l.stop();
      if (this.discGated) { this.discGated = false; this.b.snap(0); } // the disc was never shown, so there is nothing to shrink
      if (this.rr.x > 0) this.rr.go(0, this.calm ? 60 : RING_FADE_MS, (x) => x);
      this.ringOn = false;
      this.bOrigin = this.origin; // shrink toward where the closing click landed
      this.seedsB = makeSeeds();
      const ms = (this.calm ? CALM_MS : CLOSE_MS) * Math.max(0.25, this.b.x);
      const ease = this.calm ? (x: number) => x : EASE_CLOSE;
      this.b.go(0, ms, ease);
      // If the sweep was still in flight, it goes home with the disc; if it already retracted there is nothing to do.
      if (this.g.x > 0.001 && this.l.x < 0.999) this.g.go(0, ms, ease);
      else this.g.snap(0);
    }
    this.kick();
  }

  /** Jump to a state with no animation (initial mount). */
  jump(open: boolean) {
    this.jumpGlyph(open);
    this.fillOn = open;
    this.discGated = false;
    this.bOrigin = this.gOrigin = this.origin;
    this.b.snap(open ? 1 : 0);
    this.g.snap(0);
    this.l.snap(open ? 1 : 0);
    this.liftPending = false;
    this.ringOn = false;
    this.rr.snap(0);
    this.render();
  }

  jumpGlyph(open: boolean) {
    this.q.snap(open ? 1 : 0);
    this.render();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.settledCb = null;
  }

  private kick() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private get idle() {
    return !this.q.busy && !this.b.busy && !this.g.busy && !this.l.busy && !this.rr.busy && !this.liftPending;
  }

  private tick = (now: number) => {
    const dt = Math.min((now - this.last) / 1000, 1 / 30);
    this.last = now;
    const ms = dt * 1000;
    this.q.step(ms); this.b.step(ms); this.g.step(ms); this.l.step(ms); this.rr.step(ms);

    if (this.fillOn) {
      if (this.liftPending && this.g.x >= LIFT_AT) {
        // Stage 2 begins: the outline exists exactly as long as the lift does. It is the cover's own colour, so it is
        // invisible until the cover's edge rises past the rim and uncovers it.
        this.liftPending = false;
        this.discGated = false;
        this.ringOn = true;
        this.rr.snap(1);
        this.l.go(1, this.calm ? CALM_MS : LIFT_MS, this.calm ? (x) => x : EASE_LIFT);
      } else if (this.ringOn && !this.l.busy && this.l.x >= 0.999) {
        // The lift is over: the outline goes, quickly.
        this.ringOn = false;
        this.rr.go(0, this.calm ? 60 : RING_FADE_MS, (x) => x);
      }
    }

    this.render();
    if (this.idle) {
      if (!this.fillOn) { this.g.snap(0); this.l.snap(0); }
      this.render();
      this.raf = 0;
      const cb = this.settledCb;
      this.settledCb = null;
      cb?.();
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  render() {
    const g = glyphPaths(this.q.x, this.calm);
    this.els.upper.setAttribute("d", g.upper);
    this.els.lower.setAttribute("d", g.lower);

    // Disc — drawn beneath the sweep, and (like it) over the resting ring.
    const B = this.b.x;
    const [bx, by] = this.bOrigin;
    const rB = Math.hypot(bx - CENTER, by - CENTER) + CLIP_R + 1;
    this.els.fill.setAttribute("d", B <= 0.001 || this.discGated ? "" : B >= 0.999 ? circle(bx, by, rB) : blobPath(bx, by, rB * B, wobbleAt(B, this.calm), this.seedsB));

    // Sweep — grows (stage 1), then is cut away from the bottom upward in one round curve (stage 2).
    const G = this.g.x, L = this.l.x;
    const [gx, gy] = this.gOrigin;
    const rG = Math.hypot(gx - CENTER, gy - CENTER) + CLIP_R + 1;
    const showCover = G > 0.001 && L < 0.999;
    const coverD = !showCover ? "" : G >= 0.999 ? circle(gx, gy, rG) : blobPath(gx, gy, rG * G, wobbleAt(G, this.calm), this.seedsG);
    this.els.cover.setAttribute("d", coverD);
    this.els.lift.setAttribute("d", L <= 0.001 ? EVERYTHING : liftRegion(L, this.calm));

    // Stage-2 outline.
    this.els.ring.setAttribute("opacity", String(f(this.rr.x)));
  }
}

export const staticGlyph = glyphPaths(0);
