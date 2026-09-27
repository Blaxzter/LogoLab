// Raster → vector tracing pipeline:
//   1. segmentation into a label map — Mumford–Shah smoothness for gradient art
//      (segment.ts), palette-first for flat art (paletteSegment.ts), a two-label
//      ink/paper cut for mono (mono.ts);
//   2. a paint model per region — solid, linear or radial gradient (gradient.ts);
//   3. one planar shared-edge trace of the label map (planarAssemble.ts), so every
//      boundary is traced once and regions tile with no overlap and no seam;
//   4. edge-level beautify (planarBeautify.ts), then materialization into an
//      EditableDoc.
// k-means quantization (quantize.ts) survives only as a fallback / UI palette.

import type { VectorizeOptions } from '../../types'
import type { EditableDoc, GradientFill, PathItem, RadialGradient, SubPath } from '../path/types'
import type { TraceProgress, QuantizeResult } from './types'
import { segmentImage, DEFAULT_SEGMENT_OPTIONS, type SegmentOptions } from './segment.ts'
import { segmentFlatPalette, type PaletteSegmentOptions } from './paletteSegment.ts'
import { fitPaintLadder, type PaintLadderResult, type RegionSamples } from './gradient.ts'
import { DEFAULT_BEAUTIFY_OPTIONS, type BeautifyOptions } from './beautify.ts'
import { uniteBackgroundGradient, type BackgroundUnion } from './backgroundLayer.ts'
import { tracePlanar, type PlanarTrace } from './planarAssemble.ts'
import { monoLabels, MONO_INK } from './mono.ts'
import { type PlanarFitOptions, DEFAULT_PLANAR_FIT, FLAT_LINE_COST } from './planarFit.ts'
import { planarBeautify } from './planarBeautify.ts'
import { weldConvergedJunctions } from './planarReseat.ts'
import { materializeRegion, edgeMap } from '../path/topology.ts'

export {
  suggestGradients,
  measureRampiness,
  colorSpread,
  analyzeRampiness,
  RAMPINESS_GRADIENT_THRESHOLD,
  type RampinessReport,
} from './rampiness.ts'

export const DEFAULT_VECTORIZE_OPTIONS: VectorizeOptions = {
  mode: 'color',
  smoothing: 50,
  despeckle: 25,
  regionDetail: 0,
  threshold: 128,
  removeBackground: false,
  gradients: true,
  engine: 'planar',
  fidelity: DEFAULT_BEAUTIFY_OPTIONS.fidelity,
}

// Progress-bar span split (overall [0,1]): segmentation dominates the run time,
// so it owns most of the bar; paint + trace are quick.
const PROGRESS_SEGMENT_END = 0.8
const PROGRESS_PAINT_END = 0.88

/** Palette-first segmentation is kept over the smoothness segmenter only for simple
 *  flat art: high flat coverage (not continuous-tone) and few dominant colours. A
 *  rich flat illustration can still have coverage near 1, but is better served by
 *  the smoothness segmenter, which does not over-posterize it. */
const FLAT_PALETTE_MIN_COVERAGE = 0.7
const FLAT_PALETTE_MAX_COLORS = 14

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

/**
 * Labels pinned flat by a flat marker, to be painted one solid colour. Each flat
 * marker's normalized point maps to a pixel and so to its label. (Segmentation
 * already keeps a flat-marked section out of the field merge, so the label is that
 * section's own region; forcing solid paint keeps it from becoming a subtle gradient.)
 */
function flatMarkerLabels(options: VectorizeOptions, labels: Int32Array, width: number, height: number): Set<number> {
  const out = new Set<number>()
  for (const m of options.markers ?? []) {
    if (!m.flat) continue
    const px = clamp(Math.round(m.x * width), 0, width - 1)
    const py = clamp(Math.round(m.y * height), 0, height - 1)
    const label = labels[py * width + px]
    if (label >= 0) out.add(label)
  }
  return out
}

/**
 * "Remove & heal" markers. For each marker tagged `remove`, dissolve the 4-connected
 * region under it and let its bordering colours grow into the freed area: every
 * removed pixel is reassigned to the nearest bordering opaque region by a
 * multi-source grassfire (a discrete medial-axis split between the neighbours), so
 * the gap closes instead of leaving a hole. Transparent (-1) and the detected
 * background `bg` are not fill sources; a section bordering only those dissolves to
 * transparent. Returns a relabeled copy, or the input itself when there are no
 * remove markers.
 */
export function applyRemoveMarkers(
  options: VectorizeOptions,
  labels: Int32Array,
  width: number,
  height: number,
  bg: number,
): Int32Array {
  const seeds = (options.markers ?? []).filter((m) => m.remove)
  if (seeds.length === 0) return labels
  const out = labels.slice()
  const n = width * height
  const isFill = (lab: number): boolean => lab >= 0 && lab !== bg
  for (const m of seeds) {
    // floor, not round: the seed must be the pixel that contains the click point.
    // Rounding biases up to 1px toward the next region, which on a thin sliver
    // floods the neighbour instead of the sliver the user clicked.
    const sx = clamp(Math.floor(m.x * width), 0, width - 1)
    const sy = clamp(Math.floor(m.y * height), 0, height - 1)
    const start = sy * width + sx
    const target = out[start]
    if (target < 0) continue
    // The 4-connected in-bounds neighbours of p (off-grid sides omitted). Shared by
    // both passes so the flood and the grassfire walk the same adjacency.
    const forEachNeighbour = (p: number, fn: (q: number) => void): void => {
      const x = p % width
      const y = (p / width) | 0
      if (x > 0) fn(p - 1)
      if (x < width - 1) fn(p + 1)
      if (y > 0) fn(p - width)
      if (y < height - 1) fn(p + width)
    }
    // 1) Flood the connected component of `target` containing the seed (this one
    //    section only — other same-colour blobs are untouched).
    const comp: number[] = []
    const inComp = new Uint8Array(n)
    const stack = [start]
    inComp[start] = 1
    while (stack.length) {
      const p = stack.pop()!
      comp.push(p)
      forEachNeighbour(p, (q) => {
        if (!inComp[q] && out[q] === target) {
          inComp[q] = 1
          stack.push(q)
        }
      })
    }
    // 2) Multi-source grassfire: seed every component pixel that touches an opaque
    //    neighbour with that neighbour's label, then expand inward at equal speed —
    //    each neighbour claims the pixels nearest to it (the medial split).
    const assigned = new Int32Array(n).fill(-1)
    const queue: number[] = []
    for (const p of comp) {
      forEachNeighbour(p, (q) => {
        if (assigned[p] < 0 && !inComp[q] && isFill(out[q])) {
          assigned[p] = out[q]
          queue.push(p)
        }
      })
    }
    for (let head = 0; head < queue.length; head++) {
      const p = queue[head]
      const lab = assigned[p]
      forEachNeighbour(p, (q) => {
        if (inComp[q] && assigned[q] < 0) {
          assigned[q] = lab
          queue.push(q)
        }
      })
    }
    // 3) Commit: a neighbour's claim where one reached, else dissolve to transparent.
    for (const p of comp) out[p] = assigned[p] >= 0 ? assigned[p] : -1
  }
  return out
}

/**
 * Heal mislabeled boundary pixels in flat-art segmentation. A pixel grouped into
 * region L whose own colour clearly matches an adjacent region B (within a tight RGB
 * tolerance, and closer to B than to L) was mis-grouped — typically at a soft
 * multi-colour junction, where one region wedges a thin spike into a two-colour
 * stroke. Reassigning such pixels closes the wedge.
 *
 * Conservative: only a pixel that is unambiguously another region's colour moves.
 * An anti-aliased edge pixel sits between two colours, close to neither, so true
 * edges don't shift. Candidates are the 4-connected neighbours only: reassigning to a
 * diagonal-only neighbour joins regions at a corner point, and that pinch becomes a
 * spurious junction in the planar graph. Iterates (pass-synchronous, for determinism)
 * so a 2–3px spike is peeled inward. Returns the input itself when nothing moves.
 *
 * Flat art only: a gradient region's pixels stray from the region mean by design.
 */
export function healColorSpikes(
  labels: Int32Array,
  data: Uint8ClampedArray,
  width: number,
  height: number,
  palette: { r: number; g: number; b: number }[],
): Int32Array {
  const TIGHT = 30 // RGB distance below which a pixel counts as that region's flat colour
  const T2 = TIGHT * TIGHT
  const dist2 = (o: number, c: { r: number; g: number; b: number }): number => {
    const dr = data[o] - c.r
    const dg = data[o + 1] - c.g
    const db = data[o + 2] - c.b
    return dr * dr + dg * dg + db * db
  }
  let out: Int32Array | null = null // allocated lazily on the first reassignment
  let cur = labels
  for (let pass = 0; pass < 6; pass++) {
    let changed = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        const L = cur[i]
        if (L < 0) continue
        const o = i * 4
        if (dist2(o, palette[L]) <= T2) continue // matches its own region — keep
        let bestB = -1
        let bestD = T2
        const nb = [
          x > 0 ? i - 1 : -1,
          x < width - 1 ? i + 1 : -1,
          y > 0 ? i - width : -1,
          y < height - 1 ? i + width : -1,
        ]
        for (const q of nb) {
          if (q < 0) continue
          const B = cur[q]
          if (B < 0 || B === L) continue
          const d = dist2(o, palette[B])
          if (d < bestD) {
            bestD = d
            bestB = B
          }
        }
        if (bestB >= 0) {
          if (!out) out = labels.slice()
          out[i] = bestB
          changed++
        }
      }
    }
    if (changed === 0) break
    cur = out as Int32Array // next pass reads the updated labels (pass-synchronous)
  }
  return out ?? labels
}

/** Map the user fidelity dial onto the beautify pass. */
function beautifyOptionsFor(options: VectorizeOptions): BeautifyOptions {
  return {
    ...DEFAULT_BEAUTIFY_OPTIONS,
    fidelity: Math.max(0, options.fidelity ?? DEFAULT_BEAUTIFY_OPTIONS.fidelity),
  }
}

const rgbToHex = (r: number, g: number, b: number): string =>
  '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)

/** Map the user dials onto the planar tracer's edge-fit tunables. More smoothing
 *  ⇒ more staircase pre-smoothing passes; ε stays at the default. */
function planarFitOptionsFor(options: VectorizeOptions): PlanarFitOptions {
  const s = clamp(options.smoothing, 0, 100) / 100
  // smoothing 0 means no pre-smoothing at all (a raw staircase trace); the default
  // of 50 suits most art. Flat (gradients-off) art uses a higher line cost so curves
  // prefer cubics over faceted chords; gradient art keeps the conservative default.
  // `options.planarFit` (advanced) overrides any tunable.
  return {
    ...DEFAULT_PLANAR_FIT,
    lineCost: options.gradients === false ? FLAT_LINE_COST : DEFAULT_PLANAR_FIT.lineCost,
    smoothPasses: s === 0 ? 0 : Math.max(1, Math.round(s * 4)),
    ...(options.planarFit ?? {}),
  }
}

/**
 * Trace an ImageData into an editable vector document. Colour mode segments the
 * image, fits a paint model per region and traces the label map as one planar
 * graph (one path per region, tiling); mono mode cuts ink from paper and returns a
 * single black path. Both carry the shared-edge `topology`. Aborts (via `signal`)
 * throw a DOMException named 'AbortError'.
 */
export async function traceImage(
  imageData: ImageData,
  options: VectorizeOptions,
  onProgress?: (p: TraceProgress) => void,
  signal?: AbortSignal,
  /** Optional sink for the pre-merge region map (the fine regions before the
   *  gradient field merge), used by the editor's region hover-highlight. Called
   *  once per colour trace; never in mono mode. */
  onPreMerge?: (pm: { labels: Int32Array; width: number; height: number }) => void,
  /** Optional per-stage timing sink: ms spent in segment / paint / trace / beautify /
   *  materialize. Does not affect output; when omitted, no timing calls are made. */
  onStage?: (name: string, ms: number) => void,
  /** Optional diagnostic sink for the final label map — the exact array `tracePlanar`
   *  receives, after healing, remove markers and background union. Does not affect
   *  output. */
  onPlanarLabels?: (l: { labels: Int32Array; width: number; height: number }) => void,
): Promise<EditableDoc> {
  const { width, height } = imageData
  // Emits the ms since the previous mark under `name`, then re-marks. `mark()` starts a
  // fresh region (used to exclude setup before the first timed stage).
  let stageAt = onStage ? performance.now() : 0
  const stage = (name: string): void => {
    if (!onStage) return
    const t = performance.now()
    onStage(name, t - stageAt)
    stageAt = t
  }
  const mark = (): void => {
    if (onStage) stageAt = performance.now()
  }
  const despeckle = clamp(options.despeckle, 0, 100)
  // Mono despeckle: minimum component area (px²) kept in the two-label map
  // (mono.ts). From 1 px², growing quadratically so the dial's low end is gentle;
  // the colour path has its own, steeper floor (minRegionAreaFor).
  const turdsize = Math.max(1, Math.round((despeckle / 100) ** 2 * 64))
  // Planar regions tile and their loops are oriented for nonzero.
  const fillRule: 'nonzero' | 'evenodd' = 'nonzero'

  // Beautify snaps traced edges to circles/ellipses/lines within the user fidelity
  // tolerance; fidelity ≤ 0 leaves the raw trace.
  const beautifyOpts = beautifyOptionsFor(options)

  // Edge-level beautify + converged-junction weld, shared by the mono and colour
  // paths. The weld (fusing junction pairs the re-seat drove onto one crossing) runs
  // here rather than inside planarBeautify because contracting the micro-edge
  // rewrites the region loops, which beautify treats as read-only. Everything
  // downstream reads the loops after this.
  const fitOpts = planarFitOptionsFor(options)
  const finishPlanar = (trace: PlanarTrace) => {
    let reseated: ReadonlySet<number> = new Set<number>()
    const topology = planarBeautify(
      { vertices: trace.vertices, edges: trace.edges },
      trace.loopsByLabel,
      beautifyOpts,
      {
        arcSnap: fitOpts.arcSnap,
        localScaleK: fitOpts.localScaleK,
        cornerVeto: fitOpts.cornerVeto,
        chainArcs: fitOpts.chainArcs,
        reseat: fitOpts.junctionReseat,
        width,
        height,
        onReseat: (m) => {
          reseated = m
        },
        onChord: fitOpts.onChord,
        onReseatVerdict: fitOpts.onReseatVerdict,
        reseatTune: fitOpts.reseatTune,
        onArcLoop: fitOpts.onArcLoop,
      },
    )
    weldConvergedJunctions(topology.vertices, topology.edges, trace.loopsByLabel, width, height, reseated)
    return { topology, edges: edgeMap(topology) }
  }

  if (options.mode === 'mono') {
    // One ink on paper: a two-label segmentation (mono.ts) through the same planar
    // fitter as colour. Mono's contract: one path painted #000000 (the caller
    // repaints it with the probed ink), plus the shared-edge topology.
    onProgress?.({ phase: 'segment', fraction: 0.3, label: 'Cutting the ink' })
    const seg = monoLabels(imageData, options.threshold, options.invert === true, turdsize)
    stage('segment')
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    onPlanarLabels?.({ labels: seg.labels, width, height })
    onProgress?.({ phase: 'trace', fraction: PROGRESS_PAINT_END, label: 'Tracing shapes' })
    const trace = tracePlanar(seg.labels, width, height, fitOpts, seg.palette, seg.image)
    stage('trace')
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const { topology, edges } = finishPlanar(trace)
    stage('beautify')
    const loops = trace.loopsByLabel.get(MONO_INK) ?? []
    const subPaths = materializeRegion(loops, edges)
    const items: PathItem[] = []
    if (subPaths.length > 0) {
      items.push({ kind: 'path', id: 'trace-0', fill: '#000000', fillRule, loops, subPaths, visible: true })
    }
    stage('materialize')
    return { viewBox: [0, 0, width, height], items, topology }
  }

  // Stage 1 — segmentation. Two paths:
  //  • flat art (gradients off) → palette-first (paletteSegment.ts): pick the
  //    dominant colours and assign every pixel (anti-aliasing included) to the
  //    nearest, so an anti-aliased transition is one clean edge between two flats
  //    rather than a blend sliver. Opt out with flatPalette:false.
  //  • everything else → Mumford–Shah smoothness segmentation (segment.ts): groups
  //    by smooth field, reunites a split background, fits gradients downstream.
  const wantFlatPalette = options.gradients === false && options.flatPalette !== false
  mark() // exclude the setup above from the segment stage
  let q: QuantizeResult
  let preMergeLabels: Int32Array
  let regionSamples: RegionSamples[] = []
  // Palette-first is only kept if the image is actually flat; a continuous-tone
  // image would over-posterize and falls through to the smoothness segmenter.
  let fp: ReturnType<typeof segmentFlatPalette> | null = null
  let usedLockedPalette = false
  if (wantFlatPalette) {
    onProgress?.({ phase: 'segment', fraction: 0, label: 'Reading colours' })
    // A user-locked palette overrides automatic extraction: the segmenter snaps
    // every pixel to the nearest of these colours (emitted verbatim).
    const locked = options.palette && options.palette.length > 0 ? options.palette : undefined
    fp = segmentFlatPalette(
      imageData as unknown as { width: number; height: number; data: Uint8ClampedArray },
      paletteOptionsFor(options),
      locked,
    )
    // Photo-like (low coverage) or rich (many colours) ⇒ use the smoothness
    // segmenter instead; a locked palette bypasses both gates. Richness is read from
    // fp.dominantColors, not fp.palette.length: blend cleanup can shrink a photo's
    // palette under the ceiling, and the gate must count what the image contains.
    if (!locked && (fp.flatCoverage < FLAT_PALETTE_MIN_COVERAGE || fp.dominantColors > FLAT_PALETTE_MAX_COLORS))
      fp = null
    usedLockedPalette = fp != null && locked != null
  }
  if (fp) {
    q = { palette: fp.palette, labels: fp.labels, counts: fp.counts }
    preMergeLabels = fp.labels
  } else {
    const seg = segmentImage(
      imageData as unknown as { width: number; height: number; data: Uint8ClampedArray },
      segmentOptionsFor(options),
      onProgress
        ? (f, label) => onProgress({ phase: 'segment', fraction: f * PROGRESS_SEGMENT_END, label })
        : undefined,
    )
    q = { palette: seg.palette, labels: seg.labels, counts: seg.counts }
    preMergeLabels = seg.preMergeLabels
    regionSamples = seg.regionSamples
  }
  stage('segment')

  // Surface the pre-merge region map for the editor's hover-highlight.
  onPreMerge?.({ labels: preMergeLabels, width, height })

  const gradientsOn = options.gradients !== false

  // Stage 2 — paint-model ladder per region: pick the cheapest of solid /
  // linear-multistop / radial under an MDL score, fitted on the region's smooth
  // (anti-alias-free) samples. A 2-D glow field (model 'glow') becomes a base
  // linear gradient plus radial overlays.
  let labelPaint: (PaintLadderResult | null)[] = q.palette.map(() => null)
  let fullSamples: RegionSamples[] | null = null
  if (gradientsOn) {
    // The glow stack is gated on the full region (anti-aliased pixels included):
    // the smooth subset omits exactly the pixels where a glow helps most and would
    // under-report its benefit (see fitGlowStack).
    fullSamples = fullRegionSamples(q.labels, imageData.data, width, q.palette.length)
    // Regions pinned by a flat marker skip fitPaintLadder and keep their flat colour.
    const flatLabels = flatMarkerLabels(options, q.labels, width, height)
    labelPaint = regionSamples.map((s, label) =>
      flatLabels.has(label) ? null : fitPaintLadder(s, undefined, fullSamples![label]),
    )
  }
  stage('paint')
  onProgress?.({
    phase: 'paint',
    fraction: PROGRESS_SEGMENT_END,
    label: gradientsOn ? 'Fitting colours' : 'Preparing shapes',
  })

  /** Copy a region's fitted paint (solid / gradient / glow base+overlays) onto a layer. */
  const applyPaint = (
    layer: { gradient?: GradientFill; overlays?: RadialGradient[] },
    paint: PaintLadderResult | null,
  ): void => {
    if (!paint) return
    if (paint.model === 'glow' && paint.glow) {
      layer.gradient = paint.glow.base
      layer.overlays = paint.glow.overlays
    } else if (paint.gradient) {
      layer.gradient = paint.gradient
    }
  }

  // --- Planar trace -----------------------------------------------------------
  // Trace the label map as a shared-edge planar graph: every boundary is one
  // fitted curve referenced (forward/reversed) by both adjacent regions, so regions
  // tile with no overlap or seam and shared boundaries are jointly editable. The doc
  // carries the edge graph as `topology`; each region's `subPaths` is derived from it.
  onProgress?.({ phase: 'trace', fraction: PROGRESS_PAINT_END, label: 'Tracing shapes' })
  // Background is detected first (from the original labels) so it can be excluded
  // as a remove-marker fill source and dropped from the paint order below.
  const bg = options.removeBackground ? detectBorderBackground(q.labels, width, height, q.palette.length) : -1
  const removed = applyRemoveMarkers(options, q.labels, width, height, bg)
  // Heal mis-grouped pixels (see healColorSpikes). Skipped for gradient art, and for
  // a locked palette, where every pixel is by construction its nearest locked colour.
  const healed =
    gradientsOn || usedLockedPalette ? removed : healColorSpikes(removed, imageData.data, width, height, q.palette)
  // Experimental background layer separation (backgroundGradient, gradients off):
  // the border-seeded set of bands that one gradient explains is relabeled into a
  // single region painted with that gradient, so band boundaries and the junctions
  // they would cut into a foreground outline never reach the tracer.
  //
  // With removeBackground also on, the whole united set is removed rather than the
  // single border-majority band; the labels to drop are computed on the final map
  // (`dropped`, below).
  let bgUnion: BackgroundUnion | null = null
  if (!gradientsOn && options.backgroundGradient) {
    const bgSeed = detectBorderBackground(healed, width, height, q.palette.length)
    if (bgSeed >= 0) {
      // Remove markers relabel pixels but the raster keeps the dissolved object's
      // colours; exclude those pixels so they don't tint the union's gradient fit.
      const dissolved = removed === q.labels ? undefined : changedMask(q.labels, removed)
      const unionSamples = fullRegionSamples(healed, imageData.data, width, q.palette.length, 6000, dissolved)
      // Flat-marked regions are pinned out of the union, even where the gradient
      // could explain them. Computed on `healed` so the label ids line up.
      const pinned = flatMarkerLabels(options, healed, width, height)
      bgUnion = uniteBackgroundGradient(healed, width, height, bgSeed, unionSamples, q.palette, pinned)
    }
  }
  const labels = bgUnion ? bgUnion.labels : healed
  onPlanarLabels?.({ labels, width, height })
  // The palette lets the fit rank boundary contrast (a weak posterization seam vs a
  // strong edge). The source raster enables sub-pixel edge placement: chains are
  // moved from the integer crack lattice onto the anti-aliasing's iso-0.5 crossing
  // before fitting (planarSubpixel.ts), falling back to the lattice wherever the
  // local two-colour model does not hold.
  const trace = tracePlanar(labels, width, height, fitOpts, q.palette, imageData)
  stage('trace') // includes the flat-art prep above (bg detect / remove-heal / heal-spikes)
  const { topology, edges } = finishPlanar(trace)
  stage('beautify')
  let order = [...trace.loopsByLabel.keys()].filter((l) => l >= 0).sort((a, b) => a - b)
  // Background removal drops the pre-union `bg` and, when the union ran, every label
  // it absorbed (only its `seed` survives in the map). Covering both keeps the drop
  // correct whether or not the union's seed agrees with `bg`.
  if (options.removeBackground) {
    const dropped = new Set<number>(bg !== -1 ? [bg] : [])
    if (bgUnion) for (const l of bgUnion.set) dropped.add(l)
    order = order.filter((l) => !dropped.has(l))
  }
  const items: PathItem[] = []
  let traced = 0
  let lastTracePct = -1
  for (const label of order) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const pct = Math.floor((++traced / order.length) * 100)
    if (pct > lastTracePct) {
      lastTracePct = pct
      onProgress?.({
        phase: 'trace',
        fraction: PROGRESS_PAINT_END + (1 - PROGRESS_PAINT_END) * (traced / order.length),
        label: 'Tracing shapes',
      })
    }
    const loops = trace.loopsByLabel.get(label)!
    const subPaths = materializeRegion(loops, edges)
    if (subPaths.length === 0) continue
    const c = q.palette[label]
    const paint: { gradient?: GradientFill; overlays?: RadialGradient[] } = {}
    applyPaint(paint, labelPaint[label])
    const base: PathItem = {
      kind: 'path',
      id: 'trace-' + label,
      fill: rgbToHex(c.r, c.g, c.b),
      fillRule,
      loops,
      subPaths,
      visible: true,
    }
    if (paint.gradient) base.gradient = paint.gradient
    // The united background renders as one region carrying the union's gradient
    // (its palette hex stays as the fallback fill/swatch).
    if (bgUnion && label === bgUnion.seed) base.gradient = bgUnion.gradient
    // The flat palette path may give a region an alpha (its alpha mode, or a locked
    // RGBA swatch). Planar regions tile without overlap, so a single fill-opacity
    // composites correctly.
    if (c.a !== undefined && c.a < 255) base.fillOpacity = c.a / 255
    items.push(base)
    if (paint.overlays) {
      paint.overlays.forEach((ov, k) => {
        items.push({
          kind: 'path',
          id: `trace-${label}-glow-${k}`,
          fill: rgbToHex(c.r, c.g, c.b),
          fillRule,
          subPaths: cloneSubPaths(subPaths),
          gradient: ov,
          visible: true,
        })
      })
    }
  }
  stage('materialize')
  return { viewBox: [0, 0, width, height], items, topology }
}

/** 1 wherever `after` gives a pixel a different label than `before` — the pixels a
 *  remove marker reassigned, whose raster colour still belongs to the deleted object. */
function changedMask(before: Int32Array, after: Int32Array): Uint8Array {
  const m = new Uint8Array(before.length)
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) m[i] = 1
  return m
}

/**
 * Per-region full sample sets (every labelled pixel, anti-aliasing included),
 * strided down to a cap — the gate set for the glow stack. Distinct from the
 * segmenter's smooth `regionSamples`, which the paint model is fitted on.
 *
 * `skip` (optional, 1 per pixel) drops pixels whose raster colour does not belong to
 * the label they now carry; omitted ⇒ every labelled pixel is sampled.
 */
function fullRegionSamples(
  labels: Int32Array,
  data: Uint8ClampedArray,
  width: number,
  paletteSize: number,
  cap = 6000,
  skip?: Uint8Array,
): RegionSamples[] {
  const xs: number[][] = Array.from({ length: paletteSize }, () => [])
  const ys: number[][] = Array.from({ length: paletteSize }, () => [])
  const rs: number[][] = Array.from({ length: paletteSize }, () => [])
  const gs: number[][] = Array.from({ length: paletteSize }, () => [])
  const bs: number[][] = Array.from({ length: paletteSize }, () => [])
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    if (l < 0 || l >= paletteSize) continue
    if (skip !== undefined && skip[i] !== 0) continue
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
 * Map the Despeckle dial onto the segmenter's minimum region area (opaque px²):
 * the small-region merge that absorbs anti-aliasing and colour-ramp transition
 * slivers into their nearest-colour neighbour. 0 at despeckle 0, growing
 * quadratically so the dial's low end stays gentle. The merge only recolours a
 * sliver to its closest neighbour, so it can afford to grow faster than mono's
 * component-area floor.
 */
function minRegionAreaFor(despeckle: number): number {
  const d = clamp(despeckle, 0, 100) / 100
  return Math.round(d * d * 800)
}

/**
 * Map the user-facing VectorizeOptions onto the smoothness segmenter's tunables.
 * With default dials and no markers this returns DEFAULT_SEGMENT_OPTIONS itself.
 */
export function segmentOptionsFor(options: VectorizeOptions): SegmentOptions {
  // Region detail: 0 ⇒ the balanced default; higher tightens the colour-difference
  // (τ_s) and union-fit (mergeTol) merges so finer regions — e.g. translucent
  // overlaps — survive instead of fusing into a neighbour. Opt-in, because low τ_s
  // also risks fragmenting smooth gradients.
  const d = clamp(options.regionDetail ?? 0, 0, 100) / 100
  // Markers (normalized [0,1]) are the surgical alternative to regionDetail: they
  // protect only the marked spots from merging, leaving gradients elsewhere intact.
  // The UI list is tagged (`flat?`) and split into the segmenter's two seed lists;
  // flat ones additionally pin their region to its pre-merge flat form.
  const allMarkers = options.markers ?? []
  const keepMarkers = allMarkers.filter((m) => !m.flat).map((m) => ({ x: m.x, y: m.y }))
  const flatMarkerList = allMarkers.filter((m) => m.flat).map((m) => ({ x: m.x, y: m.y }))
  const markers = keepMarkers.length > 0 ? keepMarkers : undefined
  const flatMarkers = flatMarkerList.length > 0 ? flatMarkerList : undefined
  // Gradients off disables the gradient-explained union-fit merge, so smooth ramps
  // posterize into flat bands rather than fusing into one region painted with a
  // muddy mean colour.
  const mergeGradients = options.gradients !== false
  // Despeckle → minimum region area (segment.ts mergeSmallRegions); 0 ⇒ no merge.
  const minRegionArea = minRegionAreaFor(options.despeckle ?? 0)
  const needsOverride = d !== 0 || !mergeGradients || minRegionArea !== DEFAULT_SEGMENT_OPTIONS.minRegionArea
  // The unwitnessed-jump merge veto (segment.ts) applies to automatic segmentation
  // only. With Region detail raised or keep-separate markers, the legacy merge is
  // kept: the marker split relies on an overlap first fusing into its shape's class
  // so it can carve it out. Flat markers keep the veto, since they exist to fix the
  // spurious regions it prevents.
  const userSteered = d !== 0 || markers !== undefined
  const base: SegmentOptions = needsOverride
    ? {
        ...DEFAULT_SEGMENT_OPTIONS,
        tauS: DEFAULT_SEGMENT_OPTIONS.tauS - d * 7.5, // 10 → 2.5
        mergeTol: DEFAULT_SEGMENT_OPTIONS.mergeTol - d * 0.048, // 0.06 → 0.012
        mergeGradients,
        minRegionArea,
      }
    : DEFAULT_SEGMENT_OPTIONS
  const withVetoScope = userSteered ? { ...base, maxUnwitnessedJump: 1 } : base
  const withMarkers =
    !markers && !flatMarkers
      ? withVetoScope
      : { ...withVetoScope, ...(markers ? { markers } : {}), ...(flatMarkers ? { flatMarkers } : {}) }
  // Advanced override for experiments and diagnostics (same idiom as planarFit).
  return options.segment ? { ...withMarkers, ...options.segment } : withMarkers
}

/**
 * Map the user dials onto the palette-first flat segmenter (paletteSegment.ts).
 * Region detail keeps more colours (more clusters + a lower drop threshold, so
 * subtler flats survive); despeckle sheds more (a higher drop threshold). The
 * default (detail 0) keeps only the dominant flats.
 */
function paletteOptionsFor(options: VectorizeOptions): PaletteSegmentOptions {
  const detail = clamp(options.regionDetail ?? 0, 0, 100) / 100
  const despeckle = clamp(options.despeckle ?? 0, 0, 100) / 100
  return {
    maxColors: Math.round(16 + detail * 24), // 16 → 40
    minShare: Math.max(0.0006, 0.006 - detail * 0.0052 + despeckle * 0.004),
    modePasses: 2,
    // Reuse the despeckle→area curve, with a small floor so source noise never
    // litters the trace with single-pixel loops even at despeckle 0.
    minRegionArea: Math.max(24, minRegionAreaFor(options.despeckle ?? 0)),
    // Spare sub-floor regions with flat-interior evidence in the source.
    regionEvidence: true,
    // Advanced override for experiments (same idiom as planarFit).
    ...(options.paletteSegment ?? {}),
  }
}

/**
 * Detect a solid background layer: the most frequent label along the 1px
 * border ring, but only when opaque pixels cover at least half the ring.
 * An image already floating on transparency returns -1 (nothing to remove).
 */
function detectBorderBackground(labels: Int32Array, width: number, height: number, paletteSize: number): number {
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
