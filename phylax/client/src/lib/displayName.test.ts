import { describe, expect, it } from "vitest";
import { DISPLAY_NAME_MAX, displayNameLength, normalizeDisplayName, validateDisplayName } from "./displayName";

describe("normalizeDisplayName", () => {
  it("trims the ends and collapses runs of whitespace", () => {
    expect(normalizeDisplayName("  Sam   Ortiz \t")).toBe("Sam Ortiz");
  });

  it("leaves a clean name alone", () => {
    expect(normalizeDisplayName("Sam")).toBe("Sam");
  });
});

describe("displayNameLength", () => {
  it("counts what the person sees, not code units", () => {
    expect(displayNameLength("Sam")).toBe(3);
    expect(displayNameLength("e\u0301")).toBe(1); // e + combining acute accent
    expect(displayNameLength("\u{1F469}\u{1F3FD}\u200D\u{1F4BB}")).toBe(1); // a woman technologist emoji, five code points
  });

  it("ignores the whitespace that normalising removes", () => {
    expect(displayNameLength("  a   b  ")).toBe(3);
  });
});

describe("validateDisplayName", () => {
  it("asks for a name when there is none", () => {
    expect(validateDisplayName("")).toMatch(/enter the name/i);
    expect(validateDisplayName("   \t ")).toMatch(/enter the name/i);
  });

  it("accepts a name up to the limit, padding or not", () => {
    expect(validateDisplayName("a".repeat(DISPLAY_NAME_MAX))).toBeUndefined();
    expect(validateDisplayName(`  ${"a".repeat(DISPLAY_NAME_MAX)}  `)).toBeUndefined();
  });

  it("says how to fix a name that is too long", () => {
    expect(validateDisplayName("a".repeat(DISPLAY_NAME_MAX + 1))).toBe(`Use ${DISPLAY_NAME_MAX} characters or fewer.`);
  });

  it("counts an emoji as one character at the limit", () => {
    expect(validateDisplayName("\u{1F469}\u{1F3FD}\u200D\u{1F4BB}".repeat(DISPLAY_NAME_MAX))).toBeUndefined();
  });
});
