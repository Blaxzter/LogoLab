// Raster → vector tracing engine: alpha-aware quantization → anti-alias
// cleanup → stacked per-color binary masks → potrace per mask → EditableDoc.
//
// The same conceptual pipeline as Affinity/Illustrator image trace. Masks are
// STACKED (each layer also covers everything painted above it), so adjacent
// regions overlap instead of abutting — that is what kills the hairline gaps
// a naive per-color trace leaves between regions.

import type { VectorizeOptions } from '../../types'
import type { EditableDoc, GradientFill, PathItem, SubPath } from '../path/types'
import type { TraceProgress, QuantizeResult, PaletteColor } from './types'
import { traceMask, type TraceMaskOptions } from './potrace.ts'
import { traceMaskCrisp, type CrispOptions } from './subpixel.ts'
import { dropMinorColors, modeFilter, quantize } from './quantize.ts'
import { concatSamples, fitRegionFill, fitBestGradient, type RegionSamples } from './gradient.ts'

export const DEFAULT_VECTORIZE_OPTIONS: VectorizeOptions = {
  mode: 'color',
  colors: 8,
  smoothing: 50,
  despeckle: 25,
  threshold: 128,
  removeBackground: false,
  gradients: true,
  engine: 'potrace',
}

/** Map the user smoothing dial (0–100) onto the crisp tracer's tunables. */
function crispOptionsFor(smoothing: number, turdsize: number): CrispOptions {
  const s = smoothing / 100
  return {
    smooth: 0.35 + s * 0.55, // coverage blur: 0.35 → 0.9 px (gentle: keep thin features)
    turdsize,
    cornerThreshold: 80 - s * 30, // 80° → 50°: more smoothing keeps fewer corners
    simplifyEpsilon: 0.3 + s * 0.7,
    fitTolerance: 0.4 + s * 1.2,
  }
}

/** Max pixels sampled per region when fitting a gradient (perf vs. accuracy). */
const GRADIENT_SAMPLE_TARGET = 4000

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

  if (options.mode === 'mono') {
    const subPaths = await traceOne(thresholdToMask(imageData, options.threshold))
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

  onProgress?.({ phase: 'quantize' })
  let q = quantize(imageData, clamp(Math.round(options.colors), 2, 24))
  const passes = despeckle === 0 ? 0 : 1 + Math.floor(despeckle / 40)
  q = { ...q, labels: modeFilter(q.labels, width, height, passes) }
  q = dropMinorColors(q, (despeckle / 100) ** 1.5 * 0.02)

  const gradientsOn = options.gradients !== false

  // Gradient grouping happens BEFORE tracing. Sample each quantized region from
  // the ORIGINAL pixels, greedily union-refit the regions (two merge iff a single
  // gradient explains their combined samples — the plan's "merge iff one model
  // fits the union"), then MERGE the labels of each group into one region. A
  // posterized smooth field thus collapses back into a single full-bleed region
  // painted with one gradient: there are no band layers left to leave seams, and
  // a foreground mark (which never merges into the field) simply sits on top
  // instead of being sandwiched under a tiny band and showing through its cracks.
  let labelGradient: (GradientFill | null)[] = q.palette.map(() => null)
  if (gradientsOn) {
    const samples = q.palette.map((_, label) =>
      sampleRegion(imageData, q.labels, width, height, label, q.counts[label] ?? 0),
    )
    const groups = groupRegions(samples)
    const merged = mergeLabels(q, groups)
    q = merged.q
    labelGradient = merged.gradients
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
  const items: PathItem[] = []
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    onProgress?.({ phase: 'trace', layer: i + 1, total })
    const subPaths = await traceOne(stackedMask(q.labels, width, height, rank, i))
    if (subPaths.length > 0) {
      const label = paintOrder[i]
      const { r, g, b } = q.palette[label]
      const item: PathItem = {
        kind: 'path',
        id: 'trace-' + i,
        fill: rgbToHex(r, g, b),
        fillRule,
        subPaths,
        visible: true,
      }
      const grad = labelGradient[label]
      if (grad) item.gradient = grad
      items.push(item)
    }
    // Yield to the event loop so the progress UI can actually paint.
    await new Promise((r) => setTimeout(r))
  }

  return { viewBox: [0, 0, width, height], items }
}

/**
 * Oklab ΔE below which a SINGLE gradient is judged to explain the combined
 * samples of two region groups — the union-refit merge predicate. Generous:
 * biased toward unifying co-field bands into one paint (the plan tolerates loose
 * colour error but zero seams), so a posterized smooth field collapses back into
 * one shared gradient instead of several disagreeing ones.
 */
const MERGE_OKLAB_TOL = 0.06

/** Cap on samples fed to a single union-refit fit (perf; subsampled if larger). */
const UNION_FIT_CAP = 3000

interface Group {
  members: number[]
  samples: RegionSamples
  gradient: GradientFill | null
  residual: number
}

/** One union-refit group: the labels it covers and the gradient it paints. */
interface RegionGroup {
  members: number[]
  gradient: GradientFill | null
}

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))

/**
 * Greedy union-refit over the quantized regions, replacing the old posterize-
 * then-mend heuristics (axis clustering + a raw-RGB absorb tolerance, both of
 * which split a smooth field into disagreeing patches). Start one group per
 * label, then repeatedly merge the globally-best pair whose COMBINED samples are
 * still fit by a single gradient within MERGE_OKLAB_TOL, to a fixpoint. A
 * multi-member group paints its shared union gradient (and naturally absorbs flat
 * sub-bands whose colour lies on the ramp); a lone region keeps its own
 * per-region fit (a genuine single-region gradient, or solid). This is the V1
 * interim of the structure-first plan (§6); V2 replaces it with smoothness-first
 * segmentation.
 */
function groupRegions(samples: RegionSamples[]): RegionGroup[] {
  const groups: Group[] = samples.map((s, label) => {
    const fit = s.n >= 2 ? fitBestGradient(s) : null
    return { members: [label], samples: s, gradient: fit?.gradient ?? null, residual: fit?.oklabResidual ?? Infinity }
  })

  // Merge the globally-best mergeable pair until none fits under tol.
  for (;;) {
    let best: { i: number; j: number; samples: RegionSamples; gradient: GradientFill } | null = null
    let bestRes = MERGE_OKLAB_TOL
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const union = subsample(concatSamples([groups[i].samples, groups[j].samples]), UNION_FIT_CAP)
        const fit = fitBestGradient(union)
        if (fit && fit.oklabResidual <= bestRes) {
          bestRes = fit.oklabResidual
          best = { i, j, samples: union, gradient: fit.gradient }
        }
      }
    }
    if (!best) break
    const merged: Group = {
      members: groups[best.i].members.concat(groups[best.j].members),
      samples: best.samples,
      gradient: best.gradient,
      residual: bestRes,
    }
    groups.splice(best.j, 1)
    groups.splice(best.i, 1, merged)
  }

  return groups.map((g) => {
    if (g.members.length >= 2 && g.gradient) return { members: g.members, gradient: g.gradient }
    const fit = g.samples.n >= 2 ? fitRegionFill(g.samples) : null
    return { members: g.members, gradient: fit?.gradient ?? null }
  })
}

/**
 * Collapse each region group into ONE label: remap every member label to a single
 * merged entry (count-weighted mean colour, summed count), re-sort the merged
 * palette by count descending, and return the merged quantization plus the
 * gradient to paint for each merged label. Merging the bands of a smooth field
 * into one full-bleed region is what removes the band seams (and the under-layer
 * slivers a sandwiched foreground mark used to show through).
 */
function mergeLabels(q: QuantizeResult, groups: RegionGroup[]): { q: QuantizeResult; gradients: (GradientFill | null)[] } {
  const groupOf = new Int32Array(q.palette.length)
  groups.forEach((g, gi) => {
    for (const label of g.members) groupOf[label] = gi
  })

  const gr = new Float64Array(groups.length)
  const gg = new Float64Array(groups.length)
  const gb = new Float64Array(groups.length)
  const gc = new Float64Array(groups.length)
  for (let label = 0; label < q.palette.length; label++) {
    const gi = groupOf[label]
    const w = q.counts[label] ?? 0
    gr[gi] += q.palette[label].r * w
    gg[gi] += q.palette[label].g * w
    gb[gi] += q.palette[label].b * w
    gc[gi] += w
  }

  // Largest merged region paints at the bottom (full-bleed background).
  const order = groups.map((_, gi) => gi).sort((a, b) => gc[b] - gc[a])
  const mergedRank = new Int32Array(groups.length)
  order.forEach((gi, pos) => {
    mergedRank[gi] = pos
  })

  const palette: PaletteColor[] = order.map((gi) => {
    const w = gc[gi] || 1
    return { r: clamp255(gr[gi] / w), g: clamp255(gg[gi] / w), b: clamp255(gb[gi] / w) }
  })
  const counts = order.map((gi) => gc[gi])
  const gradients = order.map((gi) => groups[gi].gradient)

  const labels = new Int32Array(q.labels.length)
  for (let i = 0; i < q.labels.length; i++) {
    const l = q.labels[i]
    labels[i] = l < 0 ? -1 : mergedRank[groupOf[l]]
  }
  return { q: { palette, labels, counts }, gradients }
}

/** Evenly stride a sample set down to at most `cap` points (deterministic). */
function subsample(s: RegionSamples, cap: number): RegionSamples {
  if (s.n <= cap) return s
  const stride = Math.ceil(s.n / cap)
  const m = Math.ceil(s.n / stride)
  const xs = new Float64Array(m)
  const ys = new Float64Array(m)
  const rs = new Float64Array(m)
  const gs = new Float64Array(m)
  const bs = new Float64Array(m)
  let k = 0
  for (let i = 0; i < s.n && k < m; i += stride) {
    xs[k] = s.xs[i]
    ys[k] = s.ys[i]
    rs[k] = s.rs[i]
    gs[k] = s.gs[i]
    bs[k] = s.bs[i]
    k++
  }
  return { xs, ys, rs, gs, bs, n: k }
}

/**
 * Gather a region's original-color pixels (label == `label`) into flat sample
 * arrays for gradient fitting, evenly strided down to ~GRADIENT_SAMPLE_TARGET.
 * Colors come from the untouched source `img`; positions are in pixel == viewBox
 * space. `count` is the approximate region size (from quantization) used only to
 * pick the stride.
 */
function sampleRegion(
  img: ImageData,
  labels: Int32Array,
  width: number,
  height: number,
  label: number,
  count: number,
): RegionSamples {
  const stride = count > GRADIENT_SAMPLE_TARGET ? Math.floor(count / GRADIENT_SAMPLE_TARGET) : 1
  const cap = Math.min(count || labels.length, GRADIENT_SAMPLE_TARGET + 16)
  const xs = new Float64Array(cap)
  const ys = new Float64Array(cap)
  const rs = new Float64Array(cap)
  const gs = new Float64Array(cap)
  const bs = new Float64Array(cap)
  const data = img.data
  let k = 0
  let matched = 0
  for (let i = 0; i < labels.length && k < cap; i++) {
    if (labels[i] !== label) continue
    if (matched++ % stride !== 0) continue
    const o = i * 4
    xs[k] = i % width
    ys[k] = (i / width) | 0
    rs[k] = data[o]
    gs[k] = data[o + 1]
    bs[k] = data[o + 2]
    k++
  }
  return { xs, ys, rs, gs, bs, n: k }
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
