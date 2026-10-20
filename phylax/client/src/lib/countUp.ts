/**
 * The maths behind the dashboard's number rise (see components/CountUp.tsx). Kept free of the DOM so it can be tested.
 */

/** One count-up, in ms. Inside 1.2 to 1.8 s: long enough to read as a rise, short enough not to hold the page up. */
export const COUNT_UP_MS = 1500;

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Very fast start, long gentle tail. Best for big numbers, where the tail is a run of single steps. */
export const easeOutExpo = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - 2 ** (-10 * t));

/**
 * Quick at first, then settling. This is the one the dashboard uses: the stats here are small integers (3 platforms, 12 patterns, a few
 * dozen hours), and easeOutExpo would have a 3 reach its final value in the first 15% of the run, so it would look like a jump, not a rise.
 * easeOutCubic spreads 0, 1, 2, 3 over the first ~40% and still eases into the end.
 */
export const easeOutCubic = (t: number) => 1 - (1 - clamp01(t)) ** 3;

/** The whole number a stat counts to: rounded, never negative, and 0 for anything that is not a finite number. */
export const countTarget = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

/** The integer to show `progress` (0 to 1, by the clock) of the way from `from` to `to`. At 1 it is exactly `to`. */
export function countAt(from: number, to: number, progress: number, ease: (t: number) => number = easeOutCubic): number {
  if (!(progress < 1)) return to;
  return Math.round(from + (to - from) * ease(progress));
}
