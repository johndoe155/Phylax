import { describe, expect, it } from "vitest";
import { DEFAULT_PATTERNS, inDays, kindOf, lengthOf, patternState, relDay, shiftType, type Shift } from "./shifts";

const now = new Date(2026, 9, 17, 10, 0).getTime(); // Sat 17 Oct 2026, 10:00
const day = (n: number) => inDays(n, now);
const shift = (over: Partial<Shift>): Shift => ({ id: "s", platform: "ShiftKey", facility: "Riverside Manor", label: "Day", date: day(0), start: 7 * 60, end: 19 * 60, ...over });
const riverside = DEFAULT_PATTERNS[0]; // Riverside Manor, Day, 7A–7P

describe("kindOf", () => {
  it("names the default patterns the way the landing page does", () => {
    const names = DEFAULT_PATTERNS.map((p) => kindOf(p.start, p.end));
    expect(names).toEqual(["Day", "Night", "Day", "Evening", "Early", "Short"]);
  });

  it("calls anything that runs past midnight a night", () => {
    expect(kindOf(22 * 60, 6 * 60)).toBe("Night");
    expect(kindOf(0, 0)).toBe("Night");
  });
});

describe("shiftType", () => {
  it("keeps a real label", () => expect(shiftType({ label: "8-hour day", start: 420, end: 900 })).toBe("8-hour day"));
  it("reads shifts saved as Custom from their times", () => expect(shiftType({ label: "Custom", start: 19 * 60, end: 7 * 60 })).toBe("Night"));
});

describe("lengthOf", () => {
  it("measures same-day and overnight shifts", () => {
    expect(lengthOf({ start: 7 * 60, end: 19 * 60 })).toBe(720);
    expect(lengthOf({ start: 19 * 60, end: 7 * 60 })).toBe(720);
    expect(lengthOf({ start: 6 * 60, end: 14 * 60 + 30 })).toBe(510);
  });
});

describe("patternState", () => {
  it("is live while a shift of the pattern is running", () => {
    const s = shift({});
    expect(patternState(riverside, [s], now)).toEqual({ kind: "live", shift: s });
  });

  it("is live after midnight for an overnight shift that started yesterday", () => {
    const night = DEFAULT_PATTERNS[1];
    const s = shift({ id: "n", label: "Night", date: day(-1), start: 19 * 60, end: 7 * 60 });
    expect(patternState(night, [s], new Date(2026, 9, 17, 3, 0).getTime()).kind).toBe("live");
    expect(patternState(night, [s], new Date(2026, 9, 17, 8, 0).getTime()).kind).toBe("idle");
  });

  it("points at the soonest upcoming shift", () => {
    const later = shift({ id: "b", date: day(3) }), sooner = shift({ id: "a", date: day(1) });
    expect(patternState(riverside, [later, sooner], now)).toEqual({ kind: "next", shift: sooner });
  });

  it("does not match a different facility or different hours", () => {
    expect(patternState(riverside, [shift({ facility: "Harbor View" })], now).kind).toBe("idle");
    expect(patternState(riverside, [shift({ start: 8 * 60 })], now).kind).toBe("idle");
  });

  it("matches facility names regardless of case and spacing", () => {
    expect(patternState(riverside, [shift({ facility: "  riverside manor " })], now).kind).toBe("live");
  });

  it("is idle with nothing logged", () => expect(patternState(riverside, [], now)).toEqual({ kind: "idle" }));
});

describe("relDay", () => {
  it("says today, tomorrow, then weekday and number", () => {
    expect(relDay(day(0), now)).toBe("Today");
    expect(relDay(day(1), now)).toBe("Tomorrow");
    expect(relDay(day(4), now)).toBe("Wed 21");
  });
});
