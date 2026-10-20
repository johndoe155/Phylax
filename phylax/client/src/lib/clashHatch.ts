/**
 * Marker-hatch geometry for the overlap ("clash") box in "One night, two apps".
 *
 * The box is filled by one continuous pen stroke that zigzags across it: a diagonal line up to the right, a turn
 * outside the box, a diagonal line back down to the left, and so on, until the whole box is covered. Because the
 * path is one stroke, a single dash offset (see `.gap-hatch` in index.css) draws it from the first line to the last.
 *
 * The lines are laid out to land exactly on the striped tile the box settles into (`.gap-clash-fill`: a 135deg
 * gradient on a 12px tile, blue where (x + y) mod 12 is in [6, 12)), so when the draw finishes and the stripes start
 * moving there is no jump. Every line is a "/" diagonal: x + y is constant along it, which is why the maths here is
 * written in terms of c = x + y.
 *
 * Two strokes share this path: a wide ink one that covers the whole pitch (so the drawn box is as solid as the
 * finished one, with nothing of the overlap tint showing between the lines) and a narrower blue one on top.
 */

/** Distance between neighbouring stripe centres, measured along x + y: the 12px gradient tile. */
export const HATCH_PITCH = 12;
/** Width of the blue stripe in the same units: half the tile. */
export const HATCH_BAND = HATCH_PITCH / 2;
/** Where the first blue stripe is centred (x + y): the middle of the tile's first blue band, [6, 12). */
export const HATCH_PHASE = 9;
/** Stroke widths: a band that is `n` wide in x + y is `n / sqrt(2)` wide measured across the diagonal. */
export const HATCH_INK_WIDTH = HATCH_PITCH / Math.SQRT2;
export const HATCH_MARK_WIDTH = HATCH_BAND / Math.SQRT2;
/** How far each line runs past the box, so the turns happen outside it (the svg clips them) and the ends are square. */
export const HATCH_OVERSHOOT = 6;

export type HatchPoint = { x: number; y: number };

/** The pen's route for a `width` x `height` box, as a list of points (a polyline). Empty for an empty box. */
export function hatchPoints(width: number, height: number): HatchPoint[] {
  if (!(width > 0) || !(height > 0)) return [];
  const m = HATCH_OVERSHOOT;
  const points: HatchPoint[] = [];
  // k = -1 is the ink-only line that covers the top-left corner, [-9, 3) in x + y; the blue stripes start at k = 0.
  for (let k = -1, c = HATCH_PHASE - HATCH_PITCH; c - HATCH_PITCH / 2 < width + height; k++, c += HATCH_PITCH) {
    const xLow = Math.max(-m, c - height - m); // lower-left end of the line (largest y)
    const xHigh = Math.min(width + m, c + m); // upper-right end (smallest y)
    const lowerLeft = { x: xLow, y: c - xLow };
    const upperRight = { x: xHigh, y: c - xHigh };
    // Alternate direction: up to the right on even lines, back down to the left on odd ones, so each turn joins
    // two line ends on the same side and the pen never lifts.
    if (k % 2 === 0) points.push(lowerLeft, upperRight);
    else points.push(upperRight, lowerLeft);
  }
  return points;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** The same route as an SVG path `d` string ("" for an empty box). */
export function buildHatchPath(width: number, height: number): string {
  return hatchPoints(width, height)
    .map((p, i) => `${i === 0 ? "M" : "L"}${round(p.x)} ${round(p.y)}`)
    .join("");
}
