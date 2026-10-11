import { Reveal } from '../ui/Reveal'
import { Section } from '../ui/Section'

/**
 * §13.4 — data integrity and privacy. A product that stores worker schedules
 * and phone numbers has to say plainly what it holds and what it refuses to.
 */
const GUARANTEES = [
  {
    title: 'No protected health information',
    body: 'Phylax stores shift times, facility names and a phone number. It never collects patient data, clinical records, or anything covered by HIPAA — and is designed to stay that way.',
  },
  {
    title: 'Per-user row-level access control',
    body: 'Your shifts are readable by your account and nothing else. Row-level security is enforced at the database, not just in the interface.',
  },
  {
    title: 'Minimal collection',
    body: 'A phone number for alerts, facility coordinates for travel buffers, and the shifts you log. Nothing is collected because it might be useful later.',
  },
  {
    title: 'Explicit SMS consent and opt-out',
    body: 'Consent is captured before the first message, and opt-out is one reply away. Frequency and quiet hours are configurable.',
  },
  {
    title: 'Auditable policy data',
    body: 'Every cancellation-policy row carries an effective date, a last-reviewed date and a source note — so you can see how stale the information is.',
  },
  {
    title: 'Deletion and export',
    body: 'A full export and deletion path ships in the privacy-hardening phase. Your schedule is yours, not a retention metric.',
  },
]

export function Trust() {
  return (
    <Section id="trust" index="10" label="Trust & data" numeral="10">
      <Reveal className="pt-6">
        <h2 className="t-h2 max-w-[16ch]">
          It knows your schedule.
          <br />
          Here is <span className="text-sentinel">all</span> it knows.
        </h2>
      </Reveal>

      <Reveal className="mt-12 grid gap-x-12 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
        {GUARANTEES.map((g, i) => (
          <div key={g.title} className="border-t border-hair pt-5">
            <span className="t-mono text-bone-mute">{String(i + 1).padStart(2, '0')}</span>
            <h3 className="t-h3 mt-2 text-bone">{g.title}</h3>
            <p className="mt-2.5 text-sm leading-relaxed text-bone-dim">{g.body}</p>
          </div>
        ))}
      </Reveal>

      <Reveal className="mt-14">
        <div className="panel grain flex flex-wrap items-center justify-between gap-6 p-6">
          <p className="max-w-[42ch] text-sm leading-relaxed text-bone-dim">
            Phylax never connects to a staffing platform. Nothing is scraped, nothing is synced,
            nothing is read from your other apps. Every shift in here was logged by you.
          </p>
          <p className="t-mono text-clear">independent by design</p>
        </div>
      </Reveal>
    </Section>
  )
}
