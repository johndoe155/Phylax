/**
 * Stop-motion logic for the sketch logo in the menu (components/MenuSketchLogo.tsx).
 *
 * Seven drawings of the same mark share one canvas (viewBox 0 0 100 100) and one position, and each has its own
 * feTurbulence seed, so cutting between them makes the lines tremble ("boiling line") without the mark ever moving.
 * The risk is the opposite one: several drawings carry a signature detail you can spot (the flick, the gaps, the
 * guides), and cycling 1 -> 7 would show each of them at a fixed interval, which reads as a beat or a flicker instead of
 * as one drawing shaking. So the drawings are shown in a fixed NON-sequential order (assets/phylax-sketch/frame-order-48.txt)
 * that was built to keep loud frames apart. The rules it follows, and which `auditOrder` below checks:
 *
 *   1. Never two loud drawings back to back: loud and quiet alternate.
 *   2. The same loud drawing never comes back within 3 drawings of itself.
 *   3. The order is not a short loop. 48 drawings on twos is a 4 s cycle, far too long to feel as a beat; the player also
 *      starts each pass at a different point of the cycle.
 *
 * Everything here is pure (no DOM, no Vite imports) so it can be unit-tested; the component does the rendering.
 */

/** Playback clock: 24 fps, every drawing held for 2 frames ("on twos"), so 12 drawings a second (~83.3 ms each). */
export const FPS = 24;
export const HOLD_FRAMES = 2;
export const HOLD_MS = (1000 / FPS) * HOLD_FRAMES;

/**
 * How early a tick may advance the drawing. A requestAnimationFrame callback lands on a display refresh, not on an exact
 * 83.3 ms; without a little slack a drawing would sometimes be held one refresh too long (60 Hz: 5 refreshes = 83.3 ms
 * exactly, so any jitter tips it to 6). The clock itself stays on the exact grid, so the slack never accumulates.
 */
export const TICK_SLACK_MS = 4;

/**
 * Drawings whose signature changes the silhouette or the line count, so they are noticed: 03 (corner overshoots),
 * 04 (the outline breaks; the loudest), 05 (construction guides), 07 (ghost lines). The rest, 01, 02 and 06, differ
 * mostly in line weight and wobble and blend in.
 */
export const LOUD: ReadonlySet<number> = new Set([3, 4, 5, 7]);

/** Two appearances of the same loud drawing must be at least this many drawings apart (3 others in between). */
export const MIN_LOUD_GAP = 4;

/** Reads a frame-order file: any run of digits is a drawing number, so `03*` and `03,` also work, and `#` starts a comment. */
export function parseOrder(text: string): number[] {
  return (text.replace(/#.*$/gm, "").match(/\d+/g) ?? []).map(Number);
}

/**
 * Checks an order against the rules above, treating it as a loop (the last drawing is followed by the first, because that
 * is how it plays). Returns what is wrong, in words; an empty list means it is fine.
 */
export function auditOrder(order: readonly number[], loud: ReadonlySet<number> = LOUD, minGap = MIN_LOUD_GAP): string[] {
  const n = order.length;
  if (n < 2) return ["the order needs at least two drawings to animate"];
  const problems: string[] = [];

  for (let i = 0; i < n; i++) {
    const here = order[i];
    const next = order[(i + 1) % n];
    const at = `positions ${i + 1} and ${((i + 1) % n) + 1}`;
    if (here === next) problems.push(`drawing ${here} is held twice in a row (${at})`);
    if (loud.has(here) && loud.has(next)) problems.push(`two loud drawings back to back: ${here} then ${next} (${at})`);
  }

  for (const variant of Array.from(new Set(order)).filter((v) => loud.has(v))) {
    const at = order.flatMap((v, i) => (v === variant ? [i] : []));
    at.forEach((position, k) => {
      const gap = at.length === 1 ? n : (at[(k + 1) % at.length] - position + n) % n;
      if (gap < minGap) problems.push(`loud drawing ${variant} at position ${position + 1} comes back ${gap} drawings later (minimum ${minGap})`);
    });
  }
  return problems;
}

/** Positions in the order that hold a quiet drawing: the places a pass can start without opening on a loud one. */
export function quietStarts(order: readonly number[], loud: ReadonlySet<number> = LOUD): number[] {
  const quiet = order.flatMap((v, i) => (loud.has(v) ? [] : [i]));
  return quiet.length ? quiet : order.map((_, i) => i);
}

const METADATA_RE = /<metadata[\s\S]*?<\/metadata>/gi;
const TITLE_RE = /<title[\s\S]*?<\/title>/gi;
const ROOT_RE = /<svg\b[^>]*>/i;
/** Root attributes that must not survive inlining: the file's `.logo-mark` class would pull in the nav logo's 24x20 size,
 * `role` / `aria-label` would announce seven different "logos", and width / height are set by CSS instead. */
const ROOT_DROP_RE = /\s(?:class|role|aria-label|aria-hidden|focusable|width|height|xmlns:c2pa)="[^"]*"/g;

/**
 * Prepares one drawing's file for inlining (dangerouslySetInnerHTML), like the pricing sketches do: drops the embedded
 * content-credentials <metadata> blob and the <title> (a tooltip, and noise for assistive tech), and turns the root into a
 * decorative element. Presentation attributes (fill, stroke, stroke-width, caps, viewBox) are left exactly as drawn.
 */
export function cleanSketchSvg(svg: string): string {
  return svg
    .replace(METADATA_RE, "")
    .replace(TITLE_RE, "")
    .replace(ROOT_RE, (root) => root.replace(ROOT_DROP_RE, "").replace(/\s*>$/, ' aria-hidden="true" focusable="false">'));
}
