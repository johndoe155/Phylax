/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // The sandbox exposes the dev server through https://{port}-{id}.e2b.app.
    // Vite rejects unknown Host headers by default, so the preview origin
    // must be permitted or every request returns 403.
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        // Vite 8 is Rolldown-based: manualChunks is a function, not a map.
        // three + @react-three are deliberately NOT listed — the canvas is a
        // dynamic import, so letting the bundler place them at that boundary
        // keeps ~245KB of WebGL out of the critical path.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('/gsap/') || id.includes('/lenis/')) return 'motion'
          if (
            id.includes('/react-dom/') ||
            id.includes('/react/') ||
            id.includes('/scheduler/')
          )
            return 'react'
          return undefined
        },
      },
    },
  },
})
