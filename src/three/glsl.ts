/**
 * GLSL for the Sentinel scene.
 *
 * Kept as TS template strings rather than .glsl files so the shader source
 * travels with its uniforms and types, and so Vite needs no raw-loader
 * configuration. Every shader shares one uniform block; see useSentinelUniforms.
 */

export const COMMON_UNIFORMS = /* glsl */ `
  uniform float uTime;
  uniform float uProgress;
  uniform vec2  uPointer;
  uniform float uConflict;
  uniform float uPulse;
  uniform vec3  uAccent;
  uniform vec3  uAlert;
  uniform vec3  uInk;
  uniform vec3  uBone;
`

/* ------------------------------------------------------------------ *
 * BACKDROP — atmosphere, horizon glow, scan beam, grain, vignette.
 * Rendered on a camera-facing quad so it is always screen-filling.
 * ------------------------------------------------------------------ */
export const BACKDROP_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const BACKDROP_FRAG = /* glsl */ `
  ${COMMON_UNIFORMS}
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  void main() {
    vec2 uv = vUv;
    vec2 p = uv - 0.5;
    p.x *= 1.0;

    // Base: the night shift. Slightly lifted at the horizon band.
    vec3 col = mix(uInk, uInk * 1.9, smoothstep(0.0, 0.95, uv.y));

    // Horizon glow — the watchman's light on the wall.
    float horizon = smoothstep(0.30, 0.0, abs(uv.y - 0.62));
    vec3 glow = mix(uAccent, uAlert, uConflict);
    col += glow * horizon * (0.10 + uConflict * 0.28);

    // Slow vertical breathing so a still page is never dead.
    col += glow * 0.018 * sin(uTime * 0.35 + uv.y * 6.0);

    // The Scan — one horizontal line that owns the whole page.
    float scanY = fract(uProgress * 1.0 + uTime * 0.015);
    float scan = smoothstep(0.0035, 0.0, abs(uv.y - scanY));
    col += mix(uAccent, uAlert, uConflict) * scan * 0.55;

    // Pointer halo — the visitor is part of the scene.
    float d = length((uv - (uPointer * 0.5 + 0.5)) * vec2(1.7, 1.0));
    col += mix(uAccent, uAlert, uConflict) * smoothstep(0.55, 0.0, d) * 0.05;

    // Conflict wash.
    col = mix(col, mix(col, uAlert, 0.34), uConflict * 0.55);
    col += uAlert * uPulse * 0.16 * smoothstep(1.1, 0.0, length(p * vec2(1.5, 1.0)));

    // Vignette + film grain.
    float vig = smoothstep(1.25, 0.28, length(p * vec2(1.35, 1.05)));
    col *= mix(0.55, 1.0, vig);
    col += (hash(uv * vec2(1920.0, 1080.0) + fract(uTime)) - 0.5) * 0.028;

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`

/* ------------------------------------------------------------------ *
 * GRID FLOOR — a perspective lattice receding to the horizon.
 * fwidth-based antialiasing keeps the far lines from aliasing to mush.
 * ------------------------------------------------------------------ */
export const GRID_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

export const GRID_FRAG = /* glsl */ `
  ${COMMON_UNIFORMS}
  uniform float uScroll;
  varying vec3 vWorld;

  float gridLine(vec2 coord, float width) {
    vec2 g = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
    float l = min(g.x, g.y);
    return 1.0 - smoothstep(0.0, width, l);
  }

  void main() {
    // Scroll drives the lattice toward the viewer — depth without movement.
    vec2 coord = vec2(vWorld.x * 0.5, vWorld.z * 0.5 + uScroll);

    float major = gridLine(coord, 1.0);
    float minor = gridLine(coord * 5.0, 1.0) * 0.28;
    float g = max(major, minor);

    // Distance fade — the floor dissolves into the horizon.
    float dist = length(vWorld.xz - vec2(0.0, -14.0));
    float fade = smoothstep(150.0, 12.0, dist);

    vec3 lineCol = mix(uAccent, uAlert, uConflict);
    vec3 col = lineCol * g * fade * (0.34 + uConflict * 0.5);

    // A pulse travelling down the z axis, timed to the scroll.
    float wave = smoothstep(2.5, 0.0, abs(vWorld.z + 14.0 - mod(uScroll * 4.0, 60.0) + 30.0));
    col += lineCol * wave * 0.06 * fade;

    float alpha = g * fade;
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }
`

/* ------------------------------------------------------------------ *
 * DUST — instanced motes. Each one is a commitment floating in the system.
 * ------------------------------------------------------------------ */
export const DUST_VERT = /* glsl */ `
  attribute float aSeed;
  attribute float aScale;
  uniform float uTime;
  uniform float uScroll;
  uniform float uConflict;
  varying float vAlpha;
  varying float vSeed;

  void main() {
    vSeed = aSeed;
    vec3 p = position;

    float t = uTime * 0.12 + aSeed * 6.2831;
    p.x += sin(t) * 1.4;
    p.y += cos(t * 0.7) * 0.9;
    p.z += mod(uScroll * 3.0 + aSeed * 90.0, 120.0) - 60.0;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    float size = aScale * (26.0 + uConflict * 22.0);
    gl_PointSize = size * (26.0 / max(1.0, -mv.z));

    float dist = length(mv.xyz);
    vAlpha = smoothstep(120.0, 12.0, dist) * (0.35 + aScale * 0.65);
  }
`

export const DUST_FRAG = /* glsl */ `
  ${COMMON_UNIFORMS}
  varying float vAlpha;
  varying float vSeed;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.05, d) * vAlpha;

    vec3 col = mix(uAccent, uAlert, uConflict);
    // A few motes run warm even when calm — the system is never fully idle.
    col = mix(col, uBone, step(0.86, vSeed) * 0.7);
    gl_FragColor = vec4(col, a * (0.55 + uConflict * 0.45));
    #include <colorspace_fragment>
  }
`

/* ------------------------------------------------------------------ *
 * SHOCKWAVE — fired when a conflict is detected. Expanding ring in world
 * space at the collision point.
 * ------------------------------------------------------------------ */
export const WAVE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const WAVE_FRAG = /* glsl */ `
  ${COMMON_UNIFORMS}
  uniform float uWave;   // 0 → 1 life of this wave
  varying vec2 vUv;

  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float ring = smoothstep(0.09, 0.0, abs(d - uWave));
    float core = smoothstep(uWave, uWave - 0.35, d) * (1.0 - uWave) * 0.18;
    float a = (ring * (1.0 - uWave) + core);
    if (a < 0.002) discard;
    vec3 col = mix(uAccent, uAlert, clamp(uConflict + uWave, 0.0, 1.0));
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }
`

/* ------------------------------------------------------------------ *
 * PLATE — the halo behind a DOM shift card.
 *
 * A flat additive quad would read as a hard-edged glowing box, so the
 * falloff blends a radial term with a rectangular one: bright across the
 * card's own footprint, dissolving through the oversize bleed.
 * ------------------------------------------------------------------ */
export const PLATE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const PLATE_FRAG = /* glsl */ `
  uniform vec3  uColor;
  uniform float uOpacity;
  varying vec2 vUv;

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float radial = smoothstep(1.0, 0.22, length(p));
    float rect = smoothstep(1.0, 0.55, max(abs(p.x), abs(p.y)));
    float a = mix(radial, rect, 0.55) * uOpacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }
`
