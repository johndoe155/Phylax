/**
 * THE SCENE BRIDGE
 *
 * The single channel between the DOM layer and the WebGL layer.
 *
 * Three rules, and the whole build depends on them:
 *
 *  1. Nothing in the render loop touches React state. Every per-frame value
 *     lives in the mutable `state` object below, held outside React's render
 *     path. Reading it 60×/second must never schedule a re-render.
 *  2. WebGL never calls setState. When the scene needs to change the DOM it
 *     drives GSAP on the node directly, or writes a CSS custom property.
 *  3. The DOM is the source of truth. The canvas is a reactive renderer that
 *     is told what the document is doing — never the other way round.
 *
 * `subscribe` exists for the rare non-frame concerns (severity changes) where
 * a component genuinely should re-render.
 */

import type { Severity } from '../engine/types'

export type PerfTier = 'high' | 'medium' | 'low'

export interface CardRect {
  id: string
  left: number
  top: number
  width: number
  height: number
  /** Element centre in normalized device coordinates, x ∈ [-1,1]. */
  ndcX: number
  ndcY: number
  visible: boolean
}

export interface SceneState {
  time: number
  /** Whole-page scroll progress, 0 at top, 1 at bottom. */
  progress: number
  scrollY: number
  /** Section-local progress for the currently pinned choreography. */
  sectionProgress: number
  sectionId: string
  /** Smoothed pointer, normalized to [-1, 1] with (0,0) at viewport centre. */
  pointerX: number
  pointerY: number
  /** Raw, unsmoothed — used for cursor hit-testing only. */
  rawPointerX: number
  rawPointerY: number
  pointerActive: boolean
  viewportW: number
  viewportH: number
  dpr: number
  /** 0 → calm, 1 → full alarm. Drives shockwave, aberration and tint. */
  conflictEnergy: number
  severity: Severity | null
  /** Set for one frame when a new conflict fires, so shaders can latch. */
  conflictPulse: number
  reducedMotion: boolean
  webgl: boolean
  tier: PerfTier
  ready: boolean
}

export const state: SceneState = {
  time: 0,
  progress: 0,
  scrollY: 0,
  sectionProgress: 0,
  sectionId: 'hero',
  pointerX: 0,
  pointerY: 0,
  rawPointerX: 0,
  rawPointerY: 0,
  pointerActive: false,
  viewportW: typeof window === 'undefined' ? 1440 : window.innerWidth,
  viewportH: typeof window === 'undefined' ? 900 : window.innerHeight,
  dpr: typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2),
  conflictEnergy: 0,
  severity: null,
  conflictPulse: 0,
  reducedMotion: false,
  webgl: true,
  tier: 'high',
  ready: false,
}

/* ------------------------------------------------------------------ *
 * Card rect registry — how a WebGL glass plate knows where its DOM
 * card is. Populated by ResizeObserver + scroll, read by useFrame.
 * ------------------------------------------------------------------ */

const cards = new Map<string, CardRect>()

export function setCardRect(rect: CardRect): void {
  cards.set(rect.id, rect)
}

export function clearCardRect(id: string): void {
  cards.delete(id)
}

export function allCardRects(): CardRect[] {
  return [...cards.values()]
}

/** Convert a viewport-space rect to NDC so a plane can be placed over it. */
export function rectToNdc(left: number, top: number, width: number, height: number): CardRect {
  const vw = state.viewportW || 1
  const vh = state.viewportH || 1
  return {
    id: '',
    left,
    top,
    width,
    height,
    ndcX: ((left + width / 2) / vw) * 2 - 1,
    ndcY: -(((top + height / 2) / vh) * 2 - 1),
    visible: top + height > 0 && top < vh,
  }
}

/* ------------------------------------------------------------------ *
 * Non-frame subscriptions (severity, readiness)
 * ------------------------------------------------------------------ */

type Listener = (s: Readonly<SceneState>) => void
const listeners = new Set<Listener>()

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit(): void {
  for (const fn of listeners) fn(state)
}

export function setSeverity(severity: Severity | null): void {
  if (state.severity === severity) return
  state.severity = severity
  if (severity === 'critical' || severity === 'high') state.conflictPulse = 1
  emit()
}

export function setReady(ready: boolean): void {
  if (state.ready === ready) return
  state.ready = ready
  emit()
}

/**
 * Capability + performance tiering. Decided once, on the main thread, before
 * the canvas mounts — so we never render a heavy scene just to find out the
 * device cannot handle it.
 */
export function detectCapabilities(): { webgl: boolean; tier: PerfTier; reducedMotion: boolean } {
  const reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  let webgl = false
  if (typeof document !== 'undefined') {
    try {
      const canvas = document.createElement('canvas')
      webgl = Boolean(
        canvas.getContext('webgl2') ||
          canvas.getContext('webgl') ||
          canvas.getContext('experimental-webgl'),
      )
    } catch {
      webgl = false
    }
  }

  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 4 : 4
  // deviceMemory is Chromium-only; treat its absence as "probably fine".
  const memory =
    typeof navigator !== 'undefined'
      ? ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8)
      : 8
  const small = typeof window !== 'undefined' && window.innerWidth < 820

  let tier: PerfTier = 'high'
  if (small || cores <= 4 || memory <= 4) tier = 'low'
  else if (cores <= 8 || memory <= 8) tier = 'medium'
  if (reducedMotion) tier = 'low'

  return { webgl, tier, reducedMotion }
}
