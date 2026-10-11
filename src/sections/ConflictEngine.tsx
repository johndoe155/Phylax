import { useMemo } from 'react'
import { Reveal } from '../ui/Reveal'
import { Section } from '../ui/Section'
import { MidnightRing } from '../ui/MidnightRing'
import { useDemo } from '../store/demo'
import { SEVERITY_LABEL } from '../engine/detect'
import { formatMinutes } from '../engine/format'
import type { Severity } from '../engine'

/**
 * §9 — the engine, shown working. Nothing here is decorative: the overlap
 * rule, the midnight normalization, the configurable buffer and the severity
 * ladder are the same code paths the unit tests exercise.
 */
const LADDER: { severity: Severity; rule: string }[] = [
  { severity: 'critical', rule: 'Direct time overlap. You cannot attend both.' },
  { severity: 'high', rule: 'Travel buffer impossible, or extremely short.' },
  { severity: 'warning', rule: 'Buffer below your preferred threshold.' },
  { severity: 'info', rule: 'Close to another commitment, not yet a problem.' },
]

const SEVERITY_VAR: Record<Severity, string> = {
  critical: 'var(--color-alert)',
  high: 'var(--color-alert)',
  warning: 'var(--color-caution)',
  info: 'var(--color-sentinel)',
}

export function ConflictEngine() {
  const shifts = useDemo((s) => s.shifts)
  const conflicts = useDemo((s) => s.conflicts)
  const today = useDemo((s) => s.today)
  const options = useDemo((s) => s.options)
  const setBuffer = useDemo((s) => s.setBuffer)

  const tonight = useMemo(
    () => shifts.filter((s) => s.status === 'active' && s.date === today && s.crossesMidnight),
    [shifts, today],
  )

  const counts = useMemo(() => {
    const out: Record<Severity, number> = { critical: 0, high: 0, warning: 0, info: 0 }
    for (const c of conflicts) out[c.severity] += 1
    return out
  }, [conflicts])

  return (
    <Section id="engine" index="04" label="Conflict engine" numeral="04">
      <Reveal className="pt-6">
        <h2 className="t-h2 max-w-[16ch]">
          The only part of this
          <br />
          that has to be <span className="text-sentinel">exactly right.</span>
        </h2>
        <p className="t-lead mt-7 max-w-[50ch]">
          Everything else on this page is design. This is arithmetic on your livelihood — so the
          rules are written down, the inputs are visible, and the check runs on your device the
          instant you hit save.
        </p>
      </Reveal>

      {/* ---- 9.2 Overlap ---- */}
      <Reveal className="mt-16 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
        <div>
          <p className="t-mono text-sentinel">§9.2 · direct overlap</p>
          <h3 className="t-h3 mt-4 text-bone">Strict interval intersection</h3>
          <pre className="panel-inset mt-5 overflow-x-auto p-4 font-mono text-xs leading-relaxed text-bone-dim sm:text-sm">
{`conflict if
  N.start < E.end
  AND N.end > E.start`}
          </pre>
          <p className="mt-5 max-w-[46ch] text-sm leading-relaxed text-bone-dim">
            Strictly less-than, on purpose. A shift ending exactly when the next begins is{' '}
            <em>not</em> an overlap — that is a legal back-to-back. It may still fail the travel
            buffer, which is a different question with a different answer.
          </p>
        </div>

        {/* ---- 9.3 Midnight ---- */}
        <div>
          <p className="t-mono text-sentinel">§9.3 · midnight crossing</p>
          <h3 className="t-h3 mt-4 text-bone">One continuous interval, not two fragments</h3>
          <div className="mt-6 flex justify-center lg:justify-start">
            <MidnightRing shifts={tonight.length ? tonight : shifts.slice(0, 1)} size={280} />
          </div>
          <p className="mt-4 max-w-[46ch] text-sm leading-relaxed text-bone-dim">
            A 7 PM to 7 AM shift ends on the <em>following</em> calendar day. Get that wrong and
            the engine misses every overlap an overnight shift creates — and overnight shifts are
            the norm, not the exception.
          </p>
        </div>
      </Reveal>

      {/* ---- 9.4 Buffer, live ---- */}
      <Reveal className="mt-16 border-t border-hair pt-10">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
          <div>
            <p className="t-mono text-sentinel">§9.4 · commute buffer</p>
            <h3 className="t-h3 mt-4 text-bone">Configurable, and honest about it</h3>
            <p className="mt-5 max-w-[46ch] text-sm leading-relaxed text-bone-dim">
              Where a facility has coordinates we estimate travel at a fixed average speed, apply a
              road-distance correction, then add a safety margin. Where it does not, we fall back
              to your default and say so. We are not pretending to predict traffic.
            </p>
            <pre className="panel-inset mt-5 overflow-x-auto p-4 font-mono text-xs leading-relaxed text-bone-dim">
{`available = next.start - prev.end
conflict if available < required`}
            </pre>
          </div>

          <div className="panel p-5 sm:p-6">
            <div className="flex items-baseline justify-between">
              <label htmlFor="buffer" className="t-mono text-bone-mute">
                your minimum buffer
              </label>
              <span className="font-mono text-2xl tabular-nums text-sentinel">
                {options.defaultBufferMinutes}
                <span className="text-sm text-bone-mute"> min</span>
              </span>
            </div>

            <input
              id="buffer"
              type="range"
              min={15}
              max={120}
              step={5}
              value={options.defaultBufferMinutes}
              onChange={(e) => setBuffer(Number(e.target.value))}
              className="mt-4 w-full accent-[#4DE1FF]"
              aria-describedby="buffer-help"
            />
            <p id="buffer-help" className="t-mono mt-3 text-bone-mute">
              drag — the board below re-evaluates every shift live
            </p>

            <dl className="mt-6 grid grid-cols-4 gap-3 border-t border-hair pt-5">
              {LADDER.map((l) => (
                <div key={l.severity}>
                  <dt className="t-mono" style={{ color: SEVERITY_VAR[l.severity] }}>
                    {l.severity}
                  </dt>
                  <dd
                    className="font-display text-2xl font-extrabold tabular-nums text-bone"
                    style={{ fontStretch: '112%' }}
                  >
                    {counts[l.severity]}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </Reveal>

      {/* ---- 9.6 Ladder ---- */}
      <Reveal className="mt-16 border-t border-hair pt-10">
        <p className="t-mono text-bone-mute">§9.6 · severity model</p>
        <ul className="mt-5 space-y-0">
          {LADDER.map((l) => (
            <li
              key={l.severity}
              className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-b border-hair py-4"
            >
              <span
                className="t-mono w-24 shrink-0 uppercase"
                style={{ color: SEVERITY_VAR[l.severity] }}
              >
                {l.severity}
              </span>
              <span className="font-display text-lg font-bold tracking-tight text-bone">
                {SEVERITY_LABEL[l.severity]}
              </span>
              <span className="text-sm text-bone-dim">{l.rule}</span>
            </li>
          ))}
        </ul>
        <p className="t-mono mt-6 max-w-[52ch] text-bone-mute">
          The distinction that matters: “cannot attend both” is not the same warning as “risky
          transition”. They need different words, different colours and different urgency.
        </p>
      </Reveal>

      {/* ---- 9.5 Instant ---- */}
      <Reveal className="mt-14">
        <div className="panel grain flex flex-wrap items-center justify-between gap-6 p-6">
          <div>
            <p className="t-mono text-sentinel">§9.5 · client-side</p>
            <h3 className="t-h3 mt-3 max-w-[24ch] text-bone">
              The warning appears before the request finishes
            </h3>
          </div>
          <p className="max-w-[38ch] text-sm leading-relaxed text-bone-dim">
            The check runs against the shift list already on your device. No round trip, no
            spinner, no “checking…”. The backend re-validates on write so two devices can never
            disagree — but the interface never waits on the network to tell you the truth.
          </p>
        </div>
      </Reveal>

      {/* ---- live summary strip ---- */}
      <Reveal className="mt-8">
        <p className="t-mono text-bone-mute">
          currently evaluating {shifts.filter((s) => s.status === 'active').length} active shifts ·{' '}
          {conflicts.length} conflicts · worst gap{' '}
          {conflicts[0]
            ? formatMinutes(conflicts[0].gapMinutes ?? conflicts[0].overlapMinutes ?? 0)
            : '—'}
        </p>
      </Reveal>
    </Section>
  )
}
