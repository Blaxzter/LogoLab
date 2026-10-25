// ImageTracer.js 1.2.6 (András Jankovics, public domain / Unlicense), the plain-JavaScript
// colour tracer: colour quantisation, then each colour layer traced to lines and quadratic
// curves. github.com/jankovicsandras/imagetracerjs. Installed, pinned, into the gitignored
// .bench-tools/imagetracer (py/setup.sh) and run IN-PROCESS on the case's RGBA pixels: it is a
// pure function of an ImageData-like object, so there is no CLI to spawn and no PNG decoder of
// its own between it and the input.
//
//   imagetracer-default  the 'default' preset: 16 colours, deterministic colour sampling
//                        (colorsampling 2), and a 1px stroke of each path's own colour
//                        that the library adds to hide the seams between its layers.
//   imagetracer-fills    the same with `strokewidth: 0`, its own switch for that stroke. The
//                        geometry scorer refuses stroked shapes (svgGround), so this is the
//                        row the drawing metrics can be read on; the default row is scored
//                        on the picture only.
//   imagetracer-swept    the best of a frozen grid picked on the IN-SAMPLE corpora only
//                        (bench/compare/sweepImagetracer.ts), as vtracer-swept is.
//
// Its SVG is sized by width/height with no viewBox; render.ts normalizeRoot adds one.

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { TOOLS } from '../paths.ts'
import type { TracerAdapter, TraceInput } from '../types.ts'

export const IMAGETRACER_VERSION = '1.2.6'
const MAIN = join(TOOLS, 'imagetracer', 'node_modules', 'imagetracerjs', `imagetracer_v${IMAGETRACER_VERSION}.js`)

interface ImageTracerLib {
  imagedataToSVG(img: { width: number; height: number; data: Uint8ClampedArray }, options: object | string): string
}
let lib: ImageTracerLib | null = null
const load = (): ImageTracerLib => (lib ??= createRequire(import.meta.url)(MAIN) as ImageTracerLib)

export function imagetracer(
  name: string,
  preset: string,
  options: Record<string, number | boolean> = {},
): TracerAdapter {
  // Options over a preset: the library fills every key it is not given from 'default'.
  const opts = Object.keys(options).length ? { ...options } : preset
  return {
    name,
    lanes: ['colour', 'mono'],
    available: async () => (existsSync(MAIN) ? null : `not installed (${MAIN})`),
    version: async () =>
      `imagetracerjs ${IMAGETRACER_VERSION} ${preset}${Object.keys(options).length ? ` ${JSON.stringify(options)}` : ''}`,
    async trace(i: TraceInput) {
      const t = performance.now()
      // Its own copy: the library reads the pixels and never writes them, but the case's
      // buffer is shared with every other tool.
      const img = { width: i.image.width, height: i.image.height, data: new Uint8ClampedArray(i.image.data) }
      const svg = load().imagedataToSVG(img, opts)
      return { svg, ms: performance.now() - t }
    },
  }
}

export const imagetracerDefault = imagetracer('imagetracer-default', 'default')
export const imagetracerFills = imagetracer('imagetracer-fills', 'default', { strokewidth: 0 })

/**
 * sweepImagetracer.ts's pick (2026-10-25), 56 in-sample cases @512: ΔE p50 0.286, chamfer p50
 * 0.227, nodes p50 2266 (default, unstroked: 0.340 / 0.249 / 485). Ranked on ΔE and chamfer
 * only, like every sweep here, so it buys a little accuracy with 4.7x the nodes. The pick is
 * the grid's corner (most colours, finest thresholds); the grid was not widened after seeing it.
 */
export const IMAGETRACER_SWEPT = { strokewidth: 0, numberofcolors: 64, ltres: 0.5, qtres: 0.5, pathomit: 0 }
export const imagetracerSwept = imagetracer('imagetracer-swept', 'default', IMAGETRACER_SWEPT)
