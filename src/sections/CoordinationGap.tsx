import { Reveal } from '../ui/Reveal'
import { Section } from '../ui/Section'
import { PlatformGlyph } from '../ui/ShiftCard'
import { platformMap } from '../store/demo'

/**
 * §3.3 — every platform sees only its own shifts. The worker is the
 * synchronisation layer. That is the whole product thesis in one section.
 */
const ISLANDS = [
  {
    id: 'shiftkey',
    sees: 'Sees the Riverside day shift',
    blind: 'Blind to the 3 PM start at St. Anne’s',
  },
  {
    id: 'carerev',
    sees: 'Sees the St. Anne’s evening',
    blind: 'Blind to anything booked on ShiftKey',
  },
  {
    id: 'shiftmed',
    sees: 'Sees tonight’s 7–7',
    blind: 'Blind to tomorrow morning’s 6 AM',
  },
]

export function CoordinationGap() {
  return (
    <Section id="gap" index="01" label="The coordination gap" numeral="01">
      <Reveal className="grid gap-10 pt-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
        <div>
          <h2 className="t-h2 max-w-[14ch]">
            No app can see
            <br />
            <span className="text-alert">the other apps.</span>
          </h2>
          <div className="mt-8 space-y-5">
            <p className="t-lead max-w-[42ch]">
              Each staffing platform knows exactly what you accepted through it — and nothing about
              the rest of your week.
            </p>
            <p className="max-w-[46ch] text-bone-dim">
              App A sees the App A shift. App B sees the App B shift. You are the synchronisation
              layer, reconciling four inboxes from a phone, in scrubs, between patients. Human
              memory fails under that pressure. It is not a discipline problem; it is a missing
              tool.
            </p>
          </div>
        </div>

        <ul className="space-y-3">
          {ISLANDS.map((row, i) => {
            const platform = platformMap.get(row.id)
            return (
              <li
                key={row.id}
                className="panel grain relative overflow-hidden p-5"
                style={{ marginLeft: `${i * 14}px`, maxWidth: '34rem' }}
              >
                <div className="flex items-start gap-4">
                  <PlatformGlyph code={platform?.code ?? '??'} accent={platform?.accent ?? '#4DE1FF'} />
                  <div className="min-w-0">
                    <p className="font-display text-base font-bold tracking-tight text-bone">
                      {platform?.name}
                    </p>
                    <p className="mt-1 text-sm text-bone-dim">{row.sees}</p>
                    <p className="t-mono mt-2 text-alert/80">{row.blind}</p>
                  </div>
                </div>
              </li>
            )
          })}
          <li className="panel-inset mt-6 p-5" style={{ marginLeft: '42px', maxWidth: '34rem' }}>
            <p className="t-mono text-bone-mute">you</p>
            <p className="mt-2 font-display text-xl font-extrabold tracking-tight text-bone">
              The synchronisation layer
            </p>
            <p className="mt-2 text-sm text-bone-dim">
              Cross-checking four apps from memory. Every week. Under time pressure.
            </p>
          </li>
        </ul>
      </Reveal>

      <Reveal className="mt-16 border-t border-hair pt-8">
        <p className="t-mono text-bone-mute">what it costs when it fails</p>
        <ul className="mt-5 grid gap-x-10 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {[
            'Double-booking two facilities',
            'Late arrival or no-show',
            'Cancellation penalties',
            'Loss of platform standing',
            'Lost income on both shifts',
            'Uncompensated short shifts',
          ].map((item) => (
            <li key={item} className="flex items-baseline gap-3 text-bone-dim">
              <span aria-hidden="true" className="mt-2 h-px w-4 shrink-0 bg-alert" />
              {item}
            </li>
          ))}
        </ul>
      </Reveal>
    </Section>
  )
}
