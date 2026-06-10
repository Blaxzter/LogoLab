// Raster → vector tracing engine: alpha-aware quantization → anti-alias
// cleanup → stacked per-color binary masks → potrace per mask → EditableDoc.
//
// The same conceptual pipeline as Affinity/Illustrator image trace. Masks are
// STACKED (each layer also covers everything painted above it), so adjacent
// regions overlap instead of abutting — that is what kills the hairline gaps
// a naive per-color trace leaves between regions.

import type { VectorizeOptions } from '../../types'
import type { EditableDoc, PathItem } from '../path/types'
import type { TraceProgress } from './types'
import { traceMask, type TraceMaskOptions } from './potrace'
import { dropMinorColors, modeFilter, quantize } from './quantize'

export const DEFAULT_VECTORIZE_OPTIONS: VectorizeOptions = {
  mode: 'color',
  colors: 8,
  smoothing: 50,
  despeckle: 25,
  threshold: 128,
  removeBackground: false,
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

const rgbToHex = (r: number, g: number, b: number): string =>
  '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)

/**
 * Trace an ImageData into an editable vector document. Color mode quantizes,
 * cleans up anti-aliasing, and traces one stacked mask per palette color
 * (bottom-first paint order); mono mode thresholds to a single black shape.
 * Aborts (via `signal`) throw a DOMException named 'AbortError'.
 */
export async function traceImage(
  imageData: ImageData,
  options: VectorizeOptions,
  onProgress?: (p: TraceProgress) => void,
  signal?: AbortSignal,
): Promise<EditableDoc> {
  const { width, height } = imageData
  const smoothing = clamp(options.smoothing, 0, 100)
  const despeckle = clamp(options.despeckle, 0, 100)
  const maskOpts: TraceMaskOptions = {
    turdsize: Math.max(1, Math.round((despeckle / 100) ** 2 * 64)),
    alphamax: 0.2 + (smoothing / 100) * 1.13,
    opttolerance: 0.2 + (smoothing / 100) * 0.6,
  }

  if (options.mode === 'mono') {
    const subPaths = await traceMask(thresholdToMask(imageData, options.threshold), maskOpts)
    const items: PathItem[] = []
    if (subPaths.length > 0) {
      items.push({
        kind: 'path',
        id: 'trace-0',
        fill: '#000000',
        fillRule: 'nonzero',
        subPaths,
        visible: true,
      })
    }
    return { viewBox: [0, 0, width, height], items }
  }

  onProgress?.({ phase: 'quantize' })
  let q = quantize(imageData, clamp(Math.round(options.colors), 2, 24))
  const passes = despeckle === 0 ? 0 : 1 + Math.floor(despeckle / 40)
  q = { ...q, labels: modeFilter(q.labels, width, height, passes) }
  q = dropMinorColors(q, (despeckle / 100) ** 1.5 * 0.02)

  // Paint order: largest region at the bottom (palette is sorted by count).
  let paintOrder = q.palette.map((_, i) => i)
  if (options.removeBackground) {
    const bg = detectBorderBackground(q.labels, width, height, q.palette.length)
    if (bg !== -1) paintOrder = paintOrder.filter((i) => i !== bg)
  }

  // rank[label] = layer position; -1 = removed background (treated as a hole).
  const rank = new Int32Array(q.palette.length).fill(-1)
  paintOrder.forEach((label, i) => {
    rank[label] = i
  })

  const total = paintOrder.length
  const items: PathItem[] = []
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    onProgress?.({ phase: 'trace', layer: i + 1, total })
    const subPaths = await traceMask(stackedMask(q.labels, width, height, rank, i), maskOpts)
    if (subPaths.length > 0) {
      const { r, g, b } = q.palette[paintOrder[i]]
      items.push({
        kind: 'path',
        id: 'trace-' + i,
        fill: rgbToHex(r, g, b),
        fillRule: 'nonzero',
        subPaths,
        visible: true,
      })
    }
    // Yield to the event loop so the progress UI can actually paint.
    await new Promise((r) => setTimeout(r))
  }

  return { viewBox: [0, 0, width, height], items }
}

/**
 * Threshold to a potrace-ready binary mask: dark opaque pixels become opaque
 * black, everything else (light or alpha < 16) opaque white. Luminance uses
 * Rec.709 weights. The input is not mutated.
 */
function thresholdToMask(img: ImageData, threshold: number): ImageData {
  const { width, height, data } = img
  const out = new ImageData(width, height)
  const dst = out.data
  const cut = clamp(Math.round(threshold), 0, 255)
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    const v = data[i + 3] >= 16 && lum < cut ? 0 : 255
    dst[i] = v
    dst[i + 1] = v
    dst[i + 2] = v
    dst[i + 3] = 255
  }
  return out
}

/**
 * Detect a solid background layer: the most frequent label along the 1px
 * border ring, but only when opaque pixels cover at least half the ring.
 * An image already floating on transparency returns -1 (nothing to remove).
 */
function detectBorderBackground(
  labels: Int32Array,
  width: number,
  height: number,
  paletteSize: number,
): number {
  if (paletteSize === 0) return -1
  const counts = new Array<number>(paletteSize).fill(0)
  let ringTotal = 0
  let opaque = 0
  const visit = (i: number) => {
    ringTotal++
    const l = labels[i]
    if (l >= 0) {
      opaque++
      counts[l]++
    }
  }
  for (let x = 0; x < width; x++) {
    visit(x)
    if (height > 1) visit((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y++) {
    visit(y * width)
    if (width > 1) visit(y * width + width - 1)
  }
  if (ringTotal === 0 || opaque / ringTotal < 0.5) return -1
  let best = -1
  let bestCount = 0
  for (let l = 0; l < paletteSize; l++) {
    if (counts[l] > bestCount) {
      bestCount = counts[l]
      best = l
    }
  }
  return best
}

/**
 * Build the stacked binary mask for one layer: every pixel whose label ranks
 * at or above `layer` in the paint order is black, all else white. The bottom
 * layer therefore covers the whole opaque area and each smaller layer paints
 * on top — adjacent regions overlap instead of meeting at a hairline seam.
 */
function stackedMask(
  labels: Int32Array,
  width: number,
  height: number,
  rank: Int32Array,
  layer: number,
): ImageData {
  const out = new ImageData(width, height)
  const dst = out.data
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    const v = l >= 0 && rank[l] >= layer ? 0 : 255
    const o = i * 4
    dst[o] = v
    dst[o + 1] = v
    dst[o + 2] = v
    dst[o + 3] = 255
  }
  return out
}
