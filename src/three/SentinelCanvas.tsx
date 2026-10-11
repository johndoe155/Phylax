/**
 * THE SENTINEL SCENE
 *
 * Fixed full-viewport canvas, pointer-events:none, sitting under the DOM.
 * The DOM scrolls; this scene reacts. It never initiates.
 */

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { allCardRects, state as bridge, type PerfTier } from '../store/sceneBridge'
import {
  BACKDROP_FRAG,
  BACKDROP_VERT,
  DUST_FRAG,
  DUST_VERT,
  GRID_FRAG,
  GRID_VERT,
  PLATE_FRAG,
  PLATE_VERT,
  WAVE_FRAG,
  WAVE_VERT,
} from './glsl'
import { asThreeUniforms, createUniforms, PALETTE, severityEnergy } from './uniforms'
import { dampScalar } from './damp'

type Uniforms = ReturnType<typeof createUniforms>

const DUST_COUNT: Record<PerfTier, number> = { high: 1400, medium: 700, low: 0 }
const MAX_PLATES = 6
const PLATE_DISTANCE = 18
/**
 * Plates are deliberately LARGER than the card they sit behind.
 *
 * The DOM cards have opaque backgrounds, so a plate matched exactly to the
 * card rect would be entirely hidden by it. Oversizing turns it into a halo
 * that bleeds past the edges — which is the effect actually wanted, and it
 * keeps text contrast untouched.
 */
const PLATE_BLOAT = 1.5

/* ------------------------------------------------------------------ *
 * Frame driver — the only place that reads the bridge per frame.
 * ------------------------------------------------------------------ */
function SceneDriver({ uniforms }: { uniforms: Uniforms }) {
  const { camera } = useThree()
  const target = useMemo(() => new THREE.Vector3(), [])
  const base = useMemo(() => new THREE.Vector3(0, 5.4, 26), [])

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05)
    bridge.time += dt

    uniforms.uTime.value = bridge.time
    uniforms.uProgress.value = bridge.progress

    // Pointer smoothing — one damp for the whole scene.
    uniforms.uPointer.value.x = dampScalar(uniforms.uPointer.value.x, bridge.pointerX, 0.09, dt)
    uniforms.uPointer.value.y = dampScalar(uniforms.uPointer.value.y, bridge.pointerY, 0.09, dt)

    // Conflict energy eases toward the worst live severity.
    const wanted = severityEnergy(bridge.severity)
    uniforms.uConflict.value = dampScalar(uniforms.uConflict.value, wanted, 0.22, dt)
    uniforms.uPulse.value = Math.max(0, uniforms.uPulse.value - dt * 1.35)
    bridge.conflictPulse = Math.max(0, bridge.conflictPulse - dt * 1.35)
    bridge.conflictEnergy = uniforms.uConflict.value

    // Camera: scroll dollies us down the corridor, pointer leans us slightly.
    const p = bridge.progress
    target.set(
      base.x + uniforms.uPointer.value.x * 2.2,
      base.y - p * 5.5 + uniforms.uPointer.value.y * 1.1,
      base.z - p * 13,
    )
    camera.position.x = dampScalar(camera.position.x, target.x, 0.07, dt)
    camera.position.y = dampScalar(camera.position.y, target.y, 0.07, dt)
    camera.position.z = dampScalar(camera.position.z, target.z, 0.07, dt)
    camera.lookAt(0, 1.5 - p * 3, camera.position.z - 34)
  })

  return null
}

/* ------------------------------------------------------------------ *
 * BACKDROP — camera-facing quad, always screen-filling.
 * ------------------------------------------------------------------ */
function Backdrop({ uniforms }: { uniforms: Uniforms }) {
  const ref = useRef<THREE.Mesh>(null)
  const dir = useMemo(() => new THREE.Vector3(), [])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: asThreeUniforms(uniforms),
        vertexShader: BACKDROP_VERT,
        fragmentShader: BACKDROP_FRAG,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    [uniforms],
  )

  useEffect(() => () => material.dispose(), [material])

  useFrame(({ camera }) => {
    const m = ref.current
    if (!m) return
    camera.getWorldDirection(dir)
    m.position.copy(camera.position).addScaledVector(dir, 60)
    m.quaternion.copy(camera.quaternion)
  })

  return (
    <mesh ref={ref} renderOrder={-10} frustumCulled={false}>
      <planeGeometry args={[260, 160]} />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

/* ------------------------------------------------------------------ *
 * GRID FLOOR — the lattice the watchman stands on.
 * ------------------------------------------------------------------ */
function GridFloor({ uniforms }: { uniforms: Uniforms }) {
  // The grid needs one uniform the shared block does not carry: how far the
  // lattice has been dragged toward the viewer by scrolling.
  const matUniforms = useMemo(() => ({ ...uniforms, uScroll: { value: 0 } }), [uniforms])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: asThreeUniforms(matUniforms),
        vertexShader: GRID_VERT,
        fragmentShader: GRID_FRAG,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
      }),
    [matUniforms],
  )

  useEffect(() => () => material.dispose(), [material])

  useFrame(() => {
    matUniforms.uScroll.value = bridge.scrollY * 0.0035
  })

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -6, -30]} renderOrder={-5}>
      <planeGeometry args={[420, 420, 1, 1]} />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

/* ------------------------------------------------------------------ *
 * DUST — motes drifting through the corridor. Each one is a commitment
 * floating in the system.
 * ------------------------------------------------------------------ */
function Dust({ uniforms, tier }: { uniforms: Uniforms; tier: PerfTier }) {
  const count = DUST_COUNT[tier]

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    if (count === 0) return g
    const pos = new Float32Array(count * 3)
    const seed = new Float32Array(count)
    const scale = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      pos[i * 3 + 0] = (Math.random() - 0.5) * 90
      pos[i * 3 + 1] = Math.random() * 34 - 4
      pos[i * 3 + 2] = (Math.random() - 0.5) * 90
      seed[i] = Math.random()
      scale[i] = 0.4 + Math.random() * 0.9
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    g.setAttribute('aScale', new THREE.BufferAttribute(scale, 1))
    return g
  }, [count])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: asThreeUniforms(uniforms),
        vertexShader: DUST_VERT,
        fragmentShader: DUST_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    [uniforms],
  )

  useEffect(() => {
    return () => {
      geometry.dispose()
      material.dispose()
    }
  }, [geometry, material])

  if (count === 0) return null
  return <points geometry={geometry} material={material} frustumCulled={false} />
}

/* ------------------------------------------------------------------ *
 * SHOCKWAVE — fired when a critical or high conflict is detected.
 * ------------------------------------------------------------------ */
function Shockwave({ uniforms }: { uniforms: Uniforms }) {
  const life = useRef(1)
  const meshRef = useRef<THREE.Mesh>(null)

  const matUniforms = useMemo(() => ({ ...uniforms, uWave: { value: 1 } }), [uniforms])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: asThreeUniforms(matUniforms),
        vertexShader: WAVE_VERT,
        fragmentShader: WAVE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    [matUniforms],
  )

  useEffect(() => () => material.dispose(), [material])

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05)
    // Latch: a fresh pulse (set by setSeverity) restarts the wave.
    if (bridge.conflictPulse > 0.85 && life.current >= 1) life.current = 0
    if (life.current < 1) life.current = Math.min(1, life.current + dt * 0.62)
    matUniforms.uWave.value = life.current
    meshRef.current?.scale.setScalar(6 + life.current * 46)
  })

  return (
    <mesh ref={meshRef} position={[0, 2, -18]}>
      <planeGeometry args={[1, 1]} />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

/* ------------------------------------------------------------------ *
 * GLASS PLATES — WebGL light locked to measured DOM card rects.
 *
 * Each plate sits at a fixed distance in front of the camera; its world size
 * is derived from the world height of one pixel at that distance, so a plate
 * covers its card regardless of camera distance or viewport.
 * ------------------------------------------------------------------ */
function GlassPlates() {
  const group = useRef<THREE.Group>(null)
  const scratch = useMemo(
    () => ({
      fwd: new THREE.Vector3(),
      right: new THREE.Vector3(),
      up: new THREE.Vector3(),
      pos: new THREE.Vector3(),
      color: new THREE.Color(),
    }),
    [],
  )

  // One material per plate: each carries its own opacity and colour uniform.
  const materials = useMemo(
    () =>
      Array.from({ length: MAX_PLATES }, () => ({
        uniforms: {
          uColor: { value: new THREE.Color('#4DE1FF') },
          uOpacity: { value: 0 },
        },
        target: 0,
      })),
    [],
  )

  useFrame(({ camera }, delta) => {
    const g = group.current
    if (!g) return
    const cam = camera as THREE.PerspectiveCamera
    cam.getWorldDirection(scratch.fwd)
    scratch.right.crossVectors(scratch.fwd, cam.up).normalize()
    scratch.up.crossVectors(scratch.right, scratch.fwd).normalize()

    const vFov = (cam.fov * Math.PI) / 180
    const worldPerPx =
      (2 * Math.tan(vFov / 2) * PLATE_DISTANCE) / Math.max(1, bridge.viewportH)

    const rects = allCardRects().filter((r) => r.visible)
    const dt = Math.min(delta, 0.05)

    // Cyan when calm, coral when something is wrong.
    scratch.color.copy(PALETTE.accent).lerp(PALETTE.alert, bridge.conflictEnergy)

    g.children.forEach((child, i) => {
      const mesh = child as THREE.Mesh
      const entry = materials[i]
      const r = rects[i]

      if (!r) {
        mesh.visible = false
        entry.target = 0
        entry.uniforms.uOpacity.value = dampScalar(
          entry.uniforms.uOpacity.value,
          0,
          0.14,
          dt,
        )
        return
      }
      mesh.visible = true

      scratch.pos
        .copy(cam.position)
        .addScaledVector(scratch.fwd, PLATE_DISTANCE)
        .addScaledVector(scratch.right, r.ndcX * (bridge.viewportW / 2) * worldPerPx)
        .addScaledVector(scratch.up, r.ndcY * (bridge.viewportH / 2) * worldPerPx)

      mesh.position.x = dampScalar(mesh.position.x, scratch.pos.x, 0.12, dt)
      mesh.position.y = dampScalar(mesh.position.y, scratch.pos.y, 0.12, dt)
      mesh.position.z = dampScalar(mesh.position.z, scratch.pos.z, 0.12, dt)
      mesh.quaternion.copy(cam.quaternion)
      mesh.scale.set(
        Math.max(0.001, r.width * worldPerPx * PLATE_BLOAT),
        Math.max(0.001, r.height * worldPerPx * PLATE_BLOAT),
        1,
      )

      entry.target = 0.26 + bridge.conflictEnergy * 0.55
      entry.uniforms.uOpacity.value = dampScalar(
        entry.uniforms.uOpacity.value,
        entry.target,
        0.14,
        dt,
      )
      entry.uniforms.uColor.value.copy(scratch.color)
    })
  })

  return (
    <group ref={group}>
      {materials.map((entry, i) => (
        <mesh key={i} visible={false} frustumCulled={false}>
          <planeGeometry args={[1, 1]} />
          <shaderMaterial
            args={[
              {
                uniforms: entry.uniforms,
                vertexShader: PLATE_VERT,
                fragmentShader: PLATE_FRAG,
                transparent: true,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                toneMapped: false,
              },
            ]}
          />
        </mesh>
      ))}
    </group>
  )
}

/* ------------------------------------------------------------------ *
 * CANVAS
 * ------------------------------------------------------------------ */
export interface SentinelCanvasProps {
  tier: PerfTier
  onContextLost?: () => void
}

export function SentinelCanvas({ tier, onContextLost }: SentinelCanvasProps) {
  const uniforms = useMemo(() => createUniforms(), [])
  const dpr: [number, number] = tier === 'high' ? [1, 1.75] : tier === 'medium' ? [1, 1.4] : [1, 1]

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0" data-sentinel-canvas="">
      <Canvas
        flat
        dpr={dpr}
        gl={{
          antialias: tier === 'high',
          alpha: false,
          powerPreference: 'high-performance',
          stencil: false,
          depth: true,
        }}
        camera={{ fov: 42, near: 0.1, far: 400, position: [0, 5.4, 26] }}
        onCreated={({ gl }) => {
          gl.setClearColor('#05060A', 1)
          gl.domElement.addEventListener('webglcontextlost', (e) => {
            e.preventDefault()
            onContextLost?.()
          })
        }}
      >
        <SceneDriver uniforms={uniforms} />
        <Backdrop uniforms={uniforms} />
        <GridFloor uniforms={uniforms} />
        <Dust uniforms={uniforms} tier={tier} />
        <Shockwave uniforms={uniforms} />
        <GlassPlates />
      </Canvas>
    </div>
  )
}
