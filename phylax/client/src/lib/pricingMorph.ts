import { fromOklch, luminance, toOklch, type RGB } from "./triggerTone";

/**
 * Colour model for the Templates -> Pricing morph (see hooks/usePricingMorph.ts).
 *
 * `morphPalette(p)` answers: with the shared background `p` of the way from cream to ink, what colour should every
 * piece of text, muted text, accent, hairline and card surface in BOTH sections be? There is one `p`, one background
 * and one palette, so Templates and Pricing can never disagree about what colour the page is.
 *
 * Why this isn't just "lerp every colour from its cream-theme value to its ink-theme value": text goes ink -> cream
 * while the background goes cream -> ink, so a straight lerp of both lands on the *same* mid-grey at p = 0.5 and the
 * text vanishes. Instead each colour stays on its own side of the background for as long as it can, and only changes
 * sides around the point where the background's luminance is where black and white are equally legible (about 18%
 * luminance, ~4.5:1 either way - the best any single colour can do there).
 *
 *   1. Before the crossover a token is its cream-theme colour, drifting toward ink as the background darkens, so it keeps
 *      pulling away from the background instead of being caught by it. (`rampDown`)
 *   2. After it, it is its ink-theme colour, starting near cream and relaxing back to the theme colour as the
 *      background reaches ink. (`rampUp`)
 *   3. The hand-over between the two is a smootherstep (zero velocity AND zero acceleration at both ends) spread over a
 *      wide stretch of the scroll range, SWAP_HALF_WIDTH either side of the crossover, so colour moves continuously
 *      with scroll instead of flipping. A continuous colour cannot go from darker-than-the-background to lighter-than-
 *      it without passing through the background's own luminance, so contrast must dip once; this is the one place
 *      that happens, and it is where black/white are equally far from the background, i.e. where the dip is shallowest.
 *
 * Every step is an analytic, smooth function of p - no thresholds, no searches, no contrast clamps - so there is
 * nothing that can kink or jump. (An earlier version pushed colours to a minimum contrast with a binary search; that
 * guard switched branches mid-scroll and was one source of visible stepping.)
 *
 * Both endpoints are exactly the colours the sections used before, so p = 0 reads as the cream Templates section and
 * p = 1 is the original dark Pricing section, unchanged.
 */

const PAPER: RGB = { r: 0xf5, g: 0xf1, b: 0xea }; // --cream  (Templates' background)
const INK: RGB = { r: 0x11, g: 0x11, b: 0x12 }; //   --ink    (Pricing's original background)
const CARD_LIGHT: RGB = { r: 0xe7, g: 0xe2, b: 0xd8 }; // Templates' tile surface (.helmet-visual)
const CARD_DARK: RGB = { r: 0x18, g: 0x19, b: 0x1b }; //  the site's dark card surface (.visual)

const hex = (n: number): RGB => ({ r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 });

interface Token {
  /** Colour used when the backdrop is cream-coloured (Templates theme). */
  onLight: RGB;
  /** Colour used when the backdrop is ink-coloured (Pricing's original theme). */
  onDark: RGB;
  /** How far (0..1) the colour may lean toward ink/cream at the crossover to stay separated from the backdrop. */
  pull: number;
}

const TOKENS = {
  fg: { onLight: INK, onDark: PAPER, pull: 1 },
  muted: { onLight: hex(0x4b4b4e), onDark: hex(0xd9d4ca), pull: 0.8 },
  // Accent is display-size text ("TILES", "FREE.") and decorative dots: it leans less, so it stays recognisably blue.
  accent: { onLight: hex(0x506b80), onDark: hex(0x7a93a8), pull: 0.6 },
} satisfies Record<string, Token>;

/** Text printed on the template tiles, which sit on their own surface rather than on the page background. */
const SURFACE_FG: Token = { onLight: INK, onDark: PAPER, pull: 1 };

/** Hairlines keep their original strengths (rgba(ink, .18) on cream, rgba(cream, .2) on ink). */
const LINE_ALPHA = { onLight: 0.18, onDark: 0.2 };

/**
 * Half-width of the hand-over, in morph progress (0..1). The whole hand-over spans 2 * SWAP_HALF_WIDTH of the scroll
 * range, so text drifts from dark to light over that whole stretch instead of flipping. Wider = gentler but a longer
 * stretch of mid-contrast; narrower = crisper but it starts to read as a snap (0.015 did).
 */
export const SWAP_HALF_WIDTH = 0.14;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Quintic smootherstep: C2-continuous, so neither the colour nor its rate of change jumps at either end. */
const smootherstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
const mixRgb = (a: RGB, b: RGB, t: number): RGB => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });

/** The shared page background at progress p. Matches what the compositor draws for an ink layer at opacity p over cream. */
export const backgroundAt = (p: number): RGB => mixRgb(PAPER, INK, clamp01(p));
/** The tile surface at progress p. */
export const surfaceAt = (p: number): RGB => mixRgb(CARD_LIGHT, CARD_DARK, clamp01(p));

/** Progress at which black and white are equally legible on `backdrop` (luminance sqrt(1.05 * 0.05) - 0.05). */
function crossoverOf(backdrop: (p: number) => RGB): number {
  const target = Math.sqrt(1.05 * 0.05) - 0.05;
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (luminance(backdrop(mid)) > target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
const SWAP_POINT = crossoverOf(backgroundAt);
const SURFACE_SWAP_POINT = crossoverOf(surfaceAt);
export { SWAP_POINT };

/** Side of the hand-over: 0 = cream-theme colours, 1 = ink-theme colours. */
export const swapAt = (p: number, point = SWAP_POINT) => smootherstep(point - SWAP_HALF_WIDTH, point + SWAP_HALF_WIDTH, p);

/** Perceptual (OKLab) linear blend of two colours. */
function mixOklab(a: RGB, b: RGB, t: number): RGB {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const A = toOklch(a), B = toOklch(b);
  const ax = A.C * Math.cos((A.h * Math.PI) / 180), ay = A.C * Math.sin((A.h * Math.PI) / 180);
  const bx = B.C * Math.cos((B.h * Math.PI) / 180), by = B.C * Math.sin((B.h * Math.PI) / 180);
  const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
  return fromOklch(A.L + (B.L - A.L) * t, Math.hypot(x, y), ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}

/**
 * A token's colour at progress p on a backdrop whose black/white crossover is `point`, with hand-over weight `s`.
 * p = 0 and p = 1 return the theme colours exactly (the ramps are 0 there and mixOklab short-circuits).
 */
function tokenAt(token: Token, p: number, s: number, point: number): RGB {
  const rampDown = smootherstep(0, point, p); //      0 at cream -> 1 at the crossover
  const rampUp = 1 - smootherstep(point, 1, p); //    1 at the crossover -> 0 at ink
  const pre = mixOklab(token.onLight, INK, rampDown * token.pull);
  const post = mixOklab(token.onDark, PAPER, rampUp * token.pull);
  return mixOklab(pre, post, s);
}

export interface MorphPalette {
  /** The one background both sections share. */
  bg: RGB;
  fg: RGB;
  muted: RGB;
  accent: RGB;
  /** Hairline colour, already flattened onto the background (so it can be used as an opaque `border-color`). */
  line: RGB;
  /** Template tile surface, and the text/bars printed on it. */
  surface: RGB;
  surfaceFg: RGB;
}

export function morphPalette(p: number): MorphPalette {
  p = clamp01(p);
  const bg = backgroundAt(p);
  const surface = surfaceAt(p);
  const s = swapAt(p);
  const fg = tokenAt(TOKENS.fg, p, s, SWAP_POINT);
  const alpha = LINE_ALPHA.onLight + (LINE_ALPHA.onDark - LINE_ALPHA.onLight) * s;
  return {
    bg,
    fg,
    muted: tokenAt(TOKENS.muted, p, s, SWAP_POINT),
    accent: tokenAt(TOKENS.accent, p, s, SWAP_POINT),
    line: mixRgb(bg, fg, alpha),
    surface,
    surfaceFg: tokenAt(SURFACE_FG, p, swapAt(p, SURFACE_SWAP_POINT), SURFACE_SWAP_POINT),
  };
}

export const rgbCss = ({ r, g, b }: RGB) => `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;
