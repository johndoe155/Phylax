/**
 * Logic behind the dashboard's seven-day shift board (components/week/ShiftWeek.tsx). Everything here is pure, so the
 * layout decisions (which bar sits in which lane, where a label goes when it does not fit) are tested without a browser.
 *
 * Vocabulary: a "day" is one row of the board, a "piece" is the part of one shift that falls inside that day (an overnight
 * shift is one shift but two pieces), and a "lane" is a sub-row, used only when two pieces of the same day overlap.
 */
import { kindOf, lengthOf, span, t, ymd, clockRange, minuteOfDay, type Issue, type Shift } from "./shifts";

export const DAY_MS = 864e5;
export const WEEK_DAYS = 7;

export const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const addDays = (ms: number, n: number) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
/** Whole calendar days from `from` to `to` (rounded, so a 23 or 25 hour day around a clock change still counts as one). */
export const daysBetween = (from: number, to: number) => Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);

// ---- Days ----
export type DayCell = {
  index: number; date: string; start: number; end: number;
  weekday: string; label: string; long: string;
  weekend: boolean; today: boolean; past: boolean;
};

const WD = (ms: number) => new Date(ms).toLocaleDateString("en-US", { weekday: "short" });
const MD = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** The seven days shown for a given page: page 0 starts today, page 1 a week later, page -1 a week earlier. */
export function windowDays(now: number, page: number, count = WEEK_DAYS): DayCell[] {
  const today = startOfDay(now);
  return Array.from({ length: count }, (_, i) => {
    const start = addDays(today, page * count + i);
    const end = addDays(start, 1);
    const dow = new Date(start).getDay();
    return {
      index: i, date: ymd(new Date(start)), start, end,
      weekday: WD(start).toUpperCase(), label: MD(start).toUpperCase(), long: `${WD(start)}, ${MD(start)}`,
      weekend: dow === 0 || dow === 6, today: start === today, past: end <= now,
    };
  });
}

/** "Oct 18 – 24", or "Oct 28 – Nov 3" when the week crosses a month. */
export function rangeLabel(days: DayCell[]): string {
  const a = new Date(days[0].start), b = new Date(days[days.length - 1].start);
  const first = MD(days[0].start), last = a.getMonth() === b.getMonth() ? String(b.getDate()) : MD(days[days.length - 1].start);
  return `${first} – ${last}`;
}

/** The small title over the board: "Next 7 days" now, then how far the person has paged. */
export function pageTitle(page: number): string {
  if (page === 0) return "Next 7 days";
  if (page === 1) return "Following week";
  if (page === -1) return "Previous week";
  return page > 0 ? `In ${page} weeks` : `${-page} weeks ago`;
}

// ---- Formatting ----
/** 12h, 8h 30m, 45m. */
export function fmtHours(min: number): string {
  const m = Math.round(min), h = Math.floor(m / 60), r = m % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}
/** How long until something: 40 min, 2h 10m, 3d 4h. */
export function fmtEta(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
/** "Sat 7:00 PM": a moment, in words a person would say. */
export function fmtMoment(ms: number): string {
  const d = new Date(ms);
  return `${WD(ms)} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}
export function fmtStamp(ms: number): string {
  const d = new Date(ms);
  return `${WD(ms)}, ${MD(ms)} · ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

// ---- The kind of shift, drawn three ways (fill, outline, texture) plus a glyph, so colour is never the only signal ----
export type Kind = "Day" | "Night" | "Early" | "Evening" | "Short";
export type Fill = "solid" | "outline" | "texture";
export const KIND_FILL: Record<Kind, Fill> = { Day: "solid", Early: "solid", Evening: "texture", Short: "texture", Night: "outline" };
export const KINDS: Kind[] = ["Day", "Early", "Evening", "Night", "Short"];
/** The look of a shift comes from its hours (not its label), so "8-hour day" and "Day" are drawn alike. */
export const kindOfShift = (s: Pick<Shift, "start" | "end">): Kind => kindOf(s.start, s.end) as Kind;

// ---- Pieces and lanes ----
export type Risk = "overlap" | "tight" | null;
export type Piece = {
  shift: Shift;
  left: number; width: number;      // fractions of the day, 0 to 1
  minutes: number;                   // how much of the shift falls in this day
  startsBefore: boolean; endsAfter: boolean;
  state: "done" | "live" | "upcoming";
  elapsed: number;                   // how much of this piece has already happened, 0 to 1
  lane: number;
};

/** The pieces of `shifts` that fall in `day`, side by side, with overlapping ones moved onto their own lane. */
export function piecesFor(day: Pick<DayCell, "start" | "end">, shifts: Shift[], now: number): Piece[] {
  const len = day.end - day.start;
  const out: Piece[] = [];
  for (const s of shifts) {
    const [a, b] = span(s);
    const f = Math.max(a, day.start), e = Math.min(b, day.end);
    if (e <= f) continue;
    const state = b <= now ? "done" : a <= now ? "live" : "upcoming";
    const elapsed = state === "done" ? 1 : state === "live" ? Math.min(1, Math.max(0, (now - f) / (e - f))) : 0;
    out.push({ shift: s, left: (f - day.start) / len, width: (e - f) / len, minutes: Math.round((e - f) / 60000), startsBefore: a < day.start, endsAfter: b > day.end, state, elapsed, lane: 0 });
  }
  out.sort((x, y) => x.left - y.left || y.width - x.width || x.shift.id.localeCompare(y.shift.id));
  const laneEnd: number[] = [];
  for (const p of out) {
    let lane = laneEnd.findIndex((end) => end <= p.left + 1e-9);
    if (lane < 0) { lane = laneEnd.length; laneEnd.push(0); }
    laneEnd[lane] = p.left + p.width;
    p.lane = lane;
  }
  return out;
}
export const laneCount = (pieces: Piece[]) => pieces.reduce((n, p) => Math.max(n, p.lane + 1), 1);

/** The worst thing wrong with a shift: an overlap beats a tight window. */
export function riskOf(issues: Issue[] | undefined): Risk {
  if (!issues?.length) return null;
  return issues.some((i) => i.kind === "overlap") ? "overlap" : "tight";
}

export type Clash = { left: number; width: number; minutes: number };
/** Where, within `day`, shifts overlap (`ranges` are [from, to] in ms). */
export function clashesFor(day: Pick<DayCell, "start" | "end">, ranges: [number, number][]): Clash[] {
  const len = day.end - day.start;
  const out: Clash[] = [];
  for (const [a, b] of ranges) {
    const f = Math.max(a, day.start), e = Math.min(b, day.end);
    if (e > f) out.push({ left: (f - day.start) / len, width: (e - f) / len, minutes: Math.round((e - f) / 60000) });
  }
  return out;
}

// ---- Totals ----
export type Totals = { minutes: number; shifts: number; perDay: number[] };
/** Hours that fall inside these days (an overnight shift is split at midnight, so consecutive weeks never count it twice). */
export function totalsFor(rows: { pieces: Piece[] }[]): Totals {
  const ids = new Set<string>();
  const perDay = rows.map((r) => r.pieces.reduce((n, p) => { ids.add(p.shift.id); return n + p.minutes; }, 0));
  return { minutes: perDay.reduce((a, b) => a + b, 0), shifts: ids.size, perDay };
}

// ---- Now ----
export type NowStatus =
  | { kind: "live"; shift: Shift; endsIn: number; end: number }
  | { kind: "next"; shift: Shift; startsIn: number; start: number }
  | { kind: "idle" };

/** What is in progress, or failing that what comes next and how long until it starts. */
export function nowStatus(shifts: Shift[], now: number): NowStatus {
  const live = shifts.filter((s) => { const [a, b] = span(s); return a <= now && now < b; }).sort((x, y) => span(x)[1] - span(y)[1])[0];
  if (live) { const end = span(live)[1]; return { kind: "live", shift: live, end, endsIn: end - now }; }
  const next = shifts.filter((s) => span(s)[0] > now).sort((x, y) => span(x)[0] - span(y)[0])[0];
  if (next) { const start = span(next)[0]; return { kind: "next", shift: next, start, startsIn: start - now }; }
  return { kind: "idle" };
}
/** Where "now" sits along a day, 0 to 1 (null when `now` is not inside it). */
export const nowPosition = (day: Pick<DayCell, "start" | "end">, now: number) => (now >= day.start && now < day.end ? (now - day.start) / (day.end - day.start) : null);
export const clockNow = (now: number) => t(minuteOfDay(now));

// ---- The status chip and its jump ----
export type Pair = { a: Shift; issue: Issue };
export type Summary = {
  state: "ok" | "tight" | "overlap";
  count: number;               // how many of that kind, anywhere
  visible: number;             // how many of them touch the days on screen
  target: { shiftId: string; time: number } | null; // where "jump" goes: the first one on screen, else the first one overall
};
const startOf = (p: Pair) => (p.issue.kind === "overlap" && p.issue.overlap ? p.issue.overlap[0] : Math.max(span(p.a)[0], span(p.issue.other)[0]));
const endOf = (p: Pair) => (p.issue.kind === "overlap" && p.issue.overlap ? p.issue.overlap[1] : Math.max(span(p.a)[1], span(p.issue.other)[1]));

export function summarize(pairs: Pair[], days: Pick<DayCell, "start" | "end">[]): Summary {
  const lo = days[0].start, hi = days[days.length - 1].end;
  const overlaps = pairs.filter((p) => p.issue.kind === "overlap");
  const tights = pairs.filter((p) => p.issue.kind === "tight");
  const list = overlaps.length ? overlaps : tights;
  if (!list.length) return { state: "ok", count: 0, visible: 0, target: null };
  const sorted = [...list].sort((x, y) => startOf(x) - startOf(y));
  const visible = sorted.filter((p) => startOf(p) < hi && endOf(p) > lo);
  const first = visible[0] ?? sorted[0];
  const a = span(first.a)[0] <= span(first.issue.other)[0] ? first.a : first.issue.other;
  return { state: overlaps.length ? "overlap" : "tight", count: list.length, visible: visible.length, target: { shiftId: a.id, time: startOf(first) } };
}
/** Which page (see `windowDays`) a moment falls on. */
export const pageOf = (time: number, now: number) => Math.floor(daysBetween(now, time) / WEEK_DAYS);

// ---- Labels ----
export const LABEL_GAP = 8;
export const MIN_CLIPPED = 64;
export type LabelBox = { left: number; width: number; inside: number; outside: number };
export type Placed = { mode: "inside" | "right" | "left"; max: number | null };

/**
 * Decides, for the bars of one lane (all numbers in px, measured along the track), where each label goes.
 * A label sits inside its bar when it fits, otherwise just outside it: to the right if there is room, else to the left.
 * Bars and the labels already placed count as obstacles, so two labels never collide. When neither side has room for the
 * whole label, the roomier side is used and the label is shortened (max); only if there is almost no room at all does it
 * stay inside and clip, and the shift's full details are still one tap (or hover) away.
 */
export function placeLabels(trackW: number, boxes: LabelBox[]): Placed[] {
  const out: Placed[] = new Array(boxes.length);
  const blocked: [number, number][] = boxes.map((b) => [b.left, b.left + b.width]);
  const order = boxes.map((_, i) => i).sort((i, j) => boxes[i].left - boxes[j].left);
  const freeRight = (from: number) => {
    let end = trackW;
    for (const [l, r] of blocked) { if (r <= from) continue; if (l <= from) return 0; end = Math.min(end, l - LABEL_GAP); }
    return Math.max(0, end - from);
  };
  const freeLeft = (to: number) => {
    let start = 0;
    for (const [l, r] of blocked) { if (l >= to) continue; if (r >= to) return 0; start = Math.max(start, r + LABEL_GAP); }
    return Math.max(0, to - start);
  };
  for (const i of order) {
    const b = boxes[i];
    if (b.width >= b.inside) { out[i] = { mode: "inside", max: null }; continue; }
    const from = b.left + b.width + LABEL_GAP, to = b.left - LABEL_GAP;
    const r = freeRight(from), l = freeLeft(to);
    let pick: Placed;
    if (r >= b.outside) pick = { mode: "right", max: null };
    else if (l >= b.outside) pick = { mode: "left", max: null };
    else if (Math.max(r, l) >= MIN_CLIPPED) pick = r >= l ? { mode: "right", max: r } : { mode: "left", max: l };
    else pick = { mode: "inside", max: Math.max(0, b.width) };
    out[i] = pick;
    if (pick.mode === "right") blocked.push([from, from + Math.min(b.outside, pick.max ?? b.outside)]);
    if (pick.mode === "left") blocked.push([to - Math.min(b.outside, pick.max ?? b.outside), to]);
  }
  return out;
}

// ---- Words for a shift (screen readers, tooltip) ----
export function describeShift(s: Shift, p: { state: Piece["state"] }, risks: Issue[] | undefined, now: number): string {
  const [a, b] = span(s);
  const parts = [
    `${s.facility}, ${s.platform}`,
    `${kindOfShift(s).toLowerCase()} shift`,
    `${fmtMoment(a)} to ${fmtMoment(b)}`,
    fmtHours(lengthOf(s)),
    p.state === "live" ? `in progress, ${fmtEta(b - now)} left` : p.state === "done" ? "finished" : `starts in ${fmtEta(a - now)}`,
  ];
  for (const i of risks ?? []) parts.push(i.kind === "overlap" ? `overlaps ${i.other.facility} by ${fmtHours(i.minutes)}` : `only ${fmtHours(i.minutes)} before ${i.other.facility}`);
  return parts.join(", ");
}

/** The two texts a bar can show: its name, and its hours with a tag when it crosses midnight. */
export function labelParts(s: Shift, p: Pick<Piece, "startsBefore" | "endsAfter">) {
  const [a, b] = span(s);
  return {
    name: s.facility,
    time: `${clockRange(s)} · ${fmtHours(lengthOf(s))}`,
    from: p.startsBefore ? `← ${WD(a).toUpperCase()}` : "",
    to: p.endsAfter ? `${WD(b - 1).toUpperCase()} →` : "",
  };
}
