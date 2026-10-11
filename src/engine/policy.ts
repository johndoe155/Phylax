/**
 * §10 — cancellation-policy intelligence.
 *
 * ⚠ ILLUSTRATIVE DATA. Every row below is demo copy written for this site.
 * It is NOT verified against any platform's current terms, and §10.3 of the
 * blueprint requires that we never present policy information as a guarantee.
 * Replace these rows with verified data (policy text, effective date, source
 * URL, last-reviewed date) before this ships anywhere a worker relies on it.
 *
 * The `DISCLAIMER` below is rendered next to every policy surface in the UI.
 */

export interface CancellationPolicy {
  platformId: string
  /** Hours of notice required to cancel without penalty. */
  cancellationWindowHours: number
  /** What happens if you cancel inside the window. */
  penalty: string
  /** Provenance fields required by §10.2. */
  effectiveFrom: string
  lastReviewedAt: string
  sourceNote: string
}

export const DISCLAIMER =
  'Illustrative policy data for demonstration only. Cancellation rules vary by ' +
  'contract, facility, worker status and shift type, and they change. Always ' +
  'verify current platform policy before cancelling.'

export const CANCELLATION_POLICIES: readonly CancellationPolicy[] = [
  {
    platformId: 'shiftkey',
    cancellationWindowHours: 24,
    penalty: 'Cancellation inside the window reduces your reliability score and may restrict future shift access.',
    effectiveFrom: '2026-01-01',
    lastReviewedAt: '2026-09-01',
    sourceNote: 'Illustrative — not verified against current ShiftKey terms.',
  },
  {
    platformId: 'carerev',
    cancellationWindowHours: 12,
    penalty: 'Late cancellation can affect standing and may make you ineligible for that facility for a period.',
    effectiveFrom: '2026-01-01',
    lastReviewedAt: '2026-09-01',
    sourceNote: 'Illustrative — not verified against current CareRev terms.',
  },
  {
    platformId: 'clipboard',
    cancellationWindowHours: 24,
    penalty: 'Late cancellation is recorded against your rating and repeated occurrences can limit booking privileges.',
    effectiveFrom: '2026-01-01',
    lastReviewedAt: '2026-09-01',
    sourceNote: 'Illustrative — not verified against current Clipboard Health terms.',
  },
  {
    platformId: 'shiftmed',
    cancellationWindowHours: 3,
    penalty: 'Cancelling inside 3 hours of shift start may forfeit the shift pay and affect your standing.',
    effectiveFrom: '2026-01-01',
    lastReviewedAt: '2026-09-01',
    sourceNote: 'Illustrative — not verified against current ShiftMed terms.',
  },
  {
    platformId: 'intelycare',
    cancellationWindowHours: 6,
    penalty: 'Late cancellation lowers your IntelyScore, which affects which shifts you are offered.',
    effectiveFrom: '2026-01-01',
    lastReviewedAt: '2026-09-01',
    sourceNote: 'Illustrative — not verified against current IntelyCare terms.',
  },
]

export function policyFor(platformId: string): CancellationPolicy | undefined {
  return CANCELLATION_POLICIES.find((p) => p.platformId === platformId)
}

/**
 * §10.1 — the alert must say which window applies and how much time remains.
 * Returns the deadline instant for a shift, given "now".
 */
export function cancellationDeadline(
  shiftStartMs: number,
  policy: CancellationPolicy,
): number {
  return shiftStartMs - policy.cancellationWindowHours * 3_600_000
}

export interface WindowState {
  /** ms remaining until the window closes; negative means it has closed. */
  remainingMs: number
  closed: boolean
  /** The safer of two commitments to drop, judged purely on remaining time. */
  saferToCancelPlatformId: string | null
}

/**
 * Given the two shifts in a conflict, work out which one still has an open
 * cancellation window — i.e. which commitment is cheaper to walk away from.
 * This is the decision support §10 exists for.
 */
export function evaluateWindows(
  a: { platformId: string; startMs: number },
  b: { platformId: string; startMs: number },
  nowMs: number,
): { a: WindowState; b: WindowState; recommendation: 'a' | 'b' | null } {
  const state = (s: { platformId: string; startMs: number }): WindowState => {
    const policy = policyFor(s.platformId)
    if (!policy) {
      return { remainingMs: 0, closed: true, saferToCancelPlatformId: null }
    }
    const deadline = cancellationDeadline(s.startMs, policy)
    const remainingMs = deadline - nowMs
    return {
      remainingMs,
      closed: remainingMs <= 0,
      saferToCancelPlatformId: s.platformId,
    }
  }

  const sa = state(a)
  const sb = state(b)

  // Prefer the commitment whose window is still open. If both are open, the
  // one closing soonest is the urgent one to act on; if both are closed we
  // refuse to recommend — the system cannot know which is authoritative
  // (§20: inform the decision, never silently choose for the worker).
  let recommendation: 'a' | 'b' | null = null
  if (sa.closed && !sb.closed) recommendation = 'b'
  else if (!sa.closed && sb.closed) recommendation = 'a'
  else if (!sa.closed && !sb.closed) {
    recommendation = sa.remainingMs <= sb.remainingMs ? 'a' : 'b'
  }

  return { a: sa, b: sb, recommendation }
}
