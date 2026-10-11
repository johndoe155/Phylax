import { useMemo } from 'react'
import { Reveal } from '../ui/Reveal'
import { Section } from '../ui/Section'
import { Countdown } from '../ui/Countdown'
import { PlatformGlyph } from '../ui/ShiftCard'
import { addDaysISO, formatTime } from '../engine/format'
import { DISCLAIMER, evaluateWindows, policyFor } from '../engine/policy'

/** Local wall clock → epoch ms, using the browser's own timezone. */
function localMs(dateISO: string, hhmm: string): number {
  const [y, m, d] = dateISO.split('-').map(Number)
  const [hh, mm] = hhmm.split(':').map(Number)
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime()
}

/**
 * §10 — cancellation-policy intelligence.
 *
 * "You have a conflict" is half the answer. The half that changes behaviour
 * is which commitment is still cheap to walk away from, and for how long.
 */
export function PolicyIntelligence({ today }: { today: string }) {
  const scenario = useMemo(() => {
    const tomorrow = addDaysISO(today, 1)
    const a = { platformId: 'shiftkey', startMs: localMs(tomorrow, '19:00'), label: 'Riverside Manor · Night 7–7' }
    const b = { platformId: 'shiftmed', startMs: localMs(tomorrow, '19:00'), label: 'Greenfield Rehab · Night 7–7' }
    return { a, b, tomorrow }
  }, [today])

  const windows = useMemo(
    () => evaluateWindows(scenario.a, scenario.b, Date.now()),
    [scenario],
  )

  const policyA = policyFor(scenario.a.platformId)
  const policyB = policyFor(scenario.b.platformId)
  const recommended = windows.recommendation === 'a' ? scenario.a : windows.recommendation === 'b' ? scenario.b : null

  return (
    <Section id="policy" index="05" label="Cancellation policy" numeral="05">
      <Reveal className="grid gap-10 pt-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,32rem)] lg:gap-16">
        <div>
          <h2 className="t-h2 max-w-[15ch]">
            “You have a conflict”
            <br />
            is only <span className="text-alert">half</span> the answer.
          </h2>
          <p className="t-lead mt-7 max-w-[44ch]">
            The useful half is what to do next. Which commitment is still cheap to walk away from,
            which platform’s window is closing, and how much time is actually left.
          </p>

          <div className="panel-inset mt-8 border-l-2 p-5" style={{ borderLeftColor: 'var(--color-alert)' }}>
            <p className="t-mono text-alert">conflict detected</p>
            <p className="mt-3 text-sm leading-relaxed text-bone-dim sm:text-base">
              Your <strong className="text-bone">CareRev</strong> shift at{' '}
              <strong className="text-bone">Riverside Manor</strong> overlaps with your{' '}
              <strong className="text-bone">ShiftMed</strong> shift at{' '}
              <strong className="text-bone">St. Anne’s</strong>. ShiftMed’s cancellation window
              closes in 3 hours. Review both commitments before cancelling.
            </p>
            <p className="t-mono mt-4 text-bone-mute">
              every alert names both shifts, both platforms, the conflict type, the window that
              applies, and the deadline
            </p>
          </div>

          <ul className="mt-8 space-y-3">
            {[
              'The two conflicting shifts, with facilities and times',
              'Which staffing platforms are involved',
              'The conflict type — overlap, or travel buffer',
              'Which cancellation window applies',
              'The deadline, and the time remaining on it',
              'A clear next action, not just a red banner',
            ].map((item) => (
              <li key={item} className="flex items-baseline gap-3 text-sm text-bone-dim">
                <span aria-hidden="true" className="mt-2 h-px w-4 shrink-0 bg-sentinel" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        {/* ---- The live window ---- */}
        <div className="space-y-4">
          <div className="panel grain p-5">
            <p className="t-mono text-bone-mute">live window · {scenario.tomorrow}</p>

            <div className="mt-4 space-y-4">
              <Commitment
                code="SK"
                accent="#4DE1FF"
                name="ShiftKey"
                detail={scenario.a.label}
                time={`starts ${formatTime('19:00')}`}
                window={policyA?.cancellationWindowHours}
                closed={windows.a.closed}
                recommended={windows.recommendation === 'a'}
              />
              <Commitment
                code="SM"
                accent="#FF8A4D"
                name="ShiftMed"
                detail={scenario.b.label}
                time={`starts ${formatTime('19:00')}`}
                window={policyB?.cancellationWindowHours}
                closed={windows.b.closed}
                recommended={windows.recommendation === 'b'}
              />
            </div>

            <div className="mt-5 border-t border-hair pt-5">
              <Countdown
                deadlineMs={
                  windows.recommendation === 'b' || windows.a.closed
                    ? windows.b.remainingMs + Date.now()
                    : windows.a.remainingMs + Date.now()
                }
                windowMs={(recommended?.platformId === 'shiftmed'
                  ? (policyB?.cancellationWindowHours ?? 3)
                  : (policyA?.cancellationWindowHours ?? 24)) * 3_600_000}
                label={
                  windows.recommendation === 'b' || windows.a.closed
                    ? 'shiftmed window closes in'
                    : 'shiftkey window closes in'
                }
              />
            </div>

            <p className="mt-5 text-sm leading-relaxed text-bone-dim">
              {recommended
                ? `Safer to cancel: ${recommended.platformId === 'shiftkey' ? 'ShiftKey' : 'ShiftMed'} — its window is still open. Phylax will never cancel anything for you; it shows you the cheaper exit and you decide.`
                : 'Both windows are closed. Phylax will not guess which commitment is authoritative — it tells you, and you call it.'}
            </p>
          </div>

          <div className="panel-inset p-4">
            <p className="t-mono text-caution">⚠ policy disclaimer</p>
            <p className="mt-2 text-xs leading-relaxed text-bone-mute">{DISCLAIMER}</p>
          </div>
        </div>
      </Reveal>
    </Section>
  )
}

function Commitment({
  code,
  accent,
  name,
  detail,
  time,
  window: hours,
  closed,
  recommended,
}: {
  code: string
  accent: string
  name: string
  detail: string
  time: string
  window?: number
  closed: boolean
  recommended: boolean
}) {
  return (
    <div
      className="relative border p-4"
      style={{
        borderRadius: 2,
        borderColor: recommended ? 'var(--color-clear)' : 'var(--color-hair)',
        background: recommended ? 'rgba(61,220,151,0.06)' : undefined,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <PlatformGlyph code={code} accent={accent} />
          <div>
            <p className="text-sm font-medium text-bone">{name}</p>
            <p className="t-mono mt-0.5 text-bone-mute">{detail}</p>
            <p className="t-mono mt-0.5 text-bone-mute">{time}</p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="t-mono" style={{ color: closed ? 'var(--color-alert)' : 'var(--color-clear)' }}>
            {closed ? 'window closed' : 'window open'}
          </p>
          <p className="font-mono text-xs tabular-nums text-bone-dim">{hours}h notice</p>
        </div>
      </div>
      {recommended ? (
        <p className="t-mono mt-3 border-t border-hair pt-2.5 text-clear">
          ✓ safer to cancel
        </p>
      ) : null}
    </div>
  )
}
