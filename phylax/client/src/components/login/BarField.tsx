/**
 * The login page's ambient canvas: the landing hero's field of drifting shift bars, recomposed on a square grid so it
 * crops well in both the compact mobile header and the desktop brand column. It reuses the hero's classes
 * (.hb-bg / .hb-grid / .hb-bar / .hb-accent / .hb-clash in index.css), so palette and motion stay in lockstep with it.
 *
 * The steel-blue bar is "your shift", and it starts overlapping a neighbour, with the dashed clash box around the overlap.
 * Sign-in progress (--lg-p, 0 to 1, set on .lg) slides it clear and fades the clash out: a finished sign-in is a
 * schedule with no conflict. See .lg-accent / .lg-clash-box in login.css.
 */
import type { CSSProperties } from "react";

const LANE = 80;
// [x, laneIndex, width, opacity] on a 1000 x 1000 viewBox; bars are 40 tall, lanes 80 apart, starting at y = 40.
const BARS: [x: number, lane: number, w: number, o: number][] = [
  [120, 0, 520, 0.12], [480, 1, 430, 0.16],
  /* lane 2 holds the accent bar */
  [520, 3, 420, 0.18], [-60, 4, 480, 0.1], [80, 5, 430, 0.12], [420, 6, 540, 0.14], [40, 7, 500, 0.1],
  [560, 8, 420, 0.16], [140, 9, 460, 0.12], [560, 10, 400, 0.1], [-20, 11, 520, 0.12],
];
const y = (lane: number) => 40 + lane * LANE;

export function BarField() {
  return (
    <svg className="lg-bars" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <rect className="hb-bg" width="1000" height="1000" />
      {Array.from({ length: 11 }, (_, i) => <line key={i} className="hb-grid" x1={i * 100} y1="0" x2={i * 100} y2="1000" />)}
      {BARS.map(([x, lane, w, o], i) => (
        <rect
          key={i}
          className="hb-bar"
          x={x}
          y={y(lane)}
          width={w}
          height="40"
          // Same recipe as the hero: each faint bar gets its own speed, distance, phase and direction.
          style={{
            "--t": `${14 + ((i * 3) % 9)}s`,
            "--d": `${30 + ((i * 17) % 40)}px`,
            "--o": `${-((i * 2.7) % 12)}s`,
            animationDirection: i % 2 ? "alternate-reverse" : "alternate",
            fillOpacity: o,
          } as CSSProperties}
        />
      ))}
      <rect className="hb-accent lg-accent" x="330" y={y(2)} width="340" height="40" />
      <rect className="hb-clash lg-clash-box" x="520" y={y(2)} width="150" height="120" />
    </svg>
  );
}
