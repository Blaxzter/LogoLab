import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// `*.localhost` resolves to 127.0.0.1 per RFC 6761, so the dev server can bind
// to a branded hostname without touching /etc/hosts.
const DEV_HOST = 'logolabs.localhost'
const DEV_PORT = 5646

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2022',
    rollupOptions: {
      // Multi-page build. The labs/ pages are the vectorizer's dev harnesses, linked from
      // the header's lab menu (LAB_VIEWS in src/components/navItems.tsx) — without an entry
      // each they'd never be emitted, and the Worker's SPA fallback would quietly serve the
      // app shell in their place. They're separate entries, so none of this lands in the
      // main bundle. Keep this list, LAB_VIEWS, and labs/ itself in sync.
      //
      // These are standalone pages rather than React routes for now; see
      // docs/handoff-lab-views-react.md for the plan to fold them into the app.
      input: {
        index: page('index.html'),
        vectorizeDebug: page('labs/vectorize-debug.html'),
        vectorizeAb: page('labs/vectorize-ab.html'),
        vectorizeGolden: page('labs/vectorize-golden.html'),
        vectorizeTruth: page('labs/vectorize-truth.html'),
        vectorizeTest: page('labs/vectorize-test.html'),
      },
    },
  },
  // Transformers.js is loaded lazily (dynamic import in src/lib/aiRemove.ts) and
  // pulls Node-only optional deps (onnxruntime-node, sharp). Excluding it from
  // dep pre-bundling keeps Vite from trying to crawl those during dev/build; the
  // browser runtime fetches its WASM from the CDN on demand.
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  server: {
    host: DEV_HOST,
    port: DEV_PORT,
    // Fail loudly instead of hopping to another port — the opened URL below and
    // the VS Code build task both assume this exact address.
    strictPort: true,
    open: `http://${DEV_HOST}:${DEV_PORT}/`,
    watch: {
      // Don't watch/reload on test & screenshot artifacts or dropped-in image
      // assets (binary files can be locked mid-write and crash the watcher).
      ignored: [
        '**/.playwright-mcp/**',
        '**/assets/**',
        '**/*.png',
        '**/*.webp',
        '**/*.yml',
        '**/*.log',
        '**/dist/**',
      ],
    },
  },
})
