// Pure date and time helpers for the shift pickers (components/picker). No React, no time zones:
// every date is a local calendar day written YYYY-MM-DD, every time is "HH:MM" (24-hour), the same
// shapes the "Log a shift" form has always stored.
import { ymd } from "./shifts";

export const pad2 = (n: number) => String(n).padStart(2, "0");

/** "2026-10-16" -> local midnight. Falls back to today when the string is not a date. */
export function parseDay(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return Number.isNaN(date.getTime()) ? new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()) : date;
}

export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const daysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate();

/** Moves by whole months and keeps the day of month where it can (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(d: Date, n: number): Date {
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), daysInMonth(first.getFullYear(), first.getMonth())));
}

/** Always 42 days (six Sunday-first weeks) so the calendar never changes height between months. */
export function monthGrid(year: number, month: number): Date[] {
  const lead = new Date(year, month, 1).getDay();
  return Array.from({ length: 42 }, (_, i) => new Date(year, month, 1 - lead + i));
}

/** The 12-year page a year falls on: 2026 -> 2016. */
export const yearPage = (year: number) => Math.floor(year / 12) * 12;

export const MONTHS_LONG = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString("en-US", { month: "long" }));
export const MONTHS_SHORT = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString("en-US", { month: "short" }));
export const WEEKDAYS_LONG = Array.from({ length: 7 }, (_, i) => new Date(2000, 0, 2 + i).toLocaleDateString("en-US", { weekday: "long" })); // Sunday first
export const WEEKDAYS_SHORT = Array.from({ length: 7 }, (_, i) => new Date(2000, 0, 2 + i).toLocaleDateString("en-US", { weekday: "short" }));

export const dayName = (d: Date) => d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
export const dayKey = ymd;

// ---- Time ----
export const MINUTE_STEP = 5;
export const HOURS_12 = Array.from({ length: 12 }, (_, i) => i + 1);
export const MINUTES = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => i * MINUTE_STEP);

/** "07:30" -> 450. Anything that is not a valid time reads as midnight, so a stray value never breaks the form. */
export function minutesOf(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? ((h * 60 + m) % 1440 + 1440) % 1440 : 0;
}

/** 450 -> "07:30" */
export const clockValue = (mins: number) => { const m = ((Math.round(mins) % 1440) + 1440) % 1440; return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`; };

export type Clock12 = { hour: number; minute: number; pm: boolean };
export const to12 = (mins: number): Clock12 => ({ hour: Math.floor(mins / 60) % 12 || 12, minute: mins % 60, pm: Math.floor(mins / 60) >= 12 });
/** 12 AM is hour 0, 12 PM is hour 12. */
export const from12 = ({ hour, minute, pm }: Clock12) => (hour % 12 + (pm ? 12 : 0)) * 60 + minute;
export const clockText = (c: Clock12) => `${c.hour}:${pad2(c.minute)}`;
export const clockLong = (mins: number) => { const c = to12(mins); return `${clockText(c)} ${c.pm ? "PM" : "AM"}`; };

/** Minutes from start to end, running past midnight when end is earlier. Equal times are not a shift (0). */
export const lengthBetween = (start: number, end: number) => (end === start ? 0 : (end - start + 1440) % 1440);
