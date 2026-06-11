// Raster → vector tracing engine: alpha-aware quantization → anti-alias
// cleanup → stacked per-color binary masks → potrace per mask → EditableDoc.
//
// The same conceptual pipeline as Affinity/Illustrator image trace. Masks are
// STACKED (each layer also covers everything painted above it), so adjacent
// regions overlap instead of abutting — that is what kills the hairline gaps
// a naive per-color trace leaves between regions.

import type { VectorizeOptions } from '../../types'
import type { EditableDoc, LinearGradient, PathItem, SubPath } from '../path/types'
import type { TraceProgress } from './types'
import { traceMask, type TraceMaskOptions } from './potrace'
import { traceMaskCrisp, type CrispOptions } from './subpixel'
import { dropMinorColors, modeFilter, quantize } from './quantize'
import { concatSamples, fitRegionFill, type RegionSamples } from './gradient'

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

/** Min |dot| of two canonical axes to treat their linear ramps as one gradient. */
const AXIS_PARALLEL_DOT = 0.9

/** Unit ramp axis of a linear gradient, flipped into a canonical half-plane. */
function canonicalAxis(g: LinearGradient): [number, number] {
  let ux = g.x2 - g.x1
  let uy = g.y2 - g.y1
  const len = Math.hypot(ux, uy) || 1
  ux /= len
  uy /= len
  if (ux < -1e-9 || (Math.abs(ux) < 1e-9 && uy < 0)) {
    ux = -ux
    uy = -uy
  }
  return [ux, uy]
}

const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

/** Mean (x, y) of a region's samples. */
function centroid(s: RegionSamples): [number, number] {
  let cx = 0
  let cy = 0
  for (let i = 0; i < s.n; i++) {
    cx += s.xs[i]
    cy += s.ys[i]
  }
  return [cx / s.n, cy / s.n]
}

/** Evaluate a linear gradient's color at point (x, y), clamped to its extent. */
function sampleLinearAt(g: LinearGradient, x: number, y: number): [number, number, number] {
  const dx = g.x2 - g.x1
  const dy = g.y2 - g.y1
  const len2 = dx * dx + dy * dy || 1
  let t = ((x - g.x1) * dx + (y - g.y1) * dy) / len2
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const stops = g.stops
  let a = stops[0]
  let b = stops[stops.length - 1]
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].offset && t <= stops[i + 1].offset) {
      a = stops[i]
      b = stops[i + 1]
      break
    }
  }
  const span = b.offset - a.offset || 1
  const lt = (t - a.offset) / span
  const ca = hexToRgb(a.color)
  const cb = hexToRgb(b.color)
  return [ca[0] + (cb[0] - ca[0]) * lt, ca[1] + (cb[1] - ca[1]) * lt, ca[2] + (cb[2] - ca[2]) * lt]
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

  // Tracer backend: 'crisp' (sub-pixel, evenodd) vs 'potrace' (bilevel WASM,
  // nonzero). Both consume the same black-on-white masks.
  const engine = options.engine ?? 'potrace'
  const crispOpts = crispOptionsFor(smoothing, maskOpts.turdsize)
  const fillRule: 'nonzero' | 'evenodd' = engine === 'crisp' ? 'evenodd' : 'nonzero'
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

  const gradientsOn = options.gradients !== false
  const total = paintOrder.length
  const layers: { item: PathItem; samples: RegionSamples | null }[] = []
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
      const samples = gradientsOn
        ? sampleRegion(imageData, q.labels, width, height, label, q.counts[label] ?? 0)
        : null
      layers.push({ item, samples })
    }
    // Yield to the event loop so the progress UI can actually paint.
    await new Promise((r) => setTimeout(r))
  }

  // Look back at each region's ORIGINAL pixels: regions whose colors follow a
  // smooth ramp get a fitted SVG gradient instead of a flat fill. Co-linear
  // bands (a single gradient quantization split into several flat layers) are
  // merged onto ONE shared gradient so no seams show between them.
  if (gradientsOn) assignGradients(layers)

  return { viewBox: [0, 0, width, height], items: layers.map((l) => l.item) }
}

/**
 * Max RGB distance for a flat band to be absorbed into a shared gradient. Set
 * generously: a background band that quantization split off but didn't fit as
 * linear should still join the ramp (else it paints a flat seam over it). Real
 * foreground elements (e.g. a white mark on a colored ground) sit far further
 * than this from the gradient, so they are never wrongly absorbed.
 */
const ABSORB_COLOR_TOL = 70

/**
 * Fit gradients across the traced layers. Each region is fit individually;
 * neighbouring layers whose linear ramps share an axis and a color line are
 * then refit as one group and assigned a single shared gradient (the cure for
 * the visible seams a per-band fit leaves on a quantized gradient). Finally,
 * flat sub-bands that fall on a shared gradient are absorbed into it, so a
 * narrow "solid" slice can't paint a patch over the smooth ramp.
 */
function assignGradients(layers: { item: PathItem; samples: RegionSamples | null }[]): void {
  const fits = layers.map((l) => (l.samples ? fitRegionFill(l.samples) : null))
  const merged = new Set<number>()

  // Cluster linear-fit layers by canonical axis direction (parallel ⇒ same
  // gradient candidate). Solid / radial layers are handled on their own.
  const clusters: { axis: [number, number]; members: number[] }[] = []
  for (let i = 0; i < layers.length; i++) {
    const fit = fits[i]
    if (!fit || fit.kind !== 'linear' || fit.gradient?.type !== 'linear') continue
    const axis = canonicalAxis(fit.gradient)
    let placed = false
    for (const c of clusters) {
      if (Math.abs(axis[0] * c.axis[0] + axis[1] * c.axis[1]) >= AXIS_PARALLEL_DOT) {
        c.members.push(i)
        placed = true
        break
      }
    }
    if (!placed) clusters.push({ axis, members: [i] })
  }

  // Refit each multi-member cluster as one region → a single shared gradient.
  const shared: LinearGradient[] = []
  for (const c of clusters) {
    if (c.members.length < 2) continue
    const samples = c.members.map((i) => layers[i].samples).filter(Boolean) as RegionSamples[]
    const fit = fitRegionFill(concatSamples(samples))
    if (fit.gradient?.type === 'linear') {
      shared.push(fit.gradient)
      for (const i of c.members) {
        layers[i].item.gradient = fit.gradient
        merged.add(i)
      }
    }
  }

  // Absorb still-unmerged layers (typically flat sub-bands) whose region color
  // matches a shared gradient where it sits — they'd otherwise paint a patch.
  for (let i = 0; i < layers.length; i++) {
    if (merged.has(i)) continue
    const s = layers[i].samples
    const fit = fits[i]
    if (!s || !fit) continue
    const [cx, cy] = centroid(s)
    for (const g of shared) {
      const [pr, pg, pb] = sampleLinearAt(g, cx, cy)
      const dr = fit.solid[0] - pr
      const dg = fit.solid[1] - pg
      const db = fit.solid[2] - pb
      if (Math.sqrt(dr * dr + dg * dg + db * db) <= ABSORB_COLOR_TOL) {
        layers[i].item.gradient = g
        merged.add(i)
        break
      }
    }
  }

  // Anything still unmerged keeps its own per-region fit (incl. radials).
  for (let i = 0; i < layers.length; i++) {
    if (merged.has(i)) continue
    const g = fits[i]?.gradient
    if (g) layers[i].item.gradient = g
  }
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
