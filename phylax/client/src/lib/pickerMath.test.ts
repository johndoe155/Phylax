import { describe, expect, it } from "vitest";
import { addMonths, clockValue, from12, lengthBetween, minutesOf, monthGrid, parseDay, to12, yearPage } from "./pickerMath";

describe("pickerMath: dates", () => {
  it("parses and keeps local calendar days", () => {
    const d = parseDay("2026-10-16");
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 9, 16]);
  });
  it("clamps the day when a month is shorter", () => {
    expect(addMonths(parseDay("2026-01-31"), 1).getDate()).toBe(28);
    expect(addMonths(parseDay("2028-01-31"), 1).getDate()).toBe(29);
    expect(addMonths(parseDay("2026-12-15"), 1).getFullYear()).toBe(2027);
    expect(addMonths(parseDay("2026-01-15"), -1).getFullYear()).toBe(2025);
  });
  it("builds a fixed six-week, Sunday-first grid", () => {
    for (const [y, m] of [[2026, 1], [2026, 9], [2024, 1], [2026, 2]]) {
      const grid = monthGrid(y, m);
      expect(grid).toHaveLength(42);
      expect(grid[0].getDay()).toBe(0);
      expect(grid.filter((d) => d.getMonth() === m)).toHaveLength(new Date(y, m + 1, 0).getDate());
    }
  });
  it("pages years in blocks of twelve", () => {
    expect(yearPage(2026)).toBe(2016);
    expect(yearPage(2027)).toBe(2016);
    expect(yearPage(2028)).toBe(2028);
  });
});

describe("pickerMath: times", () => {
  it("round-trips every minute of the day through the 12-hour clock", () => {
    for (let m = 0; m < 1440; m++) expect(from12(to12(m))).toBe(m);
  });
  it("treats 12 AM as midnight and 12 PM as noon", () => {
    expect(from12({ hour: 12, minute: 0, pm: false })).toBe(0);
    expect(from12({ hour: 12, minute: 0, pm: true })).toBe(720);
    expect(to12(0)).toEqual({ hour: 12, minute: 0, pm: false });
    expect(to12(19 * 60 + 5)).toEqual({ hour: 7, minute: 5, pm: true });
  });
  it("reads and writes the HH:MM strings the form already stores", () => {
    expect(minutesOf("07:00")).toBe(420);
    expect(clockValue(420)).toBe("07:00");
    expect(clockValue(minutesOf("23:55") + 10)).toBe("00:05");
    expect(minutesOf("")).toBe(0);
  });
  it("measures a shift across midnight, and rejects equal times", () => {
    expect(lengthBetween(420, 1140)).toBe(720);
    expect(lengthBetween(1140, 420)).toBe(720);
    expect(lengthBetween(420, 420)).toBe(0);
  });
});
