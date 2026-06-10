import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2022',
  },
  // Transformers.js is loaded lazily (dynamic import in src/lib/aiRemove.ts) and
  // pulls Node-only optional deps (onnxruntime-node, sharp). Excluding it from
  // dep pre-bundling keeps Vite from trying to crawl those during dev/build; the
  // browser runtime fetches its WASM from the CDN on demand.
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  server: {
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
