// The build step that turns src/pwa/sw.js into dist/sw.js.
//
// Its one real job is deciding what goes into the precache, and that decision is
// specific enough to this repo to be worth writing down:
//
// A LogoLab build is ~31 MB of assets. 23 MB of it is the onnxruntime binary
// behind the optional AI upscaler, 3.5 MB is the lab harness's corpus, 2.4 MB is
// the resvg WASM the labs rasterize with. None of that is reached by someone who
// opens the app to crop a logo — but a glob-based precache can't tell, so it
// would make "install for offline use" a 31 MB download of mostly research code.
//
// So the set is computed from the CHUNK GRAPH instead. Start at the entry chunk
// and walk imports, static and dynamic alike — a lazily-loaded tab is still part
// of the app — but stop at chunks whose facade module is a lab, a devtest
// harness or one of the heavyweight optional packages. Everything reached that
// way is what the app needs to run offline; everything else is left to the
// runtime cache, which picks it up the first time someone actually opens it.
//
// That rule maintains itself: a new lab route becomes a new chunk faced by a
// module under src/components/labs/, and drops out without anyone remembering a
// list. And both ways of being wrong are soft — a chunk wrongly precached only
// makes the install bigger, and a chunk wrongly excluded still loads online.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChunkMetadata, Plugin, Rollup } from 'vite'

type OutputBundle = Rollup.OutputBundle
type OutputChunk = Rollup.OutputChunk
type OutputAsset = Rollup.OutputAsset

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url))

/**
 * A chunk faced by one of these is a root of the OPTIONAL half of the app: it,
 * and anything only it pulls in, stays out of the precache. Matched against
 * Rollup module ids with forward slashes.
 */
const OPTIONAL_ROOTS = [
  'src/components/labs/', // the vectorizer's research harnesses
  'src/devtest/', // corpora, scoring, snapshot fixtures
  '@huggingface/transformers', // AI background removal
  'onnxruntime', // its runtime
  '@resvg/resvg-wasm', // the labs' SVG rasterizer
]

/**
 * Ceiling for a single precached file. Reachability alone isn't enough for
 * binaries: the AI upscaler's WASM is imported from a module the app does reach,
 * and it is 23 MB. Anything this big belongs in the runtime cache, where only
 * the people who use the feature pay for it.
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024

/** Under public/, but not part of the app running offline. */
const PUBLIC_SKIP = [
  'corpus', // lab fixtures
  'examples/edge-cases', // the tracer's ⟐ fixture corpus — labs only
  'og.png', // link-preview card, never rendered in the app
]

const normalize = (id: string) => id.replace(/\\/g, '/')

const isOptionalRoot = (chunk: OutputChunk): boolean => {
  const facade = chunk.facadeModuleId
  if (facade) return OPTIONAL_ROOTS.some((root) => normalize(facade).includes(root))
  // A shared chunk with no facade is optional only if NOTHING required imports
  // it, which the walk below decides by simply never reaching it.
  return false
}

const byteLength = (asset: OutputAsset): number =>
  typeof asset.source === 'string' ? Buffer.byteLength(asset.source) : asset.source.byteLength

/** Chunk file names reachable from the entry without crossing an optional root. */
function reachableChunks(bundle: OutputBundle): Set<string> {
  const chunks = new Map<string, OutputChunk>()
  for (const [name, output] of Object.entries(bundle)) {
    if (output.type === 'chunk') chunks.set(name, output)
  }

  const seen = new Set<string>()
  const queue: string[] = []
  for (const [name, chunk] of chunks) {
    if (chunk.isEntry && !isOptionalRoot(chunk)) queue.push(name)
  }

  while (queue.length > 0) {
    const name = queue.pop()!
    if (seen.has(name)) continue
    const chunk = chunks.get(name)
    if (!chunk) continue
    seen.add(name)

    const next = new Set<string>([...chunk.imports, ...chunk.dynamicImports])
    // Not everything a chunk needs is an import. A Web Worker — and the tracer
    // runs in one — reaches its code through `new Worker(new URL(…))`, which the
    // bundler turns into a bare URL STRING in this chunk; the same goes for
    // `new URL(…, import.meta.url)` assets. Nothing in the import graph mentions
    // them, so the first version of this plugin left the tracer's worker out of
    // the precache and "works offline" quietly meant "works offline until you
    // try to trace something". So: anything whose emitted file name appears in
    // this chunk's code counts as reached.
    for (const file of chunks.keys()) {
      if (file !== name && chunk.code.includes(file)) next.add(file)
    }

    for (const file of next) {
      const target = chunks.get(file)
      if (!target || seen.has(file) || isOptionalRoot(target)) continue
      queue.push(file)
    }
  }
  return seen
}

function publicFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const rel = normalize(relative(root, full))
      if (PUBLIC_SKIP.some((skip) => rel === skip || rel.startsWith(`${skip}/`))) continue
      if (statSync(full).isDirectory()) walk(full)
      else out.push(`/${rel}`)
    }
  }
  walk(root)
  return out
}

/**
 * The build-output half of the precache list, as `/`-rooted URLs.
 *
 * Separated from the plugin so it can be tested directly (test/offline-precache.test.ts):
 * everything interesting about this feature is one judgement call over a graph,
 * and its failure mode — a chunk the app needs quietly dropped from the offline
 * bundle — is invisible until someone is offline and a tab won't open.
 */
export function bundlePrecache(bundle: OutputBundle): string[] {
  const precache = new Set<string>(['/index.html'])

  for (const name of reachableChunks(bundle)) {
    const chunk = bundle[name] as OutputChunk
    precache.add(`/${name}`)
    // Stylesheets and `new URL(…, import.meta.url)` assets aren't chunk imports;
    // Vite records them on the chunk that references them.
    const meta = chunk.viteMetadata as ChunkMetadata | undefined
    const assets = new Set<string>([...(meta?.importedCss ?? []), ...(meta?.importedAssets ?? [])])
    // Same reason as the code scan in the walk: a WASM binary referenced by URL
    // is not an import of anything.
    for (const [file, output] of Object.entries(bundle)) {
      if (output.type === 'asset' && chunk.code.includes(file)) assets.add(file)
    }
    for (const file of assets) {
      const asset = bundle[file]
      if (asset?.type === 'asset' && byteLength(asset) <= MAX_FILE_BYTES) precache.add(`/${file}`)
    }
  }
  return [...precache]
}

export function serviceWorker(): Plugin {
  return {
    name: 'logolab:service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const precache = new Set<string>(bundlePrecache(bundle))
      for (const file of publicFiles(here('../public'))) precache.add(file)

      // The build id IS the precache list: any change to the app changes a
      // content hash inside it, which changes this string, which changes sw.js —
      // and a byte-different sw.js is exactly what makes the browser notice
      // there is a new version to install.
      const urls = [...precache].sort()
      const buildId = hash(urls.join('\n'))

      // The worker's source lives in src/pwa/ with the registration code it
      // pairs with; only this build step, which is a build script like the
      // others in scripts/, lives here.
      //
      // Anchored to the declaration lines, not to the bare placeholder names: the
      // file's own header explains what gets substituted, so a plain string
      // replace rewrote the COMMENT and left the constants untouched — and the
      // result was a worker that still parsed.
      const template = readFileSync(here('../src/pwa/sw.js'), 'utf8')
      const source = template
        .replace(/^const BUILD = '__BUILD_ID__'$/m, `const BUILD = ${JSON.stringify(buildId)}`)
        .replace(
          /^const PRECACHE_URLS = __PRECACHE__$/m,
          `const PRECACHE_URLS = ${JSON.stringify(urls, null, 2)}`,
        )
      if (source.includes('__BUILD_ID__') || source.includes('__PRECACHE__')) {
        this.error('service worker: a placeholder declaration in src/pwa/sw.js was not substituted')
      }

      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

/** FNV-1a. Short, stable, and nothing here is adversarial. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}
