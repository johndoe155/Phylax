import { describe, expect, it } from "vitest";
import { describeZone, formatClock, formatOffset, groupByRegion, parseOffsetQuery, pushRecent, sameZone, searchZones, zoneClock } from "./timezonePicker";

const ZONES = ["UTC", "Africa/Lagos", "Africa/Accra", "America/New_York", "America/Los_Angeles", "America/Argentina/Buenos_Aires", "Europe/London", "Europe/Paris", "Asia/Kolkata", "Asia/Kathmandu", "Asia/Tokyo", "Etc/GMT+5"];
const OFFSETS: Record<string, number> = { UTC: 0, "Africa/Lagos": 60, "Africa/Accra": 0, "America/New_York": -240, "America/Los_Angeles": -420, "America/Argentina/Buenos_Aires": -180, "Europe/London": 60, "Europe/Paris": 120, "Asia/Kolkata": 330, "Asia/Kathmandu": 345, "Asia/Tokyo": 540, "Etc/GMT+5": -300 };
const find = (q: string) => searchZones(ZONES, q, (z) => OFFSETS[z] ?? null);

describe("describeZone", () => {
  it("names a zone by its city and country", () => {
    expect(describeZone("America/Argentina/Buenos_Aires")).toMatchObject({ city: "Buenos Aires", place: "Argentina", region: "Americas" });
    expect(describeZone("Africa/Lagos")).toMatchObject({ city: "Lagos", place: "Nigeria", region: "Africa" });
  });
  it("reads Etc/GMT+5 the way people do: five hours behind", () => {
    expect(describeZone("Etc/GMT+5").city).toBe("UTC−05:00");
  });
});

describe("searchZones", () => {
  it("finds cities, countries and nicknames", () => {
    expect(find("lagos")[0]).toBe("Africa/Lagos");
    expect(find("nigeria")).toEqual(["Africa/Lagos"]);
    expect(find("new york")[0]).toBe("America/New_York");
    expect(find("mumbai")).toEqual(["Asia/Kolkata"]);
    expect(find("buenos")).toEqual(["America/Argentina/Buenos_Aires"]);
  });
  it("finds abbreviations in any case", () => {
    expect(find("EST")).toContain("America/New_York");
    expect(find("pst")).toContain("America/Los_Angeles");
    expect(find("WAT")).toContain("Africa/Lagos");
    expect(find("gmt")).toEqual(expect.arrayContaining(["Africa/Accra", "Europe/London"]));
  });
  it("finds offsets typed several ways", () => {
    expect(find("+01:00")).toEqual(["Africa/Lagos", "Europe/London"]);
    expect(find("-5")).toEqual(["Etc/GMT+5"]);
    expect(find("UTC+5:30")).toEqual(["Asia/Kolkata"]);
    expect(find("+5")).toEqual(["Asia/Kathmandu", "Asia/Kolkata"]);
  });
  it("forgives a typo and ignores accents", () => {
    expect(find("londn")).toContain("Europe/London");
    expect(find("pariss")).toContain("Europe/Paris");
  });
  it("returns nothing for nonsense and everything for an empty query", () => {
    expect(find("zzzzqq")).toEqual([]);
    expect(find("  ")).toEqual(ZONES);
  });
});

describe("parseOffsetQuery", () => {
  it("accepts offsets and rejects words", () => {
    expect(parseOffsetQuery("-5")).toEqual({ minutes: -300, exact: false });
    expect(parseOffsetQuery("+05:45")).toEqual({ minutes: 345, exact: true });
    expect(parseOffsetQuery("gmt+0530")).toEqual({ minutes: 330, exact: true });
    expect(parseOffsetQuery("+15")).toBeNull();
    expect(parseOffsetQuery("lagos")).toBeNull();
  });
});

describe("groupByRegion", () => {
  it("groups by continent, sorts by city, and puts fixed offsets last", () => {
    const groups = groupByRegion(ZONES);
    expect(groups.map((g) => g.label)).toEqual(["Africa", "Americas", "Asia", "Europe", "UTC & fixed offsets"]);
    expect(groups[0].zones).toEqual(["Africa/Accra", "Africa/Lagos"]);
  });
});

describe("clocks", () => {
  it("formats offsets and times", () => {
    expect(formatOffset(60)).toBe("UTC+01:00");
    expect(formatOffset(-330)).toBe("UTC−05:30");
    expect(formatClock(0, 5, true)).toBe("12:05 AM");
    expect(formatClock(13, 5, false)).toBe("13:05");
  });
  it("reads a zone's offset and time at a given instant", () => {
    const at = new Date("2026-01-15T12:00:00Z");
    expect(zoneClock("Asia/Kolkata", at)).toMatchObject({ offset: 330, time: "17:30" });
    expect(zoneClock("America/New_York", at)).toMatchObject({ offset: -300, time: "07:00" });
    expect(zoneClock("America/New_York", new Date("2026-07-15T12:00:00Z"))?.offset).toBe(-240);
    expect(zoneClock("Not/AZone", at)).toBeNull();
  });
});

describe("recents", () => {
  it("keeps the newest four without repeats", () => {
    expect(pushRecent(["a", "b", "c", "d"], "c")).toEqual(["c", "a", "b", "d"]);
    expect(pushRecent(["a", "b", "c", "d"], "e")).toEqual(["e", "a", "b", "c"]);
  });
  it("treats an old id and its current one as the same zone", () => {
    expect(sameZone("Asia/Calcutta", "Asia/Kolkata")).toBe(true);
  });
});
