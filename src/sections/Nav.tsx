import { useEffect, useState } from 'react'
import { Wordmark } from '../ui/Wordmark'
import { scrollToId } from '../motion/useMotionRuntime'

const LINKS = [
  { id: 'gap', label: 'The gap' },
  { id: 'loop', label: 'The loop' },
  { id: 'engine', label: 'Engine' },
  { id: 'policy', label: 'Policy' },
  { id: 'pricing', label: 'Pricing' },
]

export function Nav() {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header
      className="fixed inset-x-0 top-0 z-50 transition-colors duration-500"
      style={{
        background: scrolled ? 'rgba(5,6,10,0.82)' : 'transparent',
        backdropFilter: scrolled ? 'blur(14px) saturate(140%)' : 'none',
        borderBottom: `1px solid ${scrolled ? 'var(--color-hair)' : 'transparent'}`,
      }}
    >
      <nav className="shell flex h-16 items-center justify-between gap-6">
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault()
            scrollToId('top')
          }}
          className="shrink-0"
        >
          <Wordmark />
        </a>

        <ul className="hidden items-center gap-7 md:flex">
          {LINKS.map((l) => (
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

        <button
          type="button"
          onClick={() => scrollToId('pricing')}
          className="group relative overflow-hidden border border-sentinel/45 px-4 py-2 transition-colors hover:border-sentinel"
          style={{ borderRadius: 2 }}
        >
          <span className="t-mono relative z-10 text-sentinel transition-colors group-hover:text-ink-950">
            Start free
          </span>
          <span
            aria-hidden="true"
            className="absolute inset-0 -translate-x-full bg-sentinel transition-transform duration-500 group-hover:translate-x-0"
            style={{ transitionTimingFunction: 'var(--ease-sentinel)' }}
          />
        </button>
      </nav>
    </header>
  )
}
