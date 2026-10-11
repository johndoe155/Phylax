/**
 * PHYLAX CONFLICT ENGINE — domain types
 *
 * Mirrors §13.3 of the blueprint. Deliberately free of React, three and any
 * browser API so the exact same module powers the marketing demo and the
 * product later, and so it can be unit-tested headlessly.
 */

/** §9.6 — the four-level severity model. */
export type Severity = 'critical' | 'high' | 'warning' | 'info'

/** What actually went wrong. */
export type ConflictType =
  | 'overlap' // §9.2 direct time overlap
  | 'buffer-impossible' // §9.4 no viable transition at all
  | 'buffer-tight' // §9.4 below the worker's preferred threshold
  | 'proximity' // informational, not yet a problem

export type ShiftStatus = 'active' | 'cancelled' | 'completed'

export interface Platform {
  id: string
  name: string
  /** Short identifier used for the abstract glyph + colour coding. */
  code: string
  accent: string
}

export interface Facility {
  id: string
  name: string
  address: string
  /** Optional — the demo seeds most, but the engine must tolerate their absence. */
  lat?: number
  lng?: number
}

/** §7.1 — facility + typical start/end + optional label. The zero-typing unit. */
export interface ShiftTemplate {
  id: string
  facilityId: string
  label: string
  start: string // 'HH:mm' local wall clock
  end: string // 'HH:mm' local wall clock
  crossesMidnight: boolean
}

/**
 * A logged shift. Times are local wall-clock strings rather than absolute
 * instants because the blueprint models shifts as "date + pattern" (§13.3),
 * and because it keeps midnight-crossing arithmetic explicit and testable.
 */
export interface Shift {
  id: string
  platformId: string
  facilityId: string
  /** 'YYYY-MM-DD' — the calendar date the shift *starts* on. */
  date: string
  start: string // 'HH:mm'
  end: string // 'HH:mm'
  crossesMidnight: boolean
  status: ShiftStatus
  notes?: string
}

export type ConflictMessage = string

/** Half-open interval in epoch milliseconds (UTC-derived). */
export interface Interval {
  start: number
  end: number
}

export interface Conflict {
  id: string
  type: ConflictType
  severity: Severity
  newShiftId: string
  existingShiftId: string
  /** Present for 'overlap'. */
  overlapMinutes?: number
  /** Present for buffer/proximity conflicts; may be negative (no gap at all). */
  gapMinutes?: number
  /** Present for buffer conflicts. */
  requiredBufferMinutes?: number
  /** Present for buffer conflicts; how the requirement was derived. */
  bufferSource?: 'travel-estimate' | 'default'
  message: ConflictMessage
}

/** §20.1 — the buffer policy is explicit and configurable, never magic. */
export interface EngineOptions {
  /** The worker's preferred minimum transition time (§9.4). */
  defaultBufferMinutes: number
  /** Added on top of a travel estimate as a safety margin. */
  safetyMarginMinutes: number
  /** When true and both facilities carry coordinates, estimate travel time. */
  useTravelEstimate: boolean
  /** Naive average door-to-door speed for the estimate. */
  travelSpeedKmh: number
  /** Below this many minutes of gap we still flag 'info'. */
  proximityWindowMinutes: number
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  defaultBufferMinutes: 45,
  safetyMarginMinutes: 15,
  useTravelEstimate: true,
  travelSpeedKmh: 38,
  proximityWindowMinutes: 240,
}
