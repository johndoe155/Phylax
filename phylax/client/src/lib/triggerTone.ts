/**
 * Shared colour maths (sRGB / OKLab / OKLCH, luminance, contrast).
 *
 * This file used to hold the menu trigger's colour engine: it sampled the pixels behind the button and derived a
 * stroke, a fill and an accent from them. That is gone. The trigger now gets its colour the same way the header logo
 * does, from `mix-blend-mode: difference` (see components/MenuTrigger.tsx), so nothing here is tied to the page background.
 * What remains is the generic colour maths, still used by lib/pricingMorph.ts.
 */

export type RGB = { r: number; g: number; b: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/* ---------- sRGB / OKLab maths ---------- */

const toLin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLin = (v: number) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

export function luminance({ r, g, b }: RGB) {
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

export function contrast(a: RGB, b: RGB) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function toOklch({ r, g, b }: RGB) {
  const R = toLin(r), G = toLin(g), B = toLin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

/** OKLCH -> sRGB. Chroma is reduced until the colour fits the sRGB gamut, so hue and lightness survive. */
export function fromOklch(L: number, C: number, h: number): RGB {
  const hr = (h * Math.PI) / 180;
  let c = C;
  for (let i = 0; i < 28; i++) {
    const a = c * Math.cos(hr), b = c * Math.sin(hr);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const lin = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    if (lin.every((v) => v >= -0.0005 && v <= 1.0005) || c < 0.0005) {
      return { r: fromLin(clamp(lin[0], 0, 1)), g: fromLin(clamp(lin[1], 0, 1)), b: fromLin(clamp(lin[2], 0, 1)) };
    }
    c *= 0.88;
  }
  const v = fromLin(clamp(L, 0, 1));
  return { r: v, g: v, b: v };
}

export const invert = ({ r, g, b }: RGB): RGB => ({ r: 255 - r, g: 255 - g, b: 255 - b });
export const css = ({ r, g, b }: RGB) => `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;

/**
 * Moves `fg` along the lightness axis (keeping its hue and chroma) until it reaches `min` contrast against
 * `against`. Heads for whichever end of the scale can actually reach higher contrast. Only does anything in the
 * mid-tone zone, where a pure inversion lands on almost the same lightness as its own background.
 */
export function ensureContrast(fg: RGB, against: RGB, min: number): RGB {
  if (contrast(fg, against) >= min) return fg;
  const { L, C, h } = toOklch(fg);
  const toWhite = contrast({ r: 255, g: 255, b: 255 }, against);
  const toBlack = contrast({ r: 0, g: 0, b: 0 }, against);
  const dir = toWhite >= toBlack ? 1 : -1;
  let best = fg;
  for (let l = L; l >= 0 && l <= 1; l += dir * 0.015) {
    best = fromOklch(l, C, h);
    if (contrast(best, against) >= min) break;
  }
  return best;
}
