import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useFooterShiftBars } from "@/hooks/useFooterShiftBars";
import { FOOTER_ART, FOOTER_BARS, FOOTER_GRID_X } from "@/lib/footerBackground";

/**
 * The footer's cream panel: a rounded rectangle with a small tab on the top edge and a wide tab on the bottom edge,
 * each joined to the body by a smooth S-curve (the shape in the design reference).
 *
 * CSS can't do this with a responsive width and a fixed corner radius (clip-path path() is pixel-only and
 * border-radius can't make the tabs), so the outline is an SVG path rebuilt in real pixels from the element's
 * measured size. The radii and tab depth therefore stay constant while the width and height change, and the edges
 * stay sharp at any size or zoom level. The tabs sit OUTSIDE the body rectangle, so they can never clip content.
 *
 * Background: the panel is painted with the artwork from `lib/footerBackground.ts` (the shapes of
 * `assets/footer-panel-bg.svg`), clipped to the same outline (tabs included). It is drawn inline, as a nested <svg> using
 * `preserveAspectRatio="slice"` (the same fit the old <image> had), NOT through an <image>: an <image> renders the file as
 * an isolated document that nothing on the page can reach, and the bars need to be animated (see useFooterShiftBars). The
 * artwork's colours come from `.footer-shape-art` in index.css, under names that cannot collide with the rest of the page.
 * A second, semi-transparent cream layer on top washes the artwork out (BACKGROUND_WASH).
 *
 * Layout contract: this element's box includes the tab depth above and below the body. `.footer-shape` in
 * index.css pads the content by those depths through the --tab-top / --tab-bottom custom properties, which this component keeps in sync.
 */

/** How strongly the cream wash covers the background SVG: 0 shows it at full strength, 1 hides it completely. */
const BACKGROUND_WASH = 0.6;

type Geometry = { path: string; tabTop: number; tabBottom: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function buildShape(w: number, h: number): Geometry {
  const compact = w < 640;
  const tabTop = compact ? 8 : 10; // how far the small top tab sticks out of the body
  const tabBottom = compact ? 14 : 22; // how far the wide bottom tab sticks out
  const r = compact ? 8 : 10; // outer corner radius
  const sTop = tabTop * 2.2; // horizontal run of each S-curve step on the top tab
  const sBottom = tabBottom * 2.2; // ...and on the bottom tab
  const cx = w / 2;

  // Overall (outer) widths of the two tabs, including their S-curves.
  const topTotal = clamp(w * 0.13, 110, 200);
  const bottomTotal = Math.min(w * 0.72, 1200, w - 2 * (r + 8));
  const topFlat = Math.max(topTotal - 2 * sTop, 24);
  const bottomFlat = Math.max(bottomTotal - 2 * sBottom, 24);

  const top = tabTop; // y of the body's top edge
  const bottom = h - tabBottom; // y of the body's bottom edge
  const kt1 = sTop * 0.55;
  const kt2 = sTop * 0.45;
  const kb1 = sBottom * 0.55;
  const kb2 = sBottom * 0.45;

  const t1 = cx - topFlat / 2 - sTop; // top tab: where the rise starts
  const t2 = cx - topFlat / 2; // top tab: left end of the flat
  const t3 = cx + topFlat / 2; // top tab: right end of the flat
  const t4 = cx + topFlat / 2 + sTop; // top tab: where the fall ends

  const b1 = cx + bottomFlat / 2 + sBottom; // bottom tab (drawn right to left)
  const b2 = cx + bottomFlat / 2;
  const b3 = cx - bottomFlat / 2;
  const b4 = cx - bottomFlat / 2 - sBottom;

  const f = (n: number) => +n.toFixed(2);
  const path = [
    `M${f(r)} ${f(top)}`,
    `H${f(t1)}`,
    `C${f(t1 + kt1)} ${f(top)} ${f(t2 - kt2)} 0 ${f(t2)} 0`,
    `H${f(t3)}`,
    `C${f(t3 + kt1)} 0 ${f(t4 - kt2)} ${f(top)} ${f(t4)} ${f(top)}`,
    `H${f(w - r)}`,
    `A${r} ${r} 0 0 1 ${f(w)} ${f(top + r)}`,
    `V${f(bottom - r)}`,
    `A${r} ${r} 0 0 1 ${f(w - r)} ${f(bottom)}`,
    `H${f(b1)}`,
    `C${f(b1 - kb1)} ${f(bottom)} ${f(b2 + kb2)} ${f(h)} ${f(b2)} ${f(h)}`,
    `H${f(b3)}`,
    `C${f(b3 - kb1)} ${f(h)} ${f(b4 + kb2)} ${f(bottom)} ${f(b4)} ${f(bottom)}`,
    `H${f(r)}`,
    `A${r} ${r} 0 0 1 0 ${f(bottom - r)}`,
    `V${f(top + r)}`,
    `A${r} ${r} 0 0 1 ${f(r)} ${f(top)}`,
    "Z",
  ].join("");

  return { path, tabTop, tabBottom };
}

/** `contentRef` exposes the cream content box (the rectangle the footer children sit in), e.g. as a drag boundary. */
export function FooterShape({
  className = "footer-shape",
  children,
  contentRef,
}: {
  className?: string;
  children: ReactNode;
  contentRef?: RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const clipId = useId().replace(/:/g, "");
  const [size, setSize] = useState({ w: 0, h: 0 });

  // Measure before paint so the shape is never seen unsized, then follow every later resize.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const geometry = size.w > 0 && size.h > 0 ? buildShape(size.w, size.h) : null;

  // The bars only exist once the panel has been measured, so the animation waits for the first sized render.
  useFooterShiftBars(ref, geometry !== null);

  return (
    <div
      ref={ref}
      className={className}
      style={geometry ? ({ "--tab-top": `${geometry.tabTop}px`, "--tab-bottom": `${geometry.tabBottom}px` } as CSSProperties) : undefined}
    >
      {geometry && (
        <svg
          className="footer-shape-bg"
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <clipPath id={clipId}>
              <path d={geometry.path} />
            </clipPath>
          </defs>
          <path d={geometry.path} />
          <g clipPath={`url(#${clipId})`}>
            <svg
              className="footer-shape-art"
              x={0}
              y={0}
              width={size.w}
              height={size.h}
              viewBox={`0 0 ${FOOTER_ART.width} ${FOOTER_ART.height}`}
              preserveAspectRatio="xMidYMid slice"
            >
              <rect className="footer-shape-art-bg" width={FOOTER_ART.width} height={FOOTER_ART.height} />
              {FOOTER_GRID_X.map((x) => (
                <line key={x} className="footer-shape-art-grid" x1={x} y1={0} x2={x} y2={FOOTER_ART.height} />
              ))}
              {/* The shift bars. useFooterShiftBars finds them by this class and moves them with a CSS transform, so
                  nothing here may set `transform` / `style` (React would fight the animation). */}
              {FOOTER_BARS.map((bar) => (
                <rect
                  key={`${bar.x}-${bar.y}`}
                  className={bar.accent ? "footer-shape-bar footer-shape-bar--accent" : "footer-shape-bar"}
                  x={bar.x}
                  y={bar.y}
                  width={bar.width}
                  height={bar.height}
                  fillOpacity={bar.opacity}
                />
              ))}
            </svg>
          </g>
          {/* Cream wash over the background image only (it sits below the content and the logo plate). */}
          <path d={geometry.path} fillOpacity={BACKGROUND_WASH} />
        </svg>
      )}
      <div ref={contentRef} className="footer-shape-content">{children}</div>
    </div>
  );
}
