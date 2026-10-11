/**
 * RECT TRACKER
 *
 * How a WebGL glass plate knows where its DOM card is.
 *
 * All registered elements are measured inside ONE requestAnimationFrame pass,
 * so the browser performs a single layout instead of one per card. Reading
 * `getBoundingClientRect` in a loop across separate frames is what turns a
 * smooth page into a janky one; batching the reads avoids that entirely.
 *
 * Writes go to the scene bridge, which the render loop reads. Nothing here
 * touches React state.
 */

import { rectToNdc, setCardRect, clearCardRect } from './sceneBridge'

const tracked = new Map<string, HTMLElement>()
let frame = 0
let running = false

function tick() {
  frame = requestAnimationFrame(tick)
  if (tracked.size === 0) return

  // Read pass — all measurements, no writes interleaved.
  const measured: Array<[string, DOMRect]> = []
  for (const [id, el] of tracked) {
    if (!el.isConnected) {
      clearCardRect(id)
      tracked.delete(id)
      continue
    }
    measured.push([id, el.getBoundingClientRect()])
  }

  // Write pass.
  for (const [id, r] of measured) {
    const ndc = rectToNdc(r.left, r.top, r.width, r.height)
    setCardRect({ ...ndc, id })
  }
}

function start() {
  if (running) return
  running = true
  frame = requestAnimationFrame(tick)
}

function stop() {
  if (!running) return
  running = false
  cancelAnimationFrame(frame)
}

export function trackCard(id: string, el: HTMLElement | null): void {
  if (!el) {
    tracked.delete(id)
    clearCardRect(id)
    if (tracked.size === 0) stop()
    return
  }
  tracked.set(id, el)
  start()
}

export function untrackCard(id: string): void {
  tracked.delete(id)
  clearCardRect(id)
  if (tracked.size === 0) stop()
}
