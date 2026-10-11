/**
 * MOTION RUNTIME
 *
 * One hook that owns Lenis, the GSAP ticker, the pointer and the viewport,
 * and writes all of it into the scene bridge. Everything downstream — shaders,
 * ScrollTrigger timelines, DOM reveals — reads from the bridge, never from
 * React state, so a scroll frame costs zero re-renders.
 */

import { useEffect } from 'react'
import Lenis from 'lenis'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { state as bridge, detectCapabilities } from '../store/sceneBridge'

gsap.registerPlugin(ScrollTrigger)

export interface MotionRuntime {
  lenis: Lenis | null
  reducedMotion: boolean
}

export function useMotionRuntime(): MotionRuntime {
  const { reducedMotion, tier } = detectCapabilities()

  useEffect(() => {
    bridge.reducedMotion = reducedMotion
    bridge.tier = tier

    const root = document.documentElement
    const updateViewport = () => {
      bridge.viewportW = window.innerWidth
      bridge.viewportH = window.innerHeight
      bridge.dpr = Math.min(window.devicePixelRatio || 1, 2)
    }
    updateViewport()

    const onResize = () => {
      updateViewport()
      ScrollTrigger.refresh()
    }

    // ---- Pointer (normalized, centre-origin) ----------------------------
    const onPointerMove = (e: PointerEvent) => {
      bridge.rawPointerX = e.clientX
      bridge.rawPointerY = e.clientY
      bridge.pointerX = (e.clientX / window.innerWidth) * 2 - 1
      bridge.pointerY = -((e.clientY / window.innerHeight) * 2 - 1)
      bridge.pointerActive = true
    }
    const onPointerLeave = () => {
      bridge.pointerActive = false
    }

    // ---- Scroll ----------------------------------------------------------
    const updateScroll = () => {
      const max = Math.max(1, root.scrollHeight - window.innerHeight)
      bridge.scrollY = window.scrollY
      bridge.progress = Math.min(1, Math.max(0, window.scrollY / max))
      // Drives the CSS twin of the WebGL scan beam for the no-WebGL path.
      root.style.setProperty('--scan', bridge.progress.toFixed(4))
    }

    let lenis: Lenis | null = null

    if (!reducedMotion) {
      lenis = new Lenis({
        duration: 1.05,
        easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        smoothWheel: true,
        touchMultiplier: 1.6,
        // Native scroll on touch — hijacking it is where mobile a11y dies.
        wheelMultiplier: 1,
      })

      lenis.on('scroll', () => {
        updateScroll()
        ScrollTrigger.update()
      })

      const raf = (time: number) => lenis?.raf(time * 1000)
      gsap.ticker.add(raf)
      gsap.ticker.lagSmoothing(0)

      // Expose for anchor links and the nav.
      ;(window as unknown as { __lenis: Lenis }).__lenis = lenis

      return () => {
        gsap.ticker.remove(raf)
        lenis?.destroy()
        window.removeEventListener('resize', onResize)
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerleave', onPointerLeave)
        window.removeEventListener('scroll', updateScroll)
      }
    }

    window.addEventListener('scroll', updateScroll, { passive: true })
    updateScroll()

    window.addEventListener('resize', onResize)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerleave', onPointerLeave)

    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('scroll', updateScroll)
    }
  }, [reducedMotion, tier])

  return { lenis: null, reducedMotion }
}

/** Smooth-scroll to a section id, honouring whether Lenis is active. */
export function scrollToId(id: string): void {
  const el = document.getElementById(id)
  if (!el) return
  const lenis = (window as unknown as { __lenis?: Lenis }).__lenis
  if (lenis) lenis.scrollTo(el, { offset: -8, duration: 1.4 })
  else el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

export { ScrollTrigger, gsap }
