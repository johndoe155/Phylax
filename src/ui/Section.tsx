/** Section shell — enforces the editorial grid and the mono section index. */

import { useEffect, useRef, type ReactNode } from 'react'
import { gsap } from '../motion/useMotionRuntime'

export interface SectionProps {
  id: string
  index: string
  label: string
  children: ReactNode
  className?: string
  /** Renders the oversized numerals that bleed past the frame. */
  numeral?: string
}

export function Section({ id, index, label, children, className = '', numeral }: SectionProps) {
  const sectionRef = useRef<HTMLElement>(null)
  const numeralRef = useRef<HTMLSpanElement>(null)

  // Scrub-linked drift on the oversized numeral: it moves against the scroll
  // direction, which is what makes the grid feel broken rather than misaligned.
  useEffect(() => {
    const el = numeralRef.current
    const root = sectionRef.current
    if (!el || !root) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const ctx = gsap.context(() => {
      gsap.fromTo(
        el,
        { yPercent: -14, opacity: 0.15 },
        {
          yPercent: 14,
          opacity: 0.5,
          ease: 'none',
          scrollTrigger: {
            trigger: root,
            start: 'top bottom',
            end: 'bottom top',
            scrub: 0.8,
          },
        },
      )
    }, root)

    return () => ctx.revert()
  }, [numeral])

  return (
    <section
      ref={sectionRef}
      id={id}
      className={`relative w-full border-t border-hair ${className}`}
      aria-labelledby={`${id}-label`}
    >
      <div className="shell relative">
        <div className="flex items-baseline justify-between gap-6 pt-6 pb-3">
          <span id={`${id}-label`} className="t-mono text-bone-mute">
            {index}
          </span>
          <span className="t-mono text-bone-mute">{label}</span>
        </div>
      </div>

      {numeral ? (
        <span
          ref={numeralRef}
          aria-hidden="true"
          className="pointer-events-none absolute -top-10 right-[2vw] select-none text-edge leading-none"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(8rem, 26vw, 26rem)',
            fontWeight: 900,
            fontStretch: '125%',
            opacity: 0.5,
            willChange: 'transform, opacity',
          }}
        >
          {numeral}
        </span>
      ) : null}

      <div className="shell relative pb-[clamp(5rem,12vh,10rem)]">{children}</div>
    </section>
  )
}
