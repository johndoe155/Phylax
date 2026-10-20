/**
 * The Phylax mark: two outlined bars, the second offset down and to the right so they overlap.
 *
 * It used to be two CSS-bordered <span>s. It is now inline SVG so the stroke can be manipulated
 * (the page loader draws it with GSAP DrawSVG) and so the nav, footer, dashboard and loader all share
 * ONE definition of the geometry.
 *
 * Geometry is the same as the old CSS version, 1 unit = 1px at nav size:
 *   outer box 24 x 20, each bar 17 x 12 outside edge, 2px outline, second bar offset +7 / +8.
 * Paths are drawn along the stroke centre line, hence the 1px inset (outer 0..17 -> centre 1..16).
 *
 * Each path is closed and starts at a corner, which matters for DrawSVG: with square line caps the
 * two caps meeting at the start corner fill the outer corner exactly, so a fully drawn bar has no notch.
 */
export const LOGO_VIEWBOX_W = 24;
export const LOGO_VIEWBOX_H = 20;

/** Bar A starts top-left and runs clockwise. */
export const LOGO_BAR_A = "M1 1H16V11H1Z";
/** Bar B starts bottom-right and runs counter-clockwise, so the loader draws the two bars toward each other. */
export const LOGO_BAR_B = "M23 19H8V9H23Z";

export function PhylaxMark({ className = "logo-mark" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${LOGO_VIEWBOX_W} ${LOGO_VIEWBOX_H}`}
      width={LOGO_VIEWBOX_W}
      height={LOGO_VIEWBOX_H}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
    >
      <path d={LOGO_BAR_A} />
      <path d={LOGO_BAR_B} />
    </svg>
  );
}
