import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

// jsxLocPlugin stamps `data-loc` on elements in dev only; it ships nothing to the browser in a production build.
//
// The three Manus plugins that used to be here are gone, and it matters that they are:
//
//   vitePluginManusRuntime   injected a ~350 kB INLINE script into the built index.html on every build. The API serves that
//                            file with `script-src 'self' <sha256 of each inline script>`, so the hash was recomputed at boot
//                            for a script nothing in this app uses — and any mismatch between the built file and the booting
//                            server left the page's own loader gate blocked. The whole thing was dead weight from the
//                            hosting preview, not part of Phylax.
//   vitePluginManusDebugCollector  POSTed browser console, network and "session replay" data to /__manus__/logs in dev.
//                            A local file is not where a person's console output should go, and it had no place in a build.
//   vitePluginStorageProxy   turned /manus-storage/* into a presigned redirect to a Forge bucket using BUILT_IN_FORGE_API_*
//                            from the environment. Nothing in this app has ever requested that path.
const plugins = [react(), tailwindcss(), jsxLocPlugin()];

// =============================================================================
// The API proxy
// =============================================================================
//
// The browser must talk to the API SAME-ORIGIN. Two things depend on it and neither can be worked around on the client:
//
//   1. the session cookie and the CSRF cookie are first-party (no SameSite=None, no cross-site rules), and
//   2. `requireSameOrigin` on the server refuses a mutating request whose `Origin` is not `APP_URL`, which is exactly
//      the page's own origin.
//
// So in development Vite forwards `/api` to the backend and the app calls relative paths. `changeOrigin: false` matters:
// with it on, the proxied request would arrive with `Host: 127.0.0.1:3100` and (in some setups) a rewritten Origin,
// which the server would be right to refuse. Leaving the headers alone keeps the request looking exactly like the
// same-origin call it is.
//
// The backend's own `APP_URL` has to name this dev origin (see phylax-backend/.env) — the origin check compares against
// that value, not against the API's address, which nobody types.
const API_TARGET = process.env.PHYLAX_API_URL || "http://127.0.0.1:3100";

export default defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    strictPort: false, // Will find next available port if 3000 is busy
    host: true,
    allowedHosts: [
      ".manuspre.computer",
      ".manus.computer",
      ".manus-asia.computer",
      ".manuscomputer.ai",
      ".manusvm.computer",
      ".e2b.app",
      "localhost",
      "127.0.0.1",
    ],
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: false,
        // The API is HTTP/1.1 JSON; nothing here needs WebSocket upgrades.
        ws: false,
      },
    },
  },
});
