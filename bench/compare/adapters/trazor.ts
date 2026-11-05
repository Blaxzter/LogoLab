// Trazor (Fabien Ménager, FSL-1.1-ALv2), a TypeScript tracer for the browser and Node.
// github.com/PhenX/Trazor. The engine is pinned and bundled by py/setup.sh into the gitignored
// .bench-tools/trazor/trazor.mjs (its packages export TypeScript source and are not on npm),
// and runs IN-PROCESS on the case's RGBA pixels. The hosted studio at trazor.studio is a
// separate product; this is the engine it is built on, as the repo's main branch has it.
//
//   trazor-auto        analyzeImage → recommendSettings, the profile's patch and then the
//                      recommendation's, over the defaults. Trazor's own comparison script
//                      (scripts/eval/tracer-compare.ts trazorSettings) does the same and calls
//                      it what the studio applies on load. This is its headline row.
//   trazor-default     DEFAULT_SETTINGS: colour, classic chain, stacked, 16 colours.
//   trazor-logo        the `logo` profile, its own preset for flat marks.
//   trazor-centerline  LINE corpora only: `mode: 'centerline'` over the defaults.
//
// Settings keep the engine's own raster cap (maxDimension 1600), so a 2048 line case is traced
// at 1600 and written in a 1600 viewBox; render.ts and lineDoc.ts map that back to the raster.
// The planar chain's boundary solve runs in the repo's prebuilt WebAssembly kernel, as in the
// studio; the source says it computes the same positions as the TypeScript descent.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TOOLS } from '../paths.ts'
import type { CorpusKind, TracerAdapter, TraceInput } from '../types.ts'

export const TRAZOR_SHA = '090b914086c5de2027b20c08e2b48c73e0e69c25'
const BUNDLE = join(TOOLS, 'trazor', 'trazor.mjs')
const KERNEL = join(TOOLS, 'trazor', 'src', 'packages', 'trace', 'wasm', 'solve.wasm')

type Settings = Record<string, unknown> & { mode?: string; geometry?: string }
interface Raster {
  width: number
  height: number
  data: Uint8ClampedArray
}
interface TrazorLib {
  vectorize(image: Raster, settings: Settings, opts?: { solveKernel?: unknown }): Promise<{ svg: string }>
  analyzeImage(image: Raster): unknown
  recommendSettings(analysis: unknown): { profileId: string; patch: Settings }
  getProfile(id: string): { patch: Settings }
  normalizeSettings(patch: Settings, base?: unknown): Settings
  DEFAULT_SETTINGS: unknown
  loadBandKernel(source: Uint8Array): Promise<unknown>
}

let loaded: Promise<{ lib: TrazorLib; kernel: unknown }> | null = null
const load = (): Promise<{ lib: TrazorLib; kernel: unknown }> =>
  (loaded ??= (async () => {
    const lib = (await import(pathToFileURL(BUNDLE).href)) as TrazorLib
    return { lib, kernel: await lib.loadBandKernel(readFileSync(KERNEL)) }
  })())

interface Plan {
  settings: Settings
  notes?: string
}

function trazor(
  name: string,
  label: string,
  plan: (lib: TrazorLib, image: Raster) => Plan,
  kinds?: CorpusKind[],
): TracerAdapter {
  return {
    name,
    lanes: ['colour', 'mono'],
    ...(kinds ? { kinds } : {}),
    available: async () =>
      existsSync(BUNDLE) && existsSync(KERNEL) ? null : `not installed (${BUNDLE}; run py/setup.sh)`,
    version: async () => `trazor@${TRAZOR_SHA.slice(0, 7)} ${label}`,
    async trace(i: TraceInput) {
      const { lib, kernel } = await load()
      // Its own copy: the case's buffer is shared with every other tool.
      const image = { width: i.image.width, height: i.image.height, data: new Uint8ClampedArray(i.image.data) }
      const { settings, notes } = plan(lib, image)
      const t = performance.now()
      const { svg } = await lib.vectorize(image, settings, { solveKernel: kernel })
      return { svg, ms: performance.now() - t, ...(notes ? { notes } : {}) }
    },
  }
}

export const trazorAuto = trazor('trazor-auto', 'auto (recommendSettings)', (lib, image) => {
  const rec = lib.recommendSettings(lib.analyzeImage(image))
  const settings = lib.normalizeSettings({ ...lib.getProfile(rec.profileId).patch, ...rec.patch })
  return { settings, notes: `profile ${rec.profileId}, ${settings.mode}, ${settings.geometry}` }
})
export const trazorDefault = trazor('trazor-default', 'DEFAULT_SETTINGS', (lib) => ({
  settings: lib.normalizeSettings({}),
}))
export const trazorLogo = trazor('trazor-logo', 'profile logo', (lib) => ({
  settings: lib.normalizeSettings(lib.getProfile('logo').patch, lib.DEFAULT_SETTINGS),
}))
export const trazorCenterline = trazor(
  'trazor-centerline',
  'mode centerline',
  (lib) => ({ settings: lib.normalizeSettings({ mode: 'centerline' }) }),
  ['line'],
)
