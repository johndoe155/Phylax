/**
 * Geometry of the footer panel's background artwork, in the artwork's own 1920 x 1080 coordinate space.
 *
 * This mirrors `assets/footer-panel-bg.svg`. The panel used to show that file through an SVG <image>, which renders it
 * as an isolated document, so nothing on the page (GSAP included) could reach the bars inside it. FooterShape now draws
 * the same shapes inline from this data, which is what makes the scroll-driven "shift bars" animation possible.
 * If the artwork is ever redrawn, update the numbers here to match.
 */

export const FOOTER_ART = { width: 1920, height: 1080 } as const;

/** x positions of the faint vertical grid lines (every 160 units, edge to edge). */
export const FOOTER_GRID_X: readonly number[] = Array.from({ length: 13 }, (_, i) => i * 160);

export type FooterBar = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** fill-opacity of the bar; omitted = fully opaque */
  opacity?: number;
  /** the single darker accent bar */
  accent?: boolean;
};

/** The horizontal bars, top to bottom. Draw order matters: the accent bar is drawn last, on top. */
export const FOOTER_BARS: readonly FooterBar[] = [
  { x: 154, y: 110, width: 691, height: 38, opacity: 0.55 },
  { x: 576, y: 188, width: 614, height: 38, opacity: 0.75 },
  { x: 998, y: 266, width: 730, height: 38, opacity: 0.45 },
  { x: 38, y: 344, width: 538, height: 38, opacity: 0.65 },
  { x: 768, y: 422, width: 730, height: 38, opacity: 0.85 },
  { x: 1267, y: 500, width: 614, height: 38, opacity: 0.55 },
  { x: 269, y: 578, width: 730, height: 38, opacity: 0.45 },
  { x: 1152, y: 734, width: 653, height: 38, opacity: 0.65 },
  { x: 384, y: 812, width: 730, height: 38, opacity: 0.55 },
  { x: 1344, y: 890, width: 576, height: 38, opacity: 0.45 },
  { x: 653, y: 968, width: 614, height: 38, opacity: 0.75 },
  { x: 883, y: 656, width: 499, height: 38, accent: true },
];
