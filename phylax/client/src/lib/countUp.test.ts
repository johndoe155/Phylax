import { describe, expect, it } from "vitest";
import { COUNT_UP_MS, countAt, countTarget, easeOutCubic, easeOutExpo } from "./countUp";

describe("countUp: timing", () => {
  it("runs between 1.2 and 1.8 seconds", () => {
    expect(COUNT_UP_MS).toBeGreaterThanOrEqual(1200);
    expect(COUNT_UP_MS).toBeLessThanOrEqual(1800);
  });
});

describe("countUp: easing", () => {
  for (const [name, ease] of [["easeOutExpo", easeOutExpo], ["easeOutCubic", easeOutCubic]] as const) {
    it(`${name} starts at 0, ends at exactly 1, and only ever rises`, () => {
      expect(ease(0)).toBe(0);
      expect(ease(1)).toBe(1);
      let last = -1;
      for (let i = 0; i <= 100; i++) { const v = ease(i / 100); expect(v).toBeGreaterThanOrEqual(last); last = v; }
    });
    it(`${name} is fast first and gentle last (most of the way by the half)`, () => {
      expect(ease(0.5)).toBeGreaterThan(0.85);
      expect(ease(0.1) - ease(0)).toBeGreaterThan(ease(1) - ease(0.9));
    });
    it(`${name} clamps out-of-range input`, () => {
      expect(ease(-3)).toBe(0);
      expect(ease(7)).toBe(1);
    });
  }
});

describe("countUp: countTarget", () => {
  it("rounds, floors at 0 and survives bad input", () => {
    expect(countTarget(36)).toBe(36);
    expect(countTarget(35.6)).toBe(36);
    expect(countTarget(-4)).toBe(0);
    expect(countTarget(NaN)).toBe(0);
    expect(countTarget(Infinity)).toBe(0);
  });
});

describe("countUp: countAt", () => {
  it("goes from the start value to exactly the target", () => {
    expect(countAt(0, 36, 0)).toBe(0);
    expect(countAt(0, 36, 1)).toBe(36);
    expect(countAt(0, 36, 1.4)).toBe(36);
  });
  it("only ever shows whole numbers, never above the target, never going backwards", () => {
    let last = 0;
    for (let i = 0; i <= 200; i++) {
      const n = countAt(0, 36, i / 200);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeLessThanOrEqual(36);
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
  });
  it("lets a small number take several visible steps (0, 1, 2, 3) rather than jumping", () => {
    const seen = new Set<number>();
    for (let i = 0; i <= 90; i++) seen.add(countAt(0, 3, i / 90));
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });
  it("re-aims from the number on screen", () => {
    expect(countAt(10, 20, 0)).toBe(10);
    expect(countAt(10, 20, 1)).toBe(20);
  });
  it("shows the target at once when there is nothing to count", () => {
    expect(countAt(0, 0, 0.3)).toBe(0);
    expect(countAt(5, 5, 0.3)).toBe(5);
  });
  it("treats a NaN progress as finished", () => {
    expect(countAt(0, 9, NaN)).toBe(9);
  });
});
