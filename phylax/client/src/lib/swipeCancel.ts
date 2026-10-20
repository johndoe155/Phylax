// The maths behind swipe-to-cancel (components/SwipeToCancel.tsx). No DOM, no React: pointer deltas in, offsets out,
// so the thresholds can be tested and tuned in one place.
//
// The gesture is a deliberate slide, not a flick. The row follows the finger one to one along a fixed track, and the
// shift is only cancelled when the row has travelled the whole track. Speed never completes it: a fast, short swipe just
// settles back, so scrolling past a row or brushing it cannot cancel anything.

export const SWIPE = {
  /** Pixels of travel before the gesture decides what it is. Under this, a touch is still a tap. */
  slop: 12,
  /** How much more horizontal than vertical the first movement must be to count as a swipe (about 32° off level). */
  dominance: 1.6,
  /** The track is half the row, held between these two lengths (px). */
  trackRatio: 0.5,
  minTrack: 150,
  maxTrack: 300,
} as const;

/** "swipe": ours, a leftward drag. "ignore": a vertical scroll or a rightward drag; leave it to the page. "pending": not enough movement yet. */
export type Intent = "pending" | "swipe" | "ignore";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Decides what a gesture is from its travel so far (dx, dy in px from the touch-down point). Only meant for the first moments of a gesture. */
export function readIntent(dx: number, dy: number, cfg: typeof SWIPE = SWIPE): Intent {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax < cfg.slop && ay < cfg.slop) return "pending";
  if (ax >= ay * cfg.dominance) return dx < 0 ? "swipe" : "ignore";
  return ay >= cfg.slop ? "ignore" : "pending";
}

/** How far the row has to travel, from its width. */
export const trackFor = (width: number, cfg: typeof SWIPE = SWIPE) => clamp(width * cfg.trackRatio, cfg.minTrack, cfg.maxTrack);

/**
 * Where the row sits (px, 0 or negative) for a drag. `origin` is where it was when the finger landed (0 unless it was
 * caught mid-settle) and `travel` is how far the finger has moved since the gesture locked on. Never past the start,
 * never past the end of the track, so dragging back to the lock point puts the row exactly where it began.
 */
export const offsetFor = (origin: number, travel: number, track: number) => clamp(origin + travel, -track, 0);

/** 0 at rest, 1 at the end of the track. */
export const progressOf = (offset: number, track: number) => (track > 0 ? clamp(-offset / track, 0, 1) : 0);

/** The one rule that cancels a shift. */
export const isComplete = (progress: number) => progress >= 1;
