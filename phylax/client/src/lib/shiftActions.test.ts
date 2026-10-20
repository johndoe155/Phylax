import { describe, expect, it } from "vitest";
import type { Shift } from "./shifts";
import { icsFor, icsName, mapsUrl, swapText, telHref } from "./shiftActions";

const night: Shift = { id: "abc123", platform: "ShiftKey", facility: "St. Anne's, North", label: "Night", date: "2026-10-17", start: 19 * 60, end: 7 * 60, address: "12 Elm St; Unit 4", contact: "Dana 555-0142", notes: "Enter by the side door,\nask for Dana" };

describe("icsFor", () => {
  const ics = icsFor(night, new Date(Date.UTC(2026, 9, 16, 12, 0, 0)).getTime());
  const lines = ics.split("\r\n");
  it("is a single event that starts and ends at the wall-clock times, across midnight", () => {
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("DTSTART:20261017T190000");
    expect(lines).toContain("DTEND:20261018T070000");
    expect(lines).toContain("UID:abc123@phylax");
    expect(lines).toContain("DTSTAMP:20261016T120000Z");
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
  it("escapes commas, semicolons and line breaks, and folds long lines", () => {
    expect(lines).toContain("SUMMARY:St. Anne's\\, North (Night)");
    expect(lines).toContain("LOCATION:12 Elm St\\; Unit 4");
    expect(ics).toContain("\\n");
    expect(lines.every((l) => l.length <= 75)).toBe(true);
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain("Enter by the side door\\,\\nask for Dana");
  });
  it("reminds an hour ahead and leaves out a location it does not have", () => {
    expect(lines).toContain("TRIGGER:-PT60M");
    expect(icsFor({ ...night, address: undefined }).includes("LOCATION")).toBe(false);
  });
});

describe("icsName", () => {
  it("makes a file name from the facility and date", () => { expect(icsName(night)).toBe("st-anne-s-north-2026-10-17.ics"); });
});

describe("mapsUrl", () => {
  it("prefers the address, falls back to the facility, and has an Apple form", () => {
    expect(mapsUrl(night)).toBe("https://www.google.com/maps/dir/?api=1&destination=12%20Elm%20St%3B%20Unit%204");
    expect(mapsUrl({ facility: "Maple Court" })).toBe("https://www.google.com/maps/dir/?api=1&destination=Maple%20Court");
    expect(mapsUrl({ facility: "Maple Court", address: "  " }, true)).toBe("https://maps.apple.com/?daddr=Maple%20Court");
  });
});

describe("swapText", () => {
  it("asks for cover with the day and hours", () => {
    expect(swapText(night)).toBe("Looking for someone to cover my night shift at St. Anne's, North (ShiftKey) on Saturday, Oct 17, 7P–7A. Anyone free?");
  });
});

describe("telHref", () => {
  it("finds a phone number inside free text", () => {
    expect(telHref("Dana, charge nurse 555-0142")).toBe("tel:5550142");
    expect(telHref("(555) 010-4242 ext 3")).toBe("tel:5550104242");
    expect(telHref("+1 555 010 4242")).toBe("tel:+15550104242");
  });
  it("gives nothing for names, short numbers or nothing", () => {
    expect(telHref("Dana")).toBeNull();
    expect(telHref("ward 12")).toBeNull();
    expect(telHref(undefined)).toBeNull();
  });
});
