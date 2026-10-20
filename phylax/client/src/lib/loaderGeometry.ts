/**
 * Geometry for the page loader's split. Pure functions, no DOM, no React, no GSAP.
 *
 * The screen is cut down the centre into a left half (L) and a right half (R). Inside a band of 12 rows the
 * cut zig-zags in large rectangles: EVEN rows are blocks of L that poke into R's side, ODD rows are blocks of R
 * that poke into L's side. Each block is as long as a stepped shield (Phylax = "guard") is wide at that row, so
 * the interlocking teeth trace the shield: wide, flat shoulders, then stepping in to a point.
 *
 * Why alternate rows: when the halves slide apart, a block of L (poking right) withdraws leftwards and a block of R
 * (poking left) withdraws rightwards. They can only do that without passing through each other if they sit on
 * different rows.
 *
 * Each half is returned as BAND_COUNT horizontal bands (a cap above the shield, the 12 shield rows, a cap below)
 * instead of one polygon, so the loader can stagger the bands and unzip the screen top to bottom.
 * Band i of L and band i of R share one seam x and one y range, so together they tile row i exactly.
 *
 * Units: 1 cell = 1 row height = 1 column width.
 */

/** Half-width of the shield, in cells, for each row from the top. 12 rows, 8 cells at its widest. */
export const SHIELD_HW = [4, 4, 4, 4, 4, 4, 3, 3, 2, 2, 1, 1] as const;
export const SHIELD_ROWS = SHIELD_HW.length;
export const SHIELD_MAX_HW = Math.max(...SHIELD_HW);

/** Top cap + one band per shield row + bottom cap. */
export const BAND_COUNT = SHIELD_ROWS + 2;

/** Bands run this far past the viewport so their outer edges are never visible. */
export const BLEED = 24;

/** One horizontal slice of the screen, as a left rectangle and a right rectangle that meet at the seam. */
export interface Band {
  y: number;
  h: number;
  /** Left rectangle (L): x .. x + w. */
  lx: number;
  lw: number;
  /** Right rectangle (R): x .. x + w. */
  rx: number;
  rw: number;
}

export interface LoaderLayout {
  /** Whole pixels, so every seam edge lands on a pixel boundary (no hairline gaps between the halves). */
  cell: number;
  cx: number;
  cy: number;
  /** Top to bottom, BAND_COUNT entries, in viewport pixels. */
  bands: Band[];
  /** How far each half must travel to be completely off screen. */
  exitLeft: number;
  exitRight: number;
}

export function computeLayout(vw: number, vh: number): LoaderLayout {
  // Shield is 12 cells tall. 15 leaves ~20% of the height as margin; 10.5 keeps it inside narrow portrait screens.
  const cell = Math.max(16, Math.floor(Math.min(vh / 15, vw / 10.5)));
  const cx = Math.round(vw / 2);
  const cy = Math.round(vh / 2);
  const top = cy - (SHIELD_ROWS / 2) * cell;
  const bottom = top + SHIELD_ROWS * cell;

  const band = (y: number, h: number, seamX: number): Band => ({
    y,
    h,
    lx: -BLEED,
    lw: seamX + BLEED,
    rx: seamX,
    rw: vw + BLEED - seamX,
  });

  const bands: Band[] = [band(-BLEED, top + BLEED, cx)];
  SHIELD_HW.forEach((hw, row) => {
    const seamX = cx + (row % 2 === 0 ? hw : -hw) * cell; // even: L pokes right. odd: R pokes left.
    bands.push(band(top + row * cell, cell, seamX));
  });
  bands.push(band(bottom, vh + BLEED - bottom, cx));

  // L's furthest-right point is cx + MAX_HW * cell; R's furthest-left is cx - MAX_HW * cell.
  const reach = (SHIELD_MAX_HW + 1) * cell;
  return { cell, cx, cy, bands, exitLeft: cx + reach, exitRight: vw - cx + reach };
}
