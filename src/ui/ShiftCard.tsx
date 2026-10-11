/**
 * SHIFT CARD
 *
 * The one component the whole site is built around. It is DOM — real text,
 * selectable, screen-reader legible — and it registers its rect with the
 * scene bridge so a WebGL plate can sit behind it.
 *
 * Drag past the threshold and it cancels with a velocity throw; release early
 * and it springs back. That is §6.3: removal must be as fast as adding.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Conflict, Shift } from '../engine'
import { SEVERITY_LABEL } from '../engine/detect'
import { formatRange } from '../engine/format'
import { facilityMap, platformMap } from '../store/demo'
import { trackCard, untrackCard } from '../store/rectTracker'

const CANCEL_THRESHOLD = 96 // px of drag before release commits

export interface ShiftCardProps {
  shift: Shift
  conflicts?: Conflict[]
  onSwipeCancel?: (id: string) => void
  onRestore?: (id: string) => void
  /** Opt into the WebGL glass plate behind this card. */
  tracked?: boolean
  className?: string
  compact?: boolean
}

export function ShiftCard({
  shift,
  conflicts = [],
  onSwipeCancel,
  onRestore,
  tracked = false,
  className = '',
  compact = false,
}: ShiftCardProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [dragX, setDragX] = useState(0)
  const drag = useRef({ active: false, startX: 0, startT: 0, lastX: 0, velocity: 0 })

  const platform = platformMap.get(shift.platformId)
  const facility = facilityMap.get(shift.facilityId)
  const worst = conflicts[0]
  const cancelled = shift.status === 'cancelled'

  useEffect(() => {
    if (!tracked) return
    trackCard(shift.id, ref.current)
    return () => untrackCard(shift.id)
  }, [tracked, shift.id])

  // ---- Spring back on release -------------------------------------------
  const springBack = useCallback(() => {
    const el = ref.current
    if (!el) return
    let x = dragX
    let v = drag.current.velocity
    let raf = 0
    const step = () => {
      // Critically-damped-ish spring toward 0.
      const force = -0.18 * x - 0.26 * v
      v += force
      x += v
      if (Math.abs(x) < 0.4 && Math.abs(v) < 0.4) {
        el.style.transform = ''
        el.style.opacity = ''
        setDragX(0)
        return
      }
      el.style.transform = `translate3d(${x}px,0,0)`
      el.style.opacity = String(1 - Math.min(0.65, Math.abs(x) / 260))
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [dragX])

  const onPointerDown = (e: React.PointerEvent) => {
    if (cancelled || !onSwipeCancel) return
    drag.current = {
      active: true,
      startX: e.clientX,
      startT: performance.now(),
      lastX: e.clientX,
      velocity: 0,
    }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current.active) return
    const dx = e.clientX - drag.current.startX
    drag.current.velocity = e.clientX - drag.current.lastX
    drag.current.lastX = e.clientX
    // Rubber-band: resistance grows the further you pull.
    const resisted = dx > 0 ? dx * 0.82 : dx * 0.35
    setDragX(resisted)
    if (ref.current) {
      ref.current.style.transform = `translate3d(${resisted}px,0,0)`
      ref.current.style.opacity = String(1 - Math.min(0.65, Math.abs(resisted) / 260))
    }
  }

  const onPointerUp = () => {
    if (!drag.current.active) return
    drag.current.active = false
    const threw = Math.abs(drag.current.velocity) > 14
    if ((dragX < -CANCEL_THRESHOLD || (dragX < -40 && threw)) && onSwipeCancel) {
      const el = ref.current
      if (el) {
        el.style.transition = 'transform .38s cubic-bezier(.16,1,.3,1), opacity .38s'
        el.style.transform = 'translate3d(-140%,0,0)'
        el.style.opacity = '0'
        window.setTimeout(() => {
          el.style.transition = ''
          onSwipeCancel(shift.id)
        }, 260)
      } else {
        onSwipeCancel(shift.id)
      }
      setDragX(0)
      return
    }
    springBack()
  }

  return (
    <div
      ref={ref}
      data-shift-id={shift.id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={[
        'relative select-none touch-pan-y will-change-transform',
        worst && !cancelled ? 'glass-alarm' : 'panel',
        cancelled ? 'opacity-45 grayscale' : '',
        compact ? 'p-3' : 'p-4 sm:p-5',
        className,
      ].join(' ')}
      style={{ borderRadius: 3 }}
    >
      {/* Severity spine */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-[2px]"
        style={{
          background: cancelled
            ? 'var(--color-ink-400)'
            : worst
              ? `var(--color-${worst.severity === 'critical' || worst.severity === 'high' ? 'alert' : worst.severity === 'warning' ? 'caution' : 'sentinel'})`
              : 'var(--color-hair-strong)',
        }}
      />

      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <PlatformGlyph code={platform?.code ?? '??'} accent={platform?.accent ?? '#4DE1FF'} />
          <div className="min-w-0">
            <p className="t-mono text-bone-mute">{platform?.name ?? 'Unknown platform'}</p>
            <h4
              className={`font-display font-bold tracking-tight text-bone ${compact ? 'text-base' : 'text-lg sm:text-xl'}`}
              style={{ fontStretch: '104%' }}
            >
              {facility?.name ?? 'Unknown facility'}
            </h4>
          </div>
        </div>

        <div className="text-right shrink-0">
          <p
            className="font-mono text-sm font-medium tabular-nums text-bone sm:text-base"
            style={{ letterSpacing: '0.01em' }}
          >
            {formatRange(shift.start, shift.end, shift.crossesMidnight)}
          </p>
          {shift.crossesMidnight ? (
            <p className="t-mono mt-0.5 text-sentinel">crosses midnight</p>
          ) : null}
        </div>
      </div>

      {shift.notes && !compact ? (
        <p className="mt-3 border-t border-hair pt-2.5 text-xs text-bone-mute">{shift.notes}</p>
      ) : null}

      {worst && !cancelled ? (
        <div className="mt-3 border-t border-hair pt-2.5">
          <p
            className="t-mono"
            style={{
              color:
                worst.severity === 'critical' || worst.severity === 'high'
                  ? 'var(--color-alert)'
                  : worst.severity === 'warning'
                    ? 'var(--color-caution)'
                    : 'var(--color-sentinel)',
            }}
          >
            {SEVERITY_LABEL[worst.severity]}
          </p>
          {!compact ? <p className="mt-1 text-xs leading-relaxed text-bone-dim">{worst.message}</p> : null}
        </div>
      ) : null}

      {cancelled && onRestore ? (
        <button
          type="button"
          onClick={() => onRestore(shift.id)}
          className="t-mono mt-3 border border-hair px-2 py-1 text-bone-dim transition-colors hover:border-sentinel hover:text-sentinel"
        >
          restore shift
        </button>
      ) : null}

      {onSwipeCancel && !cancelled ? (
        <p className="t-mono mt-3 text-bone-mute/60">← swipe to cancel</p>
      ) : null}
    </div>
  )
}

/** Abstract platform glyph — no third-party logos, no trademark exposure. */
export function PlatformGlyph({ code, accent }: { code: string; accent: string }) {
  return (
    <span
      aria-hidden="true"
      className="grid h-9 w-9 shrink-0 place-items-center border font-mono text-[11px] font-bold"
      style={{
        borderColor: `${accent}55`,
        color: accent,
        background: `${accent}12`,
        borderRadius: 2,
        letterSpacing: '0.06em',
      }}
    >
      {code}
    </span>
  )
}
