// Trace one sheet tile: the pipeline shared by the sheet batch, the single-icon
// editor and the MCP server.
//
// Not re-exported from the sheet barrel, so Node tests can import the detector
// without the tracer. It runs headless too (the worker hop is skipped where
// there is no `Worker`), which is why imports carry the `.ts` extension: Node
// resolves specifiers literally.

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
 * Seed `gradients` from this tile's own pixels: tiles on one sheet differ (a
 * flat glyph next to a shaded badge). The probe is cheap.
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
 * The pixels a tile is traced from: the crop, enlarged by `scale`. The
 * single-icon editor must trace this same input, or opening an icon would
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
