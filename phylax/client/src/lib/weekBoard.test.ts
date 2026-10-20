import { describe, expect, it } from "vitest";
import { inDays, type Issue, type Shift } from "./shifts";
import { fmtEta, fmtHours, laneCount, nowStatus, nowPosition, pageOf, pageTitle, piecesFor, placeLabels, rangeLabel, riskOf, summarize, totalsFor, windowDays, clashesFor, labelParts, kindOfShift, type Pair } from "./weekBoard";

const now = new Date(2026, 9, 18, 14, 41).getTime(); // Sun 18 Oct 2026, 2:41 PM
const day = (n: number) => inDays(n, now);
const shift = (over: Partial<Shift>): Shift => ({ id: "s", platform: "ShiftKey", facility: "Riverside Manor", label: "Night", date: day(-1), start: 19 * 60, end: 7 * 60, ...over });

describe("windowDays", () => {
  it("starts today and runs seven days, flagging today and weekends", () => {
    const d = windowDays(now, 0);
    expect(d).toHaveLength(7);
    expect(d[0]).toMatchObject({ date: "2026-10-18", today: true, weekend: true, past: false, weekday: "SUN" });
    expect(d[1]).toMatchObject({ date: "2026-10-19", today: false, weekend: false, weekday: "MON" });
    expect(d[6]).toMatchObject({ date: "2026-10-24", weekend: true });
  });
  it("pages by whole weeks, and earlier pages are in the past", () => {
    expect(windowDays(now, 1)[0].date).toBe("2026-10-25");
    const back = windowDays(now, -1);
    expect(back[0].date).toBe("2026-10-11");
    expect(back.every((d) => d.past)).toBe(true);
  });
  it("labels the range, across a month end too", () => {
    expect(rangeLabel(windowDays(now, 0))).toBe("Oct 18 – 24");
    expect(rangeLabel(windowDays(now, 1))).toBe("Oct 25 – 31");
    expect(rangeLabel(windowDays(now, 2))).toBe("Nov 1 – 7");
    expect(rangeLabel(windowDays(new Date(2026, 9, 28, 9).getTime(), 0))).toBe("Oct 28 – Nov 3");
  });
  it("titles the pages", () => {
    expect([0, 1, -1, 3, -2].map(pageTitle)).toEqual(["Next 7 days", "Following week", "Previous week", "In 3 weeks", "2 weeks ago"]);
  });
  it("finds the page a moment is on", () => {
    expect(pageOf(now, now)).toBe(0);
    expect(pageOf(new Date(2026, 9, 24, 23).getTime(), now)).toBe(0);
    expect(pageOf(new Date(2026, 9, 25, 1).getTime(), now)).toBe(1);
    expect(pageOf(new Date(2026, 9, 17, 12).getTime(), now)).toBe(-1);
  });
});

describe("piecesFor", () => {
  const days = windowDays(now, 0);
  it("carries an overnight shift into today as a piece that started yesterday", () => {
    const [p] = piecesFor(days[0], [shift({})], now);
    expect(p.startsBefore).toBe(true);
    expect(p.endsAfter).toBe(false);
    expect(p.left).toBe(0);
    expect(p.width).toBeCloseTo(7 / 24, 5);
    expect(p.minutes).toBe(7 * 60);
  });
  it("splits an overnight shift at midnight: its first half starts on one day and runs off the end of it", () => {
    const s = shift({ date: day(0) });
    const [p] = piecesFor(days[0], [s], now);
    expect(p.startsBefore).toBe(false);
    expect(p.endsAfter).toBe(true);
    expect(p.left).toBeCloseTo(19 / 24, 5);
    expect(p.minutes).toBe(5 * 60);
    const [q] = piecesFor(days[1], [s], now);
    expect(q.startsBefore).toBe(true);
    expect(q.minutes).toBe(7 * 60);
  });
  it("marks live, upcoming and finished, and how far through a live piece is", () => {
    const live = shift({ id: "a", date: day(0), start: 7 * 60, end: 19 * 60 });
    const done = shift({ id: "b", date: day(0), start: 1 * 60, end: 5 * 60 });
    const next = shift({ id: "c", date: day(0), start: 20 * 60, end: 23 * 60 });
    const ps = piecesFor(days[0], [live, done, next], now);
    expect(ps.map((p) => [p.shift.id, p.state])).toEqual([["b", "done"], ["a", "live"], ["c", "upcoming"]]);
    expect(ps[1].elapsed).toBeCloseTo((14 * 60 + 41 - 7 * 60) / (12 * 60), 4);
    expect(ps[0].elapsed).toBe(1);
    expect(ps[2].elapsed).toBe(0);
  });
  it("gives overlapping pieces their own lanes and lets back-to-back ones share one", () => {
    const a = shift({ id: "a", date: day(1), start: 6 * 60, end: 14 * 60 });
    const b = shift({ id: "b", date: day(1), start: 13 * 60, end: 20 * 60 });
    const c = shift({ id: "c", date: day(1), start: 14 * 60, end: 18 * 60 });
    const ps = piecesFor(days[1], [a, b, c], now);
    expect(Object.fromEntries(ps.map((p) => [p.shift.id, p.lane]))).toEqual({ a: 0, b: 1, c: 0 });
    expect(laneCount(ps)).toBe(2);
    expect(laneCount([])).toBe(1);
  });
  it("ignores shifts on other days", () => {
    expect(piecesFor(days[3], [shift({ date: day(1) })], now)).toEqual([]);
  });
});

describe("clashesFor", () => {
  it("clips an overlap to the day", () => {
    const days = windowDays(now, 0);
    const lo = new Date(2026, 9, 18, 23).getTime(), hi = new Date(2026, 9, 19, 2).getTime();
    expect(clashesFor(days[0], [[lo, hi]])[0]).toMatchObject({ minutes: 60 });
    expect(clashesFor(days[1], [[lo, hi]])[0]).toMatchObject({ left: 0, minutes: 120 });
    expect(clashesFor(days[2], [[lo, hi]])).toEqual([]);
  });
});

describe("totals", () => {
  it("counts only the hours inside the days shown, once", () => {
    const days = windowDays(now, 0);
    const shifts = [shift({ id: "a" }), shift({ id: "b", date: day(2), start: 7 * 60, end: 19 * 60 }), shift({ id: "c", date: day(6) })];
    const rows = days.map((d) => ({ pieces: piecesFor(d, shifts, now) }));
    const t = totalsFor(rows);
    expect(t.shifts).toBe(3);
    expect(t.minutes).toBe((7 + 12 + 5) * 60); // carried-in 7h, a 12h day, and the first 5h of a night that runs off the end
    expect(t.perDay).toEqual([7 * 60, 0, 12 * 60, 0, 0, 0, 5 * 60]);
  });
});

describe("nowStatus", () => {
  const morning = new Date(2026, 9, 18, 6, 15).getTime(); // Sun 18 Oct 2026, 6:15 AM, the night shift is still on
  it("reports the shift in progress and when it ends", () => {
    const s = nowStatus([shift({})], morning);
    expect(s.kind).toBe("live");
    if (s.kind === "live") { expect(s.endsIn).toBe(45 * 60e3); expect(s.end).toBe(new Date(2026, 9, 18, 7).getTime()); }
  });
  it("is not live once it has ended; the next one is the earliest to come", () => {
    const later = shift({ id: "later", date: day(3), start: 8 * 60, end: 16 * 60 });
    const sooner = shift({ id: "sooner", date: day(1), start: 8 * 60, end: 16 * 60 });
    const s = nowStatus([shift({}), later, sooner], now);
    expect(s.kind).toBe("next");
    if (s.kind === "next") { expect(s.shift.id).toBe("sooner"); expect(s.startsIn).toBe(new Date(2026, 9, 19, 8).getTime() - now); }
  });
  it("is idle when nothing is left", () => { expect(nowStatus([], now).kind).toBe("idle"); });
  it("places the now marker on today only", () => {
    const d = windowDays(now, 0);
    expect(nowPosition(d[0], now)).toBeCloseTo((14 * 60 + 41) / 1440, 5);
    expect(nowPosition(d[1], now)).toBeNull();
  });
});

describe("formatting", () => {
  it("writes hours and waits the way the board shows them", () => {
    expect([12 * 60, 8.5 * 60, 45, 90].map(fmtHours)).toEqual(["12h", "8h 30m", "45m", "1h 30m"]);
    expect([20e3, 40 * 60e3, 130 * 60e3, 3 * 864e5 + 4 * 36e5, 2 * 864e5].map(fmtEta)).toEqual(["under a minute", "40 min", "2h 10m", "3d 4h", "2d"]);
  });
  it("tags a shift that crosses midnight with the day it came from or goes to", () => {
    const s = shift({ date: day(-1) }); // started Sat
    expect(labelParts(s, { startsBefore: true, endsAfter: false })).toMatchObject({ name: "Riverside Manor", time: "7P–7A · 12h", from: "← SAT", to: "" });
    expect(labelParts(s, { startsBefore: false, endsAfter: true }).to).toBe("SUN →");
  });
  it("draws a shift by its hours, not its label", () => {
    expect(kindOfShift({ start: 7 * 60, end: 15 * 60 })).toBe("Day");
    expect(kindOfShift({ start: 19 * 60, end: 7 * 60 })).toBe("Night");
  });
});

describe("conflicts", () => {
  const a = shift({ id: "a", date: day(2), start: 6 * 60, end: 14 * 60 });
  const b = shift({ id: "b", facility: "St. Anne's", date: day(2), start: 13 * 60, end: 20 * 60 });
  const lo = new Date(2026, 9, 20, 13).getTime(), hi = new Date(2026, 9, 20, 14).getTime();
  const overlap: Pair = { a, issue: { kind: "overlap", other: b, minutes: 60, overlap: [lo, hi] } };
  const issueFor = (s: Shift, other: Shift): Issue[] => [{ kind: "overlap", other, minutes: 60, overlap: [lo, hi] }];

  it("riskOf puts an overlap ahead of a tight window", () => {
    expect(riskOf(undefined)).toBeNull();
    expect(riskOf([])).toBeNull();
    expect(riskOf([{ kind: "tight", other: b, minutes: 30 }, ...issueFor(a, b)])).toBe("overlap");
    expect(riskOf([{ kind: "tight", other: b, minutes: 30 }])).toBe("tight");
  });
  it("is ok with no pairs", () => {
    expect(summarize([], windowDays(now, 0))).toEqual({ state: "ok", count: 0, visible: 0, target: null });
  });
  it("points at the first overlap on screen, with the earlier-starting shift as the target", () => {
    const s = summarize([overlap], windowDays(now, 0));
    expect(s).toMatchObject({ state: "overlap", count: 1, visible: 1 });
    expect(s.target).toEqual({ shiftId: "a", time: lo });
    expect(pageOf(s.target!.time, now)).toBe(0);
  });
  it("still reports an overlap that is on another page, and where it is", () => {
    const s = summarize([overlap], windowDays(now, 1));
    expect(s).toMatchObject({ state: "overlap", count: 1, visible: 0 });
    expect(pageOf(s.target!.time, now)).toBe(0);
  });
  it("falls back to tight windows only when there is no overlap", () => {
    const tight: Pair = { a, issue: { kind: "tight", other: b, minutes: 20 } };
    expect(summarize([tight], windowDays(now, 0)).state).toBe("tight");
    expect(summarize([tight, overlap], windowDays(now, 0)).state).toBe("overlap");
  });
});

describe("placeLabels", () => {
  const W = 300;
  it("keeps a label inside a bar that is wide enough", () => {
    expect(placeLabels(W, [{ left: 40, width: 200, inside: 150, outside: 100 }])).toEqual([{ mode: "inside", max: null }]);
  });
  it("puts it to the right of a bar that is too small, when there is room", () => {
    expect(placeLabels(W, [{ left: 20, width: 50, inside: 150, outside: 100 }])[0]).toEqual({ mode: "right", max: null });
  });
  it("moves it to the left when the bar is against the right edge", () => {
    expect(placeLabels(W, [{ left: 250, width: 50, inside: 150, outside: 100 }])[0]).toEqual({ mode: "left", max: null });
  });
  it("shortens the label to the roomier side when neither side fits it whole", () => {
    const [p] = placeLabels(W, [{ left: 90, width: 60, inside: 200, outside: 160 }]);
    expect(p.mode).toBe("right");
    expect(p.max).toBe(W - (90 + 60 + 8));
  });
  it("never lets two labels collide: the second goes to the other side", () => {
    const r = placeLabels(W, [{ left: 100, width: 30, inside: 150, outside: 100 }, { left: 140, width: 30, inside: 150, outside: 100 }]);
    expect(r[0].mode).toBe("left");
    expect(r[1].mode).toBe("right");
  });
  it("clips inside the bar only when there is almost no room anywhere", () => {
    const [p] = placeLabels(100, [{ left: 40, width: 20, inside: 150, outside: 120 }]);
    expect(p).toEqual({ mode: "inside", max: 20 });
  });
  it("treats a neighbouring bar as an obstacle", () => {
    const r = placeLabels(W, [{ left: 10, width: 40, inside: 150, outside: 100 }, { left: 150, width: 100, inside: 90, outside: 60 }]);
    expect(r[0]).toEqual({ mode: "right", max: 150 - 8 - 58 }); // only 84px before the next bar, so the label is shortened to fit
    expect(r[1].mode).toBe("inside");
  });
});
