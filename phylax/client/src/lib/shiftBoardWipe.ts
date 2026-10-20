/**
 * Geometry for the wipe reveal on the Section 01 shift board (components/TapDemo.tsx, hooks/useShiftBoardWipe.ts).
 *
 * A solid panel sits over the board. Its shape is the area between a TOP edge and a BOTTOM edge, both measured down
 * from the board's top as a fraction of its height (0 = top of the board, 1 = bottom). The board itself is only visible
 * above the panel's top edge; below the panel's bottom edge there is nothing, so the page background shows.
 *
 * Everything is a pure function of one number, `p`, the animation's progress from 0 to 1 (see wipeProgressAt: it is
 * time, not scroll position; the wipe plays by itself, once, when the board scrolls into view). Two phases, back to
 * back, with the seam at p = WIPE.phase1:
 *
 *  Phase 1, cover. The top edge is fixed at the board's top, so the board stays hidden. The bottom edge starts as
 *  nothing, becomes a hairline, and moves down. Its middle leads and its sides trail, so the edge is an arch bulging
 *  downward; the arch grows with the distance travelled. Once the middle reaches the board's bottom the sides catch up
 *  (the arch collapses flat) and the bottom stays put, which finishes covering the whole board.
 *
 *  Phase 2, uncover. The bottom edge stays flat on the board's bottom. The top edge moves down, uncovering the board
 *  from top to bottom. Its middle is held back, so it bulges upward; the arch starts at full height and flattens as it
 *  descends, so the panel ends as a thin flat strip that narrows to a hairline and is gone at p = 1.
 *
 * Arches are parabolas, 4x(1 - x): 0 at both sides, 1 in the middle. For a shallow arch that is indistinguishable from
 * a circular arc, and they are kept shallow on purpose (see archDepth). All coordinates come out as percentages of the
 * board's box, so the clip-paths need the board's size in pixels only to size the arch and the 1px seam.
 *
 * When it starts is shouldPlay(): once the board is well inside the viewport, so the whole of the bulge is on screen.
 */

export const WIPE = {
  /** How long the whole wipe takes, in ms. */
  durationMs: 1500,
  /** The seam between the phases in p, so each phase takes half the time. */
  phase1: 0.5,
  /** Within phase 1: the share spent moving the bottom edge down while its arch grows. The rest flattens the arch. */
  grow: 0.7,
  /** Arch height as a fraction of the board's width, capped at `archMaxOfHeight` of its height. Gentle: about 23px on
   * a 330px phone card, 36px on a 518px desktop card. */
  archOfWidth: 0.07,
  archMaxOfHeight: 0.08,
  /** Phase 2: the top edge decelerates as (1 - v)^exitPower, so the strip lingers on its way to a hairline. */
  exitPower: 1.8,
  /** The wipe starts once this share of the board (or of the viewport's height, for a board taller than the
   * viewport) is on screen vertically, and at least `triggerAcross` of its width is on screen. */
  triggerVisible: 0.9,
  triggerAcross: 0.5,
  /** Straight segments per arch. 40 across a card keeps the polygon within a twentieth of a pixel of the parabola. */
  segments: 40,
} as const;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const easeIn = (x: number) => 1 - Math.cos((Math.PI / 2) * x);
const easeOut = (x: number) => Math.sin((Math.PI / 2) * x);
const arch = (x: number) => 4 * x * (1 - x);

export type Box = { top: number; left: number; width: number; height: number };

/** Whether the board (a bounding box, px from the viewport's top left) is in an adequate position to start the wipe. */
export function shouldPlay(box: Box, viewportWidth: number, viewportHeight: number): boolean {
  if (box.width <= 0 || box.height <= 0) return false;
  const visibleY = Math.min(box.top + box.height, viewportHeight) - Math.max(box.top, 0);
  const visibleX = Math.min(box.left + box.width, viewportWidth) - Math.max(box.left, 0);
  return (
    visibleY >= WIPE.triggerVisible * Math.min(box.height, viewportHeight) &&
    visibleX >= WIPE.triggerAcross * Math.min(box.width, viewportWidth)
  );
}

/** Progress, 0 → 1, `elapsedMs` after the wipe started. */
export function wipeProgressAt(elapsedMs: number): number {
  return clamp01(elapsedMs / WIPE.durationMs);
}

/** How high the arch is, as a fraction of the board's height. */
export function archDepth(width: number, height: number): number {
  if (height <= 0) return 0;
  return Math.min(WIPE.archOfWidth * (width / height), WIPE.archMaxOfHeight);
}

export type Edges = {
  /** The top edge: resting y at its sides, and how far its middle is held above that (fractions of height). */
  topBase: number;
  topArch: number;
  /** The bottom edge: y of its middle (the leading point), and how far its sides trail behind that. */
  bottomBase: number;
  bottomArch: number;
};

/** Where both edges are at progress p. `depth` is archDepth(). */
export function wipeEdges(p: number, depth: number): Edges {
  const t = clamp01(p);
  if (t < WIPE.phase1) {
    const u = t / WIPE.phase1;
    if (u < WIPE.grow) {
      // Moving down and growing together: the arch is always the same share of the distance covered, and both start
      // slowly, so the panel goes nothing → hairline → steady growth.
      const g = easeIn(u / WIPE.grow);
      return { topBase: 0, topArch: 0, bottomBase: g, bottomArch: depth * g };
    }
    // The middle is at the bottom; the sides catch up, ending at a full, flat cover.
    const c = easeOut((u - WIPE.grow) / (1 - WIPE.grow));
    return { topBase: 0, topArch: 0, bottomBase: 1, bottomArch: depth * (1 - c) };
  }
  const v = (t - WIPE.phase1) / (1 - WIPE.phase1);
  const top = 1 - Math.pow(1 - v, WIPE.exitPower);
  // The arch starts at full height (above the board's top, so it first shows as the corners opening) and flattens
  // faster than the strip thins, so what is left at the end is flat.
  return { topBase: top, topArch: depth * (1 - top) * (1 - top), bottomBase: 1, bottomArch: 0 };
}

/** Top edge: highest in the middle. Bottom edge: lowest in the middle. Both are clamped to the board's box. */
const topY = (base: number, rise: number, x: number) => clamp01(base - rise * arch(x));
const bottomY = (tip: number, lag: number, x: number) => clamp01(tip - lag * (1 - arch(x)));
const point = (x: number, y: number) => `${(x * 100).toFixed(2)}% ${(y * 100).toFixed(3)}%`;

export const EMPTY_CLIP = "polygon(0 0, 0 0, 0 0)";
/** Before the wipe starts: the board is clipped away entirely and the panel paints nothing. Needs no size. */
export const HIDDEN_CLIPS = { board: EMPTY_CLIP, panel: EMPTY_CLIP } as const;

/**
 * The two clip-paths for progress p, or null once the wipe is finished (clear both: nothing is clipped any more).
 *  - board: the board, visible only above the panel's top edge.
 *  - panel: the panel, between its top and bottom edges.
 *
 * The panel's top edge is drawn up to 1px higher than the board's clip, so it overlaps the board's anti-aliased rim.
 * Two clip edges that meet exactly each cover a fraction of the boundary pixels, and together they let the background
 * through as a faint seam; overlapping them leaves nothing to leak. The overlap is also capped by the strip's own
 * thickness, so it never keeps the panel alive after the strip has narrowed to nothing.
 */
export function wipeClips(p: number, width: number, height: number): { board: string; panel: string } | null {
  if (p >= 1 || height <= 0) return null;
  const e = wipeEdges(p, archDepth(width, height));
  const seam = 1 / height;
  const n = WIPE.segments;

  const top: string[] = [];
  const topPanel: string[] = [];
  const bottom: string[] = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    const y = topY(e.topBase, e.topArch, x);
    top.push(point(x, y));
    topPanel.push(point(x, clamp01(y - Math.min(seam, 1 - y))));
    bottom.push(point(x, bottomY(e.bottomBase, e.bottomArch, x)));
  }

  const board = e.topBase === 0 && e.topArch === 0 ? EMPTY_CLIP : `polygon(0 0, 100% 0, ${[...top].reverse().join(", ")})`;
  const panel = `polygon(${topPanel.join(", ")}, ${[...bottom].reverse().join(", ")})`;
  return { board, panel };
}
