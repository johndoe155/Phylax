# Phylax

**Cross-platform shift conflict guardrail for per-diem CNAs, LPNs and RNs.**

Marketing site + a live in-browser product demo. The conflict engine on this
site is the real thing — the same module the product will ship — not a
scripted animation.

Concept source: [`Phylax_micro_saas_breakdown.md`](./Phylax_micro_saas_breakdown.md).
Section references below (e.g. §9.3) point into that document.

---

## Run it

```bash
npm install      # also runs `npm run fonts` via predev/prebuild
npm run dev      # http://localhost:5173, bound to 0.0.0.0
npm run build    # tsc --noEmit && vite build
npm test         # vitest, 38 tests
```

`npm run fonts` copies the four latin variable faces out of
`@fontsource-variable/*` into `public/fonts/`. That directory is gitignored —
the script is the source of truth, not the binaries. It exists because
`fonts.googleapis.com`, `fonts.gstatic.com` and `api.fontshare.com` are all
unreachable from this environment; only the npm registry is.

---

## Stack (all pinned)

| | | |
|---|---|---|
| Vite | 8.3.4 | Rolldown-based; `manualChunks` is a function, not a map |
| React | 19.3.0 | R3F 9 requires `>=19 <19.4` |
| TypeScript | **5.9.3** | deliberately *not* `latest` (7.0.2, the new native-compiler major) |
| three | 0.186.1 | |
| @react-three/fiber | 9.8.1 | |
| GSAP + ScrollTrigger | 3.15.0 | |
| Lenis | 1.3.26 | vanilla class, driven by the GSAP ticker |
| Tailwind | 4.3.3 | CSS-first config via `@theme` |
| Zustand | 5.0.15 | |
| Vitest | 5.0.3 | + jsdom for the render smoke test |

`@react-three/drei`, `@react-spring/three` and `maath` were installed early and
then **removed** — they were unused, and `maath`'s `damp` turned out to mutate
an object property rather than smooth a scalar, so `src/three/damp.ts` exists
instead.

### Typography

| Face | Use | Axis |
|---|---|---|
| Archivo Variable | display | `wght 100–900`, `wdth 62–125%` |
| Space Grotesk Variable | body | `wght 300–700` |
| Geist Variable / Geist Mono | UI + instrumentation | `wght 100–900` |

Space Grotesk tops out at **700** and therefore cannot be the display face —
that is why Archivo carries headlines. All four are SIL OFL and self-hosted.

The type system resolves through `--font-display` / `--font-body` /
`--font-mono` in `src/index.css`, so swapping in a licensed PP Neue Machina /
Neue Montreal webfont later is a one-line `src` change per face.

---

## Architecture

### Three layers

```
z-0    <canvas id="sentinel">     fixed, full-viewport, pointer-events:none
z-10   DOM overlay                scrollable, semantic, indexable
z-50+  chrome                     nav, cursor, preloader
```

**DOM-primary, WebGL-reactive.** The shift cards carry real text — facility,
times, platform, policy window — so they stay in the DOM where they are crisp,
selectable and screen-reader legible. WebGL owns atmosphere: the horizon
lattice, dust, the scan beam, the shockwave, and a halo behind each card.

### The bridge

`src/store/sceneBridge.ts` is the only channel between the two. Three rules:

1. **Nothing in the frame loop touches React state.** Per-frame values live in
   a plain mutable object outside React's render path.
2. **WebGL never calls `setState`.** It drives GSAP on the node or writes a CSS
   custom property.
3. **The DOM is the source of truth.** The canvas reacts; it never initiates.

`src/store/rectTracker.ts` measures every tracked card inside **one**
`requestAnimationFrame` pass, so the browser does a single layout instead of
one per card. That is what keeps the halo locked to its card without jank.

The canvas is a **dynamic import**. three + R3F are ~245 KB gzipped; the DOM
content and the engine are what first paint needs, so the canvas streams in
behind them — and if it never arrives, the page is still complete.

### The engine

`src/engine/` is pure TypeScript: no React, no three, no browser APIs.

| File | Covers |
|---|---|
| `interval.ts` | §9.2 strict overlap, §9.3 midnight normalization |
| `geo.ts` | §9.4 haversine + travel buffer, with an explicit fallback |
| `detect.ts` | §9.6 severity ladder, §20.8 duplicates, midnight-flag audit |
| `policy.ts` | §10 cancellation windows + the §10.3 disclaimer |

All time math goes through `Date.UTC`, so results are identical on every
machine and in every test runner regardless of host timezone.

Midnight handling is defensive twice over: a shift is normalized as overnight
if it is *flagged* `crossesMidnight` **or** if `end <= start`. An unflagged
19:00–07:00 entry still resolves to a correct 12-hour interval instead of a
negative one.

### Demo data

`src/data/seed.ts` builds a realistic week that exercises every branch of the
engine: a critical 4-hour overlap, an overnight 19:00–07:00 shift, a 46 km
commute with only 60 minutes of gap, and a clean day. Every conflict shown
anywhere on the site is computed from this by `findConflicts`.

The buffer slider in §9.4 is wired to `setBuffer`, which re-runs the whole
board live.

---

## Verification

What was actually run, and what came back:

| Command | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | **38 passed** (28 engine, 10 render) |
| `npm run build` | succeeds; critical path **143.7 KB gz** |
| `curl localhost:5173/` | 200, `text/html` |
| `curl /fonts/*.woff2` | 200 `font/woff2`, all four faces |

The **render smoke test** pushes the real `<App />` through
`react-dom/server` in jsdom — every section, the real store, the real engine —
and asserts the engine's own conflict message reaches the DOM byte-for-byte.
It caught nothing fake: the message it asserts is generated by
`findConflicts`, not written by hand.

Bundle after lazy-loading the canvas:

```
index            25.56 KB gz   ┐
motion           49.46 KB gz   ├─ 143.7 KB gz on first paint
react            68.27 KB gz   │
runtime           0.42 KB gz   ┘
SentinelCanvas  245.02 KB gz   ← lazy, after first paint
```

---

## Known gaps — not verified here

Stated plainly rather than papered over:

- **No browser in this environment.** No GLSL shader has been compiled by a
  real GPU, no layout has been seen rendered, and no FPS figure has been
  measured. The shaders were reviewed by hand only. The 60 fps target in the
  original plan is **unmeasured**.
- **Cancellation-policy data is illustrative.** Every row in
  `src/engine/policy.ts` is demo copy. §10.3 requires that policy never be
  presented as a guarantee, so the disclaimer is rendered next to every policy
  surface and in the footer. Replace these rows with verified data before
  anyone relies on them.
- **The waitlist form is a stub.** It validates and confirms client-side, and
  says so in the UI. No backend.
- **No ESLint/Prettier.** Deferred in favour of the checks that actually gate
  the build; `tsc --noEmit` with `noUnusedLocals`/`noUnusedParameters` is
  doing that work.
- **Legal copy** (privacy, terms, SMS/TCPA consent) is intentionally not
  written. The footer marks it pending.
- **Free-tier cap is 5**, a placeholder; §20.2 leaves it open pending real
  concurrent-shift data.

## Trademark handling

The five staffing platforms are named in copy. **No logos** are used, and the
footer carries a non-affiliation notice. Platform identity in the UI is an
abstract two-letter glyph with a per-platform accent colour.
