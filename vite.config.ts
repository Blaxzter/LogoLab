import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2022',
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
