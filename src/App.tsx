import { lazy, Suspense, useEffect, useState } from 'react'
import { useMotionRuntime } from './motion/useMotionRuntime'

/**
 * The WebGL layer is a dynamic import on purpose. three + R3F are ~245 KB
 * gzipped; the DOM content, typography and the conflict engine are what the
 * visitor actually needs on first paint. The canvas streams in behind them,
 * and if it never arrives the page is still complete.
 */
const SentinelCanvas = lazy(() =>
  import('./three/SentinelCanvas').then((m) => ({ default: m.SentinelCanvas })),
)
import { detectCapabilities, setReady, state as bridge } from './store/sceneBridge'
import { useDemo } from './store/demo'

import { Cursor } from './motion/Cursor'
import { Nav } from './sections/Nav'
import { Hero } from './sections/Hero'
import { CoordinationGap } from './sections/CoordinationGap'
import { CollisionReel } from './sections/CollisionReel'
import { GuardrailLoop } from './sections/GuardrailLoop'
import { ZeroTyping } from './sections/ZeroTyping'
import { ConflictEngine } from './sections/ConflictEngine'
import { PolicyIntelligence } from './sections/PolicyIntelligence'
import { Board } from './sections/Board'
import { Alerts } from './sections/Alerts'
import { Boundary } from './sections/Boundary'
import { Pricing } from './sections/Pricing'
import { Trust } from './sections/Trust'
import { Footer } from './sections/Footer'
import { Preloader } from './sections/Preloader'

export function App() {
  const { reducedMotion } = useMotionRuntime()
  const [caps] = useState(() => detectCapabilities())
  const [webglLost, setWebglLost] = useState(false)
  const today = useDemo((s) => s.today)

  useEffect(() => {
    const hasWebgl = caps.webgl && !webglLost
    bridge.webgl = hasWebgl
    setReady(true)
    document.documentElement.classList.toggle('no-webgl', !hasWebgl)
  }, [caps.webgl, webglLost])

  const showCanvas = caps.webgl && !webglLost && !reducedMotion

  return (
    <>
      <Preloader reducedMotion={reducedMotion} />

      {showCanvas ? (
        <Suspense fallback={null}>
          <SentinelCanvas tier={caps.tier} onContextLost={() => setWebglLost(true)} />
        </Suspense>
      ) : null}

      {/* CSS twin of the WebGL scan beam, for the no-WebGL / reduced-motion path */}
      {!showCanvas ? <div className="scan-line" aria-hidden="true" /> : null}

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200] focus:bg-sentinel focus:px-4 focus:py-2 focus:text-ink-950"
      >
        Skip to content
      </a>

      <Nav />

      <Cursor />

      <main id="main" className="relative z-10">
        <Hero />
        <CoordinationGap />
        <CollisionReel />
        <GuardrailLoop />
        <ZeroTyping />
        <ConflictEngine />
        <PolicyIntelligence today={today} />
        <Board />
        <Alerts />
        <Boundary />
        <Pricing />
        <Trust />
      </main>

      <Footer />
    </>
  )
}
