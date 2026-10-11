import { useMemo } from 'react'
import { platformMap } from '../store/demo'
import { minutesOfDay, formatTime } from '../engine/format'
import type { Shift } from '../engine'

/**
 * THE MIDNIGHT WRAP — §9.3.
 *
 * The blueprint calls overnight normalization "a critical correctness
 * requirement", because 7p–7a is the single most common healthcare pattern.
 * A naive same-day comparison treats it as two fragments and misses every
 * overlap it creates. So we show it: a 24-hour ring where the shift visibly
 * runs past midnight into tomorrow.
 */
export function MidnightRing({
  shifts,
  size = 320,
}: {
  shifts: Shift[]
  size?: number
}) {
  const R = 46
  const C = 2 * Math.PI * R
  const centre = 56

  const arcs = useMemo(
    () =>
      shifts.map((s) => {
        const startMin = minutesOfDay(s.start)
        const endMin = minutesOfDay(s.end)
        const wraps = s.crossesMidnight || endMin <= startMin
        const spanMin = wraps ? 1440 - startMin + endMin : endMin - startMin
        const platform = platformMap.get(s.platformId)
        return {
          id: s.id,
          offset: (startMin / 1440) * C,
          length: (spanMin / 1440) * C,
          wraps,
          colour: platform?.accent ?? '#4DE1FF',
          label: `${platform?.name ?? ''} ${formatTime(s.start)}–${formatTime(s.end)}`,
        }
      }),
    [shifts, C],
  )

  const ticks = useMemo(
    () =>
      Array.from({ length: 24 }, (_, h) => {
        const a = (h / 24) * Math.PI * 2 - Math.PI / 2
        const inner = h % 6 === 0 ? R - 7 : R - 3.5
        return {
          h,
          x1: centre + Math.cos(a) * inner,
          y1: centre + Math.sin(a) * inner,
          x2: centre + Math.cos(a) * R,
          y2: centre + Math.sin(a) * R,
          major: h % 6 === 0,
        }
      }),
    [R, centre],
  )

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg viewBox="0 0 112 112" className="h-full w-full" role="img"
        aria-label="24 hour clock showing an overnight shift wrapping past midnight">
        {/* The midnight boundary */}
        <line
          x1={centre}
          y1={centre - R - 6}
          x2={centre}
          y2={centre - R + 4}
          stroke="var(--color-alert)"
          strokeWidth="1.4"
        />
        <text
          x={centre}
          y={centre - R - 9}
          textAnchor="middle"
          className="font-mono"
          fontSize="4.2"
          fill="var(--color-alert)"
        >
          00:00
        </text>

        <circle cx={centre} cy={centre} r={R} fill="none" stroke="var(--color-hair)" strokeWidth="1" />

        {ticks.map((t) => (
          <line
            key={t.h}
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
            stroke={t.major ? 'var(--color-hair-strong)' : 'var(--color-hair)'}
            strokeWidth={t.major ? 0.9 : 0.5}
          />
        ))}

        {arcs.map((a, i) => (
          <circle
            key={a.id}
            cx={centre}
            cy={centre}
            r={R - 10 - i * 6}
            fill="none"
            stroke={a.colour}
            strokeWidth="4.4"
            strokeLinecap="round"
            strokeDasharray={`${a.length} ${C}`}
            strokeDashoffset={-a.offset}
            transform={`rotate(-90 ${centre} ${centre})`}
            opacity={0.95}
          />
        ))}

        <text
          x={centre}
          y={centre - 1}
          textAnchor="middle"
          className="font-mono"
          fontSize="5"
          fill="var(--color-bone)"
        >
          24h
        </text>
        <text
          x={centre}
          y={centre + 6}
          textAnchor="middle"
          className="font-mono"
          fontSize="3.6"
          fill="var(--color-bone-mute)"
        >
          one interval
        </text>
      </svg>

      <ul className="absolute inset-x-0 bottom-0 space-y-1">
        {arcs.map((a) => (
          <li key={a.id} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-1.5 w-4 shrink-0 rounded-full"
              style={{ background: a.colour }}
            />
            <span className="t-mono text-bone-mute">{a.label}</span>
            {a.wraps ? <span className="t-mono text-alert">wraps +1</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
