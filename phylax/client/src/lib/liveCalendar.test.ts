import { describe, expect, it } from "vitest";
import { dayDigitsMarkup, localDay, msUntilNextLocalDay, stripSvgScripts, withCalendarDay } from "./liveCalendar";

const SVG =
  '<svg aria-label="Tear-off calendar"><g class="cal-date"><!--cal-date--><g transform="translate(37,47)"><use href="#cal-d1"/></g><!--/cal-date--></g>' +
  "<script><![CDATA[ run() ]]></script></svg>";

describe("liveCalendar", () => {
  it("strips scripts", () => {
    expect(stripSvgScripts(SVG)).not.toContain("<script");
  });

  it("draws one centred digit for single-digit days", () => {
    const out = dayDigitsMarkup(7);
    expect(out).toContain("#cal-d7");
    expect(out).toContain("translate(44,47)");
  });

  it("draws two digits side by side", () => {
    const out = dayDigitsMarkup(16);
    expect(out).toContain("translate(37,47)");
    expect(out).toContain("translate(51,47)");
    expect(out).toContain("#cal-d1");
    expect(out).toContain("#cal-d6");
  });

  it("replaces the static date and updates the label", () => {
    const out = withCalendarDay(SVG, 23);
    expect(out).not.toContain("translate(37,47)\"><use href=\"#cal-d1\"/></g><!--/");
    expect(out).toContain("#cal-d2");
    expect(out).toContain("#cal-d3");
    expect(out).toContain('aria-label="Tear-off calendar, day 23"');
  });

  it("uses the local day of month", () => {
    expect(localDay(new Date(2026, 9, 16, 23, 59))).toBe(16);
  });

  it("rolls over just after local midnight", () => {
    expect(msUntilNextLocalDay(new Date(2026, 9, 16, 23, 59, 0))).toBe(61_000);
    expect(msUntilNextLocalDay(new Date(2026, 9, 16, 0, 0, 0))).toBe(86_401_000);
  });
});
