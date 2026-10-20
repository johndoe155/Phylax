import { describe, expect, it } from "vitest";
import { EMPTY_CLIP, HIDDEN_CLIPS, WIPE, archDepth, shouldPlay, wipeClips, wipeEdges, wipeProgressAt } from "./shiftBoardWipe";

const W = 518;
const H = 440;
const depth = archDepth(W, H);

/** The polygon's points as [x, y] fractions of the box. */
const points = (poly: string) =>
  poly
    .slice("polygon(".length, -1)
    .split(", ")
    .map(pair => pair.split(" ").map(v => (v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v))) as [number, number]);
const area = (poly: string) => {
  const pts = points(poly);
  let sum = 0;
  pts.forEach(([x, y], i) => {
    const [nx, ny] = pts[(i + 1) % pts.length];
    sum += x * ny - nx * y;
  });
  return Math.abs(sum) / 2;
};
const clips = (p: number) => wipeClips(p, W, H)!;
const mid = (poly: string, pick: "top" | "bottom") => {
  // The panel polygon runs the top edge left to right, then the bottom edge right to left.
  const pts = points(poly);
  const half = pts.length / 2;
  const edge = pick === "top" ? pts.slice(0, half) : pts.slice(half).reverse();
  return { side: edge[0][1], middle: edge[Math.floor(edge.length / 2)][1] };
};

// A desktop card and a phone card, each in a viewport of its own shape.
const SHAPES = [
  { name: "desktop", w: 518, h: 440, vh: 900 },
  { name: "phone", w: 330, h: 430, vh: 750 },
  { name: "short landscape", w: 400, h: 240, vh: 360 },
];

describe("wipeProgressAt", () => {
  it("runs from 0 to 1 over the wipe's duration, then stays there", () => {
    expect(wipeProgressAt(0)).toBe(0);
    expect(wipeProgressAt(WIPE.durationMs / 2)).toBeCloseTo(0.5, 10);
    expect(wipeProgressAt(WIPE.durationMs)).toBe(1);
    expect(wipeProgressAt(WIPE.durationMs * 5)).toBe(1);
    expect(wipeProgressAt(-50)).toBe(0);
  });

  it("is a short animation", () => {
    expect(WIPE.durationMs).toBeGreaterThanOrEqual(800);
    expect(WIPE.durationMs).toBeLessThanOrEqual(2500);
  });
});

describe("shouldPlay", () => {
  const VW = 1280;
  const VH = 900;
  const at = (top: number, left = 100, w = W, h = H) => ({ top, left, width: w, height: h });

  it("waits while the board is below the fold or only just peeking in", () => {
    expect(shouldPlay(at(VH), VW, VH)).toBe(false);
    expect(shouldPlay(at(VH - 0.5 * H), VW, VH)).toBe(false);
    expect(shouldPlay(at(VH - 0.85 * H), VW, VH)).toBe(false);
  });

  it("starts once nearly all of the board is on screen", () => {
    expect(shouldPlay(at(VH - 0.95 * H), VW, VH)).toBe(true);
    expect(shouldPlay(at(VH - H), VW, VH)).toBe(true);
    expect(shouldPlay(at(200), VW, VH)).toBe(true);
  });

  it("also starts when the board is reached from above", () => {
    expect(shouldPlay(at(-0.05 * H), VW, VH)).toBe(true);
    expect(shouldPlay(at(-0.5 * H), VW, VH)).toBe(false);
    expect(shouldPlay(at(-H), VW, VH)).toBe(false);
  });

  it("needs the board to be on screen sideways too (a card in a horizontal rail)", () => {
    expect(shouldPlay(at(200, VW - 100), VW, VH)).toBe(false);
    expect(shouldPlay(at(200, -W + 60), VW, VH)).toBe(false);
    expect(shouldPlay(at(200, VW - W / 2 - 1), VW, VH)).toBe(true);
  });

  it("copes with a board taller than the viewport and with a box that has no size", () => {
    expect(shouldPlay(at(0, 100, 400, 1200), VW, VH)).toBe(true); // fills the viewport
    expect(shouldPlay(at(300, 100, 400, 1200), VW, VH)).toBe(false);
    expect(shouldPlay(at(0, 0, 0, 0), VW, VH)).toBe(false);
  });
});

describe("wipeClips: initial state", () => {
  it("has a pre-start state that needs no size and shows nothing", () => {
    expect(HIDDEN_CLIPS.board).toBe(EMPTY_CLIP);
    expect(area(HIDDEN_CLIPS.panel)).toBe(0);
  });

  it("hides the board completely and paints no panel", () => {
    const c = clips(0);
    expect(c.board).toBe(EMPTY_CLIP);
    expect(area(c.panel)).toBe(0);
  });

  it("keeps the board hidden for the whole of phase 1", () => {
    for (let p = 0; p < WIPE.phase1; p += 0.01) expect(clips(p).board).toBe(EMPTY_CLIP);
  });
});

describe("wipeClips: phase 1, covering", () => {
  it("grows from a hairline, then continuously, to cover the whole board", () => {
    const early = area(clips(0.01).panel);
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(0.002); // a hairline
    let last = 0;
    for (let p = 0.01; p <= WIPE.phase1; p += 0.01) {
      const a = area(clips(p).panel);
      expect(a).toBeGreaterThan(last);
      last = a;
    }
    expect(area(clips(WIPE.phase1).panel)).toBeCloseTo(1, 3);
  });

  it("has an arch that bulges downward and grows with the distance travelled", () => {
    const a = mid(clips(0.2).panel, "bottom");
    const b = mid(clips(0.35).panel, "bottom");
    expect(a.middle).toBeGreaterThan(a.side); // the middle leads, lower on the board than the sides
    expect(b.middle - b.side).toBeGreaterThan(a.middle - a.side);
  });

  it("is gentle", () => {
    for (const { w, h } of SHAPES) {
      expect(archDepth(w, h) * h).toBeLessThanOrEqual(0.08 * w + 1e-9); // px of rise: a small share of the width
      expect(archDepth(w, h)).toBeLessThanOrEqual(0.08);
    }
  });

  it("brings the middle to the bottom first, then lets the sides catch up and stays there", () => {
    const grown = wipeEdges(WIPE.phase1 * WIPE.grow, depth);
    expect(grown.bottomBase).toBeCloseTo(1, 10);
    expect(grown.bottomArch).toBeCloseTo(depth, 10);
    let last = grown.bottomArch;
    for (let p = WIPE.phase1 * WIPE.grow; p <= WIPE.phase1; p += 0.005) {
      const e = wipeEdges(p, depth);
      expect(e.bottomBase).toBe(1);
      expect(e.bottomArch).toBeLessThanOrEqual(last);
      last = e.bottomArch;
    }
    expect(wipeEdges(WIPE.phase1, depth).bottomArch).toBeCloseTo(0, 10);
  });
});

describe("wipeClips: phase 2, uncovering", () => {
  it("keeps the bottom edge fixed and flat on the board's bottom", () => {
    for (let p = WIPE.phase1; p < 1; p += 0.02) {
      const { side, middle } = mid(clips(p).panel, "bottom");
      expect(side).toBeCloseTo(1, 6);
      expect(middle).toBeCloseTo(1, 6);
    }
  });

  it("moves the top edge down only, uncovering the board top to bottom", () => {
    let lastSide = -1;
    let lastBoard = -1;
    for (let p = WIPE.phase1; p < 1; p += 0.01) {
      const c = clips(p);
      const { side } = mid(c.panel, "top");
      expect(side).toBeGreaterThanOrEqual(lastSide);
      lastSide = side;
      const revealed = area(c.board);
      expect(revealed).toBeGreaterThanOrEqual(lastBoard);
      lastBoard = revealed;
    }
  });

  it("bulges upward in the middle, then flattens as it goes", () => {
    const early = mid(clips(0.6).panel, "top");
    const late = mid(clips(0.85).panel, "top");
    expect(early.middle).toBeLessThan(early.side);
    expect(early.side - early.middle).toBeGreaterThan(late.side - late.middle);
    expect(late.side - late.middle).toBeGreaterThanOrEqual(0);
  });

  it("ends as a thin flat strip that narrows to nothing", () => {
    const strip = clips(0.99);
    const { side, middle } = mid(strip.panel, "top");
    expect(1 - side).toBeLessThan(0.01);
    expect(side - middle).toBeLessThan(0.002); // flat
    expect(area(strip.panel)).toBeGreaterThan(0);
    expect(wipeClips(1, W, H)).toBeNull();
  });

  it("never lets the panel's seam overlap outlive the strip", () => {
    const { panel } = clips(0.9999);
    expect(area(panel)).toBeLessThan(1e-4);
  });
});

describe("wipeClips: robustness", () => {
  it("clips nothing when the box has no size", () => {
    expect(wipeClips(0.5, 0, 0)).toBeNull();
  });

  it("scales the arch with the card's width, capped by its height", () => {
    expect(archDepth(330, 600)).toBeCloseTo(WIPE.archOfWidth * (330 / 600), 10);
    expect(archDepth(1000, 200)).toBe(WIPE.archMaxOfHeight);
  });
});
