/** Presentation helpers shared by the DOM overlay. No React, no browser APIs. */

/** '19:00' → '7:00 PM'. Kept 12-hour because US healthcare staff talk that way. */
export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const suffix = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`
}

export function formatRange(start: string, end: string, midnight: boolean): string {
  return `${formatTime(start)} – ${formatTime(end)}${midnight ? ' (+1)' : ''}`
}

/** 'Tue 14' style, from 'YYYY-MM-DD'. */
export function formatDayLabel(date: string, todayISO?: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const weekday = dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
  const day = dt.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'UTC' })
  if (todayISO === date) return `Today · ${weekday} ${day}`
  const tomorrow = addDaysISO(todayISO ?? date, 1)
  if (tomorrow === date) return `Tomorrow · ${weekday} ${day}`
  return `${weekday} ${day}`
}

export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return dt.toISOString().slice(0, 10)
}

/** Total minutes from midnight, for laying shifts out on a 24h ribbon. */
export function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** ms → 'HH:MM:SS', zero-padded. Used by the live cancellation countdown. */
export function formatCountdown(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(clamped / 3600)
  const m = Math.floor((clamped % 3600) / 60)
  const s = clamped % 60
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
}

export function formatMinutes(mins: number): string {
  const abs = Math.abs(mins)
  if (abs < 60) return `${mins} min`
  const h = Math.floor(abs / 60)
  const m = abs % 60
  const sign = mins < 0 ? '-' : ''
  return m === 0 ? `${sign}${h} hr` : `${sign}${h} hr ${m} min`
}
