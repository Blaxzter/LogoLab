// How many pixels the tracer sees — the cap on a large raster, and the
// enlargement of a small one.
//
// Both are UI-side policy, not tracer parameters (`VectorizeOptions.traceDetail`
// and `upscale` are read here and nowhere inside src/lib/trace), and they live
// in one module so the vectorize studio, the icon-sheet batch and the MCP server
// decide identically.
//
// THE CAP. Flat art (mono, or colour with gradients OFF) traces at full 2048 for
// crisp corners / sub-pixel edges; colour art WITH gradients stays at 1024 to
// bound the O(S²) Step-3c field-merge (which froze on complex photos — see
// memory + crispness-study). Measured on Schild.png: 1024→2048 cut meanΔE
// 0.96→0.78 and lifted SSIM +0.024, at ~4× trace time.
//
// THE ENLARGEMENT (mono only). The tracer places every edge to a roughly
// constant accuracy in NATIVE px (§30), so a small raster's error in artwork
// units is set by its pixel count, and the anti-aliasing carries sub-pixel
// coverage a 1× lattice cannot use. Two rules, the larger wins, both bilinear:
//
//  • by SIZE — the icon sheet's rule, measured over 54 real 170px tiles rendered
//    back to native for a fair comparison: 1× ink-area drift 0.75pp with 4 tiles
//    visibly wrong, 3× 0.13pp and 0 wrong, 4× no better than 3× (0.14pp). So a
//    tile is enlarged toward ~512px, at most 3×. (An earlier measurement said
//    upscaling was catastrophic — that was an artifact: `rasterizeDoc` renders
//    one viewBox unit per output pixel, so scoring an enlarged doc in a native-
//    size buffer silently CROPPED it.)
//  • by STROKE — what the size rule misses: a 499px page of sheet music is not
//    "small", but 87% of its ink runs are 1px, and at 1× every staff line melted
//    into the note heads. Measured on that page: 2× still broke the staff, 3× and
//    4× recovered it (nodes 2273 / 2874 / 4092 / 4373, 5–13 s). The thin ink
//    (`inkThickness`, src/lib/strokeWidth.ts) is enlarged to ~3px, at most 4×.
//
// Neither rule enlarges past the flat cap, and neither applies to colour: the
// palette segmentation follows every interpolated tone (measured on the sheet:
// colour at 4× went from 93 to 1465 nodes and 69ms to 1193ms), so colour stays
// native, with the opt-in AI upscaler (src/lib/aiUpscale.ts) as its own path.

import type { VectorizeOptions } from '../types'
import { inkThickness, type InkThickness } from './strokeWidth.ts'
import type { ImageDataLike } from './ink.ts'

export const RASTER_MAX_DIM = 1024
export const RASTER_MAX_DIM_FLAT = 2048
/**
 * "High" detail cap for flat art (gradients-off / mono). Bounded — not native —
 * so a huge upload can't blow up trace time/memory.
 */
export const RASTER_MAX_DIM_HIGH = 4096

export function rasterCapFor(opts: VectorizeOptions): number {
  const isFlat = opts.mode === 'mono' || opts.gradients === false
  const flatCap = opts.traceDetail === 'high' ? RASTER_MAX_DIM_HIGH : RASTER_MAX_DIM_FLAT
  return isFlat ? flatCap : RASTER_MAX_DIM
}

/* ------------------------------------------------------- enlargement (mono) */

/** Working resolution the size rule enlarges a small mono raster toward (long side, px). */
export const TRACE_TARGET_PX = 512
/** Beyond this the size rule's extra pixels stop paying for themselves (measured). */
export const MAX_TRACE_SCALE = 3
/** What the stroke rule enlarges the thin ink to. 3px traced the staff clean; 2px did not. */
export const MONO_TARGET_STROKE_PX = 3
/** The stroke rule's ceiling; the raster cap bounds it further. */
export const MONO_UPSCALE_MAX = 4

/** The size rule: how much to enlarge a raster of this long side. */
export function traceScale(longSide: number): number {
  if (longSide <= 0) return 1
  return Math.max(1, Math.min(MAX_TRACE_SCALE, Math.round(TRACE_TARGET_PX / longSide)))
}

/** The stroke rule: how much to enlarge ink of this thickness. */
export function strokeScale(thickness: number): number {
  if (!(thickness > 0)) return 1
  return Math.max(1, Math.min(MONO_UPSCALE_MAX, Math.ceil(MONO_TARGET_STROKE_PX / thickness)))
}

export interface MonoUpscalePlan {
  /** Integer factor to enlarge by before tracing; 1 = trace as is. */
  scale: number
  /** The thin-ink thickness the stroke rule read, or null when it was not consulted / no ink. */
  thickness: number | null
  /** Largest factor the raster cap leaves room for. */
  room: number
  /** Which rule set the factor. */
  by: 'none' | 'size' | 'stroke'
}

/**
 * How much to enlarge a raster before a MONO trace. 1 for colour, for an
 * explicit `upscale: 'off'`, and when the raster already sits within a factor
 * of the cap. `'ai'` is not refused here: that path is the studio's own, and
 * when it does not apply to a raster (above its size window) the studio asks
 * this rule instead — a refused AI request must fall back to Auto, not to
 * nothing (measured: the page at 499px traced at 1× read ΔE 3.95 against 2.5).
 */
export function monoTraceScale(img: ImageDataLike, opts: VectorizeOptions): MonoUpscalePlan {
  const none: MonoUpscalePlan = { scale: 1, thickness: null, room: 1, by: 'none' }
  if (opts.mode !== 'mono') return none
  if (opts.upscale === 'off') return none
  const long = Math.max(img.width, img.height)
  if (!(long > 0)) return none
  const room = Math.floor(rasterCapFor(opts) / long)
  if (room < 2) return { ...none, room }
  const bySize = traceScale(long)
  const ink: InkThickness | null = inkThickness(img, opts.threshold, opts.invert === true)
  const byStroke = ink ? strokeScale(ink.thickness) : 1
  const scale = Math.min(room, Math.max(bySize, byStroke))
  return {
    scale,
    thickness: ink?.thickness ?? null,
    room,
    by: scale === 1 ? 'none' : byStroke > bySize ? 'stroke' : 'size',
  }
}
