import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

/**
 * What the footer says this build IS.
 *
 * The version comes from `packages/mcp/package.json` because that is the one
 * place it lives — the npm package reads it too (`packageVersion` in
 * src/mcp/runtime.ts), and the release workflow refuses a tag that disagrees
 * with it, so a single number covers the site and the package alike.
 *
 * The date and the commit come from git, which is what makes the footer useful
 * in a bug report: "v0.1.1" alone cannot tell you whether the tab has the fix
 * you shipped an hour ago. Everything here is best-effort — a build from a
 * tarball or a checkout with no git has no commit to name, and the site must
 * still build — so each lookup falls back rather than throwing.
 */
function buildStamp(): { version: string; date: string; commit: string } {
  const git = (...args: string[]): string => {
    try {
      return execFileSync('git', args, { cwd: fileURLToPath(new URL('.', import.meta.url)) }).toString().trim()
    } catch {
      return ''
    }
  }
  let version = ''
  try {
    version = (JSON.parse(readFileSync(page('packages/mcp/package.json'), 'utf8')) as { version: string }).version
  } catch {
    version = ''
  }
  // Committer date, not author date: a rebased or cherry-picked commit ships
  // when it lands, not when it was written. ISO, so the browser can localise it.
  return { version, date: git('log', '-1', '--format=%cI') || new Date().toISOString(), commit: git('rev-parse', '--short', 'HEAD') }
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  // The MCP install dialog (src/components/AgentSetup.tsx) prints a command that
  // names this checkout. `vite dev` IS the checkout, so fill it in; a hosted build
  // has no idea where the user cloned it, and the dialog asks instead.
  define: {
    __LOGOLAB_ROOT__: JSON.stringify(command === 'serve' ? process.cwd().replace(/\\/g, '/') : ''),
    __LOGOLAB_BUILD__: JSON.stringify(buildStamp()),
  },
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
  // browser runtime fetches its WASM from the CDN on demand. (The AI upscaler in
  // src/lib/aiUpscale.ts loads the same runtime straight from that CDN instead —
  // bundling onnxruntime-web made Vite emit its 13 + 24 MB WASM binaries as assets.)
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
}))
