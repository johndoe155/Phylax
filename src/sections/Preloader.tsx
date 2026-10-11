import { useEffect, useState } from 'react'

/**
 * Preloader — the sentinel lockup assembling.
 * Short by design: it exists to cover font + shader compilation, not to be
 * admired. Skipped entirely under prefers-reduced-motion.
 */
export function Preloader({ reducedMotion }: { reducedMotion: boolean }) {
  const [progress, setProgress] = useState(reducedMotion ? 1 : 0)
  const [gone, setGone] = useState(reducedMotion)

  useEffect(() => {
    if (reducedMotion) return
    let raf = 0
    const started = performance.now()
    const DURATION = 1150

    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / DURATION)
      // Ease-out so it never feels like it stalls at 90%.
      setProgress(1 - Math.pow(1 - t, 2.2))
      if (t < 1) raf = requestAnimationFrame(tick)
      else window.setTimeout(() => setGone(true), 420)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [reducedMotion])

  if (gone) return null

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-ink-900"
      style={{
        opacity: progress >= 1 ? 0 : 1,
        transition: 'opacity .42s var(--ease-sentinel)',
        pointerEvents: progress >= 1 ? 'none' : 'auto',
      }}
      aria-hidden="true"
    >
      <div className="w-[min(22rem,70vw)]">
        <div className="flex items-baseline justify-between">
          <span
            className="font-display text-2xl font-black tracking-[0.28em] text-bone uppercase"
            style={{ fontStretch: '120%' }}
          >
            Phylax
          </span>
          <span className="font-mono text-xs tabular-nums text-sentinel">
            {String(Math.round(progress * 100)).padStart(3, '0')}
          </span>
        </div>

        <div className="mt-4 h-px w-full bg-hair">
          <div
            className="h-px bg-sentinel"
            style={{
              width: `${progress * 100}%`,
              boxShadow: '0 0 12px var(--color-sentinel)',
            }}
          />
        </div>

        <p className="t-mono mt-4 text-bone-mute">arming the watchman</p>
      </div>
    </div>
  )
}
