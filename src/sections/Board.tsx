import { useMemo } from 'react'
import { Reveal } from '../ui/Reveal'
import { Section } from '../ui/Section'
import { ShiftCard } from '../ui/ShiftCard'
import { useDemo } from '../store/demo'
import { addDaysISO, formatDayLabel } from '../engine/format'

/**
 * §14.4 / §14.7 — the shift board, with the removal gesture from §6.3.
 * Healthcare shifts get cancelled constantly, so deleting one has to be as
 * fast as adding one. Swipe it away; no confirmation modal, no form.
 */
export function Board() {
  const shifts = useDemo((s) => s.shifts)
  const today = useDemo((s) => s.today)
  const conflicts = useDemo((s) => s.conflicts)
  const cancelShift = useDemo((s) => s.cancelShift)
  const restoreShift = useDemo((s) => s.restoreShift)
  const reset = useDemo((s) => s.reset)

  const days = useMemo(() => {
    const out: { date: string; items: typeof shifts }[] = []
    for (let i = 0; i < 3; i++) {
      const date = addDaysISO(today, i)
      const items = shifts.filter((s) => s.date === date && s.status !== 'completed')
      if (items.length) out.push({ date, items })
    }
    return out
  }, [shifts, today])

  const cancelledCount = shifts.filter((s) => s.status === 'cancelled').length

  return (
    <Section id="board" index="06" label="The board" numeral="06">
      <Reveal className="grid gap-10 pt-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-16">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <h2 className="t-h2 max-w-[13ch]">
            Removal is
            <br />
            a <span className="text-sentinel">gesture,</span>
            <br />
            not a form.
          </h2>
          <p className="t-lead mt-7 max-w-[38ch]">
            Per-diem shifts get cancelled constantly — by you, by the facility, by the platform.
            A tool that makes removal harder than booking will get abandoned the first time it
            happens.
          </p>
          <p className="mt-6 max-w-[38ch] text-sm leading-relaxed text-bone-dim">
            Drag a card left past the threshold and it is gone. Release early and it springs back.
            No confirmation dialog, no multi-step flow, no “are you sure?”.
          </p>

          <div className="mt-7 flex items-center gap-4 border-t border-hair pt-5">
            <span className="t-mono text-bone-mute">{cancelledCount} cancelled</span>
            <button
              type="button"
              onClick={reset}
              className="t-mono border border-hair px-3 py-1.5 text-bone-dim transition-colors hover:border-sentinel hover:text-sentinel"
            >
              restore week
            </button>
          </div>

          <p className="t-mono mt-6 max-w-[34ch] text-bone-mute">
            ← drag any card on the right
          </p>
        </div>

        <div className="space-y-8">
          {days.map(({ date, items }) => (
            <div key={date}>
              <div className="mb-3 flex items-baseline justify-between border-b border-hair pb-2">
                <h3 className="font-display text-lg font-extrabold tracking-tight text-bone" style={{ fontStretch: '106%' }}>
                  {formatDayLabel(date, today)}
                </h3>
                <span className="t-mono text-bone-mute">{date}</span>
              </div>

              <ul className="space-y-2.5">
                {items.map((shift) => (
                  <li key={shift.id}>
                    <ShiftCard
                      shift={shift}
                      conflicts={conflicts.filter(
                        (c) => c.newShiftId === shift.id || c.existingShiftId === shift.id,
                      )}
                      onSwipeCancel={cancelShift}
                      onRestore={restoreShift}
                      tracked
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Reveal>
    </Section>
  )
}
