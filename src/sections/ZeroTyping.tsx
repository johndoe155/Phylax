import { useEffect, useState } from 'react'
import { Reveal } from '../ui/Reveal'
import { Section } from '../ui/Section'

/**
 * §7 — adoption lives or dies on not adding friction to an already demanding
 * job. This section demonstrates the autocomplete keystroke-by-keystroke.
 */
const QUERY = 'riversi'
const MATCH = 'Riverside Manor · 1 Riverside Rd, Chicago IL'

export function ZeroTyping() {
  const [typed, setTyped] = useState(0)
  const [run, setRun] = useState(false)

  useEffect(() => {
    if (!run) return
    if (typed >= QUERY.length) {
      const hold = window.setTimeout(() => {
        setTyped(0)
        setRun(false)
      }, 3200)
      return () => window.clearTimeout(hold)
    }
    const id = window.setTimeout(() => setTyped((t) => t + 1), 130)
    return () => window.clearTimeout(id)
  }, [typed, run])

  const shown = QUERY.slice(0, typed)

  return (
    <Section id="zero-typing" index="03" label="Zero typing" numeral="03">
      <Reveal className="grid gap-10 pt-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:gap-16">
        <div>
          <h2 className="t-h2 max-w-[13ch]">
            If it needs
            <br />
            typing, <span className="text-sentinel">it fails.</span>
          </h2>
          <p className="t-lead mt-7 max-w-[44ch]">
            Per-diem work is physically demanding and administratively hostile. A tool that adds
            data entry to it will be abandoned in a week. So the whole product is built around not
            asking you to type.
          </p>

          <div className="mt-10 space-y-6">
            <Principle
              n="7.1"
              title="Saved shift templates"
              body="Facilities alone are not enough — you would still enter start and end times every time. Phylax stores the combination: facility, typical start, typical end, and a label. One tap logs a 12-hour pattern."
            />
            <Principle
              n="7.2"
              title="Address autocomplete"
              body="Facility setup happens once, during onboarding. Type a fragment, tap the match, done. Under a minute for five facilities."
            />
            <Principle
              n="7.3"
              title="Date defaults to today"
              body="Today is the default. Tomorrow is one tap. The calendar exists for everything else — and stays out of the way until then."
            />
            <Principle
              n="7.4"
              title="Notes are optional, collapsed, never blocking"
              body="Unit, floor, contact — useful context, but never required to save a shift. Collapsed by default."
            />
          </div>
        </div>

        {/* ---- Autocomplete replay ---- */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          <div className="panel grain overflow-hidden">
            <div className="flex items-center justify-between border-b border-hair px-4 py-2.5">
              <span className="t-mono text-bone-mute">add facility</span>
              <button
                type="button"
                onClick={() => {
                  setTyped(0)
                  setRun(true)
                }}
                className="t-mono text-sentinel transition-opacity hover:opacity-70"
              >
                {run ? 'replaying' : 'replay'}
              </button>
            </div>

            <div className="p-4">
              <div className="panel-inset flex items-center gap-2 px-3 py-2.5">
                <span aria-hidden="true" className="text-bone-mute">
                  ⌕
                </span>
                <span className="font-mono text-sm text-bone">{shown}</span>
                <span
                  aria-hidden="true"
                  className="inline-block h-4 w-[1px] bg-sentinel"
                  style={{ animation: run ? 'phylax-caret .9s steps(1) infinite' : 'none' }}
                />
              </div>

              <div className="mt-2.5">
                {typed >= QUERY.length ? (
                  <button
                    type="button"
                    onClick={() => setRun(false)}
                    className="panel-inset flex w-full items-center justify-between gap-3 border-sentinel/40 px-3 py-3 text-left transition-colors hover:border-sentinel"
                  >
                    <span>
                      <span className="block text-sm font-medium text-bone">Riverside Manor</span>
                      <span className="t-mono mt-0.5 block text-bone-mute">
                        1 Riverside Rd, Chicago IL
                      </span>
                    </span>
                    <span className="t-mono shrink-0 text-sentinel">tap</span>
                  </button>
                ) : (
                  <p className="t-mono px-1 py-3 text-bone-mute/50">
                    {run ? 'matching…' : `${MATCH.split(' · ')[0]} — press replay`}
                  </p>
                )}
              </div>
            </div>
          </div>

          <p className="t-mono mt-4 text-bone-mute">
            one-time setup · creates a reusable tile · then never again
          </p>
        </div>
      </Reveal>

      <style>{`@keyframes phylax-caret { 50% { opacity: 0 } }`}</style>
    </Section>
  )
}

function Principle({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="grid gap-2 border-t border-hair pt-5 sm:grid-cols-[4rem_minmax(0,1fr)]">
      <span className="t-mono text-sentinel">§{n}</span>
      <div>
        <h3 className="t-h3 text-bone">{title}</h3>
        <p className="mt-2 max-w-[52ch] text-sm leading-relaxed text-bone-dim">{body}</p>
      </div>
    </div>
  )
}
