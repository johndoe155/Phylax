// Copies the latin subsets of the vendored variable fonts out of node_modules
// into public/fonts under stable names, so index.html can <link rel="preload">
// them and src/index.css can declare @font-face against a single, known path.
//
// Why not just `import '@fontsource-variable/archivo/wdth.css'`?
// That entry declares vietnamese / cyrillic / latin-ext faces too and resolves
// to hashed asset URLs, which makes preload impossible. Vendoring the four
// latin faces costs ~165KB once, downloads exactly one file per family, and
// means swapping in a licensed webfont later is a one-line src change.
//
// public/fonts is gitignored — this script is the source of truth, not the
// binaries. Run `npm run fonts` (also fires on predev/prebuild).

import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'fonts')

/** package dir (relative to node_modules/@fontsource-variable) → output name */
const FACES = [
  ['archivo/files/archivo-latin-wdth-normal.woff2', 'archivo-latin-wdth-normal.woff2'],
  ['space-grotesk/files/space-grotesk-latin-wght-normal.woff2', 'space-grotesk-latin-wght-normal.woff2'],
  ['geist/files/geist-latin-wght-normal.woff2', 'geist-latin-wght-normal.woff2'],
  ['geist-mono/files/geist-mono-latin-wght-normal.woff2', 'geist-mono-latin-wght-normal.woff2'],
]

mkdirSync(outDir, { recursive: true })

let copied = 0
for (const [rel, outName] of FACES) {
  const from = join(root, 'node_modules', '@fontsource-variable', rel)
  const to = join(outDir, outName)
  if (!existsSync(from)) {
    console.error(`[fonts] missing ${rel} — run \`npm install\` first`)
    process.exitCode = 1
    continue
  }
  copyFileSync(from, to)
  copied++
}

console.log(`[fonts] ${copied}/${FACES.length} latin woff2 faces → public/fonts`)
