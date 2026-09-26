// How many pixels the tracer sees: the cap on a large raster and the
// enlargement of a small one. This is UI-side policy (the tracer never reads
// `traceDetail` or `upscale`), kept in one module so the vectorize studio, the
// icon-sheet batch and the MCP server decide identically.
//
// Cap: flat art (mono, or colour without gradients) traces at 2048 for crisp
// corners and sub-pixel edges; colour with gradients stays at 1024 because the
// gradient field-merge is quadratic in the segment count.
//
// Enlargement (mono only): edge placement is accurate to a roughly constant
// fraction of a native pixel, so a small raster benefits from more pixels. Two
// rules, the larger wins, both bilinear:
//  - by size: enlarge toward ~512px, at most 3x.
//  - by stroke: enlarge the thin ink (`inkThickness`) toward ~3px, at most 4x,
//    so 1px lines on an otherwise large raster do not melt together.
// Neither goes past the flat cap. Colour is never enlarged: palette
// segmentation would follow every interpolated tone. Colour has the opt-in AI
// upscaler (aiUpscale.ts) instead.

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
/** Beyond this the size rule's extra pixels stop paying for themselves. */
export const MAX_TRACE_SCALE = 3
/** Thickness (px) the stroke rule enlarges the thin ink to. */
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
 * How much to enlarge a raster before a mono trace. 1 for colour, for an
 * explicit `upscale: 'off'`, and when the raster is already within 2x of the
 * cap. `'ai'` is treated like `'auto'` here: when the studio's AI path does not
 * apply to a raster it falls back to this rule rather than to no enlargement.
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
