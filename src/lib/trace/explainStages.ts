// The "How it works" explainer's stage pictures, built from the segmentation the trace
// ACTUALLY ran. traceImage picks one of three segmenters — the two-label ink cut (mono,
// and Strokes in either mode), palette-first for flat art (gradients off, when the image
// passes the flat gate), the Mumford–Shah smoothness segmenter for everything else — and
// the explainer used to always show the last one: a flat icon read "18 regions" beside
// a six-path SVG. The region map shown here is the one `tracePlanar` received (traceImage's
// `onPlanarLabels` sink), so the count and the picture describe the trace beside them.
// Display only: nothing here feeds the trace.

import {
  traceImage,
  segmentOptionsFor,
  paletteOptionsFor,
  FLAT_PALETTE_MIN_COVERAGE,
  FLAT_PALETTE_MAX_COLORS,
} from './index.ts'
import { segmentImage } from './segment.ts'
import { segmentFlatPalette } from './paletteSegment.ts'
import { fitPaintLadder } from './gradient.ts'
import { serializeDoc, docStats } from '../path/model.ts'
import { smoothedToRgba, discontinuityToRgba, segmentsToRgba, regionFillsToRgba } from './stageViz.ts'
import type { VectorizeOptions } from '../../types'

/** 'ink' = the two-label ink/paper cut, 'palette' = palette-first flat, 'smooth' = Mumford–Shah. */
export type ExplainSegmenter = 'ink' | 'palette' | 'smooth'

type Img = { width: number; height: number; data: Uint8ClampedArray }
type Rgb = { r: number; g: number; b: number }

/** Which segmenter traceImage runs for these options — its branch order, its flat gate.
 *  On the palette path it also returns the palette the trace FILLED with (the regions'
 *  paint), which a mean over each region's pixels — anti-aliasing included — is not. */
function pickSegmenter(image: Img, options: VectorizeOptions): { segmenter: ExplainSegmenter; palette?: Rgb[] } {
  if (options.mode === 'mono' || options.centerline) return { segmenter: 'ink' }
  if (options.gradients !== false || options.flatPalette === false) return { segmenter: 'smooth' }
  const locked = options.palette && options.palette.length > 0 ? options.palette : undefined
  const fp = segmentFlatPalette(image, paletteOptionsFor(options), locked)
  // A locked palette bypasses both gates, as in traceImage.
  return locked || (fp.flatCoverage >= FLAT_PALETTE_MIN_COVERAGE && fp.dominantColors <= FLAT_PALETTE_MAX_COLORS)
    ? { segmenter: 'palette', palette: fp.palette }
    : { segmenter: 'smooth' }
}

export function explainSegmenter(image: Img, options: VectorizeOptions): ExplainSegmenter {
  return pickSegmenter(image, options).segmenter
}

/** Mean source colour per label over the visible pixels (index = label; unused → null). */
function labelMeans(labels: Int32Array, data: Uint8ClampedArray): (Rgb | null)[] {
  let max = -1
  for (let i = 0; i < labels.length; i++) if (labels[i] > max) max = labels[i]
  const sum = new Float64Array((max + 1) * 4)
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    if (l < 0) continue
    const o = i * 4
    const a = data[o + 3] / 255
    sum[l * 4] += data[o] * a
    sum[l * 4 + 1] += data[o + 1] * a
    sum[l * 4 + 2] += data[o + 2] * a
    sum[l * 4 + 3] += a
  }
  const out: (Rgb | null)[] = []
  for (let l = 0; l <= max; l++) {
    const w = sum[l * 4 + 3]
    out.push(
      w > 0
        ? { r: Math.round(sum[l * 4] / w), g: Math.round(sum[l * 4 + 1] / w), b: Math.round(sum[l * 4 + 2] / w) }
        : null,
    )
  }
  return out
}

export interface StageAnalysis {
  width: number
  height: number
  /** Which segmenter the trace ran — the explainer words its stages by it. */
  segmenter: ExplainSegmenter
  /** The smoothness segmenter's pictures; null when it did not run. */
  smoothed: Uint8ClampedArray | null
  disc: Uint8ClampedArray | null
  segs: Uint8ClampedArray
  fills: Uint8ClampedArray
  /** Regions in the map the tracer received. */
  regionCount: number
  /** Per label (index = label, so the chip outline matches the region hue); null = absent. */
  paints: ({ model: string; solid: [number, number, number] } | null)[]
  svg: string
  stats: { paths: number; nodes: number }
}

export async function analyzeStages(imageData: ImageData, options: VectorizeOptions): Promise<StageAnalysis> {
  const img = imageData as unknown as Img
  let planar: Int32Array | null = null
  const doc = await traceImage(imageData, options, undefined, undefined, undefined, undefined, (l) => {
    planar = l.labels
  })
  const { width, height } = imageData
  const { segmenter, palette } = pickSegmenter(img, options)
  const st = docStats(doc)

  // Re-run the smoothness segmenter only where the trace ran it: its own map (same
  // options, deterministic) indexes the same palette the planar labels do.
  const seg = segmenter === 'smooth' ? segmentImage(img, segmentOptionsFor(options)) : null
  const labels: Int32Array = planar ?? seg?.labels ?? new Int32Array(width * height).fill(-1)

  const means = labelMeans(labels, imageData.data)
  const present = means.map((m) => m != null)
  const fillOf = seg?.palette ?? palette
  const colours: Rgb[] = means.map((m, l) => fillOf?.[l] ?? m ?? { r: 0, g: 0, b: 0 })
  const gradientsOn = segmenter === 'smooth' && options.gradients !== false
  const paints = colours.map((c, l) => {
    if (!present[l]) return null
    if (gradientsOn && seg?.regionSamples[l]) {
      const p = fitPaintLadder(seg.regionSamples[l])
      if (p) return { model: p.model, solid: p.solid }
    }
    return { model: 'solid', solid: [c.r, c.g, c.b] as [number, number, number] }
  })

  return {
    width,
    height,
    segmenter,
    smoothed: seg ? smoothedToRgba(seg.ms) : null,
    disc: seg ? discontinuityToRgba(seg.ms) : null,
    segs: segmentsToRgba(labels, width, height),
    fills: regionFillsToRgba(labels, colours, width, height),
    regionCount: present.filter(Boolean).length,
    paints,
    svg: serializeDoc(doc, 3),
    stats: { paths: st.paths, nodes: st.nodes },
  }
}
