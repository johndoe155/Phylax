import { Reveal } from '../ui/Reveal'
import { Section } from '../ui/Section'

/**
 * §5.3 — the boundary. This section is unusual for a marketing site and
 * deliberate: the product wins by doing one job quickly rather than becoming
 * another administrative system, and saying what it refuses to be is how a
 * worker believes that.
 */
const NOT = [
  'A staffing marketplace',
  'A replacement for ShiftKey, CareRev, Clipboard Health, ShiftMed or IntelyCare',
  'A job-search product',
  'A full workforce-management suite',
  'An automated scheduler or optimiser',
  'A scraper of third-party platforms',
  'A payroll, timesheet or clinical-record system',
]

const IS = [
  'A cross-platform shift log',
  'A conflict-detection guardrail',
  'A mobile-first decision-support tool',
  'A lightweight, installable web app',
  'A notification service for urgent conflicts',
]

export function Boundary() {
  return (
    <Section id="boundary" index="08" label="The boundary" numeral="08">
      <Reveal className="pt-6">
        <h2 className="t-h2 max-w-[18ch]">
          Most of what a tool could be,
          <br />
          Phylax <span className="text-alert">refuses</span> to be.
        </h2>
        <p className="t-lead mt-7 max-w-[52ch]">
          Every feature added to a guardrail makes it slower to open, slower to read and easier to
          ignore at the exact moment it matters. So the boundary is the product.
        </p>
      </Reveal>

      <Reveal className="mt-14 grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-20">
        <div>
          <p className="t-mono text-alert">what it is not</p>
          <ul className="mt-5 space-y-0">
            {NOT.map((item) => (
              <li
                key={item}
                className="relative border-b border-hair py-3.5 pr-8 text-bone-mute line-through decoration-alert/60 decoration-1"
              >
                {item}
              </li>
            ))}
          </ul>
          <p className="t-mono mt-6 max-w-[42ch] text-bone-mute">
            We never touch your platforms. No scraping, no integrations, no private APIs — that is
            a deliberate choice, not a missing feature.
          </p>
        </div>

        <div>
          <p className="t-mono text-clear">what it is</p>
          <ul className="mt-5 space-y-0">
            {IS.map((item) => (
              <li key={item} className="flex items-baseline gap-3 border-b border-hair py-3.5 text-bone">
                <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 bg-clear" />
                {item}
              </li>
            ))}
          </ul>

          <div className="panel grain mt-8 p-5">
            <p className="t-mono text-sentinel">why manual entry is the right call</p>
            <p className="mt-3 text-sm leading-relaxed text-bone-dim">
              Auto-syncing staffing platforms would mean depending on private systems that change
              without notice, break silently, and turn a 15-second safety check into a maintenance
              liability. Manual entry with saved templates keeps the whole product independent,
              predictable, and cheap to run.
            </p>
          </div>
        </div>
      </Reveal>
    </Section>
  )
}
