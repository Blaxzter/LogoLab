// Node-side glue for the MCP server.
//
// The tracer is pure TypeScript and runs anywhere, but it constructs
// `new ImageData(w, h)` for its masks — a browser global. The headless harness
// installs the same shim (src/devtest/nodeHarness.ts); this is its twin for the
// server, kept separate so the production entry never imports the test tree.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Install a minimal ImageData polyfill if the runtime lacks one (Node). */
export function ensureImageData(): void {
  const g = globalThis as unknown as { ImageData?: unknown }
  if (typeof g.ImageData !== 'undefined') return
  class NodeImageData {
    width: number
    height: number
    data: Uint8ClampedArray
    constructor(a: number | Uint8ClampedArray, b?: number, c?: number) {
      if (typeof a === 'number') {
        this.width = a
        this.height = b as number
        this.data = new Uint8ClampedArray(a * (b as number) * 4)
      } else {
        this.data = a
        this.width = b as number
        this.height = (c ?? a.length / 4 / (b as number)) as number
      }
    }
  }
  g.ImageData = NodeImageData as unknown
}

/** The LogoLab checkout this server is running from (src/mcp → repo root). */
export function projectRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/**
 * True when we are running from a LogoLab checkout rather than the published
 * package. The checkout runs `.ts` through Node's type stripping, the package
 * runs the compiled `.js` — so the extension of THIS module is the whole test,
 * with no filesystem probing and no build-time flag to keep in sync.
 */
export function runningFromSource(): boolean {
  return fileURLToPath(import.meta.url).endsWith('.ts')
}

/**
 * The version this server ships as — reported in the MCP handshake, `--help`
 * and the startup log.
 *
 * Read, never written down twice. The catch is that "our own package.json" is
 * two different files: `projectRoot()` is the REPO root from a checkout (whose
 * manifest is the private app, `logolab-app`) and the PACKAGE root from the
 * tarball. So pick the manifest that defines the published package in each
 * layout — `packages/mcp/package.json` in a checkout, our own when installed —
 * and both answer with the version npm would serve.
 */
export function packageVersion(): string {
  const manifest = runningFromSource()
    ? join(projectRoot(), 'packages', 'mcp', 'package.json')
    : join(projectRoot(), 'package.json')
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version
}

/**
 * Resolve a caller-supplied path against the process CWD.
 *
 * An MCP client runs the server with the user's project as the working
 * directory, so a relative path in a tool call means "in the project I am
 * working on" — not "inside the LogoLab checkout".
 */
export function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

/** Assert a readable file, with an error an agent can act on. */
export function requireFile(p: string, what = 'file'): string {
  const full = resolvePath(p)
  if (!existsSync(full)) throw new Error(`No such ${what}: ${full}`)
  if (!statSync(full).isFile()) throw new Error(`Not a ${what} (it is a directory): ${full}`)
  return full
}

/** Create `dir` (and parents) and return its absolute path. */
export function ensureDir(dir: string): string {
  const full = resolvePath(dir)
  mkdirSync(full, { recursive: true })
  return full
}

/** Create the parent directory of a file path that is about to be written. */
export function ensureParent(file: string): string {
  const full = resolvePath(file)
  mkdirSync(dirname(full), { recursive: true })
  return full
}

/**
 * Log to STDERR, never stdout: stdout is the MCP framing channel and one stray
 * `console.log` corrupts the stream.
 */
export function log(...parts: unknown[]): void {
  process.stderr.write(`[logolab] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`)
}

/** Human-readable byte size for tool summaries. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
