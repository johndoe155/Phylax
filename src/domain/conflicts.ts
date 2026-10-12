export type ConflictType = 'overlap' | 'buffer' | 'clear'
export type Severity = 'critical' | 'high' | 'informational'

export type Shift = {
  id: string
  platform: string
  platformMark: string
  facility: string
  address: string
  start: string
  end: string
  startAt: Date
  endAt: Date
  color: string
  note?: string
}

export type ConflictResult = {
  type: ConflictType
  severity: Severity
  message: string
  detail: string
  related?: Shift
  availableMinutes?: number
}

export function normalizeShiftInterval(date: string, start: string, end: string): { startAt: Date; endAt: Date } {
  const startAt = new Date(`${date}T${start}:00`)
  const endAt = new Date(`${date}T${end}:00`)
  if (endAt <= startAt) endAt.setDate(endAt.getDate() + 1)
  return { startAt, endAt }
}

export function detectConflict(newShift: Shift, existing: Shift[], requiredBuffer = 45): ConflictResult {
  for (const current of existing) {
    if (newShift.startAt < current.endAt && newShift.endAt > current.startAt) {
      return {
        type: 'overlap',
        severity: 'critical',
        message: 'Direct overlap detected',
        detail: `${newShift.platform} at ${newShift.facility} overlaps your ${current.platform} commitment.`,
        related: current,
      }
    }

    const follows = newShift.startAt >= current.endAt
    const precedes = current.startAt >= newShift.endAt
    if (follows || precedes) {
      const previous = follows ? current : newShift
      const next = follows ? newShift : current
      const availableMinutes = Math.round((next.startAt.getTime() - previous.endAt.getTime()) / 60000)
      if (newShift.facility !== current.facility && availableMinutes < requiredBuffer) {
        return {
          type: 'buffer',
          severity: 'high',
          message: 'Tight travel window',
          detail: `Only ${availableMinutes} minutes between facilities. Your ${requiredBuffer}-minute buffer is not met.`,
          related: current,
          availableMinutes,
        }
      }
    }
  }

  return {
    type: 'clear',
    severity: 'informational',
    message: 'Clear to commit',
    detail: 'No overlap or travel-buffer risk found in your active shifts.',
  }
}
