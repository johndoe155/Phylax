import { useMemo } from 'react'
import { ShiftCard } from '../ui/ShiftCard'
import { useDemo } from '../store/demo'
import { scrollToId } from '../motion/useMotionRuntime'
import { formatMinutes } from '../engine/format'

export function Hero() {
  const shifts = useDemo((s) => s.shifts)
  const conflicts = useDemo((s) => s.conflicts)

  const heroA = shifts.find((s) => s.id === 's-1')
  const heroB = shifts.find((s) => s.id === 's-2')
  const heroConflict = useMemo(
    () =>
      conflicts.find(
        (c) =>
          c.newShiftId === 's-1' ||
          c.existingShiftId === 's-1' ||
          c.newShiftId === 's-2' ||
          c.existingShiftId === 's-2',
      ),
    [conflicts],
  )
  // Both cards carry the same conflict record — it belongs to the pair.
  const pair = heroConflict ? [heroConflict] : []

  const activeCount = shifts.filter((s) => s.status === 'active').length
  const platforms = new Set(shifts.filter((s) => s.status === 'active').map((s) => s.platformId))
  const worst = conflicts[0]

  return (
    <section id="top" className="relative min-h-[100svh] w-full overflow-hidden pt-16">
      <div className="shell relative flex min-h-[calc(100svh-4rem)] flex-col justify-between py-10 lg:py-14">
        {/* ---- Kicker ---- */}
        <div className="is-in flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sentinel opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sentinel" />
          </span>
          <span className="t-mono text-sentinel">Cross-platform shift guardrail</span>
          <span className="t-mono text-bone-mute">for per-diem CNAs · LPNs · RNs</span>
        </div>

        {/* ---- Headline ---- */}
        <div className="is-in relative z-10 my-10 lg:my-14">
          <h1 className="t-display max-w-[16ch]">
            <span className="reveal-line">
              <span>Never get</span>
            </span>
            <span className="reveal-line">
              <span className="text-sentinel">booked</span>
            </span>
            <span className="reveal-line">
              <span>twice.</span>
            </span>
          </h1>

          <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-end">
            <p className="t-lead max-w-[46ch]">
              Log accepted shifts from every staffing app in one place. The second you save one,
              Phylax checks it for time overlap, travel buffer and cancellation exposure —
              including overnight shifts that cross midnight.
            </p>

            <dl className="grid grid-cols-3 gap-4 border-t border-hair pt-5">
              <Stat value={String(activeCount)} label="shifts tracked" />
              <Stat value={String(platforms.size)} label="platforms" />
              <Stat
                value={worst ? formatMinutes(worst.overlapMinutes ?? worst.gapMinutes ?? 0) : '0'}
                label={worst ? 'worst conflict' : 'all clear'}
                tone={worst ? 'alert' : 'clear'}
              />
            </dl>
          </div>
        </div>

        {/* ---- The live conflict ---- */}
        <div className="relative z-10 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,34rem)]">
          <div className="order-2 lg:order-1">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => scrollToId('pricing')}
                className="group relative overflow-hidden bg-sentinel px-6 py-3.5"
                style={{ borderRadius: 2 }}
              >
                <span className="t-mono relative z-10 text-ink-950">Start free</span>
              </button>
              <button
                type="button"
                onClick={() => scrollToId('engine')}
                className="t-mono border border-hair px-6 py-3.5 text-bone-dim transition-colors hover:border-sentinel hover:text-sentinel"
                style={{ borderRadius: 2 }}
              >
                See the engine
              </button>
            </div>

            <p className="t-mono mt-6 max-w-[34ch] text-bone-mute">
              Three taps to log a shift. No scraping, no integrations, no calendar to migrate.
            </p>
          </div>

          {heroA && heroB ? (
            <div className="order-1 space-y-3 lg:order-2">
              <p className="t-mono text-alert">
                {heroConflict ? `⚠ ${heroConflict.type} detected` : 'no conflict'}
              </p>
              <ShiftCard shift={heroA} conflicts={pair} tracked />
              <ShiftCard shift={heroB} conflicts={pair} />
              {heroConflict ? (
                <p className="panel-inset p-3 text-xs leading-relaxed text-bone-dim">
                  {heroConflict.message}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* ---- Scroll cue ---- */}
      <div className="shell pointer-events-none absolute inset-x-0 bottom-4 flex items-center justify-between">
        <span className="t-mono text-bone-mute">scroll</span>
        <span className="h-8 w-px bg-gradient-to-b from-sentinel to-transparent" />
      </div>
    </section>
  )
}

function Stat({
  value,
  label,
  tone = 'bone',
}: {
  value: string
  label: string
  tone?: 'bone' | 'alert' | 'clear'
}) {
  const color =
    tone === 'alert' ? 'var(--color-alert)' : tone === 'clear' ? 'var(--color-clear)' : 'var(--color-bone)'
  return (
    <div>
      <dt className="t-mono text-bone-mute">{label}</dt>
      <dd
        className="font-display text-2xl font-extrabold tabular-nums sm:text-3xl"
        style={{ color, fontStretch: '112%' }}
      >
        {value}
      </dd>
    </div>
  )
}
