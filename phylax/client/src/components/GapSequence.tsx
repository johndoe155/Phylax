import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useGapSequence } from "@/hooks/useGapSequence";
import { buildHatchPath } from "@/lib/clashHatch";
import { CLASH, axis, dayShift, nightShift, pct, type Bar } from "@/lib/shiftLanes";

// The label of a shift bar, written out character by character. Each character is its own <tspan> that traces its
// outline (a stroke-dash draw) and then fills in; `--i` is its position, `--gw-n` the character count, and the CSS
// (`.gw-ch` in index.css) turns the bar's text progress into each character's own progress, staggered left to right.
// Plain SVG text, so it uses the live page font and needs no glyph outlines. Decorative: the lanes' role="img" label
// already says everything it says.
function WriteText({ name, time }: { name: string; time: string }) {
  const nameChars = Array.from(name);
  const timeChars = Array.from(time);
  // A space is a no-break space so SVG's whitespace collapsing keeps it as its own, drawable-width tspan.
  const glyph = (ch: string) => (ch === " " ? "\u00A0" : ch);
  return (
    <svg className="gap-write" aria-hidden="true" focusable="false" style={{ "--gw-n": nameChars.length + timeChars.length } as CSSProperties}>
      <text x="0" y="50%">
        {nameChars.map((ch, i) => (
          <tspan key={`n${i}`} className="gw-ch" style={{ "--i": i } as CSSProperties}>{glyph(ch)}</tspan>
        ))}
        {timeChars.map((ch, i) => (
          // The time follows the name after an 8px gap, set in the mono face at 9px (see .gw-time).
          <tspan key={`t${i}`} className="gw-ch gw-time" dx={i === 0 ? 8 : undefined} style={{ "--i": nameChars.length + i } as CSSProperties}>{glyph(ch)}</tspan>
        ))}
      </text>
    </svg>
  );
}

// The marker fill of the overlap box: one pen stroke zigzagging across it in alternating diagonal lines (see
// lib/clashHatch.ts). It is drawn in px, so it measures the box (which is a percentage of the lane) and rebuilds on resize.
function ClashHatch() {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    // contentRect is layout size: unaffected by the merge's scale transform, which is what the path must match.
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const d = useMemo(() => buildHatchPath(size.width, size.height), [size]);
  return (
    <svg ref={ref} className="gap-hatch" viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true" focusable="false">
      {d && (
        <>
          <path className="gap-hatch-base" pathLength={1} d={d} />
          <path className="gap-hatch-mark" pathLength={1} d={d} />
        </>
      )}
    </svg>
  );
}

// One bar. The two source bars (in the app lanes) draw themselves; the duplicates (`dup`, in the Phylax lane)
// are the finished bars, parked on top of their source until the migration phase moves them down.
// Everything animates off CSS variables set by useGapSequence; see the "gap sequence" block in index.css.
function GapBar({ bar, n, dup = false }: { bar: Bar; n: 1 | 2; dup?: boolean }) {
  // A bar that starts inside the overlap slides its label clear of it as it lands.
  const clearsClash = dup && bar.from >= CLASH[0] && bar.from < CLASH[1];
  const style = {
    left: `${pct(bar.from)}%`,
    width: `${pct(bar.to) - pct(bar.from)}%`,
    // Padding percentages resolve against the bar's own width, so express the clash width relative to it.
    ...(clearsClash ? { "--pad-x": `${((pct(CLASH[1]) - pct(CLASH[0])) / (pct(bar.to) - pct(bar.from))) * 100}%` } : {}),
  } as CSSProperties;

  return (
    <div className={`gap-bar gap-bar-${n}${dup ? " is-dup" : ""}`} style={style}>
      <span className="gap-bar-fill" />
      <span className="gap-bar-text"><WriteText name={bar.name} time={bar.time} /></span>
      {!dup && (
        <svg className="gap-outline" aria-hidden="true" focusable="false">
          <rect width="100%" height="100%" pathLength={1} />
        </svg>
      )}
    </div>
  );
}

// The unified grid: time axis, the three app rows and their vertical grid lines, plus the bars that draw in
// after the merge. Rendered once per pane (see GapSequence): the panes clip complementary halves of it, so
// side by side they read as one seamless copy.
function GapLanes() {
  const clashStyle = { left: `${pct(CLASH[0])}%`, width: `${pct(CLASH[1]) - pct(CLASH[0])}%` };
  return (
    <div className="lanes" role="img" aria-label="ShiftKey shows only the night shift, CareRev shows only the day shift, Phylax shows both and the overlap">
      <div className="lane-axis" aria-hidden="true">
        {axis.map((tick) => (
          <span key={tick.at} style={{ left: `${pct(tick.at)}%` }}>{tick.label}</span>
        ))}
      </div>

      <div className="lane">
        <div className="lane-label"><span>ShiftKey app</span></div>
        <div className="lane-track"><GapBar bar={nightShift} n={1} /></div>
      </div>

      <div className="lane">
        <div className="lane-label"><span>CareRev app</span></div>
        <div className="lane-track"><GapBar bar={dayShift} n={2} /></div>
      </div>

      <div className="lane">
        <div className="lane-label"><span>Phylax</span><span className="lane-flag gap-flag">OVERLAP · 6A–7A</span></div>
        <div className="lane-track">
          <GapBar bar={nightShift} n={1} dup />
          <GapBar bar={dayShift} n={2} dup />
          {/* Where the two duplicates cross, in the overlap colour. */}
          <div className="gap-tint" style={clashStyle} />
          {/* The overlap bar: outline first, then the marker hatch fills it, and only once that is complete do the
              stripes start moving (see useGapSequence: it flags the section's data-clash-filled). */}
          <div className="gap-clash" style={clashStyle}>
            <ClashHatch />
            <span className="gap-clash-fill" />
            <svg className="gap-outline" aria-hidden="true" focusable="false">
              <rect width="100%" height="100%" pathLength={1} />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * "The gap" section: a pinned illustration with "The gap" copy that rises over it like a curtain.
 *
 *   .gap-stage    the "One night, two apps" illustration, sticky and one viewport tall. It is the fixed
 *                 background canvas: it never moves once pinned.
 *   .gap-space    an empty spacer under the stage. It is the extra scroll distance the stage stays pinned
 *                 for the later sequence steps and the finished-diagram hold.
 *   .gap-curtain  `children` (the copy). A full-viewport panel in normal flow, stacked above the stage. Once the
 *                 spacer has scrolled by, it rises from the bottom edge and covers the stage completely. Native
 *                 scroll moves it, so it is a 1:1 scrub with nothing to snap.
 *
 * The illustration is a dark card whose time labels (6P, 12A, 6A, 12P), app names and vertical grid lines are
 * the static base of the scene. Only the internal grid content moves: it is cut at its exact midpoint — between
 * the 12A and 6A grid lines — into two clipped panes (`.gap-pane-left` holds everything from 6P through the 12A
 * line for all three app rows, `.gap-pane-right` the 6A line through 12P). The panes start far apart, edge to
 * edge and slightly enlarged (partly clipped by the viewport), and are bound to scroll from the moment the first
 * part of them enters the viewport: as it scrolls they slide together while shrinking back to their natural size.
 * They merge perfectly into the unified grid, centred in the card — and only then does the rest of the sequence
 * (bars, migration, overlap, captions) begin.
 */
export function GapSequence({ children }: { children: ReactNode }) {
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const spaceRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  useGapSequence(sectionRef, stageRef, spaceRef, lanesRef);

  return (
    <section id="the-gap" ref={sectionRef} className="gap-section">
      <div className="gap-stage" ref={stageRef}>
        <div className="gap-shift">
          <div className="visual visual-fill" role="img" aria-label="Each staffing app shows only its own shift; only Phylax shows both and the overlap.">
            <div className="gap-head">
              <span className="gap-title">One night, two apps</span>
              <span className="gap-title gap-title-sub">Example</span>
            </div>
            {/* Two complementary clips of the same grid. Apart they are the two separated halves; merged
                they overlap by a pixel at the seam and read as one unified grid. */}
            <div className="gap-lanes" ref={lanesRef}>
              <div className="gap-pane gap-pane-left"><GapLanes /></div>
              <div className="gap-pane gap-pane-right"><GapLanes /></div>
            </div>
            <div className="v-foot gap-note">Each app is right about its own shift. Neither knows about the other.</div>
          </div>
          <div className="image-note">EXAMPLE SCHEDULE</div>
        </div>
      </div>
      <div className="gap-space" ref={spaceRef} aria-hidden="true" />
      <div className="gap-curtain cream-section">{children}</div>
    </section>
  );
}
