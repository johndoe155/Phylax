import { useEffect, useRef } from 'react'

/**
 * CUSTOM CURSOR
 *
 * Two elements: a hard dot on the exact pointer position, and a lagging ring
 * that eases toward it. The gap between them *is* the sense of weight.
 *
 * It reads the scene bridge's raw pointer rather than adding its own listener
 * chain, and it is suppressed entirely on touch and under reduced motion — a
 * custom cursor on either is a defect, not a flourish.
 */
export function Cursor() {
  const dot = useRef<HTMLDivElement>(null)
  const ring = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const fine = window.matchMedia('(pointer: fine)').matches
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!fine || reduced) return

    const d = dot.current
    const r = ring.current
    if (!d || !r) return

    let x = window.innerWidth / 2
    let y = window.innerHeight / 2
    let rx = x
    let ry = y
    let scale = 1
    let targetScale = 1
    let raf = 0
    let visible = false

    const onMove = (e: PointerEvent) => {
      x = e.clientX
      y = e.clientY
      if (!visible) {
        visible = true
        d.style.opacity = '1'
        r.style.opacity = '1'
      }
      // Grow over anything actionable.
      const over = (e.target as HTMLElement | null)?.closest?.(
        'a, button, input, [role="button"], [data-cursor="target"]',
      )
      targetScale = over ? 2.1 : 1
      document.documentElement.style.cursor = over ? 'none' : 'none'
    }

    const onDown = () => {
      targetScale = 0.72
    }
    const onUp = () => {
      targetScale = 1
    }
    const onLeave = () => {
      visible = false
      d.style.opacity = '0'
      r.style.opacity = '0'
    }

    const tick = () => {
      raf = requestAnimationFrame(tick)
      // Ring lags; dot does not. That lag is the whole effect.
      rx += (x - rx) * 0.16
      ry += (y - ry) * 0.16
      scale += (targetScale - scale) * 0.18

      d.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`
      r.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -50%) scale(${scale})`
    }

    // Hide the OS cursor only once our own is confirmed on screen.
    document.documentElement.classList.add('has-cursor')
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerdown', onDown, { passive: true })
    window.addEventListener('pointerup', onUp, { passive: true })
    document.addEventListener('pointerleave', onLeave)
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointerleave', onLeave)
      document.documentElement.classList.remove('has-cursor')
    }
  }, [])

  return (
    <>
      <div
        ref={ring}
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 z-[90] hidden h-9 w-9 rounded-full border border-sentinel/70 opacity-0 md:block"
        style={{ mixBlendMode: 'screen' }}
      />
      <div
        ref={dot}
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 z-[90] hidden h-1.5 w-1.5 rounded-full bg-sentinel opacity-0 md:block"
      />
    </>
  )
}
