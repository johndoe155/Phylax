/**
 * Frame-rate independent scalar damping.
 *
 * Hand-rolled rather than pulled from a math library: this is the one hot
 * path in the app (every uniform, every camera axis, every glass plate), and
 * it is three lines of exponential smoothing.
 */

/** Exponential approach: identical result at 60fps and 144fps. */
export function dampScalar(
  current: number,
  target: number,
  smoothTime: number,
  dt: number,
): number {
  const t = 1 - Math.exp(-dt / Math.max(0.0001, smoothTime))
  return current + (target - current) * t
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}
