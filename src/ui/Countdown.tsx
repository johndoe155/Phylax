/**
 * LIVE CANCELLATION COUNTDOWN — §10.1.
 *
 * The alert is only useful if the worker knows how much time is left. This is
 * a real clock against a real deadline, not a looped animation. When it hits
 * zero the card flips to the critical state, exactly as the product would.
 */

import { useEffect, useState } from 'react'
import { formatCountdown } from '../engine/format'

export interface CountdownProps {
  /** Absolute ms timestamp at which the cancellation window closes. */
  deadlineMs: number
  label?: string
  /** Total window length in ms, used to draw the depleting arc. */
  windowMs: number
  onExpire?: () => void
}

export function Countdown({ deadlineMs, label = 'window closes in', windowMs, onExpire }: CountdownProps) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [])

  const remaining = deadlineMs - now
  const expired = remaining <= 0
  const fraction = Math.max(0, Math.min(1, remaining / Math.max(1, windowMs)))

  useEffect(() => {
    if (expired) onExpire?.()
  }, [expired, onExpire])

  const color = expired ? 'var(--color-alert)' : fraction < 0.25 ? 'var(--color-alert)' : 'var(--color-caution)'
  const R = 26
  const C = 2 * Math.PI * R

  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 64 64" className="h-16 w-16 shrink-0 -rotate-90" aria-hidden="true">
        <circle cx="32" cy="32" r={R} fill="none" stroke="var(--color-hair)" strokeWidth="3" />
        <circle
          cx="32"
          cy="32"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - fraction)}
          style={{ transition: 'stroke-dashoffset .25s linear, stroke .4s' }}
        />
      </svg>

      <div>
        <p className="t-mono text-bone-mute">{label}</p>
        <p
          className="font-mono text-3xl font-medium tabular-nums leading-none sm:text-4xl"
          style={{ color, fontVariantNumeric: 'tabular-nums' }}
          role="timer"
          aria-live="off"
        >
          {expired ? 'CLOSED' : formatCountdown(remaining)}
        </p>
        <p className="t-mono mt-1.5" style={{ color }}>
          {expired ? 'cancelling now incurs a penalty' : 'act before this hits zero'}
        </p>
      </div>
    </div>
  )
}
