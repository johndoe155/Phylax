/** IntersectionObserver-driven reveal. Adds `.is-in`, which the CSS uses. */

import { useEffect, useRef, type ReactNode } from 'react'

export interface RevealProps {
  children: ReactNode
  className?: string
  /** 0–1 of the element that must be visible before it reveals. */
  threshold?: number
  as?: 'div' | 'section' | 'article' | 'li' | 'header'
  id?: string
}

export function Reveal({
  children,
  className = '',
  threshold = 0.18,
  as: Tag = 'div',
  id,
}: RevealProps) {
  const ref = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    if (
      typeof IntersectionObserver === 'undefined' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      el.classList.add('is-in')
      return
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in')
            io.unobserve(entry.target)
          }
        }
      },
      { threshold, rootMargin: '0px 0px -8% 0px' },
    )

    io.observe(el)
    return () => io.disconnect()
  }, [threshold])

  return (
    <Tag id={id} ref={ref as never} className={className}>
      {children}
    </Tag>
  )
}
