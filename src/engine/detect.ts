/**
 * §9 — the conflict-detection engine entry point.
 *
 * Runs entirely in memory against an already-loaded shift list (§9.5: instant
 * client-side feedback, no network round trip before the warning appears).
 */

import { requiredBuffer } from './geo'
import {
  crossesMidnight,
  gapMinutes,
  overlapMinutes,
  overlaps,
  toInterval,
} from './interval'
import {
  DEFAULT_ENGINE_OPTIONS,
  type Conflict,
  type EngineOptions,
  type Facility,
  type Platform,
  type Severity,
  type Shift,
} from './types'

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  warning: 2,
  info: 3,
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Cannot attend both',
  high: 'Risky transition',
  warning: 'Tight travel window',
  info: 'Close commitments',
}

export interface DetectionContext {
  facilities: ReadonlyMap<string, Facility>
  platforms: ReadonlyMap<string, Platform>
  options?: Partial<EngineOptions>
}

function hhmm(shift: Shift): string {
  return `${shift.start}–${shift.end}${shift.crossesMidnight ? ' (+1)' : ''}`
}

function facilityName(ctx: DetectionContext, id: string): string {
  return ctx.facilities.get(id)?.name ?? 'Unknown facility'
}

function platformName(ctx: DetectionContext, id: string): string {
  return ctx.platforms.get(id)?.name ?? 'Unknown platform'
}

/**
 * Compare one candidate shift against every active shift already logged.
 *
 * Cancelled and completed shifts are ignored — a removed commitment must stop
 * generating warnings immediately (§6.3).
 */
export function findConflicts(
  candidate: Shift,
  existing: readonly Shift[],
  ctx: DetectionContext,
): Conflict[] {
  const opts: EngineOptions = { ...DEFAULT_ENGINE_OPTIONS, ...ctx.options }
  const n = toInterval(candidate)
  const out: Conflict[] = []

  for (const other of existing) {
    if (other.id === candidate.id) continue
    if (other.status !== 'active') continue

    const e = toInterval(other)
    const id = `${candidate.id}__${other.id}`

    // ---- §9.2 direct overlap -------------------------------------------
    if (overlaps(n, e)) {
      const mins = overlapMinutes(n, e)
      out.push({
        id,
        type: 'overlap',
        severity: 'critical',
        newShiftId: candidate.id,
        existingShiftId: other.id,
        overlapMinutes: mins,
        message:
          `Direct overlap of ${mins} minute${mins === 1 ? '' : 's'} between ` +
          `${platformName(ctx, candidate.platformId)} at ${facilityName(ctx, candidate.facilityId)} ` +
          `(${hhmm(candidate)}) and ${platformName(ctx, other.platformId)} at ` +
          `${facilityName(ctx, other.facilityId)} (${hhmm(other)}).`,
      })
      continue
    }

    // ---- ordering: who ends first? --------------------------------------
    const candidateFirst = n.end <= e.start
    const prev = candidateFirst ? candidate : other
    const next = candidateFirst ? other : candidate
    const prevI = candidateFirst ? n : e
    const nextI = candidateFirst ? e : n
    const gap = gapMinutes(prevI, nextI)

    // ---- §9.4 commute buffer (different facilities only) -----------------
    if (prev.facilityId === next.facilityId) {
      // Same building — no travel requirement, but flag near-adjacency.
      if (gap < opts.proximityWindowMinutes) {
        out.push({
          id,
          type: 'proximity',
          severity: 'info',
          newShiftId: candidate.id,
          existingShiftId: other.id,
          gapMinutes: gap,
          message:
            `Back-to-back at the same facility: ${gap} minute` +
            `${gap === 1 ? '' : 's'} between ${hhmm(prev)} and ${hhmm(next)}.`,
        })
      }
      continue
    }

    const prevFacility = ctx.facilities.get(prev.facilityId)
    const nextFacility = ctx.facilities.get(next.facilityId)
    if (!prevFacility || !nextFacility) continue

    const req = requiredBuffer(prevFacility, nextFacility, opts)

    // Physically impossible: less time available than raw travel time.
    const physicallyImpossible =
      gap <= 0 || (req.source === 'travel-estimate' && gap < (req.travelMinutes ?? 0))

    if (physicallyImpossible || gap < req.minutes) {
      const severity: Severity = physicallyImpossible || gap <= req.minutes / 2 ? 'high' : 'warning'
      const type = physicallyImpossible ? 'buffer-impossible' : 'buffer-tight'

      const travelNote =
        req.source === 'travel-estimate'
          ? ` ~${req.distanceKm} km apart, roughly ${req.travelMinutes} min of driving`
          : ` no location data, using your ${req.minutes} min default`

      out.push({
        id,
        type,
        severity,
        newShiftId: candidate.id,
        existingShiftId: other.id,
        gapMinutes: gap,
        requiredBufferMinutes: req.minutes,
        bufferSource: req.source,
        message:
          `${gap <= 0 ? 'No gap' : `Only ${gap} min`} between ` +
          `${platformName(ctx, prev.platformId)} at ${facilityName(ctx, prev.facilityId)} ending ` +
          `${prev.end} and ${platformName(ctx, next.platformId)} at ` +
          `${facilityName(ctx, next.facilityId)} starting ${next.start}. ` +
          `You need ${req.minutes} min.${travelNote}.`,
      })
      continue
    }

    // ---- informational proximity ----------------------------------------
    if (gap < opts.proximityWindowMinutes) {
      out.push({
        id,
        type: 'proximity',
        severity: 'info',
        newShiftId: candidate.id,
        existingShiftId: other.id,
        gapMinutes: gap,
        requiredBufferMinutes: req.minutes,
        message:
          `${gap} min between facilities — above your ${req.minutes} min buffer, ` +
          `but there is no slack.`,
      })
    }
  }

  return out.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id),
  )
}

/**
 * §20.8 — duplicate detection. Genuinely similar shifts must still be allowed
 * (a worker can legitimately work the same pattern twice), so this reports
 * exact repeats rather than blocking them.
 */
export function findDuplicates(candidate: Shift, existing: readonly Shift[]): Shift[] {
  return existing.filter(
    (s) =>
      s.id !== candidate.id &&
      s.status === 'active' &&
      s.platformId === candidate.platformId &&
      s.facilityId === candidate.facilityId &&
      s.date === candidate.date &&
      s.start === candidate.start &&
      s.end === candidate.end,
  )
}

/**
 * Audit helper: surfaces shifts whose stored `crossesMidnight` flag disagrees
 * with their own wall-clock times. §9.3 makes overnight normalization a
 * correctness requirement, so the engine should be able to prove its input.
 */
export function auditMidnightFlags(shifts: readonly Shift[]): Shift[] {
  return shifts.filter((s) => s.crossesMidnight !== crossesMidnight(s))
}
