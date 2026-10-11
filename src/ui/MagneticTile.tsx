/**
 * MAGNETIC TILE
 *
 * Pointer-driven tilt + magnetise, spring-damped by hand rather than with a
 * transition, so release has real weight. Used for the logging rail and the
 * template picker — the interactions a worker repeats fifty times a week.
 */

import { useCallback, useEffect, useRef, type ReactNode } from 'react'

export interface MagneticTileProps {
  children: ReactNode
  onClick?: () => void
  selected?: boolean
  disabled?: boolean
  className?: string
  /** Max tilt in degrees. Lower on dense grids. */
  tilt?: number
  accent?: string
  ariaLabel?: string
}

export function MagneticTile({
  children,
  onClick,
  selected = false,
  disabled = false,
  className = '',
  tilt = 9,
  accent = '#4DE1FF',
  ariaLabel,
}: MagneticTileProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const raf = useRef(0)
  const spring = useRef({ x: 0, y: 0, vx: 0, vy: 0, active: false })

  const animate = useCallback(() => {
    const el = ref.current
    if (!el) return
    const s = spring.current

    const tx = s.x
    const ty = s.y
    const cx = current(el, 'rx')
    const cy = current(el, 'ry')

    // Critically-damped spring: stiffness up while hovered, so release has weight.
    const k = s.active ? 0.2 : 0.14
    const damping = 0.68
    s.vx = (s.vx + (tx - cx) * k) * damping
    s.vy = (s.vy + (ty - cy) * k) * damping

    const rx = cx + s.vx
    const ry = cy + s.vy
    el.dataset.rx = String(rx)
    el.dataset.ry = String(ry)
    el.style.transform = `perspective(700px) rotateX(${ry}deg) rotateY(${rx}deg) translate3d(0,0,${
      s.active ? 12 : 0
    }px)`

    const settled =
      Math.abs(tx - rx) < 0.05 &&
      Math.abs(ty - ry) < 0.05 &&
      Math.abs(s.vx) < 0.05 &&
      Math.abs(s.vy) < 0.05

    if (settled && !s.active) {
      el.style.transform = ''
      el.dataset.rx = '0'
      el.dataset.ry = '0'
      raf.current = 0
      return
    }
    raf.current = requestAnimationFrame(animate)
  }, [])

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const onMove = (e: React.PointerEvent) => {
    const el = ref.current
    if (!el || disabled) return
    const r = el.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width - 0.5
    const py = (e.clientY - r.top) / r.height - 0.5
    spring.current.x = px * tilt * 2
    spring.current.y = -py * tilt * 2
    spring.current.active = true
    el.style.setProperty('--mx', `${(px + 0.5) * 100}%`)
    el.style.setProperty('--my', `${(py + 0.5) * 100}%`)
    if (!raf.current) raf.current = requestAnimationFrame(animate)
  }

  const onLeave = () => {
    spring.current.x = 0
    spring.current.y = 0
    spring.current.active = false
    raf.current = requestAnimationFrame(animate)
  }

  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      aria-label={ariaLabel}
      onClick={onClick}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      data-rx="0"
      data-ry="0"
      data-tx="0"
      className={[
        'group relative overflow-hidden border text-left will-change-transform',
        'transition-colors duration-300',
        selected ? 'border-sentinel' : 'border-hair hover:border-hair-strong',
        disabled ? 'cursor-not-allowed opacity-35' : 'cursor-pointer',
        className,
      ].join(' ')}
      style={{
        borderRadius: 3,
        transformStyle: 'preserve-3d',
        background: selected ? `${accent}14` : undefined,
      }}
    >
      {/* Pointer-tracked sheen */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: `radial-gradient(220px circle at var(--mx, 50%) var(--my, 50%), ${accent}1f, transparent 62%)`,
        }}
      />
      <span className="relative z-10 block">{children}</span>
    </button>
  )
}

/** Reads the tile's current spring position back off the element. */
function current(el: HTMLElement, key: 'rx' | 'ry'): number {
  return parseFloat(el.dataset[key] || '0')
}
