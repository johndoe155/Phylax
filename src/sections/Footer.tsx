import { useState } from 'react'
import { Wordmark } from '../ui/Wordmark'
import { scrollToId } from '../motion/useMotionRuntime'
import { DISCLAIMER } from '../engine/policy'

const NAV = [
  { id: 'gap', label: 'The gap' },
  { id: 'loop', label: 'The loop' },
  { id: 'engine', label: 'Engine' },
  { id: 'policy', label: 'Policy' },
  { id: 'board', label: 'Board' },
  { id: 'pricing', label: 'Pricing' },
]

export function Footer() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)

  return (
    <footer className="relative z-10 border-t border-hair bg-ink-950">
      {/* ---- Closing CTA ---- */}
      <div className="shell py-20 lg:py-28">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:gap-20">
          <div>
            <p className="t-mono text-sentinel">phylax · φύλαξ · watchman</p>
            <h2 className="t-display mt-6 max-w-[12ch]">
              One guardrail.
              <br />
              Every shift.
            </h2>
            <p className="t-lead mt-8 max-w-[44ch]">
              Keep every per-diem shift in one place, and get warned before two staffing apps book
              you into the same time.
            </p>
          </div>

          <div>
            <p className="t-mono text-bone-mute">join the waitlist</p>
            <form
              className="mt-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (valid) setSent(true)
              }}
            >
              <div className="flex border border-hair focus-within:border-sentinel" style={{ borderRadius: 2 }}>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  aria-label="Email address"
                  className="min-w-0 flex-1 bg-transparent px-4 py-3.5 font-mono text-sm text-bone outline-none placeholder:text-bone-mute/60"
                />
                <button
                  type="submit"
                  disabled={!valid}
                  className="shrink-0 bg-sentinel px-5 transition-opacity disabled:opacity-30"
                >
                  <span className="t-mono text-ink-950">join</span>
                </button>
              </div>
            </form>
            <p className="t-mono mt-3 text-bone-mute" aria-live="polite">
              {sent
                ? 'demo build — waitlist capture is not connected to a backend yet'
                : 'no spam · SMS consent is a separate, explicit step'}
            </p>
          </div>
        </div>
      </div>

      {/* ---- Links ---- */}
      <div className="shell border-t border-hair py-10">
        <div className="flex flex-wrap items-start justify-between gap-10">
          <div>
            <Wordmark />
            <p className="t-mono mt-4 max-w-[34ch] text-bone-mute">
              cross-platform shift conflict guardrail for per-diem CNAs, LPNs and RNs
            </p>
          </div>

          <nav aria-label="Footer">
            <ul className="grid grid-cols-2 gap-x-10 gap-y-2 sm:grid-cols-3">
              {NAV.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => scrollToId(l.id)}
                    className="t-mono text-bone-mute transition-colors hover:text-sentinel"
                  >
                    {l.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>

      {/* ---- Legal ---- */}
      <div className="shell border-t border-hair py-8">
        <p className="text-xs leading-relaxed text-bone-mute">{DISCLAIMER}</p>
        <p className="t-mono mt-5 text-bone-mute/70">
          Phylax is an independent tool. It is not affiliated with, endorsed by, or sponsored by
          ShiftKey, CareRev, Clipboard Health, ShiftMed or IntelyCare. All platform names are the
          property of their respective owners and are referenced for identification only.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
          <p className="t-mono text-bone-mute/70">© {new Date().getFullYear()} Phylax</p>
          <p className="t-mono text-bone-mute/70">
            privacy · terms · SMS consent — copy pending
          </p>
        </div>
      </div>
    </footer>
  )
}
