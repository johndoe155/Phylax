/**
 * One shared uniform block for the whole scene.
 *
 * A single object reference is handed to every ShaderMaterial, so the frame
 * loop writes these values exactly once per frame instead of walking the scene
 * graph. Mutating `uniform.value` in place is what keeps the loop allocation
 * free — never reassign the uniform objects themselves.
 */

import * as THREE from 'three'

export const PALETTE = {
  accent: new THREE.Color('#4DE1FF'),
  alert: new THREE.Color('#FF5C38'),
  caution: new THREE.Color('#FFC14D'),
  ink: new THREE.Color('#05060A'),
  bone: new THREE.Color('#F2F4F7'),
} as const

export interface SentinelUniforms {
  uTime: { value: number }
  uProgress: { value: number }
  uPointer: { value: THREE.Vector2 }
  uConflict: { value: number }
  uPulse: { value: number }
  uAccent: { value: THREE.Color }
  uAlert: { value: THREE.Color }
  uInk: { value: THREE.Color }
  uBone: { value: THREE.Color }
}

export function createUniforms(): SentinelUniforms {
  return {
    uTime: { value: 0 },
    uProgress: { value: 0 },
    uPointer: { value: new THREE.Vector2(0, 0) },
    uConflict: { value: 0 },
    uPulse: { value: 0 },
    uAccent: { value: PALETTE.accent.clone() },
    uAlert: { value: PALETTE.alert.clone() },
    uInk: { value: PALETTE.ink.clone() },
    uBone: { value: PALETTE.bone.clone() },
  }
}

/**
 * THREE wants `{ [uniform: string]: IUniform }`. Our interface is deliberately
 * narrower and better typed, so the boundary is crossed once, explicitly,
 * here — rather than weakening the interface with an index signature.
 */
export function asThreeUniforms(u: object): { [uniform: string]: THREE.IUniform } {
  return u as unknown as { [uniform: string]: THREE.IUniform }
}

/** Severity → how much alarm the scene should carry (0 = calm, 1 = critical). */
export function severityEnergy(severity: string | null): number {
  switch (severity) {
    case 'critical':
      return 1
    case 'high':
      return 0.72
    case 'warning':
      return 0.4
    case 'info':
      return 0.16
    default:
      return 0
  }
}
