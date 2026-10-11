/**
 * §9.4 — commute buffer.
 *
 * Deliberately naive, and deliberately explainable. The blueprint is explicit
 * that v1 should "avoid turning this into a complex route-planning product"
 * and should surface insufficient buffer as a warning rather than pretending
 * to predict traffic. So: great-circle distance at a fixed average speed,
 * plus a visible safety margin — and every number the alert shows is derivable
 * by the worker from what we display.
 */

import type { EngineOptions, Facility } from './types'

const EARTH_RADIUS_KM = 6371

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

export interface BufferRequirement {
  minutes: number
  source: 'travel-estimate' | 'default'
  /** Present only for travel-estimate; kilometres of great-circle distance. */
  distanceKm?: number
  /** Present only for travel-estimate; raw drive time before the margin. */
  travelMinutes?: number
}

/**
 * How long the worker needs between two facilities.
 *
 * Straight-line distance understates real driving, so the estimate is inflated
 * by a routing factor before the safety margin is added. If either facility
 * lacks coordinates we fall back to the user's configured default and say so —
 * never invent a number we cannot justify.
 */
export function requiredBuffer(
  from: Facility,
  to: Facility,
  opts: EngineOptions,
): BufferRequirement {
  if (
    !opts.useTravelEstimate ||
    from.lat == null ||
    from.lng == null ||
    to.lat == null ||
    to.lng == null
  ) {
    return { minutes: opts.defaultBufferMinutes, source: 'default' }
  }

  const km = distanceKm(
    { lat: from.lat, lng: from.lng },
    { lat: to.lat, lng: to.lng },
  )
  // Straight-line → road distance correction.
  const roadKm = km * 1.3
  const travelMinutes = (roadKm / opts.travelSpeedKmh) * 60

  return {
    minutes: Math.max(
      opts.defaultBufferMinutes,
      Math.ceil(travelMinutes + opts.safetyMarginMinutes),
    ),
    source: 'travel-estimate',
    distanceKm: Math.round(km * 10) / 10,
    travelMinutes: Math.round(travelMinutes),
  }
}
