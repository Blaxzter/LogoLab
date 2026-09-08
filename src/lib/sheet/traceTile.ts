// Trace ONE sheet tile — the studio's `run()` boiled down to what a batch needs.
//
// Deliberately NOT re-exported from the sheet barrel, so the Node tests can keep
// importing the detector without dragging the tracer in. It DOES run headless:
// the worker hop is opt-in (`canTraceOffThread` is false where there is no
// `Worker`), so the MCP server traces through this same function — one tile
// pipeline for the batch, the single-icon editor and the agent alike. That is why
// its imports name the `.ts` extension: Node resolves specifiers literally.

import { serializeDoc, docStats } from '../path/model.ts'
import { suggestGradients, traceImage } from '../trace/index.ts'
import { canTraceOffThread, traceImageOffThread } from '../trace/traceOffThread.ts'
import { rasterCapFor } from '../traceCaps.ts'
import type { TraceProgress } from '../trace/types'
import type { EditableDoc } from '../path/types'
import type { VectorizeOptions } from '../../types'
import { downscaleImageData, toImageData, upscaleImageData } from './crop.ts'
import { planTileBase, type SheetColorMode } from './plan.ts'
import type { ImageDataLike, SheetBackground } from './types'

export interface TileTrace {
  doc: EditableDoc
  svg: string
  stats: { paths: number; nodes: number; colors: number }
}

/** Coordinate precision of the emitted SVG — matches the studio's (not a knob). */
export const TILE_PRECISION = 3

/**
 * `gradients` is a per-IMAGE decision, and a sheet's tiles differ — a flat glyph
 * next to a shaded badge. Probing each tile is what the studio does per upload,
 * and it is cheap (the probe strides to ~512px internally).
 */
export function seedGradients(pixels: ImageDataLike, opts: VectorizeOptions): VectorizeOptions {
  try {
    const on = suggestGradients(toImageData(pixels))
    return opts.gradients === on ? opts : { ...opts, gradients: on }
  } catch {
    return opts
  }
}

export type { SheetColorMode } from './plan.ts'

export interface TilePlan {
  /** The options to trace this tile with. */
  opts: VectorizeOptions
  /** Repaint the traced doc to this fill (mono traces come back black). */
  recolor: string | null
  /** What the ink probe saw — surfaced so the UI can explain the choice. */
  inks: number
  /** Enlarge the crop by this factor before tracing. */
  scale: number
}

/**
 * `planTileBase` (mode, size-scaled smoothing and trace scale, all pure) plus the
 * one decision that needs the tracer: seeding `gradients` from the crop's pixels.
 */
export function planTileTrace(
  pixels: ImageDataLike,
  base: VectorizeOptions,
  settings: {
    colorMode: SheetColorMode
    gradientMode: 'auto' | 'flat' | 'rich'
    background: SheetBackground | null
    hiRes?: boolean
  },
): TilePlan {
  const plan = planTileBase(pixels, base, settings)
  return {
    opts: plan.color && settings.gradientMode === 'auto' ? seedGradients(pixels, plan.opts) : plan.opts,
    recolor: plan.recolor,
    inks: plan.inks,
    scale: plan.scale,
  }
}

/**
 * The pixels a tile is actually traced from: the crop, enlarged so the tracer's
 * pixel lattice can use the anti-aliasing's sub-pixel information. The single-icon
 * editor traces THIS too — if the two differed, opening an icon would silently
 * re-trace it at a different quality than the batch produced.
 */
export function tileTraceInput(pixels: ImageDataLike, scale: number): ImageDataLike {
  return upscaleImageData(pixels, scale)
}

/** Repaint every path of a doc with one fill (mono results come back black). */
export function repaintDoc(doc: EditableDoc, fill: string): EditableDoc {
  return {
    ...doc,
    items: doc.items.map((item) => (item.kind === 'path' ? { ...item, fill } : item)),
  }
}

export async function traceTile(
  pixels: ImageDataLike,
  opts: VectorizeOptions,
  signal?: AbortSignal,
  onProgress?: (p: TraceProgress) => void,
  recolor?: string | null,
): Promise<TileTrace> {
  const capped = downscaleImageData(pixels, rasterCapFor(opts))
  const image = toImageData(capped)
  const run = canTraceOffThread(opts) ? traceImageOffThread : traceImage
  const traced = await run(image, opts, onProgress, signal)
  const doc = recolor ? repaintDoc(traced, recolor) : traced
  return { doc, svg: serializeDoc(doc, TILE_PRECISION), stats: docStats(doc) }
}
