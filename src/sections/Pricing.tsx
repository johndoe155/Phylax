import { useState } from 'react'
import { Reveal } from '../ui/Reveal'
import { Section } from '../ui/Section'

/**
 * §15 — pricing framed against a single avoidable penalty (§15.3), not
 * against other software. The free cap is a placeholder: §20.2 leaves it open
 * and it should be chosen from real concurrent-shift data.
 */
const FREE_CAP = 5

export function Pricing() {
  const [annual, setAnnual] = useState(true)

  return (
    <Section id="pricing" index="09" label="Pricing" numeral="09">
      <Reveal className="grid gap-10 pt-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:gap-16">
        <div>
          <h2 className="t-h2 max-w-[15ch]">
            Cheaper than
            <br />
            <span className="text-sentinel">one</span> avoidable no-show.
          </h2>
          <p className="t-lead mt-7 max-w-[44ch]">
            Not priced against other software. Priced against a single cancellation penalty, a
            single forfeited shift, or a single lost platform standing — any one of which costs
            more than a year of this.
          </p>

          <ul className="mt-9 space-y-3">
            {[
              'One cancellation penalty',
              'One no-show',
              'One lost shift',
              'One platform access consequence',
            ].map((item) => (
              <li key={item} className="flex items-baseline gap-3 text-bone-dim">
                <span aria-hidden="true" className="mt-2 h-px w-4 shrink-0 bg-alert" />
                {item}
              </li>
            ))}
          </ul>

          <p className="t-mono mt-8 max-w-[42ch] text-bone-mute">
            the intended upgrade moment: you have real shifts across two or more platforms and need
            to track more than the free tier allows
          </p>
        </div>

        <div>
          <div className="mb-5 flex items-center gap-1 border border-hair p-1" style={{ borderRadius: 3 }}>
            {[
              { id: false, label: 'monthly' },
              { id: true, label: 'annual' },
            ].map((opt) => (
              <button
                key={String(opt.id)}
                type="button"
                onClick={() => setAnnual(opt.id)}
                aria-pressed={annual === opt.id}
                className="t-mono flex-1 px-3 py-2 transition-colors"
                style={{
                  borderRadius: 2,
                  background: annual === opt.id ? 'var(--color-sentinel)' : 'transparent',
                  color: annual === opt.id ? 'var(--color-ink-950)' : 'var(--color-bone-mute)',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="panel grain p-6">
            <p className="t-mono text-sentinel">phylax pro</p>
            <p className="mt-4 flex items-baseline gap-2">
              <span
                className="font-display font-black tabular-nums text-bone"
                style={{ fontSize: 'clamp(3.5rem,7vw,5rem)', fontStretch: '120%', lineHeight: 0.85 }}
              >
                ${annual ? 79 : 9}
              </span>
              <span className="t-mono text-bone-mute">/{annual ? 'year' : 'month'}</span>
            </p>
            {annual ? (
              <p className="t-mono mt-3 text-clear">saves $29 a year vs monthly</p>
            ) : null}

            <ul className="mt-6 space-y-2.5 border-t border-hair pt-5">
              {[
                'Unlimited tracked shifts',
                'Conflict + travel-buffer detection',
                'Cancellation-window alerts',
                'SMS alerts with configurable quiet hours',
                'Midnight-aware overnight shifts',
              ].map((f) => (
                <li key={f} className="flex items-baseline gap-3 text-sm text-bone-dim">
                  <span aria-hidden="true" className="text-clear">✓</span>
                  {f}
                </li>
              ))}
            </ul>

            <button
              type="button"
              className="mt-6 w-full bg-sentinel py-3.5 transition-transform active:scale-[0.99]"
              style={{ borderRadius: 2 }}
            >
              <span className="t-mono text-ink-950">Start free — no card</span>
            </button>
          </div>

          <div className="panel-inset mt-4 p-5">
            <p className="t-mono text-bone-mute">free tier</p>
            <p className="mt-2 text-sm text-bone-dim">
              Up to <strong className="text-bone">{FREE_CAP} active shifts</strong> tracked, with
              full conflict detection. Enough to prove the loop; capped before it becomes a
              full-time calendar.
            </p>
            <p className="t-mono mt-3 text-bone-mute">
              cap is a placeholder pending real concurrent-shift data
            </p>
          </div>
        </div>
      </Reveal>
    </Section>
  )
}
