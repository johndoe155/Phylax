import { Reveal } from '../ui/Reveal'
import { Section } from '../ui/Section'

/**
 * §11 — SMS is the primary rail because it is the one that always works.
 * Web push needs a PWA install and a permission that iOS quietly revokes;
 * SMS just arrives.
 */
export function Alerts() {
  return (
    <Section id="alerts" index="07" label="The alert rail" numeral="07">
      <Reveal className="grid gap-10 pt-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:gap-16">
        <div>
          <h2 className="t-h2 max-w-[15ch]">
            It reaches you on
            <br />
            the rail that <span className="text-sentinel">actually works.</span>
          </h2>
          <p className="t-lead mt-7 max-w-[46ch]">
            A warning you never see is worth nothing. So the critical path does not depend on an
            app install, a browser permission, or a notification setting you turned off six months
            ago.
          </p>

          <div className="mt-10 space-y-5">
            <Channel
              rank="primary"
              name="SMS"
              tone="sentinel"
              body="Works on every phone and operating system. No install, no permission prompt, no silent failure. The same rail that already tells you about appointments and two-factor codes."
            />
            <Channel
              rank="optional"
              name="Web push"
              tone="bone"
              body="A bonus for anyone who installs Phylax to their home screen. Never required, never a gate in onboarding."
            />
            <Channel
              rank="optional"
              name="Email"
              tone="bone"
              body="Low-urgency digests, if and when they earn their place. Not part of the core promise."
            />
          </div>

          <div className="mt-10 border-t border-hair pt-6">
            <p className="t-mono text-bone-mute">what triggers a message</p>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {[
                'A new shift directly overlaps an existing one',
                'A new shift leaves too little travel time',
                'A cancellation window is about to close',
                'A shift is approaching',
              ].map((e) => (
                <li key={e} className="flex items-baseline gap-3 text-sm text-bone-dim">
                  <span aria-hidden="true" className="mt-2 h-px w-3 shrink-0 bg-sentinel" />
                  {e}
                </li>
              ))}
            </ul>
            <p className="t-mono mt-5 max-w-[46ch] text-bone-mute">
              deliberately few. Reminders you mute are worse than none — frequency and quiet hours
              are configurable.
            </p>
          </div>
        </div>

        {/* ---- Phone mock ---- */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          <div
            className="relative mx-auto w-full max-w-[19rem] border border-hair-strong bg-ink-950 p-3"
            style={{ borderRadius: 26 }}
          >
            <div className="mx-auto mb-3 h-1 w-16 rounded-full bg-ink-400" />
            <div className="space-y-2.5 p-2">
              <div className="panel-inset p-3">
                <div className="flex items-baseline justify-between">
                  <span className="t-mono text-sentinel">Phylax</span>
                  <span className="t-mono text-bone-mute">now</span>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-bone">
                  <strong>Conflict:</strong> CareRev at Riverside Manor overlaps ShiftMed at
                  Greenfield tomorrow 7 PM.
                </p>
                <p className="mt-2 text-[13px] leading-relaxed text-bone">
                  ShiftMed window closes in 2:41:09. Tap to review both.
                </p>
              </div>
              <div className="panel-inset p-3 opacity-70">
                <div className="flex items-baseline justify-between">
                  <span className="t-mono text-bone-mute">Phylax</span>
                  <span className="t-mono text-bone-mute">2h ago</span>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-bone-dim">
                  Shift in 3h: Riverside Manor, Day 7–7.
                </p>
              </div>
            </div>
          </div>
          <p className="t-mono mt-4 text-center text-bone-mute">
            no install · no permission · no missed alert
          </p>
        </div>
      </Reveal>
    </Section>
  )
}

function Channel({
  rank,
  name,
  body,
  tone,
}: {
  rank: string
  name: string
  body: string
  tone: 'sentinel' | 'bone'
}) {
  return (
    <div className="grid gap-2 border-t border-hair pt-5 sm:grid-cols-[7rem_minmax(0,1fr)]">
      <div>
        <p className="t-mono" style={{ color: tone === 'sentinel' ? 'var(--color-sentinel)' : 'var(--color-bone-mute)' }}>
          {rank}
        </p>
        <p className="font-display text-xl font-extrabold tracking-tight text-bone" style={{ fontStretch: '108%' }}>
          {name}
        </p>
      </div>
      <p className="max-w-[48ch] text-sm leading-relaxed text-bone-dim">{body}</p>
    </div>
  )
}
