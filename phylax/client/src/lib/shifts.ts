import { useEffect, useState } from "react";

export const PLATFORMS = ["ShiftKey", "CareRev", "ShiftMed", "Clipboard Health", "IntelyCare"];

// Times are minutes after midnight. A pattern whose end <= start runs overnight.
export type Pattern = { id: string; facility: string; label: string; start: number; end: number; address?: string };
// date = YYYY-MM-DD (day the shift starts). notes and contact are filled in from the shift's detail sheet; address comes from the pattern or the sheet.
export type Shift = Pattern & { platform: string; date: string; notes?: string; contact?: string };
export type Rules = { travelMin: number; cancelHrs: number };
export type Issue = { kind: "overlap" | "tight"; other: Shift; minutes: number; overlap?: [number, number] };

export const DEFAULT_RULES: Rules = { travelMin: 60, cancelHrs: 24 };

// Same saved patterns as the landing page "Saved tiles" section.
export const DEFAULT_PATTERNS: Pattern[] = [
  ["Riverside Manor", "Day", 7, 19],
  ["Riverside Manor", "Night", 19, 7],
  ["St. Anne's", "8-hour day", 7, 15],
  ["Greenfield Rehab", "Evening", 15, 23],
  ["Harbor View", "Early", 6, 14],
  ["Maple Court", "Short", 16, 20],
].map(([facility, label, s, e], i) => ({ id: `p${i}`, facility: facility as string, label: label as string, start: (s as number) * 60, end: (e as number) * 60 }));

const HOUR = 3600000;
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const toMin = (v: string) => { const [h, m] = v.split(":").map(Number); return h * 60 + m; };
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const inDays = (n: number, from = Date.now()) => { const d = new Date(from); d.setDate(d.getDate() + n); return ymd(d); };

const at = (date: string, mins: number, plusDays = 0) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d + plusDays, 0, mins).getTime();
};
export const span = (s: Pick<Shift, "date" | "start" | "end">): [number, number] => [at(s.date, s.start), at(s.date, s.end, s.end <= s.start ? 1 : 0)];

/** Length of a pattern or shift in minutes. An end at or before the start runs overnight, so equal times read as 24 hours. */
export const lengthOf = (s: Pick<Shift, "start" | "end">) => (s.end > s.start ? s.end - s.start : s.end - s.start + 1440);

/**
 * The kind of shift a start and end make: Night (runs past midnight), Short (5 hours or less), Early (starts before 7A),
 * Evening (starts 2P or later), otherwise Day. The same names as the saved patterns on the landing page.
 */
export function kindOf(start: number, end: number): string {
  if (end <= start) return "Night";
  if (end - start <= 5 * 60) return "Short";
  if (start < 7 * 60) return "Early";
  if (start >= 14 * 60) return "Evening";
  return "Day";
}
/** What to call a pattern or shift. Anything saved before kinds were named is labelled "Custom", so that one is read from its times. */
export const shiftType = (s: Pick<Shift, "label" | "start" | "end">) => (s.label && s.label !== "Custom" ? s.label : kindOf(s.start, s.end));

/** The same site and the same hours: a shift logged from a pattern keeps the pattern's facility, start and end. */
export const samePattern = (a: Pick<Pattern, "facility" | "start" | "end">, b: Pick<Pattern, "facility" | "start" | "end">) =>
  a.start === b.start && a.end === b.end && a.facility.trim().toLowerCase() === b.facility.trim().toLowerCase();

export type PatternState = { kind: "live" | "next" | "idle"; shift?: Shift };
/** Whether a logged shift of this pattern is running right now, is the next one coming, or there is none. `shifts` should be the ones that have not ended. */
export function patternState(p: Pattern, shifts: Shift[], now: number): PatternState {
  const mine = shifts.filter((s) => samePattern(s, p));
  const live = mine.find((s) => { const [a, b] = span(s); return a <= now && now < b; });
  if (live) return { kind: "live", shift: live };
  const next = mine.filter((s) => span(s)[0] > now).sort((x, y) => span(x)[0] - span(y)[0])[0];
  return next ? { kind: "next", shift: next } : { kind: "idle" };
}
/** Minutes after local midnight at `ms`: where "now" sits on a 24-hour bar. */
export const minuteOfDay = (ms: number) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
/** "Today", "Tomorrow", or "Fri 24" for anything further out. */
export function relDay(date: string, now: number): string {
  if (date === inDays(0, now)) return "Today";
  if (date === inDays(1, now)) return "Tomorrow";
  const d = new Date(date + "T00:00");
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${d.getDate()}`;
}

// ---- Formatting (same "7P–7A" style as the landing page) ----
export const t = (m: number) => `${Math.floor(m / 60) % 12 || 12}${m % 60 ? ":" + String(m % 60).padStart(2, "0") : ""}${Math.floor(m / 60) % 24 >= 12 ? "P" : "A"}`;
export const hr = (m: number) => `${Math.floor(m / 60) % 12 || 12}${m % 60 ? ":" + String(m % 60).padStart(2, "0") : ""}`;
export const clockRange = (s: Pick<Shift, "start" | "end">) => `${t(s.start)}–${t(s.end)}`;
export const dateLabel = (date: string) => new Date(date + "T00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
export const dur = (min: number) => {
  const m = Math.round(min), h = Math.floor(m / 60), r = m % 60;
  return [h && `${h} HR`, r && `${r} MIN`].filter(Boolean).join(" ") || "0 MIN";
};
const left = (ms: number) => {
  const h = ms / HOUR;
  return h < 1 ? `${Math.max(1, Math.round(ms / 60000))} minutes` : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`;
};

// ---- The checks (landing page: Direct overlap, Travel buffer, Cancellation window) ----
export function compare(a: Shift, b: Shift, rules: Rules): Omit<Issue, "other"> | null {
  const [as, ae] = span(a), [bs, be] = span(b);
  const lo = Math.max(as, bs), hi = Math.min(ae, be);
  if (hi > lo) return { kind: "overlap", minutes: (hi - lo) / 60000, overlap: [lo, hi] };
  const gap = (as >= be ? as - be : bs - ae) / 60000;
  const sameSite = a.facility.trim().toLowerCase() === b.facility.trim().toLowerCase();
  return !sameSite && gap < rules.travelMin ? { kind: "tight", minutes: gap } : null;
}
export const issuesFor = (shift: Shift, others: Shift[], rules: Rules): Issue[] =>
  others
    .filter((o) => o.id !== shift.id)
    .flatMap((o) => { const r = compare(shift, o, rules); return r ? [{ ...r, other: o }] : []; })
    .sort((x, y) => Number(y.kind === "overlap") - Number(x.kind === "overlap"));

export const cancelNote = (s: Shift, rules: Rules, now: number) => {
  const ms = span(s)[0] - rules.cancelHrs * HOUR - now;
  return ms > 0 ? `${s.platform}'s cancellation window closes in ${left(ms)}.` : `${s.platform}'s cancellation window has likely closed.`;
};

export function example(): Shift[] {
  const mk = (day: number, platform: string, facility: string, label: string, s: number, e: number, i: number): Shift =>
    ({ id: `ex${i}`, platform, facility, label, date: inDays(day), start: s * 60, end: e * 60 });
  return [
    mk(1, "ShiftKey", "Riverside Manor", "Night", 19, 7, 0),
    mk(2, "CareRev", "St. Anne's", "Early", 6, 14, 1),
    mk(4, "Clipboard Health", "Greenfield Rehab", "Evening", 15, 23, 2),
    mk(6, "ShiftMed", "Harbor View", "Early", 6, 14, 3),
    { ...mk(6, "IntelyCare", "Maple Court", "Short", 0, 0, 4), start: 14 * 60 + 30, end: 18 * 60 + 30 },
  ];
}

export function useStored<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : initial; } catch { return initial; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } }, [key, value]);
  return [value, setValue] as const;
}
