// What the app downloads to work offline — and, more importantly, what it doesn't.
//
//   node --test test/offline-precache.test.ts
//
// The service worker (src/pwa/sw.js) is handed a list of URLs to store on
// install, and that list is not a glob: a LogoLab build is ~31 MB of assets, 27
// MB of which is the lab harness and the optional AI upscaler. So the list is
// computed from the chunk graph in scripts/swPlugin.ts — reachable from the
// entry, stopping at labs/bench/AI roots.
//
// Which makes this a heuristic over a graph nobody looks at, with a failure mode
// that a green build, a green typecheck and a working dev server all miss: a
// chunk wrongly left out is fine until someone is offline, and then a tab simply
// doesn't open. That already happened once — Vite emits the TRACER'S WEB WORKER
// as a chunk referenced by a bare URL string rather than by an import, so the
// first version of the walk dropped it, and "works offline" quietly meant "works
// offline until you try to trace something". The worker case is the third test
// below.
//
// The bundles here are synthetic: the point is the decision, not this week's
// chunk hashes, and a test that needed a real build would cost a minute per run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Rollup } from 'vite'
import { bundlePrecache } from '../scripts/swPlugin.ts'

type Bundle = Rollup.OutputBundle

interface ChunkSpec {
  code?: string
  imports?: string[]
  dynamicImports?: string[]
  isEntry?: boolean
  facadeModuleId?: string | null
}

function chunk(spec: ChunkSpec): Rollup.OutputChunk {
  return {
    type: 'chunk',
    code: spec.code ?? '',
    imports: spec.imports ?? [],
    dynamicImports: spec.dynamicImports ?? [],
    isEntry: spec.isEntry ?? false,
    facadeModuleId: spec.facadeModuleId ?? null,
    moduleIds: [],
  } as unknown as Rollup.OutputChunk
}

function asset(bytes: number): Rollup.OutputAsset {
  return { type: 'asset', source: new Uint8Array(bytes) } as unknown as Rollup.OutputAsset
}

test('the app shell and the lazy tabs are stored for offline use', () => {
  const bundle = {
    'assets/index-aaa.js': chunk({
      isEntry: true,
      facadeModuleId: '/repo/src/main.tsx',
      imports: ['assets/chunk-bbb.js'],
      dynamicImports: ['assets/VectorizePanel-ccc.js'],
    }),
    'assets/chunk-bbb.js': chunk({}),
    'assets/VectorizePanel-ccc.js': chunk({
      facadeModuleId: '/repo/src/components/panels/VectorizePanel.tsx',
    }),
  } as unknown as Bundle

  const files = bundlePrecache(bundle)
  assert.ok(files.includes('/index.html'), 'the SPA shell is what a navigation is answered from')
  assert.ok(files.includes('/assets/index-aaa.js'))
  assert.ok(files.includes('/assets/chunk-bbb.js'))
  assert.ok(
    files.includes('/assets/VectorizePanel-ccc.js'),
    'a lazily-loaded TAB is still part of the app — offline has to be able to open it',
  )
})

test('the labs and the AI runtime are left to the runtime cache', () => {
  const bundle = {
    'assets/index-aaa.js': chunk({
      isEntry: true,
      facadeModuleId: '/repo/src/main.tsx',
      dynamicImports: ['assets/AbLab-ddd.js', 'assets/aiUpscale-eee.js'],
    }),
    'assets/AbLab-ddd.js': chunk({
      facadeModuleId: '/repo/src/components/labs/AbLab.tsx',
      imports: ['assets/useLabRun-fff.js'],
    }),
    // Only the lab imports this, so it must not be dragged in behind it.
    'assets/useLabRun-fff.js': chunk({}),
    'assets/aiUpscale-eee.js': chunk({
      facadeModuleId: '/repo/node_modules/onnxruntime-web/dist/ort.mjs',
    }),
  } as unknown as Bundle

  const files = bundlePrecache(bundle)
  assert.ok(!files.includes('/assets/AbLab-ddd.js'), 'a lab route is not part of the offline app')
  assert.ok(
    !files.includes('/assets/useLabRun-fff.js'),
    'nor is a chunk only a lab reaches — this one is 3.5 MB of corpus',
  )
  assert.ok(!files.includes('/assets/aiUpscale-eee.js'), 'nor the optional AI runtime')
})

test('a Web Worker referenced by URL string is stored — the tracer runs in one', () => {
  const bundle = {
    'assets/index-aaa.js': chunk({
      isEntry: true,
      facadeModuleId: '/repo/src/main.tsx',
      imports: ['assets/traceOffThread-ggg.js'],
    }),
    // This is the shape Vite emits for `new Worker(new URL('./trace.worker.ts',
    // import.meta.url))`: the worker appears NOWHERE in the import graph, only
    // as a string in the code of the module that spawns it.
    'assets/traceOffThread-ggg.js': chunk({
      code: 'new Worker(new URL("/assets/trace.worker-hhh.js", import.meta.url), {type:"module"})',
    }),
    'assets/trace.worker-hhh.js': chunk({ facadeModuleId: '/repo/src/lib/trace/trace.worker.ts' }),
  } as unknown as Bundle

  assert.ok(
    bundlePrecache(bundle).includes('/assets/trace.worker-hhh.js'),
    'without the worker, an offline app loads and then cannot trace anything',
  )
})

test('a WASM binary is stored when it is small and skipped when it is huge', () => {
  const bundle = {
    'assets/index-aaa.js': chunk({
      isEntry: true,
      facadeModuleId: '/repo/src/main.tsx',
      code: 'fetch("/assets/small-iii.wasm"); fetch("/assets/ort-jjj.wasm")',
    }),
    'assets/small-iii.wasm': asset(512 * 1024),
    // The real one is 23 MB. Precaching it would make installing the app a
    // 23 MB download for a feature most users never open.
    'assets/ort-jjj.wasm': asset(23 * 1024 * 1024),
  } as unknown as Bundle

  const files = bundlePrecache(bundle)
  assert.ok(files.includes('/assets/small-iii.wasm'))
  assert.ok(!files.includes('/assets/ort-jjj.wasm'))
})
