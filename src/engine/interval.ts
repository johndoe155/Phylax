/**
 * Interval arithmetic — §9.2 and §9.3.
 *
 * Everything is expressed in epoch milliseconds built with Date.UTC so results
 * are identical on every machine and in every test runner regardless of the
 * host timezone. The site's demo is a UI concern; correctness is not.
 */

import type { Interval, Shift } from './types'

export const MS_PER_MINUTE = 60_000
export const MS_PER_DAY = 86_400_000

export function parseDate(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) throw new Error(`Invalid shift date: ${date}`)
  return { y, m, d }
}

export function parseTime(time: string): { hh: number; mm: number } {
  const [hh, mm] = time.split(':').map(Number)
  if (Number.isNaN(hh) || Number.isNaN(mm)) throw new Error(`Invalid shift time: ${time}`)
  return { hh, mm }
}

/** Deterministic wall-clock → epoch-ms conversion (UTC, no host TZ involved). */
export function toMs(date: string, time: string): number {
  const { y, m, d } = parseDate(date)
  const { hh, mm } = parseTime(time)
  return Date.UTC(y, m - 1, d, hh, mm, 0, 0)
}

/**
 * §9.3 — Midnight-crossing shifts must be ONE continuous interval whose end
 * falls on the following calendar day. A 19:00 → 07:00 shift is 12 hours,
 * never two same-day fragments.
 *
 * `crossesMidnight` is trusted, but `end <= start` is also treated as an
 * overnight shift. That defensive branch means an unflagged 19:00–07:00 entry
 * still normalizes correctly instead of silently becoming a negative interval.
 */
export function toInterval(shift: Shift): Interval {
  const start = toMs(shift.date, shift.start)
  let end = toMs(shift.date, shift.end)
  if (shift.crossesMidnight || end <= start) end += MS_PER_DAY
  return { start, end }
}

/** §9.2 — `conflict if N.start < E.end AND N.end > E.start`, strictly. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end
}

/**
 * Boundary rule (§9.2): a shift ending exactly when another begins is NOT a
 * direct overlap. Back-to-back is legal; it may still fail the buffer check.
 */
export function touches(a: Interval, b: Interval): boolean {
  return a.end === b.start || b.end === a.start
}

export function overlapMinutes(a: Interval, b: Interval): number {
  const start = Math.max(a.start, b.start)
  const end = Math.min(a.end, b.end)
  return Math.max(0, Math.round((end - start) / MS_PER_MINUTE))
}

/**
 * Signed transition time between two shifts: positive when `next` starts after
 * `prev` ends, negative when they overlap. Zero means they touch.
 */
export function gapMinutes(prev: Interval, next: Interval): number {
  return Math.round((next.start - prev.end) / MS_PER_MINUTE)
}

export function durationMinutes(i: Interval): number {
  return Math.round((i.end - i.start) / MS_PER_MINUTE)
}

/**
 * True when the shift's end falls on a later calendar date than its start.
 * Derived from the raw wall-clock values, so it works whether or not the
 * record was flagged — which is what lets the engine audit its own input.
 */
export function crossesMidnight(shift: Shift): boolean {
  return toMs(shift.date, shift.end) <= toMs(shift.date, shift.start)
}
