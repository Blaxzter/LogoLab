// Raster → vector tracing engine (V2, structure-first — plan §3): Mumford–Shah
// smoothness segmentation → per-macro-region paint-model ladder → stacked per-
// region binary masks → tracer per mask → EditableDoc.
//
// The order is INVERTED from the old posterize-then-mend pipeline: regions are
// found by smoothness FIRST (segment.ts), each region's paint (solid / linear /
// radial gradient) is fitted SECOND (gradient.ts fitPaintLadder), and geometry is
// traced LAST — once per region. Masks are still STACKED (each layer also covers
// everything painted above it) so adjacent regions overlap instead of abutting,
// which kills the hairline gaps a naive per-region trace leaves between regions.
// k-means quantization (quantize.ts) survives only as a fallback / UI palette.

import type { VectorizeOptions } from '../../types'
import type { EditableDoc, GradientFill, PathItem, RadialGradient, SubPath } from '../path/types'
import type { TraceProgress, QuantizeResult } from './types'
import { traceMask, type TraceMaskOptions } from './potrace.ts'
import { traceMaskCrisp, type CrispOptions } from './subpixel.ts'
import { segmentImage, DEFAULT_SEGMENT_OPTIONS, type SegmentOptions } from './segment.ts'
import { fitPaintLadder, type PaintLadderResult, type RegionSamples } from './gradient.ts'
import { beautify, DEFAULT_BEAUTIFY_OPTIONS, type BeautifyOptions } from './beautify.ts'

export const DEFAULT_VECTORIZE_OPTIONS: VectorizeOptions = {
  mode: 'color',
  colors: 8,
  smoothing: 50,
  despeckle: 25,
  threshold: 128,
  removeBackground: false,
  gradients: true,
  engine: 'potrace',
  fidelity: DEFAULT_BEAUTIFY_OPTIONS.fidelity,
}

/** Map the user smoothing dial (0–100) onto the crisp tracer's tunables. */
function crispOptionsFor(smoothing: number, turdsize: number): CrispOptions {
  const s = smoothing / 100
  return {
    smooth: 0.35 + s * 0.55, // coverage blur: 0.35 → 0.9 px (gentle: keep thin features)
    turdsize,
    // Curve-fit tolerance ε. The paper uses 1.5 px uniformly; we run 1.0 px,
    // the one measured deviation: at 1.5 the looser cubic fit regressed nebula's
    // smooth-gradient region (SSIM 0.9782→0.9758, meanΔE 2.95→3.00) below V4
    // parity, while 1.0 holds nebula/petals exactly AND keeps the node-count win.
    // Corner placement is evidence-based (curveFit), independent of this value.
    keyEpsilon: 1.0,
  }
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

/** Map the user fidelity dial onto the beautify pass (plan §3.3 / V3). */
function beautifyOptionsFor(options: VectorizeOptions): BeautifyOptions {
  return {
    ...DEFAULT_BEAUTIFY_OPTIONS,
    fidelity: Math.max(0, options.fidelity ?? DEFAULT_BEAUTIFY_OPTIONS.fidelity),
  }
}

const rgbToHex = (r: number, g: number, b: number): string =>
  '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)

/**
 * Trace an ImageData into an editable vector document. Color mode segments by
 * smoothness (Mumford–Shah), fits a paint model per macro-region, and traces one
 * stacked mask per region (bottom-first paint order); mono mode thresholds to a
 * single black shape. Aborts (via `signal`) throw a DOMException named 'AbortError'.
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

  // Tracer backend: 'crisp' (sub-pixel, evenodd) vs 'potrace' (bilevel WASM,
  // nonzero). Both consume the same black-on-white masks.
  const engine = options.engine ?? 'potrace'
  const crispOpts = crispOptionsFor(smoothing, maskOpts.turdsize)
  // Both engines now fill nonzero. The crisp tracer used to fill even-odd, which
  // XORs two near-coincident simplified contours into hairline background slivers
  // (the "cracks"); its loops are now oriented for nonzero (orientForNonzero), so
  // holes still render correctly without the seam mechanism.
  const fillRule: 'nonzero' | 'evenodd' = 'nonzero'
  const traceOne = (mask: ImageData): Promise<SubPath[]> =>
    engine === 'crisp' ? Promise.resolve(traceMaskCrisp(mask, crispOpts)) : traceMask(mask, maskOpts)

  // Stage 3 beautify (plan §3.3): a pure post-pass that snaps traced contours to
  // perfect circles/ellipses/lines and reconciles concentric/equal shapes, gated
  // by the user fidelity tolerance. Runs for BOTH engines, on the traced subpaths
  // before items are assembled. fidelity ≤ 0 makes it a no-op (raw trace).
  const beautifyOpts = beautifyOptionsFor(options)

  if (options.mode === 'mono') {
    const traced = await traceOne(thresholdToMask(imageData, options.threshold))
    const [subPaths] = beautify([traced], beautifyOpts)
    const items: PathItem[] = []
    if (subPaths.length > 0) {
      items.push({
        kind: 'path',
        id: 'trace-0',
        fill: '#000000',
        fillRule,
        subPaths,
        visible: true,
      })
    }
    return { viewBox: [0, 0, width, height], items }
  }

  // Stage 1 — smoothness segmentation: Mumford–Shah smoothing splits the image
  // into macro-regions (one smooth field each), reuniting a background that an
  // edge spatially split and keeping true edges separate (segment.ts). This
  // replaces quantize → mode-filter → drop-minor → union-refit entirely.
  onProgress?.({ phase: 'quantize' })
  const seg = segmentImage(
    imageData as unknown as { width: number; height: number; data: Uint8ClampedArray },
    segmentOptionsFor(options),
  )
  const q: QuantizeResult = { palette: seg.palette, labels: seg.labels, counts: seg.counts }

  const gradientsOn = options.gradients !== false

  // Stage 2 — paint-model ladder per macro-region: pick the cheapest of
  // solid / linear-multistop / radial under an MDL score, fitting on the region's
  // smooth (anti-alias-free) samples. A flat region stays solid (flat-logo
  // parity); a smooth field becomes one coherent gradient; a 2-D glow field
  // (model 'glow') becomes a base linear + radial overlays (Stage 2.4, §3.2.4).
  let labelPaint: (PaintLadderResult | null)[] = q.palette.map(() => null)
  if (gradientsOn) {
    // The paint model is fit on the segmenter's SMOOTH (AA-free) samples, but the
    // glow stack is GATED on the FULL region (every labelled pixel, AA included):
    // the smooth subset omits the high-error anti-aliased pixels where a glow
    // helps most and so under-reports its benefit (see fitGlowStack).
    const fullSamples = fullRegionSamples(q.labels, imageData.data, width, q.palette.length)
    labelPaint = seg.regionSamples.map((s, label) => fitPaintLadder(s, undefined, fullSamples[label]))
  }

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
  // Trace every layer first, collecting its raw subpaths + paint metadata, so the
  // beautify pass can run its cross-shape relation solver (concentric centres,
  // equal radii, …) over ALL loops at once rather than one layer in isolation.
  interface Layer {
    id: string
    subPaths: SubPath[]
    fill: string
    gradient?: GradientFill
    /** Glow overlays painted above this region's base (model 'glow', §3.2.4). */
    overlays?: RadialGradient[]
  }
  const layers: Layer[] = []
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    onProgress?.({ phase: 'trace', layer: i + 1, total })
    const subPaths = await traceOne(stackedMask(q.labels, width, height, rank, i))
    if (subPaths.length > 0) {
      const label = paintOrder[i]
      const { r, g, b } = q.palette[label]
      const layer: Layer = { id: 'trace-' + i, subPaths, fill: rgbToHex(r, g, b) }
      const paint = labelPaint[label]
      if (paint) {
        if (paint.model === 'glow' && paint.glow) {
          layer.gradient = paint.glow.base
          layer.overlays = paint.glow.overlays
        } else if (paint.gradient) {
          layer.gradient = paint.gradient
        }
      }
      layers.push(layer)
    }
    // Yield to the event loop so the progress UI can actually paint.
    await new Promise((r) => setTimeout(r))
  }

  const beautified = beautify(
    layers.map((l) => l.subPaths),
    beautifyOpts,
  )
  // Assemble bottom-up. A glow region emits its opaque base, then one translucent
  // overlay item per radial glow (sharing the region's beautified geometry), all
  // before the next region — so the glow paints over the base but under the marks.
  const items: PathItem[] = []
  layers.forEach((layer, i) => {
    const base: PathItem = {
      kind: 'path',
      id: layer.id,
      fill: layer.fill,
      fillRule,
      subPaths: beautified[i],
      visible: true,
    }
    if (layer.gradient) base.gradient = layer.gradient
    items.push(base)
    if (layer.overlays) {
      layer.overlays.forEach((ov, k) => {
        items.push({
          kind: 'path',
          id: `${layer.id}-glow-${k}`,
          fill: layer.fill,
          fillRule,
          subPaths: cloneSubPaths(beautified[i]),
          gradient: ov,
          visible: true,
        })
      })
    }
  })

  return { viewBox: [0, 0, width, height], items }
}

/**
 * Per-region FULL sample sets (every labelled pixel of each region, AA included),
 * strided down to a cap — the gate set for the glow stack. Distinct from the
 * segmenter's smooth `regionSamples`, which the paint model is FIT on but which
 * omit the anti-aliased pixels a glow most improves.
 */
function fullRegionSamples(
  labels: Int32Array,
  data: Uint8ClampedArray,
  width: number,
  paletteSize: number,
  cap = 6000,
): RegionSamples[] {
  const xs: number[][] = Array.from({ length: paletteSize }, () => [])
  const ys: number[][] = Array.from({ length: paletteSize }, () => [])
  const rs: number[][] = Array.from({ length: paletteSize }, () => [])
  const gs: number[][] = Array.from({ length: paletteSize }, () => [])
  const bs: number[][] = Array.from({ length: paletteSize }, () => [])
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    if (l < 0 || l >= paletteSize) continue
    const o = i * 4
    xs[l].push(i % width)
    ys[l].push((i / width) | 0)
    rs[l].push(data[o])
    gs[l].push(data[o + 1])
    bs[l].push(data[o + 2])
  }
  return xs.map((_, l) => stride(xs[l], ys[l], rs[l], gs[l], bs[l], cap))
}

/** Stride parallel JS arrays down to at most `cap` points → a RegionSamples. */
function stride(xs: number[], ys: number[], rs: number[], gs: number[], bs: number[], cap: number): RegionSamples {
  const total = xs.length
  const step = total > cap ? Math.ceil(total / cap) : 1
  const m = Math.ceil(total / step)
  const X = new Float64Array(m)
  const Y = new Float64Array(m)
  const R = new Float64Array(m)
  const G = new Float64Array(m)
  const B = new Float64Array(m)
  let k = 0
  for (let i = 0; i < total && k < m; i += step) {
    X[k] = xs[i]
    Y[k] = ys[i]
    R[k] = rs[i]
    G[k] = gs[i]
    B[k] = bs[i]
    k++
  }
  return { xs: X, ys: Y, rs: R, gs: G, bs: B, n: k }
}

/** Deep-clone a subpath list so a glow overlay's geometry is independent of the
 *  base item's (no shared-reference aliasing when either is later edited). */
function cloneSubPaths(subPaths: SubPath[]): SubPath[] {
  return subPaths.map((sp) => ({
    closed: sp.closed,
    nodes: sp.nodes.map((n) => ({
      x: n.x,
      y: n.y,
      hIn: n.hIn ? { x: n.hIn.x, y: n.hIn.y } : null,
      hOut: n.hOut ? { x: n.hOut.x, y: n.hOut.y } : null,
      kind: n.kind,
    })),
  }))
}

/**
 * Map the user-facing VectorizeOptions onto the structure-first segmenter's
 * tunables. V2 starts every parameter at the blueprint paper's fixed value
 * (τ_s = 10, σ = 5, τ_a = 0.25, MS α = 1.0, and the calibrated edge threshold);
 * the `colors`/`despeckle` dials no longer drive a k-means count — segmentation
 * is structural — so they are intentionally left at the defaults here (the dials
 * still tune the tracer's smoothing/turdsize downstream).
 */
function segmentOptionsFor(_options: VectorizeOptions): SegmentOptions {
  return DEFAULT_SEGMENT_OPTIONS
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
