import { describe, expect, it } from "vitest";
import { DISPLAY_NAME_MAX } from "./displayName";
import { NAME_SIZE_MAX, NAME_SIZE_MIN, nameSizeEm, possessiveName } from "./dashboardName";

describe("possessiveName", () => {
  it("adds 's to the name", () => {
    expect(possessiveName("Sam")).toBe("Sam's");
  });

  it("adds 's after a name that ends in s too", () => {
    expect(possessiveName("James")).toBe("James's");
  });

  it("tidies the name the way the account page does", () => {
    expect(possessiveName("  Sam   Ortiz ")).toBe("Sam Ortiz's");
  });

  it("has nothing to show without a name", () => {
    expect(possessiveName(undefined)).toBeUndefined();
    expect(possessiveName(null)).toBeUndefined();
    expect(possessiveName("")).toBeUndefined();
    expect(possessiveName("   ")).toBeUndefined();
    expect(possessiveName(42 as unknown as string)).toBeUndefined();
  });
});

describe("nameSizeEm", () => {
  it("never goes above the maximum, however short the name", () => {
    expect(nameSizeEm("A's")).toBe(NAME_SIZE_MAX);
    expect(nameSizeEm("Al's")).toBe(NAME_SIZE_MAX);
    expect(nameSizeEm("")).toBe(NAME_SIZE_MAX);
  });

  it("never goes below the minimum, even for the longest name the account page accepts", () => {
    expect(nameSizeEm(possessiveName("a".repeat(DISPLAY_NAME_MAX))!)).toBe(NAME_SIZE_MIN);
    expect(nameSizeEm("a".repeat(500))).toBe(NAME_SIZE_MIN);
  });

  it("shrinks as the name gets longer", () => {
    const sizes = ["Sam's", "Daniel's", "Alexandra's", "Maximilian's"].map(nameSizeEm);
    expect(sizes[0]).toBeGreaterThan(sizes[1]);
    expect(sizes[1]).toBeGreaterThan(sizes[2]);
    expect(sizes[2]).toBeGreaterThan(sizes[3]);
    sizes.forEach((s) => { expect(s).toBeGreaterThanOrEqual(NAME_SIZE_MIN); expect(s).toBeLessThanOrEqual(NAME_SIZE_MAX); });
  });

  it("is a size between the limits for a typical name", () => {
    expect(nameSizeEm("Sam's")).toBe(NAME_SIZE_MAX); // 8.5 / 5 is above the maximum
    expect(nameSizeEm("Alexandra's")).toBeCloseTo(0.773, 3);
  });

  it("counts what the person sees, so an emoji or an accent is one character", () => {
    expect(nameSizeEm("e\u0301e\u0301e\u0301's")).toBe(nameSizeEm("eee's"));
  });
});
