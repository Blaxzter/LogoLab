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
import { segmentFlatPalette, type PaletteSegmentOptions } from './paletteSegment.ts'
import { fitPaintLadder, type PaintLadderResult, type RegionSamples } from './gradient.ts'
import { beautify, DEFAULT_BEAUTIFY_OPTIONS, type BeautifyOptions } from './beautify.ts'
import { decomposeTranslucent, type Decomposition } from './layers.ts'
import { uniteBackgroundGradient, type BackgroundUnion } from './backgroundLayer.ts'
import { rasterizeDoc } from '../render/raster.ts'
import { srgbToLab, deltaE76 } from './lab.ts'
import { tracePlanar } from './planarAssemble.ts'
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

// Progress-bar span split (overall [0,1]): segmentation is the bulk and the long
// pole (the Step-3c merge), so it owns most of the bar; paint + trace are quick.
const PROGRESS_SEGMENT_END = 0.8
const PROGRESS_PAINT_END = 0.88

/** Palette-first is KEPT over the smoothness segmenter only for genuinely simple
 *  flat art: high flat-coverage (not continuous-tone) AND few dominant colours.
 *  A rich flat illustration (many colours / fine detail — coverage can still be ~1)
 *  is better served by MS, which captures its structure without exploding the node
 *  count or over-posterizing. Schild ≈ 7 colours; the Headphones illustration ≥ 16. */
const FLAT_PALETTE_MIN_COVERAGE = 0.7
const FLAT_PALETTE_MAX_COLORS = 14

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

/**
 * Final labels pinned FLAT by a flat marker — painted one solid colour. Each flat
 * marker's normalized point maps to a pixel → its final label. (Segmentation already
 * excludes a flat-marked section from the field merge via `flatMarkers`, so the label
 * is the marked section's own region; forcing solid paint here guarantees it stays
 * flat, not a subtle gradient.) Empty ⇒ no change.
 */
function flatMarkerLabels(
  options: VectorizeOptions,
  labels: Int32Array,
  width: number,
  height: number,
): Set<number> {
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
 * "Remove & heal" markers (planar engine). For each marker tagged `remove`, dissolve
 * the 4-connected region under it and let its bordering colours grow into the freed
 * area: every removed pixel is reassigned to the NEAREST bordering opaque region by a
 * multi-source grassfire (a discrete medial-axis split between the neighbours), so the
 * gap closes instead of leaving a hole. Transparent (-1) and the detected background
 * `bg` are excluded as fill sources, so the area goes to real colours; a section that
 * borders ONLY those dissolves to transparent (a plain delete). Returns a relabeled
 * COPY, or the input unchanged when there are no remove markers (byte-identical).
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
    // floor, NOT round: the seed must be the pixel that CONTAINS the click point.
    // round() snaps to the nearest grid line — an up-to-1px bias toward the next
    // region, which for a 1–2px unmerged sliver means flooding the big neighbour
    // instead of the sliver the user clicked.
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
 * Heal mislabeled boundary pixels in FLAT-art segmentation. A pixel grouped into
 * region L but whose OWN colour clearly matches an ADJACENT region B (within a tight
 * RGB tolerance, and closer to B than to L) was mis-grouped — typically at a soft
 * multi-colour junction, where the segmenter lets one region (often the dark
 * background) wedge a thin spike into a continuous two-colour stroke (the schild
 * shield's amber↔teal tip). Reassigning those pixels to the region their colour
 * actually belongs to closes the wedge.
 *
 * Deliberately conservative: only a pixel that is UNAMBIGUOUSLY another region's
 * colour moves. An anti-aliased edge pixel sits BETWEEN two colours — close to
 * neither within the tolerance — so it is left alone and true edges don't shift; a
 * genuinely background-coloured gap pixel stays background (its colour matches its
 * own region). Target regions are the 4-connected neighbours ONLY: reassigning a
 * pixel to a region it touches just diagonally joins them at a corner point, and
 * that checkerboard pinch becomes a junction in the planar network — it split
 * sharp-star's outline into OPEN edges, which get no corner snap, so every tip
 * traced as a beveled cap (§10.2). The colour evidence comes from the PALETTE, not
 * the neighbour pixel, so 8-connectivity added nothing except those pinches; a
 * genuinely mislabeled wedge still heals inward edge-by-edge across passes.
 * Iterates so a 2–3px spike is peeled inward, pass-synchronous for determinism;
 * returns the INPUT unchanged when nothing is mislabeled (byte-identical). Pure.
 *
 * The caller gates this to flat art (gradients off): a gradient region's pixels
 * stray from the region mean by design, so the colour-match test must not run there.
 */
export function healColorSpikes(
  labels: Int32Array,
  data: Uint8ClampedArray,
  width: number,
  height: number,
  palette: { r: number; g: number; b: number }[],
): Int32Array {
  const TIGHT = 30 // RGB distance below which a pixel IS that region's flat colour
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
        const nb = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]
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

/** Map the user fidelity dial onto the beautify pass (plan §3.3 / V3). */
function beautifyOptionsFor(options: VectorizeOptions): BeautifyOptions {
  return {
    ...DEFAULT_BEAUTIFY_OPTIONS,
    fidelity: Math.max(0, options.fidelity ?? DEFAULT_BEAUTIFY_OPTIONS.fidelity),
  }
}

const rgbToHex = (r: number, g: number, b: number): string =>
  '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)

/** Map the user dials onto the planar tracer's edge-fit tunables. More smoothing
 *  ⇒ more staircase pre-smoothing passes; ε stays at the crisp tracer's 1.0 px. */
function planarFitOptionsFor(options: VectorizeOptions): PlanarFitOptions {
  const s = clamp(options.smoothing, 0, 100) / 100
  // smoothing=0 now means ZERO pre-smoothing (was clamped to 1, so a fully crisp
  // staircase trace was unreachable). Note: the crispness-study showed 0 passes
  // does NOT improve fidelity on flat logos (slightly more faceting) — this just
  // makes the floor reachable; the 50 default stays best for most art.
  // Flat (gradients-off) art prefers cubics over chords to de-facet curves; gradient
  // art keeps the conservative lineCost (the bump worsened the headphones-grad seam).
  // `options.planarFit` (advanced) overrides any tunable for A/B experiments.
  return {
    ...DEFAULT_PLANAR_FIT,
    lineCost: options.gradients === false ? FLAT_LINE_COST : DEFAULT_PLANAR_FIT.lineCost,
    smoothPasses: s === 0 ? 0 : Math.max(1, Math.round(s * 4)),
    ...(options.planarFit ?? {}),
  }
}

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
  /** Optional sink for the PRE-merge region map (the fine regions before the
   *  gradient field-merge) — used by the editor's region hover-highlight. Called
   *  once per color trace; never in mono mode. */
  onPreMerge?: (pm: { labels: Int32Array; width: number; height: number }) => void,
  /** Optional per-stage timing sink (the Profiler lab). Reports the ms spent in each
   *  major pipeline stage — segment / paint / trace / beautify / materialize. A pure
   *  side channel: it never touches the returned geometry, so output stays byte-
   *  identical, and when omitted NOT EVEN `performance.now()` is called (zero cost). */
  onStage?: (name: string, ms: number) => void,
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
  const smoothing = clamp(options.smoothing, 0, 100)
  const despeckle = clamp(options.despeckle, 0, 100)
  const maskOpts: TraceMaskOptions = {
    turdsize: Math.max(1, Math.round((despeckle / 100) ** 2 * 64)),
    alphamax: 0.2 + (smoothing / 100) * 1.13,
    opttolerance: 0.2 + (smoothing / 100) * 0.6,
  }

  // Tracer backend: 'planar' (shared-edge subdivision; the default for color) /
  // 'crisp' (sub-pixel per-region curves) / 'potrace' (bilevel WASM). The latter
  // two consume the same black-on-white masks; planar has its own geometry path.
  const engine = options.engine ?? 'planar'
  const crispOpts = crispOptionsFor(smoothing, maskOpts.turdsize)
  // Both engines now fill nonzero. The crisp tracer used to fill even-odd, which
  // XORs two near-coincident simplified contours into hairline background slivers
  // (the "cracks"); its loops are now oriented for nonzero (orientForNonzero), so
  // holes still render correctly without the seam mechanism.
  const fillRule: 'nonzero' | 'evenodd' = 'nonzero'
  // Mask tracing (mono mode + the crisp/potrace color path). 'planar' has its own
  // geometry path below and never reaches here for color; for mono it falls back
  // to the crisp mask tracer.
  const traceOne = (mask: ImageData): Promise<SubPath[]> =>
    engine === 'potrace' ? traceMask(mask, maskOpts) : Promise.resolve(traceMaskCrisp(mask, crispOpts))

  // Stage 3 beautify (plan §3.3): a pure post-pass that snaps traced contours to
  // perfect circles/ellipses/lines and reconciles concentric/equal shapes, gated
  // by the user fidelity tolerance. Runs for BOTH engines, on the traced subpaths
  // before items are assembled. fidelity ≤ 0 makes it a no-op (raw trace).
  const beautifyOpts = beautifyOptionsFor(options)

  if (options.mode === 'mono') {
    const traced = await traceOne(thresholdToMask(imageData, options.threshold))
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError') // parity with the colour path's checkpoints
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

  // Stage 1 — segmentation. Two paths:
  //  • FLAT art (gradients off) → PALETTE-FIRST (paletteSegment.ts): pick the
  //    dominant colours, assign every pixel (AA included) to the nearest one. No
  //    blend region can form, so anti-alias transitions are a single clean edge
  //    between two flats (the olive/brown sliver fix). Opt out with flatPalette:false.
  //  • everything else → Mumford–Shah smoothness segmentation (segment.ts): groups
  //    by smooth field, reunites a split background, fits gradients downstream.
  const wantFlatPalette = options.gradients === false && options.flatPalette !== false
  mark() // exclude the mask-option setup above from the segment stage
  let q: QuantizeResult
  let preMergeLabels: Int32Array
  let regionSamples: RegionSamples[] = []
  // Try palette-first for flat art, but only KEEP it if the image is actually flat
  // (high flatCoverage). A continuous-tone image (a photo traced with gradients off)
  // would over-posterize, so it falls through to the smoothness segmenter below.
  let fp: ReturnType<typeof segmentFlatPalette> | null = null
  let usedLockedPalette = false
  if (wantFlatPalette) {
    onProgress?.({ phase: 'segment', fraction: 0, label: 'Reading colours' })
    // A user-LOCKED palette overrides automatic extraction: the segmenter snaps
    // every pixel to the nearest of these colours (emitted verbatim).
    const locked = options.palette && options.palette.length > 0 ? options.palette : undefined
    fp = segmentFlatPalette(
      imageData as unknown as { width: number; height: number; data: Uint8ClampedArray },
      paletteOptionsFor(options),
      locked,
    )
    // Photo-like (low coverage) OR rich flat art (many colours) ⇒ use MS instead —
    // but a locked palette bypasses both gates (the user owns the colours + count).
    // Richness is fp.dominantColors, NOT fp.palette.length: blend dissolution can
    // shrink a photo's palette under the ceiling (continuous tone is full of
    // colours that sit on lines between other colours), and the gate must count
    // what the image contains, not what the cleanup kept.
    if (!locked && (fp.flatCoverage < FLAT_PALETTE_MIN_COVERAGE || fp.dominantColors > FLAT_PALETTE_MAX_COLORS)) fp = null
    usedLockedPalette = fp != null && locked != null
  }
  if (fp) {
    q = { palette: fp.palette, labels: fp.labels, counts: fp.counts }
    preMergeLabels = fp.labels
  } else {
    const seg = segmentImage(
      imageData as unknown as { width: number; height: number; data: Uint8ClampedArray },
      segmentOptionsFor(options),
      onProgress ? (f, label) => onProgress({ phase: 'segment', fraction: f * PROGRESS_SEGMENT_END, label }) : undefined,
    )
    q = { palette: seg.palette, labels: seg.labels, counts: seg.counts }
    preMergeLabels = seg.preMergeLabels
    regionSamples = seg.regionSamples
  }
  stage('segment')

  // Surface the pre-merge region map (fine regions before the field-merge) for the
  // editor's hover-highlight. Independent of engine; skipped in mono (no markers).
  onPreMerge?.({ labels: preMergeLabels, width, height })

  const gradientsOn = options.gradients !== false

  // Stage 2 — paint-model ladder per macro-region: pick the cheapest of
  // solid / linear-multistop / radial under an MDL score, fitting on the region's
  // smooth (anti-alias-free) samples. A flat region stays solid (flat-logo
  // parity); a smooth field becomes one coherent gradient; a 2-D glow field
  // (model 'glow') becomes a base linear + radial overlays (Stage 2.4, §3.2.4).
  let labelPaint: (PaintLadderResult | null)[] = q.palette.map(() => null)
  let fullSamples: RegionSamples[] | null = null
  if (gradientsOn) {
    // The paint model is fit on the segmenter's SMOOTH (AA-free) samples, but the
    // glow stack is GATED on the FULL region (every labelled pixel, AA included):
    // the smooth subset omits the high-error anti-aliased pixels where a glow
    // helps most and so under-reports its benefit (see fitGlowStack).
    fullSamples = fullRegionSamples(q.labels, imageData.data, width, q.palette.length)
    // Regions pinned by a FLAT marker are painted SOLID — fitPaintLadder is
    // skipped so they keep their representative flat colour, not a fitted gradient
    // (the user's "this region should be flat"). Segmentation already excluded them
    // from the field merge (`flatMarkers`), so they're their own distinct regions.
    const flatLabels = flatMarkerLabels(options, q.labels, width, height)
    labelPaint = regionSamples.map((s, label) =>
      flatLabels.has(label) ? null : fitPaintLadder(s, undefined, fullSamples![label]),
    )
  }
  stage('paint')
  onProgress?.({ phase: 'paint', fraction: PROGRESS_SEGMENT_END, label: gradientsOn ? 'Fitting colours' : 'Preparing shapes' })

  // V6 — translucent layer decomposition (plan §9). Only ATTEMPTED when the user
  // has opted into recovering overlaps (markers or Region detail) and gradients
  // are on; with neither, the default corpus output is byte-identical (the attempt
  // is skipped, so nothing downstream can change). When attempted it still no-ops
  // unless the segmentation actually has overlap-shaped regions AND the translucent
  // model beats the opaque one (decomposeTranslucent returns null otherwise). Uses
  // the FULL-region samples as its gate set — the glow-stack methodology.
  let decomposition: Decomposition | null = null
  const wantsDecomp =
    engine !== 'planar' &&
    gradientsOn &&
    options.layeredDecomposition !== false &&
    !options.removeBackground &&
    ((options.markers?.length ?? 0) > 0 || (options.regionDetail ?? 0) > 0)
  if (wantsDecomp && fullSamples) {
    decomposition = decomposeTranslucent(q.labels, width, height, q.palette, q.counts, fullSamples)
  }

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
    /** Translucent fill opacity (V6 decomposition shapes); omitted ⇒ opaque. */
    fillOpacity?: number
  }
  /** Copy a region's fitted paint (solid / gradient / glow base+overlays) onto a layer. */
  const applyPaint = (layer: { gradient?: GradientFill; overlays?: RadialGradient[] }, paint: PaintLadderResult | null): void => {
    if (!paint) return
    if (paint.model === 'glow' && paint.glow) {
      layer.gradient = paint.glow.base
      layer.overlays = paint.glow.overlays
    } else if (paint.gradient) {
      layer.gradient = paint.gradient
    }
  }

  // --- Planar subdivision path (default for color) -------------------------
  // Trace the label map as a shared-edge planar graph: every boundary is ONE
  // fitted curve referenced (forward/reversed) by both adjacent regions, so the
  // regions tile with no overlap and no hairline seam, and shared boundaries are
  // jointly editable (the doc carries the edge graph as `topology`; each region's
  // `subPaths` is the derived render/hit cache). No loop-beautify (it moves loops
  // independently and would desync shared edges); per-region paint is reused.
  if (engine === 'planar') {
    onProgress?.({ phase: 'trace', fraction: PROGRESS_PAINT_END, label: 'Tracing shapes' })
    // "Remove & heal" markers dissolve a marked section and grow its neighbours into
    // the gap. Background is detected first (from the ORIGINAL labels) so it can be
    // both excluded as a fill source and dropped from the paint order below.
    const bg = options.removeBackground ? detectBorderBackground(q.labels, width, height, q.palette.length) : -1
    const removed = applyRemoveMarkers(options, q.labels, width, height, bg)
    // Flat-art only: heal pixels grouped into the wrong region at a soft multi-colour
    // junction — e.g. a dark-background wedge poking into a continuous two-colour
    // stroke (the schild shield tip). Skipped when gradients are on (a gradient
    // region's pixels legitimately stray from the region mean, so the colour test
    // doesn't apply) AND when the user LOCKED a palette: there is no mis-grouping to
    // heal — every pixel is already its nearest locked colour by construction, so the
    // contract is exactly "snap to nearest given colour", nothing more. No mislabeled
    // pixels ⇒ returns the input ⇒ byte-identical.
    const healed =
      gradientsOn || usedLockedPalette
        ? removed
        : healColorSpikes(removed, imageData.data, width, height, q.palette)
    // EXPERIMENTAL background layer separation (backgroundGradient, gradients OFF):
    // the border-seeded band-set that ONE gradient explains is relabeled into a
    // single region painted with that fitted gradient — the background becomes one
    // uninterrupted layer, so band↔band boundaries and the band junctions that
    // split a foreground outline (the ring "pull") never reach the tracer.
    // Null / flag off ⇒ byte-identical passthrough.
    //
    // COMPOSES with removeBackground: the union is the better background DETECTOR (a
    // posterized ramp is one background, not N bands), so with both flags on we delete
    // the whole united set rather than the single border-majority band. The label to
    // drop is therefore computed on the FINAL map (`dropped`, below) — not from `bg`,
    // which was detected on `q.labels` before the union relabeled its members to a seed
    // re-detected on `healed`.
    let bgUnion: BackgroundUnion | null = null
    if (!gradientsOn && options.backgroundGradient) {
      const bgSeed = detectBorderBackground(healed, width, height, q.palette.length)
      if (bgSeed >= 0) {
        // Remove-markers relabel pixels but the raster keeps the DISSOLVED object's
        // colours, so sampling them feeds a ghost tint into the union's gradient fit and
        // its render gate. Exclude exactly the pixels the markers moved. No remove
        // markers ⇒ `removed` IS `q.labels` ⇒ no mask ⇒ byte-identical.
        const dissolved = removed === q.labels ? undefined : changedMask(q.labels, removed)
        const unionSamples = fullRegionSamples(healed, imageData.data, width, q.palette.length, 6000, dissolved)
        // A FLAT marker ("keep this region flat") pins its label out of the union, so
        // an explicitly-flat region is never absorbed into the background gradient —
        // even where the gradient could explain it. Computed on `healed` (the map the
        // union runs on) so the label ids line up. No flat markers ⇒ empty ⇒ no-op.
        const pinned = flatMarkerLabels(options, healed, width, height)
        bgUnion = uniteBackgroundGradient(healed, width, height, bgSeed, unionSamples, q.palette, pinned)
      }
    }
    const labels = bgUnion ? bgUnion.labels : healed
    const fitOpts = planarFitOptionsFor(options)
    // The palette rides along for the §14 contrast rank only: it lets the fit tell a
    // posterization band seam (weak) from a real logo edge (strong) so the weak one
    // stops aiming the strong one. Geometry-only when omitted.
    const trace = tracePlanar(labels, width, height, fitOpts, q.palette)
    stage('trace') // includes the flat-art prep above (bg detect / remove-heal / heal-spikes)
    // Phase 6 — edge-level beautify: snap shared edges to circles/ellipses/lines
    // ONCE (both adjacent regions inherit it; no desync). fidelity ≤ 0 is a
    // no-op, so the unbeautified planar output is byte-identical. The co-circular
    // arc snap (§1d) can be turned off via planarFit.arcSnap (Test view baseline).
    let reseated: ReadonlySet<number> = new Set<number>()
    const topology = planarBeautify({ vertices: trace.vertices, edges: trace.edges }, trace.loopsByLabel, beautifyOpts, {
      arcSnap: fitOpts.arcSnap,
      localScaleK: fitOpts.localScaleK,
      cornerVeto: fitOpts.cornerVeto,
      reseat: fitOpts.junctionReseat,
      width,
      height,
      onReseat: (m) => { reseated = m },
    })
    // §10.4 second half — fuse junction pairs the re-seat converged (a rasterized
    // degree-4 crossing = two degree-3 junctions + a micro-edge; once re-seated
    // onto the true crossing they are ONE authored point). Runs here, not inside
    // planarBeautify: contracting the micro-edge rewrites the region loops, and
    // beautify treats `loopsByLabel` as read-only. Both structures are owned by
    // this trace pass, and everything below reads them AFTER this line.
    weldConvergedJunctions(topology.vertices, topology.edges, trace.loopsByLabel, width, height, reseated)
    const edges = edgeMap(topology)
    stage('beautify')
    let order = [...trace.loopsByLabel.keys()].filter((l) => l >= 0).sort((a, b) => a - b)
    // Background removal drops the pre-union `bg` (byte-identical to before when no union
    // ran) AND, when the union ran, every label it swallowed — of which only `seed` still
    // exists in the map. Covering both makes the drop correct whether or not the union's
    // seed (re-detected on `healed`) agrees with `bg` (detected on `q.labels`).
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
        onProgress?.({ phase: 'trace', fraction: PROGRESS_PAINT_END + (1 - PROGRESS_PAINT_END) * (traced / order.length), label: 'Tracing shapes' })
      }
      const loops = trace.loopsByLabel.get(label)!
      const subPaths = materializeRegion(loops, edges)
      if (subPaths.length === 0) continue
      const c = q.palette[label]
      const paint: { gradient?: GradientFill; overlays?: RadialGradient[] } = {}
      applyPaint(paint, labelPaint[label])
      const base: PathItem = { kind: 'path', id: 'trace-' + label, fill: rgbToHex(c.r, c.g, c.b), fillRule, loops, subPaths, visible: true }
      if (paint.gradient) base.gradient = paint.gradient
      // Background layer separation: the united band-set renders as ONE region
      // carrying the gradient fitted over the union (its palette hex stays as the
      // fallback fill/swatch).
      if (bgUnion && label === bgUnion.seed) base.gradient = bgUnion.gradient
      // Flat palette path may tag a region with an alpha (its alpha mode, or a locked
      // RGBA swatch) — paint it translucent. Planar regions tile without overlap, so a
      // single fill-opacity composites correctly against the background. Opaque (a≥255
      // / undefined) ⇒ no fill-opacity ⇒ byte-identical to before.
      if (c.a !== undefined && c.a < 255) base.fillOpacity = c.a / 255
      items.push(base)
      if (paint.overlays) {
        paint.overlays.forEach((ov, k) => {
          items.push({ kind: 'path', id: `trace-${label}-glow-${k}`, fill: rgbToHex(c.r, c.g, c.b), fillRule, subPaths: cloneSubPaths(subPaths), gradient: ov, visible: true })
        })
      }
    }
    stage('materialize')
    return { viewBox: [0, 0, width, height], items, topology }
  }

  // Beautify (cross-shape relation solver over ALL loops) + assemble bottom-up.
  // A glow region emits its opaque base then one translucent overlay item per
  // radial glow (sharing the beautified geometry); a V6 translucent shape emits a
  // single fillOpacity item. Pure given `layers`, so both candidate stacks
  // (opaque / translucent) assemble through the same path.
  const assemble = (layers: Layer[]): EditableDoc => {
    const beautified = beautify(
      layers.map((l) => l.subPaths),
      beautifyOpts,
    )
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
      if (layer.fillOpacity !== undefined && layer.fillOpacity < 1) base.fillOpacity = layer.fillOpacity
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

  // Default path: largest region at the bottom; each layer's mask is its own
  // region flooded through CONNECTED higher-rank pixels, so it overlaps only the
  // shapes stacked directly against it (the overlap that seals anti-alias seams)
  // without re-tracing spatially-disjoint shapes as hidden islands.
  const buildOpaqueLayers = async (): Promise<Layer[]> => {
    const layers: Layer[] = []
    let paintOrder = q.palette.map((_, i) => i)
    if (options.removeBackground) {
      const bg = detectBorderBackground(q.labels, width, height, q.palette.length)
      if (bg !== -1) paintOrder = paintOrder.filter((i) => i !== bg)
    }
    const rank = new Int32Array(q.palette.length).fill(-1)
    paintOrder.forEach((label, i) => {
      rank[label] = i
    })
    const total = paintOrder.length
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      onProgress?.({ phase: 'trace', fraction: PROGRESS_PAINT_END + (1 - PROGRESS_PAINT_END) * ((i + 1) / total), label: `Tracing layer ${i + 1}/${total}` })
      const subPaths = await traceOne(stackedMask(q.labels, width, height, rank, i))
      if (subPaths.length > 0) {
        const label = paintOrder[i]
        const { r, g, b } = q.palette[label]
        const layer: Layer = { id: 'trace-' + i, subPaths, fill: rgbToHex(r, g, b) }
        applyPaint(layer, labelPaint[label])
        layers.push(layer)
      }
      await new Promise((r) => setTimeout(r))
    }
    return layers
  }

  // V6 path: background full-bleed base, any unrelated opaque region above it, then
  // the recovered TRANSLUCENT shapes (each the cleaned UNION mask of its label set)
  // in stacking order — the renderer blends them exactly as the source does.
  const buildDecompLayers = async (dec: Decomposition): Promise<Layer[]> => {
    const layers: Layer[] = []
    const consumed = new Set(dec.consumed)
    const bgLabel = dec.background
    const others: number[] = []
    for (let l = 0; l < q.palette.length; l++) {
      if (l === bgLabel || consumed.has(l) || (q.counts[l] ?? 0) === 0) continue
      others.push(l)
    }
    const shapesSorted = [...dec.shapes].sort((a, b) => a.order - b.order)
    const total = 1 + others.length + shapesSorted.length
    let li = 0
    const pushTraced = async (layer: Omit<Layer, 'subPaths'>, mask: ImageData): Promise<void> => {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      onProgress?.({ phase: 'trace', fraction: PROGRESS_PAINT_END + (1 - PROGRESS_PAINT_END) * ((li + 1) / total), label: `Tracing layer ${li + 1}/${total}` })
      li++
      const subPaths = await traceOne(mask)
      if (subPaths.length > 0) layers.push({ ...layer, subPaths })
      await new Promise((r) => setTimeout(r))
    }
    const bgCol = q.palette[bgLabel]
    const bgLayer: Omit<Layer, 'subPaths'> = { id: 'trace-bg', fill: rgbToHex(bgCol.r, bgCol.g, bgCol.b) }
    applyPaint(bgLayer, labelPaint[bgLabel])
    await pushTraced(bgLayer, maskFromLabels(q.labels, width, height, (l) => l >= 0))
    for (const l of others) {
      const c = q.palette[l]
      const opLayer: Omit<Layer, 'subPaths'> = { id: 'trace-op-' + l, fill: rgbToHex(c.r, c.g, c.b) }
      applyPaint(opLayer, labelPaint[l])
      await pushTraced(opLayer, maskFromLabels(q.labels, width, height, (x) => x === l))
    }
    // The union mask is CLEANED (largest connected component + filled holes) so
    // watershed stray pixels don't fragment the disk or corrupt beautify's circle
    // snap.
    for (const shape of shapesSorted) {
      const set = new Set(shape.labels)
      await pushTraced(
        { id: 'trace-layer-' + shape.order, fill: shape.color, fillOpacity: shape.alpha },
        maskFromLabels(q.labels, width, height, (l) => set.has(l), true),
      )
    }
    return layers
  }

  // When a decomposition is proposed, RENDER both candidate docs and keep the
  // translucent one ONLY if it beats the opaque rendering on mean CIE76 ΔE — the
  // V4 glow-stack discipline, but measured on the REAL render because the analytic
  // per-region residual is anti-correlated with reality here (the opaque bands'
  // damage is in tracing thin overlap lenses, which a per-pixel region-mean model
  // cannot see). Same rasterizer the harness scores with ⇒ the gate measures what
  // ships. Falls back to the byte-identical opaque output when it doesn't win.
  if (decomposition) {
    const transDoc = assemble(await buildDecompLayers(decomposition))
    const opaqueDoc = assemble(await buildOpaqueLayers())
    const transDE = meanRenderDeltaE(transDoc, imageData, width, height)
    const opaqueDE = meanRenderDeltaE(opaqueDoc, imageData, width, height)
    if (transDE <= opaqueDE - DECOMP_WIN_MARGIN) return transDoc
    return opaqueDoc
  }

  return assemble(await buildOpaqueLayers())
}

/** Mean full-image CIE76 ΔE of a doc's render vs the source (the V6 render gate). */
function meanRenderDeltaE(doc: EditableDoc, source: ImageData, width: number, height: number): number {
  const render = rasterizeDoc(doc, width, height)
  const src = source.data
  let sum = 0
  const n = width * height
  for (let i = 0; i < n; i++) {
    const o = i * 4
    sum += deltaE76(srgbToLab(src[o], src[o + 1], src[o + 2]), srgbToLab(render[o], render[o + 1], render[o + 2]))
  }
  return n > 0 ? sum / n : Infinity
}

/** Translucent decomposition must beat opaque by at least this mean CIE76 ΔE. */
const DECOMP_WIN_MARGIN = 0.1

/** 1 wherever `after` moved a pixel to a different label than `before` — i.e. the
 *  pixels a remove-marker dissolve reassigned, whose raster RGB still belongs to the
 *  deleted object and must not be sampled as its new region's colour. */
function changedMask(before: Int32Array, after: Int32Array): Uint8Array {
  const m = new Uint8Array(before.length)
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) m[i] = 1
  return m
}

/**
 * Per-region FULL sample sets (every labelled pixel of each region, AA included),
 * strided down to a cap — the gate set for the glow stack. Distinct from the
 * segmenter's smooth `regionSamples`, which the paint model is FIT on but which
 * omit the anti-aliased pixels a glow most improves.
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
 * Map the user-facing VectorizeOptions onto the structure-first segmenter's
 * tunables. V2 starts every parameter at the blueprint paper's fixed value
 * (τ_s = 10, σ = 5, τ_a = 0.25, MS α = 1.0, and the calibrated edge threshold);
 * the `colors`/`despeckle` dials no longer drive a k-means count — segmentation
 * is structural — so they are intentionally left at the defaults here (the dials
 * still tune the tracer's smoothing/turdsize downstream).
 */
/**
 * Map the Despeckle dial onto the segmenter's minimum-region area (opaque px²) —
 * the engine-agnostic small-region merge that absorbs anti-alias / colour-ramp
 * TRANSITION SLIVERS into their nearest-colour neighbour. 0 at despeckle 0 (so a
 * despeckle-0 trace is byte-identical to before), growing quadratically so the
 * dial's low end stays gentle and the high end aggressively cleans slivers. The
 * merge is render-safe (a sliver is recoloured to its closest neighbour), so this
 * scales faster than the crisp/potrace `turdsize` loop-drop. Absolute px², like
 * turdsize, so it reads the same across engines.
 */
function minRegionAreaFor(despeckle: number): number {
  const d = clamp(despeckle, 0, 100) / 100
  return Math.round(d * d * 800)
}

export function segmentOptionsFor(options: VectorizeOptions): SegmentOptions {
  // Region detail: 0 ⇒ the balanced default (identical output to before); higher
  // tightens the colour-difference (τ_s) and union-fit (mergeTol) merge so finer
  // regions — e.g. translucent overlaps — survive instead of fusing into a
  // neighbour. Measured: the overlaps return only once τ_s drops to ≈2–3, which
  // also risks fragmenting smooth gradients, so this is opt-in, not the default.
  const d = clamp(options.regionDetail ?? 0, 0, 100) / 100
  // User markers (normalized [0,1]) are a surgical alternative to regionDetail:
  // they protect only the marked spots from merging (segment.ts), leaving smooth
  // gradients elsewhere intact. Threaded through whether or not regionDetail is
  // raised. No markers + regionDetail 0 ⇒ the exact default object (byte-identical
  // output to before).
  // The UI marker list is tagged (`flat?`); split it into the segmenter's two
  // seed lists. Both drive the seeded split (keep regions distinct); flat ones
  // additionally pin their region to its pre-merge flat form (+ solid paint).
  const allMarkers = options.markers ?? []
  const keepMarkers = allMarkers.filter((m) => !m.flat).map((m) => ({ x: m.x, y: m.y }))
  const flatMarkerList = allMarkers.filter((m) => m.flat).map((m) => ({ x: m.x, y: m.y }))
  const markers = keepMarkers.length > 0 ? keepMarkers : undefined
  const flatMarkers = flatMarkerList.length > 0 ? flatMarkerList : undefined
  // Gradients OFF disables the gradient-explained union-fit merge (segment.ts Step
  // 3c) so smooth ramps posterize into flat bands rather than fusing into one
  // region that Stage 2 then averages to a muddy mean colour. On (the default) is
  // byte-identical to before.
  const mergeGradients = options.gradients !== false
  // Despeckle → minimum-region area: absorbs anti-alias / colour-ramp slivers into
  // a neighbour (segment.ts mergeSmallRegions). 0 ⇒ no merge (byte-identical).
  const minRegionArea = minRegionAreaFor(options.despeckle ?? 0)
  const needsOverride =
    d !== 0 || !mergeGradients || minRegionArea !== DEFAULT_SEGMENT_OPTIONS.minRegionArea
  // The unwitnessed-jump veto (the step-fit merge fix, segment.ts) applies to the
  // AUTO path only. User-steered segmentation — Region detail raised or
  // keep-separate markers — keeps the legacy merge: the marker-controlled split
  // and the V6 translucent recovery CONSUME the fusion behaviour (an overlap must
  // fuse into its shape's class for the marker split to carve it out, and the
  // α-solve is calibrated on those exact classes; bloom's layers-integration test
  // locks this). FLAT markers keep the veto: they exist to hand-fix fake regions,
  // and disabling it on their account would resurrect the fakes it already fixed.
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
  if (!markers && !flatMarkers) return withVetoScope
  return { ...withVetoScope, ...(markers ? { markers } : {}), ...(flatMarkers ? { flatMarkers } : {}) }
}

/**
 * Map the user dials onto the palette-first flat segmenter (paletteSegment.ts).
 * Region detail keeps MORE colours (more clusters + a lower drop threshold, so
 * subtler flats survive); despeckle sheds more (a higher drop threshold). The
 * default (detail 0) lands on the dominant flats only — the fewest, cleanest
 * colours, which is the point for flat logos.
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
  }
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
 * Build a binary trace mask (black = keep) from a label predicate — used by the
 * V6 decomposition path to trace a translucent shape's UNION mask (all its label
 * set) or a full-bleed background (`l >= 0`), independent of the stacked-rank
 * paint order the opaque path uses. When `clean` is set, the mask is reduced to
 * its largest 4-connected component with internal holes filled — the marker
 * watershed scatters a few boundary pixels into neighbour territory, and those
 * disconnected stray islands would otherwise corrupt the circle/ellipse fit in
 * beautify (measured: they pushed a fitted circle's bbox ~100px off). A
 * translucent shape is one connected blob, so its true geometry is the largest
 * component; cleaning lets beautify snap it to a perfect circle.
 */
function maskFromLabels(
  labels: Int32Array,
  width: number,
  height: number,
  keep: (label: number) => boolean,
  clean = false,
): ImageData {
  const out = new ImageData(width, height)
  const dst = out.data
  const black = new Uint8Array(labels.length)
  for (let i = 0; i < labels.length; i++) black[i] = keep(labels[i]) ? 1 : 0
  const kept = clean ? largestComponentFilled(black, width, height) : black
  for (let i = 0; i < labels.length; i++) {
    const v = kept[i] ? 0 : 255
    const o = i * 4
    dst[o] = v
    dst[o + 1] = v
    dst[o + 2] = v
    dst[o + 3] = 255
  }
  return out
}

/**
 * Largest 4-connected component of a binary mask, with internal holes filled.
 * Drops disconnected stray islands (watershed mislabels) and patches AA gaps
 * inside the blob, so a translucent shape's union mask becomes one clean region.
 */
function largestComponentFilled(black: Uint8Array, width: number, height: number): Uint8Array {
  const n = black.length
  const comp = new Int32Array(n).fill(-1)
  const stack: number[] = []
  let bestId = -1
  let bestSize = 0
  let nextId = 0
  for (let s = 0; s < n; s++) {
    if (!black[s] || comp[s] !== -1) continue
    const id = nextId++
    let size = 0
    stack.length = 0
    stack.push(s)
    comp[s] = id
    while (stack.length) {
      const p = stack.pop()!
      size++
      const x = p % width
      const y = (p / width) | 0
      if (x > 0 && black[p - 1] && comp[p - 1] === -1) { comp[p - 1] = id; stack.push(p - 1) }
      if (x + 1 < width && black[p + 1] && comp[p + 1] === -1) { comp[p + 1] = id; stack.push(p + 1) }
      if (y > 0 && black[p - width] && comp[p - width] === -1) { comp[p - width] = id; stack.push(p - width) }
      if (y + 1 < height && black[p + width] && comp[p + width] === -1) { comp[p + width] = id; stack.push(p + width) }
    }
    if (size > bestSize) { bestSize = size; bestId = id }
  }
  const keep = new Uint8Array(n)
  if (bestId < 0) return keep
  for (let i = 0; i < n; i++) if (comp[i] === bestId) keep[i] = 1
  // Fill holes: flood the OUTSIDE (non-kept reachable from the border), then any
  // non-kept pixel not reached is an interior hole → fill it.
  const outside = new Uint8Array(n)
  stack.length = 0
  const pushOutside = (i: number) => { if (!keep[i] && !outside[i]) { outside[i] = 1; stack.push(i) } }
  for (let x = 0; x < width; x++) { pushOutside(x); pushOutside((height - 1) * width + x) }
  for (let y = 0; y < height; y++) { pushOutside(y * width); pushOutside(y * width + width - 1) }
  while (stack.length) {
    const p = stack.pop()!
    const x = p % width
    const y = (p / width) | 0
    if (x > 0) pushOutside(p - 1)
    if (x + 1 < width) pushOutside(p + 1)
    if (y > 0) pushOutside(p - width)
    if (y + 1 < height) pushOutside(p + width)
  }
  for (let i = 0; i < n; i++) if (!keep[i] && !outside[i]) keep[i] = 1
  return keep
}

/**
 * Build the stacked binary mask for one layer. The seed is this layer's own
 * region (rank === layer); from there we flood through CONNECTED higher-rank
 * pixels (rank > layer), so the mask absorbs only the shapes stacked directly
 * against this region — the overlap that keeps adjacent regions from meeting at
 * a hairline seam. Higher-rank shapes that are spatially DISJOINT from this
 * region (e.g. a document's corner fold floating inside an unrelated rim layer)
 * are left out: the old "every pixel of rank ≥ layer" rule re-traced them as
 * hidden islands in every layer beneath them — invisible in the render (painted
 * over) but real geometry that cluttered the node editor and bloated the export.
 * Dropping them is render-safe: every point under a disjoint island is already
 * fully covered by the lower-rank layers painted before this one.
 */
function stackedMask(
  labels: Int32Array,
  width: number,
  height: number,
  rank: Int32Array,
  layer: number,
): ImageData {
  const n = labels.length
  const keep = new Uint8Array(n)
  const stack: number[] = []
  for (let i = 0; i < n; i++) {
    const l = labels[i]
    if (l >= 0 && rank[l] === layer) {
      keep[i] = 1
      stack.push(i)
    }
  }
  const visit = (q: number): void => {
    const l = labels[q]
    if (!keep[q] && l >= 0 && rank[l] >= layer) {
      keep[q] = 1
      stack.push(q)
    }
  }
  while (stack.length) {
    const p = stack.pop()!
    const x = p % width
    const y = (p / width) | 0
    if (x > 0) visit(p - 1)
    if (x + 1 < width) visit(p + 1)
    if (y > 0) visit(p - width)
    if (y + 1 < height) visit(p + width)
  }
  const out = new ImageData(width, height)
  const dst = out.data
  for (let i = 0; i < n; i++) {
    const v = keep[i] ? 0 : 255
    const o = i * 4
    dst[o] = v
    dst[o + 1] = v
    dst[o + 2] = v
    dst[o + 3] = 255
  }
  return out
}
