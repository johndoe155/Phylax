import { useMemo, useState } from 'react'
import { Reveal } from '../ui/Reveal'
import { Section } from '../ui/Section'
import { MagneticTile } from '../ui/MagneticTile'
import { PlatformGlyph } from '../ui/ShiftCard'
import { useDemo, platformMap, facilityMap } from '../store/demo'
import { PLATFORMS, TEMPLATES } from '../data/seed'
import { addDaysISO, formatDayLabel, formatRange } from '../engine/format'
import type { Shift } from '../engine'

/**
 * §6 — the locked interaction model, built as a working control:
 * Platform → Saved template → Date → Save → immediate conflict result.
 *
 * This is not a mockup. Saving here writes a real Shift into the store, the
 * real engine evaluates it, and the real result renders.
 */
const STEPS = ['Platform', 'Template', 'Date', 'Result'] as const

export function GuardrailLoop() {
  const today = useDemo((s) => s.today)
  const logShift = useDemo((s) => s.logShift)
  const shifts = useDemo((s) => s.shifts)
  const conflicts = useDemo((s) => s.conflicts)

  const [step, setStep] = useState(0)
  const [platformId, setPlatformId] = useState<string | null>(null)
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [date, setDate] = useState<string>(today)
  const [resultId, setResultId] = useState<string | null>(null)

  const template = TEMPLATES.find((t) => t.id === templateId) ?? null
  const platform = platformId ? platformMap.get(platformId) : null
  const facility = template ? facilityMap.get(template.facilityId) : null

  const result = useMemo(
    () => (resultId ? shifts.find((s) => s.id === resultId) : null),
    [resultId, shifts],
  )
  const resultConflicts = useMemo(
    () =>
      result
        ? conflicts.filter((c) => c.newShiftId === result.id || c.existingShiftId === result.id)
        : [],
    [result, conflicts],
  )

  const save = () => {
    if (!platformId || !template) return
    const id = `demo-${Date.now().toString(36)}`
    const shift: Shift = {
      id,
      platformId,
      facilityId: template.facilityId,
      date,
      start: template.start,
      end: template.end,
      crossesMidnight: template.crossesMidnight,
      status: 'active',
    }
    logShift(shift)
    setResultId(id)
    setStep(3)
  }

  const reset = () => {
    setStep(0)
    setPlatformId(null)
    setTemplateId(null)
    setDate(today)
    setResultId(null)
  }

  const dates = [today, addDaysISO(today, 1), addDaysISO(today, 2)]

  return (
    <Section id="loop" index="02" label="The locked loop" numeral="02">
      <Reveal className="grid gap-10 pt-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,34rem)] lg:gap-16">
        <div>
          <h2 className="t-h2 max-w-[15ch]">
            Four taps.
            <br />
            <span className="text-sentinel">Zero typing.</span>
          </h2>
          <p className="t-lead mt-7 max-w-[44ch]">
            The entire logging flow is a locked sequence. Platform, saved template, date, save.
            Nothing else is required — no forms, no time pickers, no address entry in the common
            case.
          </p>

          <ol className="mt-9 space-y-0 border-t border-hair">
            {STEPS.map((label, i) => (
              <li
                key={label}
                className="flex items-center gap-5 border-b border-hair py-4 transition-colors"
                style={{ color: i === step ? 'var(--color-bone)' : 'var(--color-bone-mute)' }}
              >
                <span
                  className="font-mono text-xs tabular-nums"
                  style={{ color: i === step ? 'var(--color-sentinel)' : undefined }}
                >
                  0{i + 1}
                </span>
                <span
                  className="font-display text-lg font-bold tracking-tight"
                  style={{ fontStretch: '106%' }}
                >
                  {label}
                </span>
                {i === step ? (
                  <span className="t-mono ml-auto text-sentinel">active</span>
                ) : i < step ? (
                  <span className="t-mono ml-auto text-clear">done</span>
                ) : null}
              </li>
            ))}
          </ol>

          <p className="t-mono mt-6 max-w-[38ch] text-bone-mute">
            Off-pattern shift? A time picker exists. It is the exception path, never the default.
          </p>
        </div>

        {/* ---- The live control ---- */}
        <div className="panel grain relative overflow-hidden p-5 sm:p-6">
          <p className="t-mono text-bone-mute">
            interactive · step {step + 1} of 4
          </p>

          <div className="mt-5 min-h-[19rem]">
            {step === 0 ? (
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {PLATFORMS.map((p) => (
                  <MagneticTile
                    key={p.id}
                    accent={p.accent}
                    selected={platformId === p.id}
                    onClick={() => {
                      setPlatformId(p.id)
                      setStep(1)
                    }}
                    className="p-3.5"
                    ariaLabel={`Select ${p.name}`}
                  >
                    <PlatformGlyph code={p.code} accent={p.accent} />
                    <span className="mt-2.5 block text-sm font-medium text-bone">{p.name}</span>
                  </MagneticTile>
                ))}
              </div>
            ) : null}

            {step === 1 ? (
              <div className="space-y-2.5">
                {TEMPLATES.map((t) => {
                  const f = facilityMap.get(t.facilityId)
                  return (
                    <MagneticTile
                      key={t.id}
                      tilt={5}
                      selected={templateId === t.id}
                      onClick={() => {
                        setTemplateId(t.id)
                        setStep(2)
                      }}
                      className="flex w-full items-center justify-between gap-4 p-3.5"
                      ariaLabel={`${f?.name} ${t.label}`}
                    >
                      <span>
                        <span className="block text-sm font-medium text-bone">{f?.name}</span>
                        <span className="t-mono mt-0.5 block text-bone-mute">{t.label}</span>
                      </span>
                      <span className="font-mono text-xs tabular-nums text-bone-dim">
                        {formatRange(t.start, t.end, t.crossesMidnight)}
                      </span>
                    </MagneticTile>
                  )
                })}
              </div>
            ) : null}

            {step === 2 ? (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-2.5">
                  {dates.map((d, i) => (
                    <MagneticTile
                      key={d}
                      tilt={6}
                      selected={date === d}
                      onClick={() => setDate(d)}
                      className="p-3.5 text-center"
                      ariaLabel={formatDayLabel(d, today)}
                    >
                      <span className="t-mono block text-bone-mute">
                        {i === 0 ? 'today' : i === 1 ? 'tomorrow' : '+2'}
                      </span>
                      <span className="mt-1.5 block font-mono text-sm tabular-nums text-bone">
                        {d.slice(5)}
                      </span>
                    </MagneticTile>
                  ))}
                </div>

                <div className="panel-inset p-4">
                  <p className="t-mono text-bone-mute">about to log</p>
                  <p className="mt-2 text-sm text-bone">
                    {platform?.name} · {facility?.name}
                  </p>
                  <p className="font-mono text-sm tabular-nums text-sentinel">
                    {template ? formatRange(template.start, template.end, template.crossesMidnight) : ''}{' '}
                    · {formatDayLabel(date, today)}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={save}
                  className="w-full bg-sentinel py-3.5 transition-transform active:scale-[0.99]"
                  style={{ borderRadius: 2 }}
                >
                  <span className="t-mono text-ink-950">Save &amp; check</span>
                </button>
              </div>
            ) : null}

            {step === 3 && result ? (
              <div className="space-y-4">
                {resultConflicts.length === 0 ? (
                  <div className="panel-inset p-5">
                    <p className="t-mono text-clear">✓ clear</p>
                    <p className="mt-2 font-display text-xl font-extrabold tracking-tight text-bone">
                      No conflict
                    </p>
                    <p className="mt-2 text-sm text-bone-dim">
                      Nothing overlaps and every travel buffer clears your threshold. Saved.
                    </p>
                  </div>
                ) : (
                  <div className="glass-alarm p-5" style={{ borderRadius: 3 }}>
                    <p className="t-mono text-alert">⚠ conflict detected</p>
                    <p className="mt-2 font-display text-xl font-extrabold tracking-tight text-bone">
                      {resultConflicts[0].type === 'overlap'
                        ? 'You are double-booked'
                        : 'Tight travel window'}
                    </p>
                    <ul className="mt-3 space-y-2">
                      {resultConflicts.map((c) => (
                        <li key={c.id} className="text-sm leading-relaxed text-bone-dim">
                          {c.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="t-mono text-bone-mute">
                  Phylax informs the decision — it never silently cancels a shift for you.
                </p>
              </div>
            ) : null}
          </div>

          <div className="mt-5 flex items-center justify-between border-t border-hair pt-4">
            <button
              type="button"
              onClick={reset}
              className="t-mono text-bone-mute transition-colors hover:text-bone"
            >
              reset
            </button>
            <span className="t-mono text-bone-mute">
              {platform?.name ?? '—'} · {template?.label ?? '—'} · {date.slice(5)}
            </span>
          </div>
        </div>
      </Reveal>
    </Section>
  )
}
