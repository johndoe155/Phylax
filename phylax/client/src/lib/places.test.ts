import { describe, expect, it } from "vitest";
import { rank, splitMatch, suggestAddresses, suggestFacilities } from "./places";
import type { Shift } from "./shifts";

let n = 0;
const log = (facility: string, date: string, address?: string): Shift => ({ id: `s${n++}`, platform: "ShiftKey", facility, label: "Day", date, start: 420, end: 1140, address });

const history: Shift[] = [
  log("Riverside Manor", "2026-09-01"),
  log("Riverside Manor", "2026-09-20", "12 Elm Street, Albany"),
  log("Riverside Manor", "2026-10-02", "12 Elm Street, Albany"),
  log("St. Anne's", "2026-10-05", "400 Grove Ave"),
  log("Harbor View", "2026-08-11", "1 Pier Road"),
  log("River Oaks Rehab", "2026-10-10"),
];

describe("rank and splitMatch", () => {
  it("orders prefix, word start, then inside", () => {
    expect(rank("Riverside Manor", "riv")).toBe(0);
    expect(rank("Old Riverside", "riv")).toBe(1);
    expect(rank("Deriving", "riv")).toBe(2);
    expect(rank("Harbor", "riv")).toBe(-1);
    expect(rank("Anything", "")).toBe(0);
  });

  it("splits around the first match, ignoring case", () => {
    expect(splitMatch("Riverside Manor", "SIDE")).toEqual(["River", "side", " Manor"]);
    expect(splitMatch("Harbor", "x")).toEqual(["Harbor", "", ""]);
    expect(splitMatch("Harbor", "")).toEqual(["Harbor", "", ""]);
  });
});

describe("suggestFacilities", () => {
  it("groups repeat visits and carries the most recent address", () => {
    const [hit] = suggestFacilities(history, "river");
    expect(hit).toMatchObject({ facility: "Riverside Manor", address: "12 Elm Street, Albany", uses: 3, last: "2026-10-02" });
  });

  it("puts the more used of two matches first", () => {
    expect(suggestFacilities(history, "river").map((h) => h.facility)).toEqual(["Riverside Manor", "River Oaks Rehab"]);
  });

  it("offers the most used places before anything is typed, capped", () => {
    expect(suggestFacilities(history, "", 2).map((h) => h.facility)).toEqual(["Riverside Manor", "River Oaks Rehab"]);
  });

  it("finds nothing for text that matches no past facility", () => expect(suggestFacilities(history, "zzz")).toEqual([]));
  it("finds nothing with no history", () => expect(suggestFacilities([], "")).toEqual([]));
});

describe("suggestAddresses", () => {
  it("only offers addresses that were actually logged", () => {
    expect(suggestAddresses(history, "").map((h) => h.address).sort()).toEqual(["1 Pier Road", "12 Elm Street, Albany", "400 Grove Ave"]);
  });

  it("matches inside the address", () => {
    expect(suggestAddresses(history, "grove")).toEqual([{ address: "400 Grove Ave", facility: "St. Anne's", uses: 1, last: "2026-10-05" }]);
  });

  it("lists the typed facility's own address first", () => {
    expect(suggestAddresses(history, "", "harbor view")[0].address).toBe("1 Pier Road");
  });
});
