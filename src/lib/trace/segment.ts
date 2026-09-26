// Structure-first smoothness segmentation (reference paper §3.1–3.2 and its
// Supplement Algorithms 1–2). Used for gradient art; flat art goes through
// paletteSegment.ts.
//
//   1. Mumford–Shah smoothing: smoothed u + discontinuity map 𝒟 (mumfordShah.ts).
//   2. Colour-difference merge: fine segments S₀ of the smooth pixels (𝒟̄), by
//      agglomerative CIELAB merging with τ_s = 10 (Supplement Alg 1).
//   3. Discontinuity-aware merge into macro-regions: a global greedy union-fit
//      merge (two segments merge iff one gradient explains their union in Oklab),
//      subject to vetoes:
//        - edge veto 𝒜 (eq 3): pairs facing each other across 𝒟 (opposite sides
//          within σ px, facing density > τ_a) must stay separate, so flat colours
//          never bridge a true edge;
//        - profile-gap veto: a union whose colour profile has a wide empty span
//          along the fitted axis is two distinct flats, not one field;
//        - unwitnessed-jump veto (see `maxUnwitnessedJump`).
//      Because the merge is global, it can reunite a background that 𝒟 split
//      (e.g. the field outside a ring and inside its hole) into one gradient
//      region, while the edge veto keeps the ring itself separate.
//   4. Anti-aliased 𝒟 pixels are flooded into the neighbouring macro-region whose
//      mean colour matches best, so the label map is complete.
//   5. Optional small-region merge (`minRegionArea`): regions below the area
//      threshold are absorbed into their nearest-colour neighbour, so AA and ramp
//      transition slivers don't survive as tiny shapes. User-marked regions are
//      protected.
//
// Output is QuantizeResult-shaped (labels / palette / counts, largest region
// first). Deterministic: no PRNG, fixed scan orders.
// Design notes and measurements: docs/vectorization-benchmarks.md.

import type { PaletteColor, QuantizeResult } from './types'
import { solveMumfordShah, DEFAULT_MS_OPTIONS, type MumfordShahOptions, type MumfordShahResult } from './mumfordShah.ts'
import { srgbToLab, deltaE76 } from './lab.ts'
import { srgbToOklab, oklabDeltaE, type Oklab } from './oklab.ts'
import { fitBestGradient, concatSamples, gradientParamT, type RegionSamples } from './gradient.ts'
import type { GradientFill } from '../path/types'

export interface SegmentOptions {
  ms: MumfordShahOptions
  /** CIELAB ΔE below which adjacent smooth segments merge (color-diff, τ_s). */
  tauS: number
  /** Discontinuity facing-scan radius (px), σ. */
  sigma: number
  /** Facing density above which a segment pair is must-stay-separate, τ_a. */
  tauA: number
  /** Min facing observations before a pair can enter 𝒜 (noise floor). */
  minFacing: number
  /** Oklab ΔE under which a single gradient is judged to explain a union. */
  mergeTol: number
  /** Reject a union whose colour profile has an empty axis span wider than this
   *  fraction of [0,1] (bimodal ⇒ two distinct flats, not one smooth field). */
  maxProfileGap: number
  /**
   * Reject a union whose fitted gradient makes an Oklab colour jump larger than
   * this across a sample-free stretch of its parameter t (an "unwitnessed jump").
   *
   * A multi-stop gradient can explain two disjoint flats almost perfectly as a
   * step function (flat, jump, flat), often with a lower residual than an honest
   * ramp merge, so without this veto the greedy merge fuses distinct objects into
   * one region wearing a step "gradient". A step's signature is that its whole
   * contrast sits at a point of t no sample explains: the samples on either side,
   * each extrapolated along its own colour trend in t, do not meet there. A
   * genuine smooth field's two sides do meet, and a genuine reunite overlaps in t.
   * The jump is measured between adjacent samples at sample resolution; binning t
   * would miss a step placed inside one bin.
   *
   * The veto fires only when one of the two groups is itself near-flat (see
   * FLAT_FLANK_RES): pieces of a smooth field may jump across a gap their own
   * trend explains, and blocking those only reorders the merge sequence, which
   * perturbs the strided samples and thus the fitted paint. Values ≥ 1.2 (the
   * Oklab ΔE ceiling) disable it.
   */
  maxUnwitnessedJump: number
  /**
   * Run Step 3c, the global gradient-explained union-fit merge, which fuses the
   * colour-difference bands of a smooth ramp back into one gradient region. With
   * gradients off that region would be flattened to its mean colour, so the merge
   * is skipped and the Step-2 bands posterize into several flat regions.
   * Default true. */
  mergeGradients: boolean
  /** Cap on samples per segment fed to a union fit (perf; deterministic stride). */
  sampleCap: number
  /**
   * Step-3c candidate gate, in Oklab ΔE. Bounds the O(S²) pair fits on complex
   * images. It engages only once the fine-segment count exceeds GATE_MIN_SEGMENTS
   * (small art stays ungated, keeping its non-adjacent reunites). When engaged, a
   * pair reaches the gradient fit only if the groups are adjacent or, when
   * meanGate > 0, their mean colours are within meanGate. The mean clause re-joins
   * non-adjacent same-mean pieces but is much slower on photos and tends to force
   * distant pieces into one stretched gradient, so it defaults off (0 ⇒
   * adjacency only). Only consulted when `mergeGradients` is on.
   */
  meanGate: number
  /**
   * Minimum macro-region area (opaque px). After segmentation, any region smaller
   * than this is absorbed into the adjacent region whose mean colour is closest,
   * so AA and colour-ramp transition slivers don't survive as tiny shapes.
   * 0 ⇒ disabled. Driven by the Despeckle setting.
   */
  minRegionArea: number
  /**
   * Flat region markers in normalized [0,1] coords (distinct from `markers`). Each
   * flat marker's pre-merge fine segment is excluded from the Step-3c gradient
   * merge, so it survives as its own region instead of being fused into a gradient
   * with its neighbours. The exclusion happens before the Step-4 anti-alias flood,
   * so the region's boundary settles on the true colour edge and a single marker
   * suffices. Painted solid downstream (index.ts). Processed in input order.
   */
  flatMarkers?: { x: number; y: number }[]
  /**
   * User-placed region markers in normalized [0,1] image coordinates (converted
   * to pixels against the image's own size, so they hold at any resolution). Each
   * marker seeds a distinct region: two segments carrying different markers never
   * merge (vetoed in both merge steps), and a marked segment is never absorbed.
   * Processed in input order so the veto is deterministic.
   */
  markers?: { x: number; y: number }[]
  /**
   * Diagnostic observer for the Step-3c merge. Called once per pair evaluation that
   * ran (a cache miss in evalPair) with all four terms of the acceptance condition,
   * computed in full even where the condition short-circuits so the caller can see
   * which term decided, and once per accepted merge, in merge order. Read-only: the
   * result is identical with or without an observer. Used by
   * `bench/stepRampDiag.ts`.
   */
  onPair?: MergePairObserver
}

/**
 * One Step-3c event for `SegmentOptions.onPair`: a pair evaluation (`kind: 'eval'`,
 * every cache-miss call of evalPair, whether or not it reached the fit) or an accepted
 * merge (`kind: 'merged'`, the global-min pair of one sweep, fused into group `c`).
 */
export interface MergePairRecord {
  kind: 'eval' | 'merged'
  /** Group ids — stable, never reused; ≥ S for a group born of a merge. */
  gi: number
  gj: number
  /** Fine-segment members of each side, and each side's opaque pixel count + mean sRGB
   *  (over every pixel of the members, not the strided sample). */
  membersI: number[]
  membersJ: number[]
  pxI: number
  pxJ: number
  meanI: [number, number, number]
  meanJ: [number, number, number]
  /** How far the pair got. Only 'evaluated' pairs carry finite terms below. */
  reached: 'flat-pinned' | 'gate' | 'edge-veto' | 'no-fit' | 'evaluated'
  /** The acceptance condition's four terms: union-fit Oklab residual (≤ mergeTol),
   *  profile gap (≤ maxProfileGap), unwitnessed jump (≤ maxUnwitnessedJump unless the
   *  flat-flank escape holds: min(solidI, solidJ) > FLAT_FLANK_RES). NaN when unreached. */
  res: number
  gap: number
  jump: number
  solidI: number
  solidJ: number
  /** The union fit that produced those terms. */
  fitType?: 'linear' | 'radial'
  stops?: number
  fit?: GradientFill
  /** Sample count per bin of the fitted parameter t (the bins profileGap reads);
   *  shows whether the two sides abut in t. */
  bins?: number[]
  /** Where along t the `jump` sits, and the widest sample-free stretch of t strictly
   *  inside the union's own [tmin, tmax] (fraction of [0,1]). */
  jumpT?: number
  holeT?: number
  /** 'eval': the pair qualifies as a merge candidate. 'merged': always true. */
  accepted: boolean
  /** 'merged' only: the new group's id. */
  c?: number
}
export type MergePairObserver = (r: MergePairRecord) => void

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  ms: DEFAULT_MS_OPTIONS,
  tauS: 10,
  sigma: 5,
  tauA: 0.25,
  minFacing: 4,
  mergeTol: 0.06,
  maxProfileGap: 0.34,
  maxUnwitnessedJump: 0.12,
  mergeGradients: true,
  sampleCap: 3000,
  minRegionArea: 0,
  meanGate: 0,
}

/** Reusable empty protected-group set (the no-marker merge protects nothing). */
const NO_PROTECTED: ReadonlySet<number> = new Set<number>()

/**
 * Fine-segment count above which the Step-3c candidate gate switches on. Below it
 * the ungated all-pairs merge is already fast, and simple art keeps its
 * non-adjacent reunites.
 */
const GATE_MIN_SEGMENTS = 64

export interface SegmentResult extends QuantizeResult {
  /** Mumford–Shah by-products (diagnostics; not required downstream). */
  ms: MumfordShahResult
  /** Number of fine segments S₀ before discontinuity-aware merging. */
  fineSegments: number
  /**
   * Per-pixel pre-merge region id: the fine segments (S₀) before the Step-3c
   * gradient merge fuses them into macro-regions. −1 for anti-aliased /
   * transparent pixels. The editor highlights these on hover so the user can
   * pick one to keep flat. (`labels` is the final, post-merge map.)
   */
  preMergeLabels: Int32Array
  /**
   * Per macro-region (parallel to `palette`/`counts`), the smooth-pixel samples
   * used for the merge, anti-aliased 𝒟 pixels excluded, so the paint model is fit
   * on clean colours without boundary-distance weighting.
   */
  regionSamples: RegionSamples[]
}

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))

/**
 * How far (Chebyshev px) a marker may snap to reach a smooth pixel. A fraction of the
 * image, because markers arrive in normalized coordinates and the same marker must
 * reach the same artwork at every resolution. The floor is in pixels because a
 * discontinuity band is a few px wide at any resolution.
 */
export const MARKER_SNAP_FRAC = 1 / 8
export const MARKER_SNAP_MIN = 8
export function markerSnapRadius(w: number, h: number): number {
  return Math.min(Math.max(w, h), Math.max(MARKER_SNAP_MIN, Math.round(Math.max(w, h) * MARKER_SNAP_FRAC)))
}

/**
 * Nearest smooth pixel to (px,py) by an expanding Chebyshev-ring scan (fixed
 * order ⇒ deterministic). Returns its index, or −1 if none is within
 * `markerSnapRadius`. A marker dropped on a discontinuity or transparent pixel
 * snaps to the closest real segment; a badly misplaced one becomes a no-op.
 */
function nearestSmoothPixel(smooth: Uint8Array, w: number, h: number, px: number, py: number): number {
  if (smooth[py * w + px]) return py * w + px
  const maxR = markerSnapRadius(w, h)
  for (let r = 1; r <= maxR; r++) {
    const x0 = px - r
    const x1 = px + r
    const y0 = py - r
    const y1 = py + r
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= w) continue
      if (y0 >= 0 && smooth[y0 * w + x]) return y0 * w + x
      if (y1 < h && smooth[y1 * w + x]) return y1 * w + x
    }
    for (let y = y0 + 1; y <= y1 - 1; y++) {
      if (y < 0 || y >= h) continue
      if (x0 >= 0 && smooth[y * w + x0]) return y * w + x0
      if (x1 < w && smooth[y * w + x1]) return y * w + x1
    }
  }
  return -1
}

/**
 * Segment an image into smooth macro-regions. See module header. `onProgress` (if
 * given) reports a fraction in [0,1] of the work plus a short label; the Step-3c
 * merge, the slowest step on complex images, reports per batch. Progress reporting
 * never affects the result.
 */
export function segmentImage(
  img: { width: number; height: number; data: Uint8ClampedArray },
  opts: SegmentOptions = DEFAULT_SEGMENT_OPTIONS,
  onProgress?: (fraction: number, label: string) => void,
): SegmentResult {
  const { width: w, height: h } = img
  const n = w * h
  const data = img.data
  const report = (f: number, label: string): void => onProgress?.(f, label)
  report(0.02, 'Smoothing image')
  const ms = solveMumfordShah(img, opts.ms)
  const { discontinuity: disc, opaque, cutH, cutV } = ms

  // Per-pixel CIELAB of the smoothed image, so AA and noise don't fragment a region.
  const labL = new Float64Array(n)
  const labA = new Float64Array(n)
  const labB = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    if (!opaque[i]) continue
    const lab = srgbToLab(ms.r[i] * 255, ms.g[i] * 255, ms.b[i] * 255)
    labL[i] = lab[0]
    labA[i] = lab[1]
    labB[i] = lab[2]
  }

  // --- Step 2: colour-difference agglomerative merge over smooth pixels --------
  // Union-find; each smooth pixel starts as its own segment with fill = its Lab.
  // Repeatedly merge 4-neighbour smooth pairs whose current segment-mean ΔE ≤ τ_s,
  // to a fixpoint. Means are maintained per root and read through find(), so the
  // decision always uses up-to-date fills (Supplement Alg 1).
  const parent = new Int32Array(n).fill(-1)
  const sumL = new Float64Array(n)
  const sumA = new Float64Array(n)
  const sumB = new Float64Array(n)
  const cnt = new Float64Array(n)
  const smooth = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (opaque[i] && !disc[i]) {
      smooth[i] = 1
      parent[i] = i
      sumL[i] = labL[i]
      sumA[i] = labA[i]
      sumB[i] = labB[i]
      cnt[i] = 1
    }
  }

  // --- User markers → seed pixels ---------------------------------------------
  // Each marker (normalised [0,1], input order) claims the nearest smooth pixel;
  // duplicate and unreachable seeds are dropped. The two kinds act differently:
  //
  //   - keep-separate `markers` drive a seeded region-growing split
  //     (markerControlledSplit below): a macro-region holding ≥2 of them is
  //     partitioned by growing a sub-region from each, the boundary settling on the
  //     colour ridge between them. This recovers a translucent overlap whose colour
  //     is within τ_s of the shape beneath it. Needs ≥2 seeds to have anything to
  //     grow against.
  //
  //   - `flatMarkers` exclude their fine segment from the Step-3c merge
  //     (flatPinned, below), so it survives as its own region. Because this happens
  //     before the Step-4 anti-alias flood, the region's edge lands on the true
  //     colour edge and a single marker is enough.
  const splitSeeds: number[] = []
  const flatSeeds: number[] = []
  const usedSeed = new Set<number>()
  const claimSeed = (mx: number, my: number, into: number[]): void => {
    const px = Math.max(0, Math.min(w - 1, Math.round(mx * w)))
    const py = Math.max(0, Math.min(h - 1, Math.round(my * h)))
    const seed = nearestSmoothPixel(smooth, w, h, px, py)
    if (seed >= 0 && !usedSeed.has(seed)) {
      usedSeed.add(seed)
      into.push(seed)
    }
  }
  for (const m of opts.markers ?? []) claimSeed(m.x, m.y, splitSeeds)
  for (const m of opts.flatMarkers ?? []) claimSeed(m.x, m.y, flatSeeds)
  const hasMarkers = splitSeeds.length > 0 || flatSeeds.length > 0

  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]
    // Path compression (deterministic).
    let c = x
    while (parent[c] !== r) {
      const next = parent[c]
      parent[c] = r
      c = next
    }
    return r
  }
  const meanDelta = (ra: number, rb: number): number => {
    const ml = [sumL[ra] / cnt[ra], sumA[ra] / cnt[ra], sumB[ra] / cnt[ra]] as [number, number, number]
    const nl = [sumL[rb] / cnt[rb], sumA[rb] / cnt[rb], sumB[rb] / cnt[rb]] as [number, number, number]
    return deltaE76(ml, nl)
  }
  const unite = (ra: number, rb: number): void => {
    // Smaller index becomes root (deterministic).
    const lo = ra < rb ? ra : rb
    const hi = ra < rb ? rb : ra
    parent[hi] = lo
    sumL[lo] += sumL[hi]
    sumA[lo] += sumA[hi]
    sumB[lo] += sumB[hi]
    cnt[lo] += cnt[hi]
  }

  report(0.2, 'Finding regions')
  // Loop to a true fixpoint (Supplement Alg 1). Terminates because every productive
  // pass strictly reduces the live segment count. Don't add an iteration cap: it
  // could silently under-merge a long serpentine ramp.
  for (;;) {
    let changed = false
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (!smooth[i]) continue
        // right
        if (x + 1 < w && smooth[i + 1] && !cutH[i]) {
          const ra = find(i)
          const rb = find(i + 1)
          if (ra !== rb && meanDelta(ra, rb) <= opts.tauS) {
            unite(ra, rb)
            changed = true
          }
        }
        // down
        if (y + 1 < h && smooth[i + w] && !cutV[i]) {
          const ra = find(i)
          const rb = find(i + w)
          if (ra !== rb && meanDelta(ra, rb) <= opts.tauS) {
            unite(ra, rb)
            changed = true
          }
        }
      }
    }
    if (!changed) break
  }

  // Compact S₀ roots → segment ids 0..S-1; segOf[pixel] = id, −1 for 𝒟/transparent.
  const segOf = new Int32Array(n).fill(-1)
  const rootToSeg = new Map<number, number>()
  let S = 0
  for (let i = 0; i < n; i++) {
    if (!smooth[i]) continue
    const r = find(i)
    let id = rootToSeg.get(r)
    if (id === undefined) {
      id = S++
      rootToSeg.set(r, id)
    }
    segOf[i] = id
  }
  if (S === 0) {
    // Degenerate (e.g. fully transparent / everything an edge): one flat region.
    return fallbackSingleRegion(img, ms)
  }

  // Flat-marker pins: the fine segment id under each flat marker, excluded from the
  // Step-3c merge (evalPair, below) so each stays its own region. Held out before
  // the Step-4 flood so the AA settles on the true colour edge.
  const flatPinned = new Set<number>()
  for (const seed of flatSeeds) {
    const s = segOf[seed]
    if (s >= 0) flatPinned.add(s)
  }

  report(0.35, 'Detecting edges')
  // --- Step 3a: discontinuity relation 𝒜 (eq 3) -------------------------------
  // For each 𝒟 pixel and each of 3 axes (→, ↓, ↘), find the nearest smooth
  // segment within σ on each side. A pair seen on opposite sides is a "facing"
  // observation; any pair seen near the same 𝒟 pixel is a "touch". A pair whose
  // facing/touch ratio exceeds τ_a must stay separate.
  //
  // `facing` is tallied per axis (up to 3× per pixel) while `touch` is per pixel,
  // so f/t is not the paper's normalized [0,1] density: it is deliberately biased
  // toward firing the veto. That is the safe direction, since the failure to avoid
  // is a greedy merge bridging a real edge. τ_a keeps the paper's 0.25, but its
  // effective scale differs by this weighting.
  const facing = new Map<number, number>()
  const touch = new Map<number, number>()
  const pairKey = (a: number, b: number): number => (a < b ? a * S + b : b * S + a)
  const dirs: [number, number][] = [
    [1, 0],
    [0, 1],
    [1, 1],
  ]
  const nearestSeg = (x: number, y: number, dx: number, dy: number): number => {
    for (let s = 1; s <= opts.sigma; s++) {
      const nx = x + dx * s
      const ny = y + dy * s
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return -1
      const id = segOf[ny * w + nx]
      if (id >= 0) return id
    }
    return -1
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!opaque[i] || !disc[i]) continue
      // Collect nearby segments across all 6 half-directions for the touch tally.
      const near = new Set<number>()
      for (const [dx, dy] of dirs) {
        const pos = nearestSeg(x, y, dx, dy)
        const neg = nearestSeg(x, y, -dx, -dy)
        if (pos >= 0) near.add(pos)
        if (neg >= 0) near.add(neg)
        if (pos >= 0 && neg >= 0 && pos !== neg) {
          const k = pairKey(pos, neg)
          facing.set(k, (facing.get(k) ?? 0) + 1)
        }
      }
      const arr = [...near].sort((a, b) => a - b)
      for (let a = 0; a < arr.length; a++) {
        for (let b = a + 1; b < arr.length; b++) {
          const k = pairKey(arr[a], arr[b])
          touch.set(k, (touch.get(k) ?? 0) + 1)
        }
      }
    }
  }
  const vetoed = new Set<number>()
  for (const [k, f] of facing) {
    const t = touch.get(k) ?? f
    if (f >= opts.minFacing && f > opts.tauA * t) vetoed.add(k)
  }

  report(0.42, 'Sampling colours')
  // --- Step 3b: gather per-segment samples (original colours) ------------------
  // Also accumulate each segment's exact colour sum (every pixel, not the strided
  // sample) so Step-3c's candidate gate compares true region means.
  const segSamples: RegionSamples[] = []
  const segSumR = new Float64Array(S)
  const segSumG = new Float64Array(S)
  const segSumB = new Float64Array(S)
  const segCnt = new Float64Array(S)
  {
    const xsA: number[][] = Array.from({ length: S }, () => [])
    const ysA: number[][] = Array.from({ length: S }, () => [])
    const rsA: number[][] = Array.from({ length: S }, () => [])
    const gsA: number[][] = Array.from({ length: S }, () => [])
    const bsA: number[][] = Array.from({ length: S }, () => [])
    for (let i = 0; i < n; i++) {
      const id = segOf[i]
      if (id < 0) continue
      const o = i * 4
      xsA[id].push(i % w)
      ysA[id].push((i / w) | 0)
      rsA[id].push(data[o])
      gsA[id].push(data[o + 1])
      bsA[id].push(data[o + 2])
      segSumR[id] += data[o]
      segSumG[id] += data[o + 1]
      segSumB[id] += data[o + 2]
      segCnt[id]++
    }
    for (let id = 0; id < S; id++) {
      segSamples.push(strideSamples(xsA[id], ysA[id], rsA[id], gsA[id], bsA[id], opts.sampleCap))
    }
  }

  // --- Step 3c: global greedy union-fit merge with the vetoes ------------------
  // Merge the globally cheapest qualifying pair (not vetoed, low residual, no
  // profile gap, no unwitnessed jump) until none qualifies; ties break by scan
  // position. Groups carry stable ids (never reused) so the pairwise candidate cache
  // survives across merges and only the merged group's row is recomputed. Two cost
  // cuts that don't change which pair wins among eligible ones:
  //   - Candidate gate (see `meanGate`; only once S exceeds GATE_MIN_SEGMENTS): a
  //     pair reaches the gradient fit only when the groups are adjacent or, if
  //     enabled, mean-near. This covers the desirable merges (adjacent ramp bands,
  //     same-mean field pieces) and turns the ~S²/2 fit burst into a few fits.
  //   - Indexed cache invalidation: each merge drops only the two retired groups'
  //     rows via a per-group key index instead of sweeping the whole cache.
  const members = new Map<number, number[]>()
  const samples = new Map<number, RegionSamples>()
  const alive: number[] = []
  for (let id = 0; id < S; id++) {
    members.set(id, [id])
    samples.set(id, segSamples[id])
    alive.push(id)
  }
  let nextId = S

  // Gradients off ⇒ skip the merge: the Step-2 bands stay as the macro-regions, so
  // a smooth ramp posterizes into flats instead of being averaged to one mean colour.
  if (opts.mergeGradients) {
    const gated = S > GATE_MIN_SEGMENTS
    const useMean = gated && opts.meanGate > 0 && Number.isFinite(opts.meanGate)

    // Per-group adjacency (when gated) and running colour means (only for the
    // optional mean clause, so the adjacency-only path doesn't pay for them).
    const groupAdj = new Map<number, Set<number>>()
    const gSumR = new Map<number, number>()
    const gSumG = new Map<number, number>()
    const gSumB = new Map<number, number>()
    const gCnt = new Map<number, number>()
    const meanCache = new Map<number, Oklab>()
    if (gated) {
      // Fine-segment adjacency (4-neighbour touch). One raster scan, both directions
      // recorded; fixed order ⇒ deterministic.
      const fineAdj: Set<number>[] = Array.from({ length: S }, () => new Set<number>())
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x
          const a = segOf[i]
          if (a < 0) continue
          if (x + 1 < w) { const b = segOf[i + 1]; if (b >= 0 && b !== a) { fineAdj[a].add(b); fineAdj[b].add(a) } }
          if (y + 1 < h) { const b = segOf[i + w]; if (b >= 0 && b !== a) { fineAdj[a].add(b); fineAdj[b].add(a) } }
        }
      }
      for (let id = 0; id < S; id++) {
        groupAdj.set(id, new Set(fineAdj[id]))
        if (useMean) { gSumR.set(id, segSumR[id]); gSumG.set(id, segSumG[id]); gSumB.set(id, segSumB[id]); gCnt.set(id, segCnt[id]) }
      }
    }
    const meanOk = (gid: number): Oklab => {
      let m = meanCache.get(gid)
      if (m) return m
      const c = gCnt.get(gid)! || 1
      m = srgbToOklab(gSumR.get(gid)! / c, gSumG.get(gid)! / c, gSumB.get(gid)! / c)
      meanCache.set(gid, m)
      return m
    }
    // Gate: adjacent or (optionally) mean-near. Ungated (small S) ⇒ every pair is
    // eligible.
    const gateEligible = (gi: number, gj: number): boolean =>
      !gated || groupAdj.get(gi)!.has(gj) || (useMean && oklabDeltaE(meanOk(gi), meanOk(gj)) <= opts.meanGate)

    const cache = new Map<number, { res: number; samples: RegionSamples } | null>()
    const cacheRows = new Map<number, number[]>() // groupId → cache keys naming it
    const ckey = (a: number, b: number): number => (a < b ? a * 1e7 + b : b * 1e7 + a)
    const noteRow = (g: number, k: number): void => {
      const arr = cacheRows.get(g)
      if (arr) arr.push(k)
      else cacheRows.set(g, [k])
    }
    const pairVetoed = (gi: number, gj: number): boolean => {
      const mi = members.get(gi)!
      const mj = members.get(gj)!
      for (const a of mi) for (const b of mj) if (vetoed.has(pairKey(a, b))) return true
      return false
    }
    // A flat-pinned segment never merges. Its group id equals the segment id and is
    // never retired, so checking pinned ids stays valid; merged groups get ids ≥ S.
    // `describe` supports the onPair observer and is only called when one is set.
    const onPair = opts.onPair
    const describe = (g: number): { members: number[]; px: number; mean: [number, number, number] } => {
      const m = members.get(g)!
      let r = 0
      let gg = 0
      let b = 0
      let c = 0
      for (const s of m) {
        r += segSumR[s]
        gg += segSumG[s]
        b += segSumB[s]
        c += segCnt[s]
      }
      return { members: m.slice(), px: c, mean: [r / (c || 1), gg / (c || 1), b / (c || 1)] }
    }
    const evalPair = (gi: number, gj: number): { res: number; samples: RegionSamples } | null => {
      const k = ckey(gi, gj)
      if (cache.has(k)) return cache.get(k)!
      let result: { res: number; samples: RegionSamples } | null = null
      // The predicate chain is unrolled so an observer can learn which link stopped
      // a pair; evaluation order and short-circuiting are unchanged.
      let reached: MergePairRecord['reached'] = 'evaluated'
      let fit: ReturnType<typeof fitBestGradient> = null
      let union: RegionSamples | null = null
      if (flatPinned.has(gi) || flatPinned.has(gj)) reached = 'flat-pinned'
      else if (!gateEligible(gi, gj)) reached = 'gate'
      else if (pairVetoed(gi, gj)) reached = 'edge-veto'
      else {
        union = strideConcat([samples.get(gi)!, samples.get(gj)!], opts.sampleCap)
        fit = fitBestGradient(union)
        if (!fit) reached = 'no-fit'
      }
      if (fit && union) {
        if (
          fit.oklabResidual <= opts.mergeTol &&
          profileGap(fit.gradient, union) <= opts.maxProfileGap &&
          (unwitnessedJump(fit.gradient, union) <= opts.maxUnwitnessedJump ||
            // Flat-flank condition: an unwitnessed jump is fatal only when one side
            // is a near-flat colour block, which has no interior trend that could
            // bridge the gap. When both sides carry interior spread they are pieces
            // of a smooth field, and vetoing them would only reorder the merges,
            // perturbing the strided samples and thus the fitted paint.
            Math.min(solidResidual(samples.get(gi)!), solidResidual(samples.get(gj)!)) > FLAT_FLANK_RES)
        ) {
          result = { res: fit.oklabResidual, samples: union }
        }
      }
      if (onPair) {
        const di = describe(gi)
        const dj = describe(gj)
        const step = fit && union ? unwitnessedStep(fit.gradient, union) : null
        onPair({
          kind: 'eval',
          gi,
          gj,
          membersI: di.members,
          membersJ: dj.members,
          pxI: di.px,
          pxJ: dj.px,
          meanI: di.mean,
          meanJ: dj.mean,
          reached,
          res: fit ? fit.oklabResidual : NaN,
          gap: fit && union ? profileGap(fit.gradient, union) : NaN,
          jump: step ? step.jump : NaN,
          solidI: fit ? solidResidual(samples.get(gi)!) : NaN,
          solidJ: fit ? solidResidual(samples.get(gj)!) : NaN,
          ...(fit && union && step
            ? { fitType: fit.gradient.type, stops: fit.gradient.stops.length, fit: fit.gradient, bins: tBins(fit.gradient, union), jumpT: step.at, holeT: step.holeT }
            : {}),
          accepted: result !== null,
        })
      }
      cache.set(k, result)
      noteRow(gi, k)
      noteRow(gj, k)
      return result
    }

    report(0.45, 'Merging regions')
    const A0 = alive.length // group count when the merge starts (for progress)
    let lastPct = -1
    let seedEvals = 0
    let seeding = true // true only during the first (cold, all-pairs) scan
    for (;;) {
      let best: { i: number; j: number; samples: RegionSamples; res: number } | null = null
      for (let a = 0; a < alive.length; a++) {
        for (let b = a + 1; b < alive.length; b++) {
          const cand = evalPair(alive[a], alive[b])
          if (cand && (!best || cand.res < best.res)) {
            best = { i: alive[a], j: alive[b], samples: cand.samples, res: cand.res }
          }
          // Advance the bar through the cold first scan (the slow part); the
          // `seeding` guard keeps later scans free of this check.
          if (seeding && (++seedEvals & 8191) === 0) {
            report(0.45 + 0.1 * Math.min(1, (2 * seedEvals) / (A0 * A0)), 'Merging regions')
          }
        }
      }
      seeding = false
      if (!best) break
      const c = nextId++
      if (onPair) {
        const di = describe(best.i)
        const dj = describe(best.j)
        onPair({
          kind: 'merged',
          gi: best.i,
          gj: best.j,
          membersI: di.members,
          membersJ: dj.members,
          pxI: di.px,
          pxJ: dj.px,
          meanI: di.mean,
          meanJ: dj.mean,
          reached: 'evaluated',
          res: best.res,
          gap: NaN,
          jump: NaN,
          solidI: NaN,
          solidJ: NaN,
          accepted: true,
          c,
        })
      }
      members.set(c, members.get(best.i)!.concat(members.get(best.j)!))
      samples.set(c, best.samples)
      if (gated) {
        // c's neighbours are the union of the merged pair's, minus the two merged
        // ids, and every neighbour repoints i/j → c.
        const adjC = new Set<number>()
        for (const nb of groupAdj.get(best.i)!) if (nb !== best.j) adjC.add(nb)
        for (const nb of groupAdj.get(best.j)!) if (nb !== best.i) adjC.add(nb)
        for (const nb of adjC) {
          const s = groupAdj.get(nb)
          if (s) { s.delete(best.i); s.delete(best.j); s.add(c) }
        }
        groupAdj.set(c, adjC)
        groupAdj.delete(best.i); groupAdj.delete(best.j)
      }
      if (useMean) {
        // c's running colour sums add; drop the retired groups' means.
        gSumR.set(c, gSumR.get(best.i)! + gSumR.get(best.j)!)
        gSumG.set(c, gSumG.get(best.i)! + gSumG.get(best.j)!)
        gSumB.set(c, gSumB.get(best.i)! + gSumB.get(best.j)!)
        gCnt.set(c, gCnt.get(best.i)! + gCnt.get(best.j)!)
        gSumR.delete(best.i); gSumG.delete(best.i); gSumB.delete(best.i); gCnt.delete(best.i); meanCache.delete(best.i)
        gSumR.delete(best.j); gSumG.delete(best.j); gSumB.delete(best.j); gCnt.delete(best.j); meanCache.delete(best.j)
      }
      // Retire the two merged groups: drop them from `alive` and invalidate their
      // cache rows.
      alive.splice(alive.indexOf(best.j), 1)
      alive.splice(alive.indexOf(best.i), 1)
      for (const g of [best.i, best.j]) {
        const rows = cacheRows.get(g)
        if (rows) for (const k of rows) cache.delete(k)
        cacheRows.delete(g)
      }
      members.delete(best.i)
      members.delete(best.j)
      samples.delete(best.i)
      samples.delete(best.j)
      alive.push(c)
      // Advance the bar as groups merge away (throttled to whole-percent steps).
      const done = A0 - alive.length
      const pct = Math.floor((done / A0) * 100)
      if (pct > lastPct) {
        lastPct = pct
        report(0.55 + 0.37 * (done / A0), `Merging regions (${alive.length} left)`)
      }
    }
  }

  const G = alive.length
  const segToGroup = new Int32Array(S)
  const groupSampleList: RegionSamples[] = alive.map((gid) => samples.get(gid)!)
  alive.forEach((gid, gi) => {
    for (const sId of members.get(gid)!) segToGroup[sId] = gi
  })

  report(0.92, 'Filling edges')
  // --- Step 4: flood 𝒟 (anti-aliased) pixels into the best-matching neighbour ---
  // groupId per pixel: smooth pixels inherit their segment's group; 𝒟 pixels are
  // assigned by repeated passes, choosing the adjacent group whose mean original
  // colour best matches the pixel (the paper's convex-combination test,
  // approximated by nearest fill). Means are accumulated as pixels are assigned.
  const groupId = new Int32Array(n).fill(-1)
  const gSumR = new Float64Array(G)
  const gSumG = new Float64Array(G)
  const gSumB = new Float64Array(G)
  const gCnt = new Float64Array(G)
  for (let i = 0; i < n; i++) {
    const sId = segOf[i]
    if (sId < 0) continue
    const gi = segToGroup[sId]
    groupId[i] = gi
    const o = i * 4
    gSumR[gi] += data[o]
    gSumG[gi] += data[o + 1]
    gSumB[gi] += data[o + 2]
    gCnt[gi]++
  }

  const groupLab = (gi: number): [number, number, number] =>
    srgbToLab(gSumR[gi] / gCnt[gi], gSumG[gi] / gCnt[gi], gSumB[gi] / gCnt[gi])

  // Flood unassigned opaque (𝒟) pixels until none remain.
  let remaining = 0
  for (let i = 0; i < n; i++) if (opaque[i] && groupId[i] < 0) remaining++
  const neigh = [-1, 1, -w, w]
  for (let guard = 0; remaining > 0 && guard < n; guard++) {
    let assignedThisPass = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (!opaque[i] || groupId[i] >= 0) continue
        const o = i * 4
        const px = srgbToLab(data[o], data[o + 1], data[o + 2])
        let bestG = -1
        let bestD = Infinity
        for (let d = 0; d < 4; d++) {
          if (d === 0 && x === 0) continue
          if (d === 1 && x === w - 1) continue
          if (d === 2 && y === 0) continue
          if (d === 3 && y === h - 1) continue
          const ni = i + neigh[d]
          const gj = groupId[ni]
          if (gj < 0) continue
          const dd = deltaE76(px, groupLab(gj))
          if (dd < bestD) {
            bestD = dd
            bestG = gj
          }
        }
        if (bestG >= 0) {
          groupId[i] = bestG
          gSumR[bestG] += data[o]
          gSumG[bestG] += data[o + 1]
          gSumB[bestG] += data[o + 2]
          gCnt[bestG]++
          assignedThisPass++
        }
      }
    }
    remaining -= assignedThisPass
    if (assignedThisPass === 0) break // no opaque pixel borders an assigned one
  }

  // Any opaque pixel still unassigned belongs to an isolated all-𝒟 component (a
  // thin mark on transparency whose every pixel is a discontinuity), which the
  // flood can never reach. Seed each 4-connected such component as its own
  // macro-region so the feature survives instead of being labelled transparent.
  const extra: { sumR: number; sumG: number; sumB: number; cnt: number; xs: number[]; ys: number[]; rs: number[]; gs: number[]; bs: number[] }[] = []
  const stack: number[] = []
  for (let i = 0; i < n; i++) {
    if (!opaque[i] || groupId[i] >= 0) continue
    const gid = G + extra.length
    const grp = { sumR: 0, sumG: 0, sumB: 0, cnt: 0, xs: [] as number[], ys: [] as number[], rs: [] as number[], gs: [] as number[], bs: [] as number[] }
    groupId[i] = gid
    stack.length = 0
    stack.push(i)
    while (stack.length) {
      const p = stack.pop()!
      const o = p * 4
      grp.sumR += data[o]; grp.sumG += data[o + 1]; grp.sumB += data[o + 2]; grp.cnt++
      grp.xs.push(p % w); grp.ys.push((p / w) | 0); grp.rs.push(data[o]); grp.gs.push(data[o + 1]); grp.bs.push(data[o + 2])
      const px = p % w
      const py = (p / w) | 0
      if (px > 0 && opaque[p - 1] && groupId[p - 1] < 0) { groupId[p - 1] = gid; stack.push(p - 1) }
      if (px < w - 1 && opaque[p + 1] && groupId[p + 1] < 0) { groupId[p + 1] = gid; stack.push(p + 1) }
      if (py > 0 && opaque[p - w] && groupId[p - w] < 0) { groupId[p - w] = gid; stack.push(p - w) }
      if (py < h - 1 && opaque[p + w] && groupId[p + w] < 0) { groupId[p + w] = gid; stack.push(p + w) }
    }
    extra.push(grp)
  }

  // --- Marker-controlled split (seeded region growing) ------------------------
  // Any macro-region containing ≥2 markers is partitioned by growing a sub-region
  // from each marker (seeded region growing on original-colour Lab, confined to
  // that region), so the boundary settles on the colour ridge between them. This
  // separates a translucent overlap from the shape beneath it even though their
  // mean colours merged. Runs without markers skip this and the assembly below.
  if (hasMarkers) {
    // Flat markers already separated their regions by exclusion; keep-separate
    // markers split here.
    let groupCount = G + extra.length
    if (splitSeeds.length > 0) {
      // Grow on original-colour Lab, not the smoothed Lab: smoothing erases subtle
      // overlap edges, which would put the split boundary off the true edge.
      const oL = new Float64Array(n)
      const oA = new Float64Array(n)
      const oB = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        if (!opaque[i]) continue
        const o = i * 4
        const lab = srgbToLab(data[o], data[o + 1], data[o + 2])
        oL[i] = lab[0]
        oA[i] = lab[1]
        oB[i] = lab[2]
      }
      groupCount = markerControlledSplit(groupId, groupCount, splitSeeds, w, h, oL, oA, oB)
    }
    if (opts.minRegionArea > 0) {
      // Absorb sub-threshold slivers, but never a user-marked region (split or flat).
      const protectedGroups = new Set<number>()
      for (const seed of splitSeeds) {
        const g = groupId[seed]
        if (g >= 0) protectedGroups.add(g)
      }
      for (const seed of flatSeeds) {
        const g = groupId[seed]
        if (g >= 0) protectedGroups.add(g)
      }
      groupCount = mergeSmallRegions(groupId, groupCount, n, w, h, data, opts.minRegionArea, protectedGroups).count
    }
    return { ...assembleFromGroupId(groupId, groupCount, n, w, data, smooth, ms, S, opts.sampleCap), preMergeLabels: segOf }
  }

  // --- Small-region merge (despeckle): absorb sub-threshold slivers into their
  // nearest-colour neighbour. Falls through to the assembly below when nothing merged.
  if (opts.minRegionArea > 0) {
    const merged = mergeSmallRegions(groupId, G + extra.length, n, w, h, data, opts.minRegionArea, NO_PROTECTED)
    if (merged.changed) return { ...assembleFromGroupId(groupId, merged.count, n, w, data, smooth, ms, S, opts.sampleCap), preMergeLabels: segOf }
  }

  // --- Assemble QuantizeResult over all macro-regions (smooth groups + isolated
  // 𝒟 components), sorted by pixel count desc.
  const GG = G + extra.length
  const cntOf = (gi: number): number => (gi < G ? gCnt[gi] : extra[gi - G].cnt)
  const sumOf = (gi: number): [number, number, number] =>
    gi < G ? [gSumR[gi], gSumG[gi], gSumB[gi]] : [extra[gi - G].sumR, extra[gi - G].sumG, extra[gi - G].sumB]
  const samplesOf = (gi: number): RegionSamples =>
    gi < G
      ? groupSampleList[gi]
      : strideSamples(extra[gi - G].xs, extra[gi - G].ys, extra[gi - G].rs, extra[gi - G].gs, extra[gi - G].bs, opts.sampleCap)

  const order = Array.from({ length: GG }, (_, gi) => gi).sort((a, b) => cntOf(b) - cntOf(a))
  const rank = new Int32Array(GG)
  order.forEach((gi, pos) => {
    rank[gi] = pos
  })
  const palette: PaletteColor[] = order.map((gi) => {
    const c = cntOf(gi) || 1
    const [sr, sg, sb] = sumOf(gi)
    return { r: clamp255(sr / c), g: clamp255(sg / c), b: clamp255(sb / c) }
  })
  const counts = order.map((gi) => cntOf(gi))
  const regionSamples = order.map((gi) => samplesOf(gi))
  const labels = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const gi = groupId[i]
    labels[i] = gi < 0 ? -1 : rank[gi]
  }

  return { palette, labels, counts, ms, fineSegments: S, regionSamples, preMergeLabels: segOf }
}

// ---------------------------------------------------------------------------
// Marker-controlled seeded region growing (Adams & Bischof, 1994): grow each
// seed's region by repeatedly claiming the unassigned boundary pixel most similar
// to a region's running mean (a priority queue), so the boundary settles on the
// colour ridge between regions. Works even when the regions' mean colours are
// within the global merge threshold and the step is subtle.
// ---------------------------------------------------------------------------

/**
 * Split every macro-region holding ≥2 markers, growing one sub-region per marker.
 * Mutates `groupId` in place (sub-region 0 keeps the group's id, the rest get new
 * ids ≥ GG0) and returns the new total group count. Deterministic: groups and
 * seeds are processed in ascending / input order; heap ties break by pixel index.
 */
function markerControlledSplit(
  groupId: Int32Array,
  GG0: number,
  markerSeeds: number[],
  w: number,
  h: number,
  labL: Float64Array,
  labA: Float64Array,
  labB: Float64Array,
): number {
  const byGroup = new Map<number, number[]>()
  for (const seed of markerSeeds) {
    const g = groupId[seed]
    if (g < 0) continue
    const list = byGroup.get(g)
    if (list) list.push(seed)
    else byGroup.set(g, [seed])
  }
  const toSplit = [...byGroup.keys()].filter((g) => byGroup.get(g)!.length >= 2).sort((a, b) => a - b)
  if (toSplit.length === 0) return GG0

  const sub = new Int32Array(groupId.length).fill(-1) // per-pixel sub-region (reused)
  let nextGroup = GG0
  for (const g of toSplit) {
    const seeds = byGroup.get(g)!
    const subIds = seeds.map((_, i) => (i === 0 ? g : nextGroup++))
    growSeeds(groupId, g, seeds, subIds, sub, w, h, labL, labA, labB)
  }
  return nextGroup
}

/** Grow `seeds` over the pixels currently labelled `g`, writing their final group
 *  ids (`subIds`) into `groupId`. `sub` is scratch (size = #px), reset on return. */
function growSeeds(
  groupId: Int32Array,
  g: number,
  seeds: number[],
  subIds: number[],
  sub: Int32Array,
  w: number,
  h: number,
  labL: Float64Array,
  labA: Float64Array,
  labB: Float64Array,
): void {
  const K = seeds.length
  const sumL = new Float64Array(K)
  const sumA = new Float64Array(K)
  const sumB = new Float64Array(K)
  const cnt = new Float64Array(K)
  const heap = new MinHeap()
  const touched: number[] = []

  const meanDE = (pix: number, k: number): number => {
    const dl = labL[pix] - sumL[k] / cnt[k]
    const da = labA[pix] - sumA[k] / cnt[k]
    const db = labB[pix] - sumB[k] / cnt[k]
    return Math.sqrt(dl * dl + da * da + db * db)
  }
  const pushNbrs = (pix: number, k: number): void => {
    const x = pix % w
    const y = (pix / w) | 0
    if (x > 0 && groupId[pix - 1] === g && sub[pix - 1] === -1) heap.push(meanDE(pix - 1, k), pix - 1, k)
    if (x < w - 1 && groupId[pix + 1] === g && sub[pix + 1] === -1) heap.push(meanDE(pix + 1, k), pix + 1, k)
    if (y > 0 && groupId[pix - w] === g && sub[pix - w] === -1) heap.push(meanDE(pix - w, k), pix - w, k)
    if (y < h - 1 && groupId[pix + w] === g && sub[pix + w] === -1) heap.push(meanDE(pix + w, k), pix + w, k)
  }

  for (let k = 0; k < K; k++) {
    const s = seeds[k]
    sub[s] = k
    touched.push(s)
    sumL[k] = labL[s]
    sumA[k] = labA[s]
    sumB[k] = labB[s]
    cnt[k] = 1
  }
  for (let k = 0; k < K; k++) pushNbrs(seeds[k], k)

  while (heap.size > 0) {
    const pix = heap.pop()
    const k = heap.popReg
    if (sub[pix] !== -1) continue // already claimed by an earlier (lower-ΔE) pop
    sub[pix] = k
    touched.push(pix)
    sumL[k] += labL[pix]
    sumA[k] += labA[pix]
    sumB[k] += labB[pix]
    cnt[k]++
    pushNbrs(pix, k)
  }

  // Write final ids; any pixel of g the growth didn't reach (a component with no
  // seed) stays in sub-region 0 (= g). Reset the touched scratch for the next group.
  for (let i = 0; i < groupId.length; i++) {
    if (groupId[i] !== g) continue
    const k = sub[i]
    groupId[i] = subIds[k < 0 ? 0 : k]
  }
  for (const p of touched) sub[p] = -1
}

/** Binary min-heap of (ΔE, pixel, region) entries, ordered by ΔE then pixel index
 *  then region (a total order ⇒ deterministic region growing). `pop()` returns the
 *  pixel and exposes its region via `popReg`. */
class MinHeap {
  de: number[] = []
  pix: number[] = []
  reg: number[] = []
  size = 0
  popReg = 0
  push(de: number, pix: number, reg: number): void {
    const i = this.size++
    this.de[i] = de
    this.pix[i] = pix
    this.reg[i] = reg
    this.up(i)
  }
  pop(): number {
    const pix = this.pix[0]
    this.popReg = this.reg[0]
    const last = --this.size
    this.de[0] = this.de[last]
    this.pix[0] = this.pix[last]
    this.reg[0] = this.reg[last]
    if (this.size > 0) this.down(0)
    return pix
  }
  less(i: number, j: number): boolean {
    if (this.de[i] !== this.de[j]) return this.de[i] < this.de[j]
    if (this.pix[i] !== this.pix[j]) return this.pix[i] < this.pix[j]
    return this.reg[i] < this.reg[j]
  }
  swap(i: number, j: number): void {
    const d = this.de[i]; this.de[i] = this.de[j]; this.de[j] = d
    const p = this.pix[i]; this.pix[i] = this.pix[j]; this.pix[j] = p
    const r = this.reg[i]; this.reg[i] = this.reg[j]; this.reg[j] = r
  }
  up(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.less(i, parent)) break
      this.swap(i, parent)
      i = parent
    }
  }
  down(i: number): void {
    for (;;) {
      const l = 2 * i + 1
      const r = 2 * i + 2
      let m = i
      if (l < this.size && this.less(l, m)) m = l
      if (r < this.size && this.less(r, m)) m = r
      if (m === i) break
      this.swap(i, m)
      i = m
    }
  }
}

/** Iteration cap for the small-region merge (a fixpoint is reached well before). */
const MAX_MERGE_PASSES = 64

/**
 * Absorb every macro-region smaller than `minArea` opaque pixels into an adjacent
 * region, so AA and colour-ramp transition slivers don't survive as tiny shapes.
 * Each small region is merged into the neighbour whose mean original colour is
 * closest, preferring a neighbour that is itself ≥ minArea so slivers collapse
 * into real shapes rather than chaining through each other. `protectedGroups`
 * (user markers) are never absorbed, though they may absorb. Mutates `groupId` in
 * place (relabelled, then compacted to 0..count-1) and returns the new count and
 * whether anything changed. Deterministic: small groups scanned in ascending id,
 * target ties broken by shared-boundary length then id; iterates to a fixpoint.
 */
function mergeSmallRegions(
  groupId: Int32Array,
  groupCount: number,
  n: number,
  w: number,
  h: number,
  data: Uint8ClampedArray,
  minArea: number,
  protectedGroups: ReadonlySet<number>,
): { count: number; changed: boolean } {
  if (!(minArea > 0)) return { count: groupCount, changed: false }
  const G = groupCount
  let changed = false

  for (let pass = 0; pass < MAX_MERGE_PASSES; pass++) {
    // Per-group opaque count + mean original colour.
    const cnt = new Float64Array(G)
    const sumR = new Float64Array(G)
    const sumG = new Float64Array(G)
    const sumB = new Float64Array(G)
    for (let i = 0; i < n; i++) {
      const g = groupId[i]
      if (g < 0) continue
      const o = i * 4
      cnt[g]++
      sumR[g] += data[o]
      sumG[g] += data[o + 1]
      sumB[g] += data[o + 2]
    }
    // Region adjacency with shared-boundary length (4-connectivity).
    const adj = new Map<number, Map<number, number>>()
    const bump = (a: number, b: number): void => {
      let m = adj.get(a)
      if (!m) adj.set(a, (m = new Map()))
      m.set(b, (m.get(b) ?? 0) + 1)
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const g = groupId[i]
        if (g < 0) continue
        if (x + 1 < w) {
          const r = groupId[i + 1]
          if (r >= 0 && r !== g) { bump(g, r); bump(r, g) }
        }
        if (y + 1 < h) {
          const d = groupId[i + w]
          if (d >= 0 && d !== g) { bump(g, d); bump(d, g) }
        }
      }
    }

    // Qualifying small groups (ascending id ⇒ deterministic).
    const small: number[] = []
    for (let g = 0; g < G; g++) {
      if (cnt[g] > 0 && cnt[g] < minArea && !protectedGroups.has(g) && (adj.get(g)?.size ?? 0) > 0) small.push(g)
    }
    if (small.length === 0) break

    const labCache = new Map<number, [number, number, number]>()
    const labOf = (g: number): [number, number, number] => {
      let l = labCache.get(g)
      if (!l) labCache.set(g, (l = srgbToLab(sumR[g] / cnt[g], sumG[g] / cnt[g], sumB[g] / cnt[g])))
      return l
    }

    // Union-find over group ids; the more "keepable" group wins the root.
    const parent = Array.from({ length: G }, (_, i) => i)
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]]
        x = parent[x]
      }
      return x
    }
    const keepScore = (g: number): number => (protectedGroups.has(g) ? 2 : cnt[g] >= minArea ? 1 : 0)
    const union = (a: number, b: number): void => {
      const ra = find(a)
      const rb = find(b)
      if (ra === rb) return
      const sa = keepScore(ra)
      const sb = keepScore(rb)
      const bWins = sb > sa || (sb === sa && (cnt[rb] > cnt[ra] || (cnt[rb] === cnt[ra] && rb < ra)))
      if (bWins) parent[ra] = rb
      else parent[rb] = ra
    }

    for (const g of small) {
      const nbrs = adj.get(g)!
      let bestT = -1
      let bestDE = Infinity
      let bestBoundary = -1
      const consider = (preferReal: boolean): void => {
        for (const [t, boundary] of nbrs) {
          if (preferReal && cnt[t] < minArea && !protectedGroups.has(t)) continue
          const de = deltaE76(labOf(g), labOf(t))
          if (de < bestDE || (de === bestDE && (boundary > bestBoundary || (boundary === bestBoundary && t < bestT)))) {
            bestDE = de
            bestT = t
            bestBoundary = boundary
          }
        }
      }
      consider(true) // prefer a real (≥ minArea) neighbour
      if (bestT < 0) consider(false) // else any neighbour
      if (bestT >= 0) union(g, bestT)
    }

    // Apply the relabel.
    let any = false
    for (let i = 0; i < n; i++) {
      const g = groupId[i]
      if (g < 0) continue
      const r = find(g)
      if (r !== g) {
        groupId[i] = r
        any = true
      }
    }
    if (!any) break
    changed = true
  }

  if (!changed) return { count: G, changed: false }

  // Compact surviving ids → 0..count-1 (ascending original id ⇒ deterministic).
  const remap = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const g = groupId[i]
    if (g >= 0 && !remap.has(g)) remap.set(g, 0)
  }
  const roots = [...remap.keys()].sort((a, b) => a - b)
  roots.forEach((g, idx) => remap.set(g, idx))
  for (let i = 0; i < n; i++) {
    const g = groupId[i]
    if (g >= 0) groupId[i] = remap.get(g)!
  }
  return { count: roots.length, changed: true }
}

/**
 * Build a SegmentResult from a per-pixel `groupId` labelling (used after marker
 * splits and small-region merges). Palette = mean original colour over each
 * group's opaque pixels; regionSamples = original colours of each group's smooth
 * pixels (or all its opaque pixels for an isolated all-𝒟 mark), strided. Groups
 * are ranked by pixel count desc, matching the default assembly.
 */
function assembleFromGroupId(
  groupId: Int32Array,
  groupCount: number,
  n: number,
  w: number,
  data: Uint8ClampedArray,
  smooth: Uint8Array,
  ms: MumfordShahResult,
  S: number,
  sampleCap: number,
): Omit<SegmentResult, 'preMergeLabels'> {
  const G = groupCount
  const cnt = new Float64Array(G)
  const sumR = new Float64Array(G)
  const sumG = new Float64Array(G)
  const sumB = new Float64Array(G)
  const xs: number[][] = Array.from({ length: G }, () => [])
  const ys: number[][] = Array.from({ length: G }, () => [])
  const rs: number[][] = Array.from({ length: G }, () => [])
  const gs: number[][] = Array.from({ length: G }, () => [])
  const bs: number[][] = Array.from({ length: G }, () => [])
  for (let i = 0; i < n; i++) {
    const g = groupId[i]
    if (g < 0) continue
    const o = i * 4
    cnt[g]++
    sumR[g] += data[o]
    sumG[g] += data[o + 1]
    sumB[g] += data[o + 2]
    if (smooth[i]) {
      xs[g].push(i % w)
      ys[g].push((i / w) | 0)
      rs[g].push(data[o])
      gs[g].push(data[o + 1])
      bs[g].push(data[o + 2])
    }
  }
  // Groups with no smooth pixels (isolated all-𝒟 marks) → sample all opaque pixels.
  let anyNeedAll = false
  const needAll = new Uint8Array(G)
  for (let g = 0; g < G; g++) {
    if (cnt[g] > 0 && xs[g].length === 0) {
      needAll[g] = 1
      anyNeedAll = true
    }
  }
  if (anyNeedAll) {
    for (let i = 0; i < n; i++) {
      const g = groupId[i]
      if (g < 0 || !needAll[g]) continue
      const o = i * 4
      xs[g].push(i % w)
      ys[g].push((i / w) | 0)
      rs[g].push(data[o])
      gs[g].push(data[o + 1])
      bs[g].push(data[o + 2])
    }
  }
  const order = Array.from({ length: G }, (_, g) => g).sort((a, b) => cnt[b] - cnt[a])
  const rank = new Int32Array(G)
  order.forEach((g, pos) => {
    rank[g] = pos
  })
  const palette: PaletteColor[] = order.map((g) => {
    const c = cnt[g] || 1
    return { r: clamp255(sumR[g] / c), g: clamp255(sumG[g] / c), b: clamp255(sumB[g] / c) }
  })
  const counts = order.map((g) => cnt[g])
  const regionSamples = order.map((g) => strideSamples(xs[g], ys[g], rs[g], gs[g], bs[g], sampleCap))
  const labels = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const g = groupId[i]
    labels[i] = g < 0 ? -1 : rank[g]
  }
  return { palette, labels, counts, ms, fineSegments: S, regionSamples }
}

/**
 * A group whose samples sit within this RMS Oklab ΔE of their own mean is a flat
 * colour block for the unwitnessed-jump veto's flat-flank condition. Flat sides of
 * real step fusions read near 0, pieces of smooth fields roughly twice this or
 * more; the threshold sits in the gap between them.
 */
const FLAT_FLANK_RES = 0.008

/** RMS Oklab ΔE of a sample set from its own mean colour — how far the group is
 *  from being a single flat colour. */
function solidResidual(s: RegionSamples): number {
  if (s.n === 0) return 0
  let mL = 0
  let mA = 0
  let mB = 0
  const labs: [number, number, number][] = []
  for (let i = 0; i < s.n; i++) {
    const o = srgbToOklab(s.rs[i], s.gs[i], s.bs[i])
    labs.push(o as unknown as [number, number, number])
    mL += o[0]
    mA += o[1]
    mB += o[2]
  }
  mL /= s.n
  mA /= s.n
  mB /= s.n
  let sq = 0
  for (const o of labs) {
    const dl = o[0] - mL
    const da = o[1] - mA
    const db = o[2] - mB
    sq += dl * dl + da * da + db * db
  }
  return Math.sqrt(sq / s.n)
}

/**
 * The colour jump a fitted gradient asserts that no sample witnesses (see
 * SegmentOptions.maxUnwitnessedJump): the largest Oklab ΔE, over every boundary
 * between consecutive samples along the gradient's own parameter t, between the
 * two sides' colour trends extrapolated to that boundary. Each side is a window
 * of width W = 1/24 in t; its trend is the least-squares line of Oklab against t
 * over the window (the plain mean when the window is too small or has no spread
 * in t). A smooth ramp's two trends meet at every boundary, steep or shallow, so
 * it reads ≈ 0; two flats of different colour meet nowhere, so the fit's step
 * between them reads its full contrast whatever axis the fit chose. Measured at
 * sample resolution: a binned version would miss a step narrower than a bin.
 */
function unwitnessedJump(g: GradientFill, s: RegionSamples): number {
  return unwitnessedStep(g, s).jump
}

/** unwitnessedJump with its location (`at`, in t) and the widest sample-free stretch of
 *  t strictly inside the union's own range (reported to the observer). */
function unwitnessedStep(g: GradientFill, s: RegionSamples): { jump: number; at: number; holeT: number } {
  const n = s.n
  if (n < 2) return { jump: 0, at: 0, holeT: 0 }
  const t = new Float64Array(n)
  const idx = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    t[i] = gradientParamT(g, s.xs[i], s.ys[i])
    idx[i] = i
  }
  idx.sort((a, b) => t[a] - t[b])
  // Sorted t and Oklab, with prefix sums for O(1) window means / regressions:
  // n, Σt, Σt², ΣL, Σa, Σb, ΣtL, Σta, Σtb.
  const ts = new Float64Array(n)
  const P = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(() => new Float64Array(n + 1))
  for (let k = 0; k < n; k++) {
    const i = idx[k]
    const o = srgbToOklab(s.rs[i], s.gs[i], s.bs[i])
    const tk = t[i]
    ts[k] = tk
    P[0][k + 1] = P[0][k] + 1
    P[1][k + 1] = P[1][k] + tk
    P[2][k + 1] = P[2][k] + tk * tk
    P[3][k + 1] = P[3][k] + o[0]
    P[4][k + 1] = P[4][k] + o[1]
    P[5][k + 1] = P[5][k] + o[2]
    P[6][k + 1] = P[6][k] + tk * o[0]
    P[7][k + 1] = P[7][k] + tk * o[1]
    P[8][k + 1] = P[8][k] + tk * o[2]
  }
  const W = 1 / 24
  // Linear trend of the sorted window [a,b) evaluated at tb; the mean when the
  // window has < 3 samples or no spread in t.
  const extrap = (a: number, b: number, tb: number): Oklab => {
    const c = P[0][b] - P[0][a] || 1
    const m: Oklab = [(P[3][b] - P[3][a]) / c, (P[4][b] - P[4][a]) / c, (P[5][b] - P[5][a]) / c]
    if (c < 3) return m
    const st = P[1][b] - P[1][a]
    const varT = P[2][b] - P[2][a] - (st * st) / c
    if (varT < 1e-12) return m
    const mt = st / c
    for (let ch = 0; ch < 3; ch++) {
      const sv = P[3 + ch][b] - P[3 + ch][a]
      const stv = P[6 + ch][b] - P[6 + ch][a]
      m[ch] += ((stv - (st * sv) / c) / varT) * (tb - mt)
    }
    return m
  }
  let jump = 0
  let at = 0
  let holeT = 0
  let lo = 0 // first sorted index with ts ≥ ts[k-1] − W
  let hi = 0 // first sorted index with ts > ts[k] + W
  for (let k = 1; k < n; k++) {
    const d = ts[k] - ts[k - 1]
    if (d > holeT) holeT = d
    while (ts[lo] < ts[k - 1] - W) lo++
    if (hi < k) hi = k
    while (hi < n && ts[hi] <= ts[k] + W) hi++
    const tb = (ts[k - 1] + ts[k]) / 2
    const x = oklabDeltaE(extrap(lo, k, tb), extrap(k, hi, tb))
    if (x > jump) {
      jump = x
      at = tb
    }
  }
  return { jump, at, holeT }
}

/** Observer-only: sample count per t-bin of a fitted gradient over a sample set (the
 *  bins profileGap reads). */
function tBins(g: GradientFill, s: RegionSamples, bins = 24): number[] {
  const cnt = new Array<number>(bins).fill(0)
  for (let i = 0; i < s.n; i++) {
    let bi = Math.floor(gradientParamT(g, s.xs[i], s.ys[i]) * bins)
    if (bi < 0) bi = 0
    else if (bi >= bins) bi = bins - 1
    cnt[bi]++
  }
  return cnt
}

/** Longest run of empty interior bins (as a fraction of [0,1]) of a gradient's
 *  per-sample parameter t — high ⇒ a bimodal profile (two distinct flats). */
function profileGap(g: GradientFill, s: RegionSamples, bins = 24): number {
  const filled = new Uint8Array(bins)
  for (let i = 0; i < s.n; i++) {
    const t = gradientParamT(g, s.xs[i], s.ys[i])
    let bi = Math.floor(t * bins)
    if (bi < 0) bi = 0
    else if (bi >= bins) bi = bins - 1
    filled[bi] = 1
  }
  // Trim leading/trailing empties (profile only spans where samples exist).
  let lo = 0
  while (lo < bins && !filled[lo]) lo++
  let hi = bins - 1
  while (hi >= 0 && !filled[hi]) hi--
  if (hi <= lo) return 0
  let maxRun = 0
  let run = 0
  for (let b = lo; b <= hi; b++) {
    if (filled[b]) run = 0
    else {
      run++
      if (run > maxRun) maxRun = run
    }
  }
  return maxRun / bins
}

/** Build a RegionSamples from JS arrays, strided down to at most `cap` points. */
function strideSamples(
  xs: number[],
  ys: number[],
  rs: number[],
  gs: number[],
  bs: number[],
  cap: number,
): RegionSamples {
  const total = xs.length
  const stride = total > cap ? Math.ceil(total / cap) : 1
  const m = Math.ceil(total / stride)
  const X = new Float64Array(m)
  const Y = new Float64Array(m)
  const R = new Float64Array(m)
  const Gc = new Float64Array(m)
  const B = new Float64Array(m)
  let k = 0
  for (let i = 0; i < total && k < m; i += stride) {
    X[k] = xs[i]
    Y[k] = ys[i]
    R[k] = rs[i]
    Gc[k] = gs[i]
    B[k] = bs[i]
    k++
  }
  return { xs: X, ys: Y, rs: R, gs: Gc, bs: B, n: k }
}

/** Concatenate sample sets then stride to `cap` (deterministic). */
function strideConcat(list: RegionSamples[], cap: number): RegionSamples {
  const all = concatSamples(list)
  if (all.n <= cap) return all
  const stride = Math.ceil(all.n / cap)
  const m = Math.ceil(all.n / stride)
  const X = new Float64Array(m)
  const Y = new Float64Array(m)
  const R = new Float64Array(m)
  const Gc = new Float64Array(m)
  const B = new Float64Array(m)
  let k = 0
  for (let i = 0; i < all.n && k < m; i += stride) {
    X[k] = all.xs[i]
    Y[k] = all.ys[i]
    R[k] = all.rs[i]
    Gc[k] = all.gs[i]
    B[k] = all.bs[i]
    k++
  }
  return { xs: X, ys: Y, rs: R, gs: Gc, bs: B, n: k }
}

/** Everything-one-region fallback (degenerate inputs). */
function fallbackSingleRegion(
  img: { width: number; height: number; data: Uint8ClampedArray },
  ms: MumfordShahResult,
): SegmentResult {
  const { width: w, height: h, data } = img
  const n = w * h
  const labels = new Int32Array(n)
  let r = 0
  let g = 0
  let b = 0
  let c = 0
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] < 128) {
      labels[i] = -1
      continue
    }
    labels[i] = 0
    r += data[i * 4]
    g += data[i * 4 + 1]
    b += data[i * 4 + 2]
    c++
  }
  const palette: PaletteColor[] = [{ r: clamp255(r / (c || 1)), g: clamp255(g / (c || 1)), b: clamp255(b / (c || 1)) }]
  const empty: RegionSamples = { xs: new Float64Array(0), ys: new Float64Array(0), rs: new Float64Array(0), gs: new Float64Array(0), bs: new Float64Array(0), n: 0 }
  return { palette, labels, counts: [c], ms, fineSegments: 1, regionSamples: [empty], preMergeLabels: labels }
}
