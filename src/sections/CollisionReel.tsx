import { useEffect, useRef } from 'react'
import { gsap } from '../motion/useMotionRuntime'
import { setSeverity } from '../store/sceneBridge'
import { PlatformGlyph } from '../ui/ShiftCard'

/**
 * THE COLLISION REEL — the signature scroll moment.
 *
 * A pinned, scroll-scrubbed reconstruction of the failure: three accepted
 * shifts slide along one 24-hour ribbon, two of them land in the same slot,
 * and the page goes into alarm. Scrubbing backwards unwinds it exactly, which
 * is the difference between a scroll animation and a scroll *instrument*.
 *
 * Everything here writes to the scene bridge — the WebGL shockwave and tint
 * follow because they read the same severity state, not because this
 * component knows the canvas exists.
 */

const TRACK = [
  { id: 'a', code: 'SK', accent: '#4DE1FF', name: 'ShiftKey', facility: 'Riverside Manor', range: '07:00–19:00', slot: 29, span: 50 },
  { id: 'b', code: 'CR', accent: '#3DDC97', name: 'CareRev', facility: "St. Anne's", range: '15:00–23:00', slot: 62, span: 33 },
  { id: 'c', code: 'SM', accent: '#FF8A4D', name: 'ShiftMed', facility: 'Greenfield Rehab', range: '19:00–07:00', slot: 79, span: 50 },
]

/** Where card B sits before the scrub pulls it into the collision. */
const B_START_SLOT = 6

export function CollisionReel() {
  const root = useRef<HTMLElement>(null)
  const cardB = useRef<HTMLDivElement>(null)
  const alertRef = useRef<HTMLDivElement>(null)
  const ribbon = useRef<HTMLDivElement>(null)
  const captions = useRef<(HTMLParagraphElement | null)[]>([])

  useEffect(() => {
    const el = root.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setSeverity('critical')
      return
    }

    const ctx = gsap.context(() => {
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: el,
          start: 'top top',
          end: '+=220%',
          pin: true,
          scrub: 0.6,
          anticipatePin: 1,
          onUpdate: (self) => {
            // Alarm state is a function of scrub position, so scrubbing back
            // genuinely disarms it rather than leaving the page stuck red.
            setSeverity(self.progress > 0.58 ? 'critical' : self.progress > 0.3 ? 'info' : null)
          },
          onLeave: () => setSeverity('critical'),
          onLeaveBack: () => setSeverity(null),
        },
      })

      // Card B travels from an innocent morning slot into the occupied one.
      tl.to(
        cardB.current,
        { left: `${TRACK[1].slot}%`, ease: 'none', duration: 1 },
        0,
      )
        .to(
          ribbon.current,
          { boxShadow: '0 0 90px -10px rgba(255,92,56,0.55)', ease: 'none', duration: 1 },
          0,
        )
        .to(
          alertRef.current,
          { opacity: 1, y: 0, ease: 'none', duration: 0.42 },
          0.58,
        )

      // Caption beats cross-fade as the scrub advances.
      const beats = captions.current.filter(Boolean) as HTMLParagraphElement[]
      beats.forEach((node, i) => {
        const at = i / Math.max(1, beats.length - 1)
        tl.to(
          node,
          {
            opacity: 1,
            y: 0,
            duration: 0.14,
            ease: 'none',
            onStart: () => {
              beats.forEach((other) => {
                if (other !== node) gsap.set(other, { opacity: 0, y: 14 })
              })
            },
          },
          Math.max(0, at - 0.07),
        )
      })
    }, el)

    return () => {
      ctx.revert()
      setSeverity(null)
    }
  }, [])

  return (
    <section
      ref={root}
      id="collision"
      className="relative h-[100svh] w-full overflow-hidden"
      aria-labelledby="collision-label"
    >
      <div className="shell flex h-full flex-col justify-center">
        <p id="collision-label" className="t-mono text-bone-mute">
          the moment it goes wrong
        </p>

        {/* ---- Caption stack ---- */}
        <div className="relative mt-5 h-[7.5rem] sm:h-[6rem]">
          {[
            'Three shifts accepted. Three different apps.',
            'None of them can see the other two.',
            'Two of them want you at 15:00.',
          ].map((line, i) => (
            <p
              key={line}
              ref={(node) => {
                captions.current[i] = node
              }}
              className="t-h2 absolute inset-x-0 top-0 max-w-[18ch]"
              style={{ opacity: i === 0 ? 1 : 0 }}
            >
              {line}
            </p>
          ))}
        </div>

        {/* ---- The 24h ribbon ---- */}
        <div
          ref={ribbon}
          className="panel relative mt-10 h-[13rem] overflow-hidden transition-shadow duration-300"
        >
          {/* hour ticks */}
          <div className="absolute inset-x-0 bottom-0 flex h-6" aria-hidden="true">
            {Array.from({ length: 25 }, (_, h) => (
              <span
                key={h}
                className="flex-1 border-l border-hair"
                style={{ opacity: h % 6 === 0 ? 1 : 0.4 }}
              />
            ))}
          </div>
          <div className="absolute inset-x-0 bottom-6 flex" aria-hidden="true">
            {[0, 6, 12, 18, 24].map((h) => (
              <span key={h} className="t-mono flex-1 text-bone-mute">
                {String(h).padStart(2, '0')}
              </span>
            ))}
          </div>

          {/* shift bars */}
          {TRACK.map((t, i) => {
            const isB = t.id === 'b'
            return (
              <div
                key={t.id}
                ref={isB ? cardB : undefined}
                className="absolute flex items-center gap-2.5 border px-3"
                style={{
                  left: isB ? `${B_START_SLOT}%` : `${t.slot}%`,
                  width: `${t.span}%`,
                  top: `${1.1 + i * 2.6}rem`,
                  height: '2.1rem',
                  borderRadius: 2,
                  borderColor: `${t.accent}66`,
                  background: `linear-gradient(90deg, ${t.accent}26, ${t.accent}0a)`,
                  willChange: isB ? 'left' : undefined,
                }}
              >
                <PlatformGlyph code={t.code} accent={t.accent} />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-bone">{t.facility}</span>
                  <span className="t-mono block text-bone-mute">{t.range}</span>
                </span>
              </div>
            )
          })}

          {/* the collision marker */}
          <span
            aria-hidden="true"
            className="absolute inset-y-0 border-l border-dashed border-alert/70"
            style={{ left: '62.5%' }}
          />
        </div>

        {/* ---- Alert ---- */}
        <div
          ref={alertRef}
          className="glass-alarm mt-6 p-5"
          style={{ borderRadius: 3, opacity: 0, transform: 'translateY(18px)' }}
          role="alert"
        >
          <p className="t-mono text-alert">⚠ conflict detected · direct overlap</p>
          <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-bone-dim sm:text-base">
            Your <strong className="text-bone">CareRev</strong> shift at{' '}
            <strong className="text-bone">St. Anne’s</strong> overlaps your{' '}
            <strong className="text-bone">ShiftKey</strong> shift at{' '}
            <strong className="text-bone">Riverside Manor</strong> by 4 hours. ShiftKey’s
            cancellation window closed 2 hours ago; CareRev’s closes in 3.
          </p>
          <p className="t-mono mt-4 text-bone-mute">
            phylax tells you which exit is cheaper — it never cancels for you
          </p>
        </div>
      </div>
    </section>
  )
}
