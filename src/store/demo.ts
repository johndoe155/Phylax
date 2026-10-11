/**
 * Demo store. Thin Zustand wrapper over the pure engine.
 *
 * Nothing here re-implements conflict logic — every derived value comes from
 * `findConflicts`, the same function the unit tests exercise. That is the
 * point: the marketing demo and the product share one algorithm.
 */

import { create } from 'zustand'
import {
  DEFAULT_ENGINE_OPTIONS,
  findConflicts,
  type Conflict,
  type EngineOptions,
  type Facility,
  type Platform,
  type Shift,
} from '../engine'
import { FACILITIES, PLATFORMS, buildSeed } from '../data/seed'
import { setSeverity } from './sceneBridge'

export const platformMap = new Map<string, Platform>(PLATFORMS.map((p) => [p.id, p]))
export const facilityMap = new Map<string, Facility>(FACILITIES.map((f) => [f.id, f]))

interface DemoState {
  shifts: Shift[]
  conflicts: Conflict[]
  today: string
  options: EngineOptions
  /** Id of the shift the visitor most recently logged, for reveal animation. */
  lastLoggedId: string | null
  logShift: (shift: Shift) => void
  cancelShift: (id: string) => void
  restoreShift: (id: string) => void
  setBuffer: (minutes: number) => void
  reset: () => void
}

function recompute(
  shifts: Shift[],
  options: EngineOptions,
): Conflict[] {
  const ctx = { facilities: facilityMap, platforms: platformMap, options }
  const seen = new Set<string>()
  const out: Conflict[] = []

  // Compare every active shift against the rest, de-duplicating the pairs
  // that findConflicts would otherwise report twice (A→B and B→A).
  for (const s of shifts) {
    if (s.status !== 'active') continue
    for (const c of findConflicts(s, shifts, ctx)) {
      const key = [c.newShiftId, c.existingShiftId].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      out.push(c)
    }
  }
  return out
}

const seed = buildSeed()

export const useDemo = create<DemoState>((set, get) => ({
  shifts: seed.shifts,
  conflicts: recompute(seed.shifts, DEFAULT_ENGINE_OPTIONS),
  today: seed.today,
  options: DEFAULT_ENGINE_OPTIONS,
  lastLoggedId: null,

  logShift: (shift) => {
    const shifts = [...get().shifts, shift]
    const conflicts = recompute(shifts, get().options)
    set({ shifts, conflicts, lastLoggedId: shift.id })
    syncSeverity(conflicts)
  },

  cancelShift: (id) => {
    const shifts = get().shifts.map((s) => (s.id === id ? { ...s, status: 'cancelled' as const } : s))
    const conflicts = recompute(shifts, get().options)
    set({ shifts, conflicts })
    syncSeverity(conflicts)
  },

  restoreShift: (id) => {
    const shifts = get().shifts.map((s) => (s.id === id ? { ...s, status: 'active' as const } : s))
    const conflicts = recompute(shifts, get().options)
    set({ shifts, conflicts })
    syncSeverity(conflicts)
  },

  setBuffer: (minutes) => {
    const options = { ...get().options, defaultBufferMinutes: minutes }
    set({ options, conflicts: recompute(get().shifts, options) })
    syncSeverity(recompute(get().shifts, options))
  },

  reset: () => {
    const fresh = buildSeed(get().today)
    set({ shifts: fresh.shifts, conflicts: recompute(fresh.shifts, get().options), lastLoggedId: null })
    syncSeverity(recompute(fresh.shifts, get().options))
  },
}))

/** Push the worst live severity into the scene bridge so shaders can follow. */
function syncSeverity(conflicts: Conflict[]): void {
  const worst = conflicts.reduce<Conflict['severity'] | null>((acc, c) => {
    const order = { critical: 0, high: 1, warning: 2, info: 3 } as const
    if (acc === null) return c.severity
    return order[c.severity] < order[acc] ? c.severity : acc
  }, null)
  setSeverity(worst)
}

