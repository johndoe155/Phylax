import { describe, expect, it } from "vitest";
import { FOOTER_ART, FOOTER_BARS } from "./footerBackground";
import { EDGE_TRAVEL, KEEP_INSIDE, MIN_TRAVEL, computeBarShift, easeToward, scrollProgress } from "./footerShift";

const CENTER = FOOTER_ART.width / 2;
const FULL = FOOTER_ART.width; // artwork fully visible (wide panel)

/** What `slice` shows of the artwork for a panel of this size, in artwork units. */
const visibleWidthFor = (panelW: number, panelH: number) => panelW / Math.max(panelW / FOOTER_ART.width, panelH / FOOTER_ART.height);

/** Where a bar's edges are at progress p, as fractions of the visible window (0..1 = on screen). */
function edgesAt(bar: { x: number; width: number }, travel: number, p: number, visible: number) {
  const windowLeft = CENTER - visible / 2;
  const left = (bar.x + p * travel - windowLeft) / visible;
  return { left, right: left + bar.width / visible };
}
const onScreen = (u: number) => u >= 0 && u <= 1;

describe("computeBarShift: direction and desktop behaviour", () => {
  it("classifies by the bar's left edge relative to the midpoint", () => {
    expect(computeBarShift(154, 691, CENTER, FULL).side).toBe("left");
    expect(computeBarShift(883, 499, CENTER, FULL).side).toBe("left"); // starts left of centre even though it ends right of it
    expect(computeBarShift(998, 730, CENTER, FULL).side).toBe("right");
    expect(computeBarShift(960, 400, CENTER, FULL).side).toBe("right"); // exactly on the midpoint
  });

  it("moves left-aligned bars right (+) and right-aligned bars left (-)", () => {
    expect(computeBarShift(154, 691, CENTER, FULL).travel).toBeGreaterThan(0);
    expect(computeBarShift(1344, 576, CENTER, FULL).travel).toBeLessThan(0);
  });

  it("on a full-width panel travels exactly (MIN + (EDGE - MIN) * distance from midpoint) of the width, as it always has", () => {
    for (const bar of FOOTER_BARS) {
      const depth = Math.abs(bar.x - CENTER) / CENTER;
      const expected = (MIN_TRAVEL + (EDGE_TRAVEL - MIN_TRAVEL) * depth) * FULL;
      expect(Math.abs(computeBarShift(bar.x, bar.width, CENTER, FULL).travel)).toBeCloseTo(expected, 8);
    }
  });

  it("is symmetric: bars whose left edges are equally far either side of the midpoint travel the same distance the other way", () => {
    const a = computeBarShift(CENTER - 400, 500, CENTER, FULL).travel;
    const b = computeBarShift(CENTER + 400, 500, CENTER, FULL).travel;
    expect(b).toBeCloseTo(-a, 8);
  });

  it("returns no travel (and no NaN) for a zero-width panel", () => {
    expect(computeBarShift(154, 691, CENTER, 0).travel).toBe(0);
  });
});

describe("computeBarShift: every bar visibly moves on every screen, which is what 'static bars' on phones was about", () => {
  // Phone portrait sizes (panels are tall: the whole footer content), a short and a tall one, tablets, laptop, wide desktop.
  const panels: [number, number][] = [
    [320, 900], [360, 1000], [390, 760], [390, 1000], [430, 1100], [768, 900], [1024, 800], [1440, 700], [2560, 800],
  ];

  for (const [w, h] of panels) {
    it(`${w}x${h}: each bar ends with an edge on screen, and that edge sweeps a meaningful share of the panel`, () => {
      const visible = visibleWidthFor(w, h);
      for (const bar of FOOTER_BARS) {
        const { travel } = computeBarShift(bar.x, bar.width, CENTER, visible);
        const end = edgesAt(bar, travel, 1, visible);
        // The bar may not end up covering the whole panel or sitting outside it: that is exactly "frozen".
        expect(onScreen(end.left) || onScreen(end.right)).toBe(true);
        // The sweep is the distance the visible edge covers while on screen: it is at least MIN_TRAVEL of the panel.
        const dir = Math.sign(travel);
        const covered = Math.abs(travel) / visible;
        expect(covered).toBeGreaterThanOrEqual(MIN_TRAVEL - 1e-9);
        // The leading edge moves towards the middle and the bar never travels the wrong way.
        expect(dir === (bar.x < CENTER ? 1 : -1)).toBe(true);
      }
    });

    it(`${w}x${h}: progress and position are linear, with no clamp part-way (position at p=.5 is half of p=1)`, () => {
      const visible = visibleWidthFor(w, h);
      for (const bar of FOOTER_BARS) {
        const { travel } = computeBarShift(bar.x, bar.width, CENTER, visible);
        const at = (p: number) => edgesAt(bar, travel, p, visible).left;
        const step = at(0.5) - at(0);
        expect(at(1) - at(0.5)).toBeCloseTo(step, 10);
        expect(at(0.25) - at(0)).toBeCloseTo(step / 2, 10);
      }
    });
  }

  it("a phone: a bar that covers the whole window, or lies outside it, is carried until an edge is on screen", () => {
    const visible = visibleWidthFor(390, 1000); // ~421 units of the artwork: 749..1171
    const covering = FOOTER_BARS.find((b) => b.x === 576)!; // 576..1190 covers the window
    const outside = FOOTER_BARS.find((b) => b.x === 38)!; // 38..576 is entirely off the left
    for (const bar of [covering, outside]) {
      const start = edgesAt(bar, 0, 0, visible);
      expect(onScreen(start.left) || onScreen(start.right)).toBe(false); // frozen/hidden at rest: that is the drawn artwork
      const { travel } = computeBarShift(bar.x, bar.width, CENTER, visible);
      const end = edgesAt(bar, travel, 1, visible);
      expect(onScreen(end.left) || onScreen(end.right)).toBe(true);
    }
  });

  it("the edge that is sweeping always ends inside KEEP_INSIDE of the panel (past it the bar would cover the panel and freeze again)", () => {
    for (const [w, h] of [[390, 1000], [390, 760], [768, 900], [1440, 700]] as const) {
      const visible = visibleWidthFor(w, h);
      for (const bar of FOOTER_BARS) {
        const { travel, side } = computeBarShift(bar.x, bar.width, CENTER, visible);
        const end = edgesAt(bar, travel, 1, visible);
        const edges = side === "left" ? [end.left, end.right] : [1 - end.right, 1 - end.left]; // [trailing, leading] towards the middle
        expect(edges.some((u) => u > 0 && u <= KEEP_INSIDE + 1e-9)).toBe(true);
      }
    }
  });
});

describe("scrollProgress", () => {
  // A page 3000 tall in a 800 viewport (max scroll 2200), the panel's top edge at 1500: the range runs 700 -> 2200.
  const p = (y: number, panelTop = 1500, vh = 800, max = 2200) => scrollProgress(y, panelTop, vh, max);

  it("is 0 until the panel's top edge enters the viewport, 1 at the very end of the page", () => {
    expect(p(0)).toBe(0);
    expect(p(700)).toBe(0);
    expect(p(2200)).toBe(1);
  });

  it("is a straight line in between, so every pixel of scroll in the range moves the bars", () => {
    expect(p(1450)).toBeCloseTo(0.5, 10);
    expect(p(1000) - p(900)).toBeCloseTo(p(2000) - p(1900), 10);
    for (let y = 750; y <= 2200; y += 50) expect(p(y)).toBeGreaterThan(p(y - 50)); // strictly rising across the whole range
  });

  it("is clamped to 0..1 (rubber-band overscroll on iOS goes past both ends)", () => {
    expect(p(-80)).toBe(0);
    expect(p(2290)).toBe(1);
  });

  it("follows a phone's address bar: the viewport grows by 90px and the page can scroll 90px less, and progress still ends at 1", () => {
    const before = p(2200, 1500, 800, 2200);
    const after = p(2110, 1500, 890, 2110); // bar hid: taller viewport, shorter max scroll, user is at the new end of the page
    expect(before).toBe(1);
    expect(after).toBe(1);
    // and never exceeds 1 or jumps backwards by much for the same physical spot
    expect(p(2000, 1500, 890, 2110)).toBeGreaterThan(0.9);
  });

  it("covers the whole footer, not just a short strip: the range is at least as long as the panel is tall", () => {
    // Footer at the bottom of the page: the panel is 1000 tall and the legal row below it 100. The range is (panel + 100) long.
    const vh = 700;
    const docHeight = 5000;
    const panelTop = 4000 - 0; // panel: 4000..5000, plus 100 of legal row => document height 5100
    const max = docHeight + 100 - vh;
    const start = panelTop - vh;
    expect(max - start).toBeGreaterThanOrEqual(1000);
    expect(scrollProgress(start + (max - start) / 2, panelTop, vh, max)).toBeCloseTo(0.5, 10);
  });

  it("leaves the artwork as drawn when there is nothing to scroll through", () => {
    expect(scrollProgress(0, 300, 900, 0)).toBe(0);
    expect(scrollProgress(0, 300, 900, -20)).toBe(0);
  });
});

describe("easeToward", () => {
  it("moves a frame-rate independent fraction of the gap", () => {
    const oneStep = easeToward(0, 1, 0.1, 0.2);
    let twoSteps = easeToward(0, 1, 0.05, 0.2);
    twoSteps = easeToward(twoSteps, 1, 0.05, 0.2);
    expect(oneStep).toBeCloseTo(twoSteps, 10);
  });

  it("snaps to the target when imperceptibly close, so the loop can stop, and never overshoots", () => {
    expect(easeToward(0.9996, 1, 1 / 60, 0.2)).toBe(1);
    let v = 0;
    for (let i = 0; i < 2000; i++) {
      v = easeToward(v, 1, 1 / 60, 0.18);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(v).toBe(1);
  });
});
