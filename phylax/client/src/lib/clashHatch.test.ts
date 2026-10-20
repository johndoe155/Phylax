import { describe, expect, it } from "vitest";
import { HATCH_BAND, HATCH_INK_WIDTH, HATCH_MARK_WIDTH, HATCH_PITCH, buildHatchPath, hatchPoints } from "./clashHatch";

/** Distance from (px, py) to the segment a-b. */
function distanceToSegment(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function distanceToPath(px: number, py: number, pts: { x: number; y: number }[]) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distanceToSegment(px, py, pts[i - 1], pts[i]));
  return best;
}

/** The CSS gradient the box settles into (`.gap-clash-fill`): blue where (x + y) mod 12 is in [6, 12). */
const isBlueInStripeTile = (x: number, y: number) => (((x + y) % HATCH_PITCH) + HATCH_PITCH) % HATCH_PITCH >= HATCH_BAND;

const SIZES: [number, number][] = [[24, 44], [31.5, 46], [60, 30], [9, 9], [120.4, 52.7]];

describe("hatchPoints", () => {
  it("is empty for a box with no area", () => {
    expect(hatchPoints(0, 40)).toEqual([]);
    expect(hatchPoints(40, 0)).toEqual([]);
    expect(buildHatchPath(0, 0)).toBe("");
  });

  it("is one unbroken stroke: an M followed only by L segments", () => {
    const d = buildHatchPath(24, 44);
    expect(d.startsWith("M")).toBe(true);
    expect(d.slice(1)).not.toMatch(/M/);
  });

  it("zigzags: neighbouring diagonals run in opposite directions and the turns stay outside the box", () => {
    for (const [w, h] of SIZES) {
      const pts = hatchPoints(w, h);
      expect(pts.length % 2).toBe(0);
      for (let i = 0; i + 1 < pts.length; i += 2) {
        // Every line is a "/" diagonal: x + y is constant along it.
        expect(pts[i].x + pts[i].y).toBeCloseTo(pts[i + 1].x + pts[i + 1].y, 6);
      }
      const dirs: number[] = [];
      for (let i = 0; i + 1 < pts.length; i += 2) dirs.push(Math.sign(pts[i + 1].x - pts[i].x));
      for (let i = 1; i < dirs.length; i++) expect(dirs[i]).toBe(-dirs[i - 1]);
      // The turns (end of one line to the start of the next) happen outside the box: even with the ink stroke's
      // half-width they never reach back into it, so the pen is only ever seen travelling along the diagonals.
      for (let i = 1; i + 1 < pts.length; i += 2) {
        for (let s = 0; s <= 1; s += 0.05) {
          const x = pts[i].x + s * (pts[i + 1].x - pts[i].x);
          const y = pts[i].y + s * (pts[i + 1].y - pts[i].y);
          const outside = Math.hypot(Math.max(0, -x, x - w), Math.max(0, -y, y - h));
          expect(outside).toBeGreaterThan(HATCH_INK_WIDTH / 2);
        }
      }
    }
  });
});

describe("hatch coverage", () => {
  it("the ink stroke covers every pixel of the box, so the drawn box is as solid as the finished one", () => {
    for (const [w, h] of SIZES) {
      const pts = hatchPoints(w, h);
      for (let x = 0.25; x < w; x += 0.5) {
        for (let y = 0.25; y < h; y += 0.5) {
          expect(distanceToPath(x, y, pts)).toBeLessThanOrEqual(HATCH_INK_WIDTH / 2 + 1e-6);
        }
      }
    }
  });

  it("the blue stroke lands exactly on the blue stripes of the striped tile it hands over to", () => {
    for (const [w, h] of SIZES) {
      const pts = hatchPoints(w, h);
      let checked = 0;
      for (let x = 0.25; x < w; x += 0.5) {
        for (let y = 0.25; y < h; y += 0.5) {
          const phase = (((x + y) % HATCH_PITCH) + HATCH_PITCH) % HATCH_PITCH;
          // Skip the anti-aliased seams between stripes (within 0.15 of an edge in x + y).
          if (Math.abs(phase - HATCH_BAND) < 0.3 || phase < 0.3 || phase > HATCH_PITCH - 0.3) continue;
          const covered = distanceToPath(x, y, pts) <= HATCH_MARK_WIDTH / 2;
          expect(covered).toBe(isBlueInStripeTile(x, y));
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
    }
  });
});
