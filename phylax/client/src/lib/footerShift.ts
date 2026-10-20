/**
 * The maths behind the footer's scroll-driven "shift bars" (see hooks/useFooterShiftBars.ts). Pure, so it can be tested
 * without a DOM.
 *
 * Everything is in the artwork's own units (the 1920 x 1080 viewBox), where `centerX` is the artwork's horizontal
 * midpoint. Because the artwork is drawn with `preserveAspectRatio="slice"` and centred, that midpoint is also the
 * midpoint of the visible panel at every size, so one rule works from phone to desktop.
 *
 * WHY THIS IS MORE THAN "DISTANCE x PROGRESS"
 * On a phone the panel is tall and narrow, so `slice` crops the artwork to a window a few hundred units wide, while the
 * bars are 500-730 units long. A bar's edges are the only thing that shows movement, and on a phone most bars have both
 * edges outside the window (they simply cover it) or lie entirely outside it. Sliding such a bar by a few percent of the
 * panel's width changes nothing on screen: it looks frozen however far it "travels". So the distance is chosen from where
 * the bar's edges are relative to the VISIBLE window, not just from how far the bar sits from the midpoint.
 */

/** Which half of the panel a bar starts in, judged by its left edge. */
export type ShiftSide = "left" | "right";

/**
 * How far a bar's visible edge sweeps across the panel, as a fraction of the panel's visible width, for a bar at the far
 * edge of the artwork. Bars nearer the midpoint sweep less (down to MIN_TRAVEL) so the stack has depth.
 * On a full-width panel (desktop) this is exactly the distance the bars have always travelled.
 */
export const EDGE_TRAVEL = 0.12;

/** The least any bar's edge sweeps, same unit. Keeps bars that start near the midpoint visibly moving. */
export const MIN_TRAVEL = 0.05;

/**
 * The narrower the visible window is compared with the whole artwork, the larger the sweep (as a fraction of that window).
 * Without it a phone, which shows ~20% of the artwork, would get 20% of the desktop's pixel distance. The multiplier is
 * (artwork width / visible width) ^ NARROW_EXPONENT: 1 on a full-width panel, ~2.5 when only a fifth is visible. It is
 * deliberately sub-linear, so a phone gets a clearly visible sweep without the bars racing across it.
 */
export const NARROW_EXPONENT = 0.6;

/** Where a sweeping edge must stay, as a fraction of the visible width. Past this the edge would leave the panel and the bar would freeze. */
export const KEEP_INSIDE = 0.92;

/**
 * A bar that has to be carried in from off screen (it lies outside the window, or covers it) is hidden or frozen until its
 * edge arrives, so it is given more distance once it does: its edge sweeps in to this fraction of the visible width,
 * instead of the usual short sweep. That shortens the stretch of scroll where the bar is not yet showing anything. It stays
 * below KEEP_INSIDE. Bars already on screen (all of them on a desktop) are not affected.
 */
export const ENTER_REACH = 0.75;

/** If the leading edge has less room than this left before it would leave the panel, the trailing edge is tracked instead. */
export const MIN_VISIBLE_SWEEP = 0.12;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * @param barX          the bar's untransformed left edge
 * @param barWidth      the bar's width
 * @param centerX       the artwork's horizontal midpoint
 * @param visibleWidth  how much of the artwork's width the panel actually shows (artwork units; <= artwork width)
 * @returns `side` and `travel`, the signed distance (artwork units) the bar covers by the end of the scroll range:
 *          a left-aligned bar travels right (+), a right-aligned bar travels left (-), so the stack closes towards the
 *          middle. Together with `progress` (0..1) the bar sits at `travel * progress`, a straight line with no clamping.
 *
 *          The bar is slid so that ONE OF ITS EDGES is on screen and sweeping for the whole of the distance:
 *          - leading edge (the one facing the middle) already on screen with room to move -> it sweeps;
 *          - bar lying entirely outside the window -> first carries it in, then the leading edge sweeps;
 *          - leading edge off the far side / out of room (the bar covers the window) -> the trailing edge is carried in
 *            and sweeps instead.
 *          A sweep never carries the edge out of the window (KEEP_INSIDE), because the bar would then cover the whole
 *          panel again and look frozen. That is a limit on where an edge may end up, not on how far the bar travels.
 */
export function computeBarShift(
  barX: number,
  barWidth: number,
  centerX: number,
  visibleWidth: number,
): { side: ShiftSide; travel: number } {
  const offset = barX - centerX;
  const side: ShiftSide = offset < 0 ? "left" : "right";
  if (!(visibleWidth > 0) || !(centerX > 0)) return { side, travel: 0 };

  // Base sweep: grows with how far from the midpoint the bar starts (0 at the midpoint, 1 at the artwork's edge).
  const depth = clamp01(Math.abs(offset) / centerX);
  const fullWidth = centerX * 2;
  const narrow = Math.max(1, fullWidth / visibleWidth) ** NARROW_EXPONENT;
  const sweep = (MIN_TRAVEL + (EDGE_TRAVEL - MIN_TRAVEL) * depth) * narrow;

  // Edges as fractions of the visible window (0 = its left edge, 1 = its right edge; outside 0..1 = off screen), mirrored
  // for right-aligned bars so that "forward" always means "towards the middle".
  const windowLeft = centerX - visibleWidth / 2;
  const uLeft = (barX - windowLeft) / visibleWidth;
  const uRight = (barX + barWidth - windowLeft) / visibleWidth;
  const forward = side === "left" ? 1 : -1;
  const lead = side === "left" ? uRight : 1 - uLeft;
  const trail = side === "left" ? uLeft : 1 - uRight;

  /** Carry `edge` in if it is off the near side and sweep it to ENTER_REACH, otherwise sweep it by `sweep`; never past KEEP_INSIDE. */
  const sweepEdge = (edge: number) =>
    edge <= 0 ? -edge + Math.max(sweep, ENTER_REACH) : Math.min(sweep, Math.max(KEEP_INSIDE - edge, 0));

  const leadUsable = lead <= 0 || (lead < 1 && KEEP_INSIDE - lead >= MIN_VISIBLE_SWEEP);
  const delta = leadUsable ? sweepEdge(lead) : sweepEdge(trail);
  return { side, travel: forward * delta * visibleWidth };
}

/**
 * Scroll progress of the footer effect, 0..1, as a straight line in the scroll position.
 *
 * It starts when the panel's top edge reaches the bottom of the viewport (the bars rest in their drawn positions until
 * the footer appears) and reaches 1 exactly when the page can scroll no further. Everything is measured by the caller from
 * the live layout each frame, so a late-loading font or image, or a mobile address bar showing / hiding (which changes the
 * viewport height and so the maximum scroll), moves the range with it instead of leaving a stale, too-short one behind.
 *
 * @param scrollY         the current scroll position
 * @param panelTop        the panel's top edge in document coordinates
 * @param viewportHeight  the current visible viewport height
 * @param maxScroll       the largest scroll position the page allows right now
 */
export function scrollProgress(scrollY: number, panelTop: number, viewportHeight: number, maxScroll: number): number {
  const start = Math.max(0, panelTop - viewportHeight);
  const span = maxScroll - start;
  if (!(span > 0)) return 0; // nothing to scroll through: leave the artwork as drawn
  return clamp01((scrollY - start) / span);
}

/**
 * One step of exponential smoothing: `current` eases towards `target` with time constant `tau` seconds, independent of the
 * frame rate. Snaps once it is imperceptibly close so the animation loop can stop.
 */
export function easeToward(current: number, target: number, dtSeconds: number, tau: number): number {
  const gap = target - current;
  if (Math.abs(gap) < 0.0005 || !(tau > 0)) return target;
  return current + gap * (1 - Math.exp(-dtSeconds / tau));
}
