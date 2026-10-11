import { describe, expect, it } from 'vitest'
import {
  auditMidnightFlags,
  crossesMidnight,
  DEFAULT_ENGINE_OPTIONS,
  distanceKm,
  durationMinutes,
  evaluateWindows,
  findConflicts,
  findDuplicates,
  gapMinutes,
  overlaps,
  requiredBuffer,
  toInterval,
  toMs,
  touches,
  type Facility,
  type Platform,
  type Shift,
} from '../src/engine'

/* ------------------------------------------------------------------ *
 * Fixtures — a realistic per-diem week: three platforms, four sites.
 * ------------------------------------------------------------------ */

const PLATFORMS: readonly Platform[] = [
  { id: 'shiftkey', name: 'ShiftKey', code: 'SK', accent: '#4DE1FF' },
  { id: 'carerev', name: 'CareRev', code: 'CR', accent: '#3DDC97' },
  { id: 'shiftmed', name: 'ShiftMed', code: 'SM', accent: '#FFC14D' },
]

const FACILITIES: readonly Facility[] = [
  { id: 'f-riverside', name: 'Riverside Manor', address: '1 Riverside Rd', lat: 41.8781, lng: -87.6298 },
  { id: 'f-stannes', name: "St. Anne's", address: '44 Chapel St', lat: 41.8901, lng: -87.6199 },
  { id: 'f-greenfield', name: 'Greenfield Rehab', address: '900 Greenfield Ave', lat: 41.95, lng: -87.7 },
  { id: 'f-nolocs', name: 'Unmapped Clinic', address: 'Somewhere' },
  // 46 km out — far enough that the travel estimate overrides the default.
  { id: 'f-far', name: 'Northfield Care Center', address: '1 Northfield Way', lat: 42.15, lng: -88.05 },
]

const platformMap = new Map(PLATFORMS.map((p) => [p.id, p]))
const facilityMap = new Map(FACILITIES.map((f) => [f.id, f]))
const CTX = { facilities: facilityMap, platforms: platformMap }

function shift(partial: Partial<Shift> & Pick<Shift, 'id'>): Shift {
  return {
    platformId: 'shiftkey',
    facilityId: 'f-riverside',
    date: '2026-10-14',
    start: '07:00',
    end: '19:00',
    crossesMidnight: false,
    status: 'active',
    ...partial,
  }
}

/* ================================================================== *
 * §9.3 — MIDNIGHT NORMALIZATION (the #1 correctness requirement)
 * ================================================================== */
describe('midnight-crossing normalization (§9.3)', () => {
  it('treats a flagged 19:00–07:00 shift as one continuous 12h interval', () => {
    const night = shift({ id: 'n', start: '19:00', end: '07:00', crossesMidnight: true })
    const i = toInterval(night)

    expect(durationMinutes(i)).toBe(12 * 60)
    expect(i.start).toBe(toMs('2026-10-14', '19:00'))
    expect(i.end).toBe(toMs('2026-10-15', '07:00'))
  })

  it('puts the normalized end on the FOLLOWING calendar day, not the same day', () => {
    const night = shift({ id: 'n', start: '19:00', end: '07:00', crossesMidnight: true })
    const i = toInterval(night)

    // The failure mode §9.3 warns about: two same-day fragments.
    expect(i.end).toBeGreaterThan(toMs('2026-10-14', '23:59'))
    expect(new Date(i.end).toISOString()).toBe('2026-10-15T07:00:00.000Z')
  })

  it('normalizes an UNFLAGGED overnight shift instead of making a negative interval', () => {
    const sloppy = shift({ id: 'n', start: '23:00', end: '07:00', crossesMidnight: false })
    const i = toInterval(sloppy)

    expect(i.end).toBeGreaterThan(i.start)
    expect(durationMinutes(i)).toBe(8 * 60)
  })

  it('detects midnight crossing from wall-clock values alone', () => {
    expect(crossesMidnight(shift({ id: 'a', start: '19:00', end: '07:00' }))).toBe(true)
    expect(crossesMidnight(shift({ id: 'b', start: '07:00', end: '19:00' }))).toBe(false)
  })

  it('audits stored flags that disagree with the times they carry', () => {
    const mislabelled = shift({ id: 'bad', start: '19:00', end: '07:00', crossesMidnight: false })
    const correct = shift({ id: 'good', start: '07:00', end: '19:00' })
    expect(auditMidnightFlags([mislabelled, correct]).map((s) => s.id)).toEqual(['bad'])
  })

  it('catches an overlap a naive same-day comparison would miss entirely', () => {
    // Night shift 14th 19:00 → 15th 07:00, against a morning shift on the 15th.
    const night = shift({ id: 'night', start: '19:00', end: '07:00', crossesMidnight: true })
    const morning = shift({
      id: 'morning',
      date: '2026-10-15',
      start: '06:00',
      end: '14:00',
      platformId: 'carerev',
    })

    const conflicts = findConflicts(morning, [night], CTX)
    const overlap = conflicts.find((c) => c.type === 'overlap')

    expect(overlap).toBeDefined()
    expect(overlap?.severity).toBe('critical')
    expect(overlap?.overlapMinutes).toBe(60) // 06:00–07:00
  })
})

/* ================================================================== *
 * §9.2 — DIRECT OVERLAP
 * ================================================================== */
describe('direct overlap detection (§9.2)', () => {
  const base = shift({ id: 'base', start: '07:00', end: '19:00' })

  it('flags a partially overlapping shift as critical', () => {
    const other = shift({ id: 'x', start: '15:00', end: '23:00', platformId: 'carerev' })
    const c = findConflicts(other, [base], CTX)

    expect(c).toHaveLength(1)
    expect(c[0].severity).toBe('critical')
    expect(c[0].type).toBe('overlap')
    expect(c[0].overlapMinutes).toBe(4 * 60)
  })

  it('flags full containment', () => {
    const inner = shift({ id: 'x', start: '09:00', end: '13:00', platformId: 'shiftmed' })
    expect(findConflicts(inner, [base], CTX)[0].type).toBe('overlap')
  })

  it('does NOT flag back-to-back shifts that merely touch (§9.2 boundary rule)', () => {
    const touching = shift({ id: 'x', start: '19:00', end: '23:00', platformId: 'carerev' })

    expect(touches(toInterval(base), toInterval(touching))).toBe(true)
    expect(overlaps(toInterval(base), toInterval(touching))).toBe(false)
    expect(gapMinutes(toInterval(base), toInterval(touching))).toBe(0)
    expect(findConflicts(touching, [base], CTX).some((c) => c.type === 'overlap')).toBe(false)
  })

  it('ignores its own record when comparing', () => {
    expect(findConflicts(base, [base], CTX)).toHaveLength(0)
  })

  it('ignores cancelled and completed shifts (§6.3)', () => {
    const cancelled = shift({ id: 'c', start: '07:00', end: '19:00', status: 'cancelled' })
    const completed = shift({ id: 'd', start: '07:00', end: '19:00', status: 'completed' })
    const fresh = shift({ id: 'new', start: '07:00', end: '19:00', platformId: 'carerev' })

    expect(findConflicts(fresh, [cancelled, completed], CTX)).toHaveLength(0)
  })

  it('deterministic regardless of host timezone (Date.UTC arithmetic)', () => {
    expect(toMs('2026-10-14', '19:00')).toBe(Date.UTC(2026, 9, 14, 19, 0, 0, 0))
  })
})

/* ================================================================== *
 * §9.4 — COMMUTE BUFFER
 * ================================================================== */
describe('commute buffer detection (§9.4)', () => {
  it('computes a sane great-circle distance', () => {
    // One degree of latitude ≈ 111 km.
    const km = distanceKm({ lat: 41.0, lng: -87.0 }, { lat: 42.0, lng: -87.0 })
    expect(km).toBeGreaterThan(110)
    expect(km).toBeLessThan(112)
  })

  it('falls back to the default buffer when a facility has no coordinates', () => {
    const req = requiredBuffer(
      facilityMap.get('f-riverside')!,
      facilityMap.get('f-nolocs')!,
      DEFAULT_ENGINE_OPTIONS,
    )
    expect(req.source).toBe('default')
    expect(req.minutes).toBe(DEFAULT_ENGINE_OPTIONS.defaultBufferMinutes)
  })

  it('uses the travel estimate but lets the default win for intra-city hops', () => {
    const req = requiredBuffer(
      facilityMap.get('f-riverside')!,
      facilityMap.get('f-greenfield')!,
      DEFAULT_ENGINE_OPTIONS,
    )
    expect(req.source).toBe('travel-estimate')
    // 9.88 km straight line → 12.85 km road → 20.3 min drive + 15 min margin
    // = 36, which is below the 45 min default, so the default holds.
    expect(req.distanceKm).toBe(9.9)
    expect(req.travelMinutes).toBe(20)
    expect(req.minutes).toBe(DEFAULT_ENGINE_OPTIONS.defaultBufferMinutes)
  })

  it('lets the travel estimate override the default for a long commute', () => {
    const req = requiredBuffer(
      facilityMap.get('f-riverside')!,
      facilityMap.get('f-far')!,
      DEFAULT_ENGINE_OPTIONS,
    )
    expect(req.source).toBe('travel-estimate')
    // 46 km → ~94.5 min drive + 15 min margin.
    expect(req.minutes).toBeGreaterThan(DEFAULT_ENGINE_OPTIONS.defaultBufferMinutes)
    expect(req.minutes).toBe(110)
  })

  it('honours useTravelEstimate: false by falling back to the default', () => {
    const req = requiredBuffer(
      facilityMap.get('f-riverside')!,
      facilityMap.get('f-far')!,
      { ...DEFAULT_ENGINE_OPTIONS, useTravelEstimate: false },
    )
    expect(req.source).toBe('default')
    expect(req.minutes).toBe(45)
  })

  it('raises a buffer conflict when the gap is below the requirement', () => {
    const first = shift({ id: 'a', start: '07:00', end: '15:00' })
    const second = shift({
      id: 'b',
      platformId: 'carerev',
      facilityId: 'f-greenfield',
      start: '15:15',
      end: '23:00',
    })

    const c = findConflicts(second, [first], CTX)
    expect(c).toHaveLength(1)
    expect(c[0].type).toMatch(/^buffer-/)
    expect(c[0].gapMinutes).toBe(15)
    expect(['high', 'warning']).toContain(c[0].severity)
  })

  it('does not raise a buffer conflict when the gap comfortably clears it', () => {
    const first = shift({ id: 'a', start: '07:00', end: '15:00' })
    const second = shift({
      id: 'b',
      platformId: 'carerev',
      facilityId: 'f-greenfield',
      start: '19:00',
      end: '23:00',
    })
    expect(findConflicts(second, [first], CTX)).toHaveLength(0)
  })

  it('never demands travel time between shifts at the SAME facility', () => {
    const first = shift({ id: 'a', start: '07:00', end: '15:00' })
    const second = shift({ id: 'b', start: '15:00', end: '23:00', platformId: 'carerev' })

    const c = findConflicts(second, [first], CTX)
    expect(c.every((x) => x.type !== 'buffer-tight' && x.type !== 'buffer-impossible')).toBe(true)
  })

  it('reports same-facility back-to-back as informational only', () => {
    const first = shift({ id: 'a', start: '07:00', end: '15:00' })
    const second = shift({ id: 'b', start: '15:30', end: '23:00', platformId: 'carerev' })

    const c = findConflicts(second, [first], CTX)
    expect(c).toHaveLength(1)
    expect(c[0].severity).toBe('info')
    expect(c[0].gapMinutes).toBe(30)
  })

  it('escalates a long-commute shortfall to high severity', () => {
    const first = shift({ id: 'a', start: '07:00', end: '15:00' })
    const second = shift({
      id: 'b',
      platformId: 'carerev',
      facilityId: 'f-far',
      start: '16:00',
      end: '23:00',
    })

    const c = findConflicts(second, [first], CTX)
    expect(c).toHaveLength(1)
    expect(c[0].severity).toBe('high')
    expect(c[0].requiredBufferMinutes).toBe(110)
    expect(c[0].gapMinutes).toBe(60)
  })

  it('works in both directions — candidate first or candidate second', () => {
    const early = shift({ id: 'a', start: '07:00', end: '15:00' })
    const late = shift({
      id: 'b',
      platformId: 'carerev',
      facilityId: 'f-greenfield',
      start: '15:15',
      end: '23:00',
    })

    const forward = findConflicts(late, [early], CTX)
    const backward = findConflicts(early, [late], CTX)

    expect(forward).toHaveLength(1)
    expect(backward).toHaveLength(1)
    expect(backward[0].gapMinutes).toBe(forward[0].gapMinutes)
  })
})

/* ================================================================== *
 * §9.6 — SEVERITY
 * ================================================================== */
describe('severity model (§9.6)', () => {
  it('ranks critical above high above warning above info', () => {
    const day = shift({ id: 'day', start: '07:00', end: '19:00' })
    const overlapping = shift({
      id: 'over',
      platformId: 'carerev',
      facilityId: 'f-stannes',
      start: '18:00',
      end: '23:00',
    })
    const tight = shift({
      id: 'tight',
      platformId: 'shiftmed',
      facilityId: 'f-greenfield',
      start: '19:10',
      end: '23:00',
    })

    const c = findConflicts(day, [overlapping, tight], CTX)
    expect(c[0].severity).toBe('critical')
    expect(c.some((x) => x.severity === 'critical')).toBe(true)
    expect(c.every((x, i) => i === 0 || rank(c[i - 1].severity) <= rank(x.severity))).toBe(true)
  })
})

function rank(s: string): number {
  return { critical: 0, high: 1, warning: 2, info: 3 }[s] ?? 99
}

/* ================================================================== *
 * §20.8 — DUPLICATES
 * ================================================================== */
describe('duplicate detection (§20.8)', () => {
  it('reports exact repeats but does not block genuinely similar shifts', () => {
    const original = shift({ id: 'a' })
    const exactDupe = shift({ id: 'b' })
    const similar = shift({ id: 'c', start: '07:00', end: '15:00' })

    expect(findDuplicates(exactDupe, [original, similar]).map((s) => s.id)).toEqual(['a'])
    expect(findDuplicates(original, [similar])).toHaveLength(0)
  })
})

/* ================================================================== *
 * §10 — CANCELLATION WINDOWS
 * ================================================================== */
describe('cancellation-policy intelligence (§10)', () => {
  it('identifies which of two conflicts still has an open window', () => {
    const now = Date.UTC(2026, 9, 14, 12, 0, 0, 0)
    // shiftMed window = 3h, shiftKey window = 24h.
    const shiftMed = { platformId: 'shiftmed', startMs: Date.UTC(2026, 9, 14, 19, 0, 0, 0) }
    const shiftKey = { platformId: 'shiftkey', startMs: Date.UTC(2026, 9, 14, 19, 0, 0, 0) }

    const r = evaluateWindows(shiftMed, shiftKey, now)

    // ShiftMed deadline 16:00 → still open (4h). ShiftKey deadline 14th 19:00
    // minus 24h = 13th 19:00 → already closed.
    expect(r.a.closed).toBe(false)
    expect(r.b.closed).toBe(true)
    expect(r.recommendation).toBe('a')
  })

  it('refuses to recommend when both windows are already closed', () => {
    const now = Date.UTC(2026, 9, 14, 18, 59, 0, 0)
    const a = { platformId: 'shiftmed', startMs: Date.UTC(2026, 9, 14, 19, 0, 0, 0) }
    const b = { platformId: 'shiftmed', startMs: Date.UTC(2026, 9, 14, 19, 0, 0, 0) }

    const r = evaluateWindows(a, b, now)
    expect(r.a.closed).toBe(true)
    expect(r.b.closed).toBe(true)
    expect(r.recommendation).toBeNull()
  })

  it('counts down the remaining window in ms', () => {
    const now = Date.UTC(2026, 9, 14, 12, 0, 0, 0)
    const s = { platformId: 'shiftmed', startMs: Date.UTC(2026, 9, 14, 19, 0, 0, 0) }
    const r = evaluateWindows(s, { platformId: 'shiftkey', startMs: Date.UTC(2027, 0, 1, 0, 0) }, now)

    // deadline 16:00, now 12:00 → 4h
    expect(r.a.remainingMs).toBe(4 * 3_600_000)
  })
})
