/**
 * Demo seed — a realistic per-diem week.
 *
 * Every conflict the marketing site shows is computed by the real engine from
 * this data, not scripted. `buildSeed` takes the reference date so the board
 * always looks live, while tests can pin it.
 */

import type { Facility, Platform, Shift, ShiftTemplate } from '../engine'
import { addDaysISO } from '../engine/format'

export const PLATFORMS: readonly Platform[] = [
  { id: 'shiftkey', name: 'ShiftKey', code: 'SK', accent: '#4DE1FF' },
  { id: 'carerev', name: 'CareRev', code: 'CR', accent: '#3DDC97' },
  { id: 'clipboard', name: 'Clipboard Health', code: 'CH', accent: '#FFC14D' },
  { id: 'shiftmed', name: 'ShiftMed', code: 'SM', accent: '#FF8A4D' },
  { id: 'intelycare', name: 'IntelyCare', code: 'IC', accent: '#A78BFA' },
]

export const FACILITIES: readonly Facility[] = [
  { id: 'f-riverside', name: 'Riverside Manor', address: '1 Riverside Rd', lat: 41.8781, lng: -87.6298 },
  { id: 'f-stannes', name: "St. Anne's", address: '44 Chapel St', lat: 41.8901, lng: -87.6199 },
  { id: 'f-greenfield', name: 'Greenfield Rehab', address: '900 Greenfield Ave', lat: 41.95, lng: -87.7 },
  { id: 'f-northfield', name: 'Northfield Care Center', address: '1 Northfield Way', lat: 42.15, lng: -88.05 },
]

/** §7.1 — facility + typical start/end + label. The zero-typing unit. */
export const TEMPLATES: readonly ShiftTemplate[] = [
  { id: 't-riv-day', facilityId: 'f-riverside', label: 'Day 7–7', start: '07:00', end: '19:00', crossesMidnight: false },
  { id: 't-riv-night', facilityId: 'f-riverside', label: 'Night 7–7', start: '19:00', end: '07:00', crossesMidnight: true },
  { id: 't-anne-day', facilityId: 'f-stannes', label: '8-hour day', start: '07:00', end: '15:00', crossesMidnight: false },
  { id: 't-green-eve', facilityId: 'f-greenfield', label: 'Evening 3–11', start: '15:00', end: '23:00', crossesMidnight: false },
  { id: 't-north-night', facilityId: 'f-northfield', label: 'Night 7–7', start: '19:00', end: '07:00', crossesMidnight: true },
]

export interface Seed {
  shifts: Shift[]
  /** ISO date the board treats as "today". */
  today: string
}

/**
 * The seeded week is engineered to exercise every branch of the engine:
 *   1. a critical direct overlap (the hero conflict)
 *   2. a midnight-crossing overnight shift (§9.3)
 *   3. a long-commute buffer failure (§9.4)
 *   4. a clean, conflict-free stretch so the "clear" state is visible too
 */
export function buildSeed(today = localTodayISO()): Seed {
  const t0 = today
  const t1 = addDaysISO(today, 1)
  const t2 = addDaysISO(today, 2)

  const shifts: Shift[] = [
    // (1) THE HERO CONFLICT — 4h direct overlap across two platforms.
    {
      id: 's-1',
      platformId: 'shiftkey',
      facilityId: 'f-riverside',
      date: t0,
      start: '07:00',
      end: '19:00',
      crossesMidnight: false,
      status: 'active',
      notes: 'Unit 3 West · charge nurse Dana',
    },
    {
      id: 's-2',
      platformId: 'carerev',
      facilityId: 'f-stannes',
      date: t0,
      start: '15:00',
      end: '23:00',
      crossesMidnight: false,
      status: 'active',
    },

    // (2) OVERNIGHT — 19:00 tonight running through to 07:00 tomorrow.
    {
      id: 's-3',
      platformId: 'shiftmed',
      facilityId: 'f-greenfield',
      date: t0,
      start: '19:00',
      end: '07:00',
      crossesMidnight: true,
      status: 'active',
      notes: 'Rehab floor, badge at the east door',
    },

    // (4) CLEAN — a normal day with nothing near it.
    {
      id: 's-4',
      platformId: 'intelycare',
      facilityId: 'f-riverside',
      date: t1,
      start: '07:00',
      end: '15:00',
      crossesMidnight: false,
      status: 'active',
    },

    // (3) LONG COMMUTE — 8h at Riverside, then 46 km out with only 60 min.
    {
      id: 's-5',
      platformId: 'shiftkey',
      facilityId: 'f-riverside',
      date: t2,
      start: '07:00',
      end: '15:00',
      crossesMidnight: false,
      status: 'active',
    },
    {
      id: 's-6',
      platformId: 'clipboard',
      facilityId: 'f-northfield',
      date: t2,
      start: '16:00',
      end: '23:00',
      crossesMidnight: false,
      status: 'active',
    },
  ]

  return { shifts, today: t0 }
}

export function localTodayISO(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
