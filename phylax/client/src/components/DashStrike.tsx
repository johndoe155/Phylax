import { memo } from "react";

/**
 * The marker stroke through YOUR on the dashboard ("<name>'s" is written above it, see pages/Dashboard.tsx and the
 * .dash-your / .dash-strike rules in dashboard.css).
 *
 * Only this line is animated: the name above it is not drawn. The line is drawn like a real marker pass:
 *   - BODY is a filled outline, not a stroked path, so its thickness varies along the stroke (the pen lands heavy, swells and eases
 *     with pressure, then lifts off thinner), its edges are slightly uneven and its ends are rounded and different from each other.
 *   - STREAK is a thin second pass over the upper half of the stroke where the ink is denser, drawn a moment later.
 *   - The draw itself is a mask: a thick stroke along the centre line (MASK) whose dash is pulled back with
 *     stroke-dashoffset, so the filled body is uncovered from left to right along its own path.
 *
 * The paths were generated once (a centre line with a hand tremor, a pressure curve for the thickness, small random jitter on both
 * edges) in a 260x30 box, and the svg stretches that box over the word (preserveAspectRatio="none").
 */
const BODY =
  "M4.9 13.5 C5.9 13.3 9.2 12.7 11.3 12.5 C13.5 12.3 15.8 12.5 17.9 12.3 C20.1 12.0 22.2 11.4 24.3 11.1 C26.4 10.8 28.6 10.5 30.7 10.2 C32.9 9.8 35.0 9.2 37.1 9.1 C39.3 9.0 41.4 9.5 43.6 9.4 C45.7 9.4 47.9 9.2 50.0 9.0 C52.1 8.8 54.3 8.5 56.4 8.4 C58.6 8.3 60.7 8.3 62.9 8.4 C65.0 8.6 67.1 8.9 69.3 9.2 C71.4 9.5 73.5 10.0 75.7 10.3 C77.8 10.5 79.9 10.5 82.1 10.8 C84.2 11.1 86.3 11.7 88.5 12.1 C90.6 12.6 92.7 13.3 94.9 13.4 C97.1 13.5 99.2 12.9 101.4 12.9 C103.6 12.9 105.7 13.2 107.9 13.2 C110.1 13.2 112.2 13.0 114.4 12.8 C116.6 12.6 118.8 12.0 120.9 11.7 C123.1 11.4 125.3 11.2 127.5 10.9 C129.6 10.6 131.8 10.3 134.0 9.9 C136.2 9.6 138.4 9.2 140.6 8.8 C142.8 8.5 145.0 8.3 147.2 7.9 C149.4 7.4 151.7 6.5 153.9 6.3 C156.2 6.0 158.4 6.3 160.6 6.3 C162.8 6.3 164.9 6.4 167.0 6.3 C169.0 6.2 171.0 5.7 173.0 5.7 C175.0 5.6 176.9 5.8 178.8 5.7 C180.7 5.7 182.6 5.6 184.4 5.4 C186.3 5.3 188.1 4.9 189.8 4.9 C191.6 4.8 193.3 5.2 195.0 5.3 C196.7 5.4 198.4 5.6 200.1 5.6 C201.7 5.6 203.3 5.4 204.9 5.4 C206.5 5.4 208.0 5.8 209.6 5.8 C211.1 5.8 212.6 5.4 214.1 5.4 C215.6 5.4 217.0 5.8 218.4 5.9 C219.8 6.0 221.3 5.9 222.6 6.0 C224.0 6.1 225.4 6.2 226.7 6.3 C228.0 6.5 229.3 6.8 230.6 6.8 C231.9 6.9 233.2 6.6 234.5 6.5 C235.7 6.4 237.0 6.2 238.2 6.3 C239.5 6.4 240.8 7.0 242.0 7.2 C243.3 7.3 244.5 7.1 245.7 7.0 C246.9 6.8 248.1 6.3 249.3 6.3 C250.6 6.2 252.7 6.6 253.4 6.6 Q257.1 8.7 254.5 10.8 C253.9 11.0 252.0 12.0 250.7 12.4 C249.4 12.7 248.0 12.5 246.7 12.8 C245.4 13.1 244.1 13.9 242.8 14.3 C241.5 14.6 240.2 14.9 238.8 15.0 C237.5 15.1 236.1 14.7 234.8 14.9 C233.4 15.2 232.0 16.3 230.7 16.5 C229.3 16.7 227.9 16.1 226.5 16.1 C225.1 16.2 223.6 16.6 222.2 16.7 C220.8 16.8 219.3 16.6 217.9 16.7 C216.4 16.7 214.9 16.8 213.4 17.0 C211.9 17.1 210.4 17.4 208.9 17.4 C207.3 17.4 205.8 17.1 204.3 17.1 C202.7 17.0 201.1 17.0 199.5 17.0 C197.9 17.0 196.3 17.0 194.6 17.1 C193.0 17.1 191.3 17.2 189.6 17.1 C187.9 16.9 186.2 16.6 184.5 16.4 C182.7 16.2 180.9 16.0 179.1 15.8 C177.2 15.6 175.4 15.3 173.5 15.1 C171.5 14.9 169.6 14.8 167.6 14.9 C165.6 15.0 163.6 15.5 161.6 15.8 C159.5 16.0 157.4 16.1 155.2 16.3 C153.1 16.4 150.8 16.5 148.6 16.8 C146.3 17.0 144.0 17.4 141.7 17.6 C139.4 17.9 137.1 18.0 134.8 18.3 C132.5 18.7 130.3 19.3 128.1 19.6 C125.8 19.9 123.6 20.3 121.3 20.4 C119.1 20.5 116.8 20.3 114.6 20.3 C112.4 20.2 110.1 20.2 107.9 20.2 C105.7 20.2 103.5 20.0 101.3 20.1 C99.1 20.2 96.9 20.5 94.8 20.5 C92.6 20.6 90.4 20.7 88.2 20.6 C86.1 20.6 83.9 20.1 81.8 20.0 C79.6 20.0 77.5 20.3 75.3 20.2 C73.2 20.1 71.1 19.7 69.0 19.6 C66.9 19.5 64.7 19.6 62.6 19.5 C60.5 19.4 58.4 18.9 56.3 18.9 C54.2 18.8 52.1 19.3 50.1 19.4 C48.0 19.4 45.9 19.0 43.8 19.0 C41.7 19.1 39.7 19.1 37.6 19.5 C35.6 19.9 33.6 20.8 31.5 21.3 C29.5 21.8 27.5 22.0 25.5 22.3 C23.5 22.6 21.4 22.8 19.4 23.2 C17.4 23.6 15.5 24.2 13.5 24.6 C11.5 25.1 8.5 25.8 7.5 26.0 Q3.6 19.8 4.9 13.5 Z";
const STREAK =
  "M24.7 14.5 C27.8 14.3 37.3 13.6 43.7 13.3 C50.0 13.0 56.4 12.8 62.8 12.7 C69.2 12.6 75.6 12.5 82.0 12.5 C88.5 12.5 94.9 12.6 101.4 12.6 C107.9 12.6 114.4 12.8 121.0 12.6 C127.6 12.4 134.3 12.2 140.9 11.7 C147.6 11.2 154.6 10.2 160.9 9.6 C167.3 9.1 173.2 8.9 178.9 8.7 C184.6 8.5 189.9 8.4 194.9 8.4 C200.0 8.4 204.8 8.5 209.4 8.6 C214.0 8.7 218.3 8.8 222.5 8.8 C226.7 8.8 230.7 8.8 234.5 8.6 C238.4 8.4 243.9 7.7 245.8 7.5";
const MASK =
  "M6.0 19.0 C9.1 18.5 18.5 16.7 24.8 16.0 C31.1 15.3 37.4 15.1 43.7 14.9 C50.0 14.7 56.4 14.8 62.7 14.9 C69.1 15.0 75.5 15.3 81.9 15.5 C88.4 15.6 94.8 15.9 101.4 15.9 C107.9 15.9 114.5 16.0 121.1 15.6 C127.7 15.3 134.5 14.7 141.2 14.0 C147.9 13.2 154.8 11.9 161.1 11.3 C167.4 10.7 173.3 10.3 178.9 10.2 C184.6 10.0 189.8 10.1 194.9 10.3 C199.9 10.4 204.7 10.8 209.2 11.0 C213.8 11.2 218.2 11.6 222.4 11.7 C226.6 11.9 230.7 12.0 234.7 11.8 C238.6 11.7 243.1 11.2 246.3 10.7 C249.6 10.2 252.7 9.3 254.0 9.0";

// The id is fixed: the dashboard has exactly one of these.
const MASK_ID = "dash-strike-mask";

export const DashStrike = memo(function DashStrike() {
  return (
    <svg className="dash-strike" viewBox="0 0 260 30" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        {/* userSpaceOnUse with generous bounds, so the mask's default 10% margin never trims the thick reveal stroke. */}
        <mask id={MASK_ID} maskUnits="userSpaceOnUse" x="-20" y="-30" width="300" height="90">
          <path className="dash-strike-reveal" d={MASK} pathLength={1} fill="none" stroke="#fff" strokeWidth="46" />
        </mask>
      </defs>
      <g mask={`url(#${MASK_ID})`}>
        <path className="dash-strike-body" d={BODY} />
        <path className="dash-strike-streak" d={STREAK} pathLength={1} fill="none" strokeWidth="2.6" strokeLinecap="round" />
      </g>
    </svg>
  );
});
