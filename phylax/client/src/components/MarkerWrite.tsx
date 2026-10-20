import { useEffect, useId, useRef } from "react";
import type { ElementType, ReactNode } from "react";
import { MARKER_PHRASES } from "@/components/markerWriteData";

type Props = {
  /** Starts the writing. Until it is true nothing is drawn; once true it plays once and the writing stays. */
  active: boolean;
  /** "fast" is a flick (about a second); "slow" is a careful hand (a few seconds). The timings are WRITE_MS below. */
  speed: "fast" | "slow";
  className?: string;
  as?: ElementType;
  "aria-hidden"?: boolean | "true" | "false";
  /** The text to write. Only phrases that have pen strokes in markerWriteData.ts ("Shifts.", "Hi!!") are drawn stroke by stroke. */
  children: ReactNode;
};

/** Length of the whole write, in ms. The strokes' own timing (pen speed, lifts, travel between strokes) is baked into markerWriteData.ts as fractions of it. */
const WRITE_MS = { fast: 1200, slow: 3200 } as const;
/** A dot is a dab: the marker is pressed down and the ink blooms outwards. Never shorter than this, so it reads even in a fast write. */
const DAB_MIN_MS = 110;
const STROKE_MIN_MS = 50;
/** Where the viewBox starts above the baseline. With line-height: 1 the baseline sits 0.8em below the top of the line box (true for both the hhea and the typo metrics of Marker Hand). */
const ASCENT = 800;

/**
 * Marker Hand text that is WRITTEN with a marker, stroke by stroke, instead of faded or wiped in.
 *
 * - Each character is drawn from the font's real outline (so it is pixel-identical to the text set in Marker Hand, kerning included),
 *   shown through an SVG mask made of that character's PEN STROKES: the centre-lines of the glyph in the order and direction a hand
 *   writes it (a stem top to bottom, then the bar left to right; the dot of an "i" last).
 * - Every stroke is drawn along its path by animating stroke-dashoffset, with the pen speed of real handwriting (slower in tight
 *   curves, landing and lifting slowly), a round marker tip at the leading edge, and a pause plus travel time while the pen is in the
 *   air between strokes. Dots (".", the dot of "!") are dabs that bloom outwards from where the marker touched down.
 * - The strokes, outlines and timings are generated from the font by scripts/gen-marker-strokes.py into markerWriteData.ts.
 *
 * The element itself is left alone (position, tilt, colour all stay with the caller's className); the glyphs take its colour
 * (currentColor) and the SVG is sized in em, so it occupies exactly the box the text did (line-height: 1). The real text stays in the
 * DOM, visually hidden, for assistive technology. With reduced motion the writing is simply there.
 */
export function MarkerWrite({ active, speed, className, as: Tag = "span", children, ...rest }: Props) {
  const text = typeof children === "string" ? children : null;
  const phrase = text !== null ? MARKER_PHRASES[text] : undefined;
  const maskId = `mw-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const strokeEls = useRef<(SVGPathElement | null)[]>([]);

  useEffect(() => {
    if (!active || !phrase) return;
    const els = strokeEls.current;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const canAnimate = !reduced && typeof Element !== "undefined" && typeof Element.prototype.animate === "function";
    const total = WRITE_MS[speed];
    const running: Animation[] = [];

    const settle = (el: SVGPathElement, dab: boolean | undefined, w: number) => {
      el.style.opacity = "1";
      if (dab) el.style.strokeWidth = String(w);
      else el.style.strokeDashoffset = "0";
    };

    phrase.strokes.forEach((s, i) => {
      const el = els[i];
      if (!el) return;
      if (!canAnimate) return settle(el, s.dab, s.w);
      const delay = s.t * total;
      let anim: Animation;
      if (s.dab) {
        anim = el.animate(
          [{ opacity: 1, strokeWidth: `${s.w * 0.3}px` }, { opacity: 1, strokeWidth: `${s.w}px` }],
          { delay, duration: Math.max(s.dur * total, DAB_MIN_MS), easing: "cubic-bezier(.15,.85,.3,1)", fill: "forwards" },
        );
      } else {
        // The pen's speed profile: k[j] is the share of the stroke's time at which j/n of its length has been drawn.
        const k = s.k!;
        const n = k.length - 1;
        anim = el.animate(
          k.map((offset, j) => ({ offset, opacity: 1, strokeDashoffset: 1 - j / n, easing: "linear" })),
          { delay, duration: Math.max(s.dur * total, STROKE_MIN_MS), fill: "forwards" },
        );
      }
      // Once a stroke is done, hand its final look to the element itself and drop the animation.
      anim.onfinish = () => { settle(el, s.dab, s.w); anim.cancel(); };
      running.push(anim);
    });

    return () => running.forEach((a) => { a.onfinish = null; a.cancel(); });
  }, [active, phrase, speed]);

  const cls = ["marker-write", active ? "is-writing" : "", className].filter(Boolean).join(" ");

  // No pen strokes for this text: show it set in the font once active.
  if (!phrase) {
    return (
      <Tag className={cls} data-speed={speed} {...rest}>
        <span className="marker-write-plain">{children}</span>
      </Tag>
    );
  }

  return (
    <Tag className={cls} data-speed={speed} {...rest}>
      <span className="marker-write-sr">{children}</span>
      <svg
        className="marker-write-svg"
        viewBox={`0 ${-ASCENT} ${phrase.w} 1000`}
        style={{ width: `${phrase.w / 1000}em` }}
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x={-400} y={-1400} width={phrase.w + 800} height={2800}>
            {phrase.strokes.map((s, i) => (
              <path
                key={i}
                ref={(el) => { strokeEls.current[i] = el; }}
                d={s.d}
                fill="none"
                stroke="#fff"
                strokeLinecap="round"
                strokeLinejoin="round"
                // Hidden until its turn. A dash as long as the whole stroke, pushed one stroke-length off its start, is a stroke not yet drawn.
                {...(s.dab ? {} : { pathLength: 1, strokeDasharray: "1 1" })}
                style={s.dab ? { opacity: 0, strokeWidth: 0 } : { opacity: 0, strokeWidth: s.w, strokeDashoffset: 1 }}
              />
            ))}
          </mask>
        </defs>
        <path d={phrase.glyphs} fill="currentColor" fillRule="nonzero" mask={`url(#${maskId})`} />
      </svg>
    </Tag>
  );
}
