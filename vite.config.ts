import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Browsers map `*.localhost` to loopback themselves, so the branded hostname
// works in the address bar without touching the hosts file. The OS resolver does
// NOT — binding the server to it fails with ENOTFOUND on Windows — so we listen
// on the loopback IP and only *open* the branded URL.
const DEV_HOST = 'logolabs.localhost'
const DEV_PORT = 5646

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2022',
    rollupOptions: {
      // Single entry. The vectorizer's harnesses used to be standalone HTML pages here;
      // they are now lazily-loaded React routes under /labs (LAB_VIEWS in
      // src/components/navItems.tsx, wired up in App.tsx). React.lazy keeps them out of the
      // main bundle just as separate entries did — the corpora, the scoring modules and the
      // fixtures they import all land in their own chunks.
      input: { index: page('index.html') },
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
    host: '127.0.0.1',
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
