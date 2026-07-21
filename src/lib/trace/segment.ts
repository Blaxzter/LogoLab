// Structure-first smoothness segmentation (Stage 1 of the V2 vectorizer — plan
// §3.1 / §4.1–4.2, blueprint paper §3.1–3.2 + Supplement Algorithms 1–2).
//
// Replaces the V1 posterize-then-mend path (k-means bands → union-refit). Order:
//
//   1. Mumford–Shah smoothing  → smoothed u + discontinuity map 𝒟  (mumfordShah.ts)
//   2. Colour-difference merge  → fine segments S₀ of the SMOOTH pixels (𝒟̄), by
//      agglomerative CIELAB merging with τ_s = 10 (Supplement Alg 1).
//   3. Discontinuity-aware merge → macro-regions: a GLOBAL greedy union-fit merge
//      (two segments merge iff one gradient explains their union in Oklab) gated by
//      two vetoes —
//        • edge veto 𝒜 (eq 3): pairs facing each other across 𝒟 (opposite sides
//          within σ = 5 px, facing density > τ_a = 0.25) are must-stay-separate —
//          this is the principled fix for V1's latent flat-colour bridging across a
//          true edge;
//        • profile-gap veto: a union whose colour profile is bimodal (a wide empty
//          span along the fitted axis) is two distinct flats, not one field — so a
//          blue and a red shape never fuse into a fake ramp even when non-adjacent.
//      The global (non-adjacent) merge is what reunites a background that 𝒟 has
//      split — e.g. nebula's field outside the ring and in the ring's hole — into
//      ONE gradient region, while the edge veto keeps the ring itself separate.
//   4. Anti-aliased 𝒟 pixels  → flooded into the neighbouring macro-region whose
//      mean colour best matches (the §3.4 convex-combination test, approximated by
//      nearest fill), so the output label map is complete.
//   5. Small-region merge (opt-in, `minRegionArea` from the Despeckle dial) →
//      absorb every macro-region below the area threshold into its nearest-colour
//      neighbour, so anti-alias / colour-ramp TRANSITION SLIVERS don't survive as
//      their own tiny shapes. Engine-agnostic (runs here, before tracing); 0 ⇒ off
//      (byte-identical). User-marked regions are protected from being absorbed.
//
// Output is QuantizeResult-shaped (labels / palette / counts, largest region
// first) so the existing stacked-mask tracer consumes it unchanged. Pure and
// deterministic (no PRNG, fixed scan orders): runs under `node --test`.

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
   * this across a SAMPLE-FREE stretch of its parameter t (an "unwitnessed
   * jump"). This is the step-fit veto: a multi-stop gradient can explain
   * {big flat region} ∪ {small far-away flat-ish sliver} almost perfectly as a
   * step function — flat, jump, flat — with an RMS residual BELOW the honest
   * adjacent merge's (a real ramp carries curvature; a step of two flats is
   * exact), so greedy hands e.g. a gradient background's corner band to a WHITE
   * shape's colour class (the nebula-png / gradient-flat corner sliver, painted
   * flat mid-gradient). The step's signature is that its entire contrast sits in
   * a t-run NO sample witnesses; a genuine smooth field is witnessed everywhere
   * along its own axis (consecutive filled bins abut), and a genuine reunite
   * (nebula's field outside the ring re-joining the hole) OVERLAPS in t. NOT the
   * reverted profileCliff veto: that measured contrast at the pair's colour seam
   * (inverted between real bg-reunite and fake, see §0 history); this measures
   * contrast across EMPTY parameter space. Calibrated on tier 0+1: honest
   * unions sit ≈0; the degenerate step-pastes measure 0.29–0.75. ≥1 disables.
   */
  maxUnwitnessedJump: number
  /**
   * Run Step 3c, the global gradient-explained union-fit merge. Its job is to fuse
   * the colour-difference bands of a smooth ramp back into ONE gradient region so
   * Stage 2 can paint it as a single gradient. When the user has gradients OFF that
   * region would instead be flattened to its MEAN colour (a wide ramp → muddy
   * average), so we skip the merge: the Step-2 bands survive and posterize into
   * several flat regions. Default true (byte-identical to before). */
  mergeGradients: boolean
  /** Cap on samples per segment fed to a union fit (perf; deterministic stride). */
  sampleCap: number
  /**
   * Step-3c candidate gate, in Oklab ΔE — the fix for complex photos freezing on
   * "analyzing colors". It engages ONLY once the fine-segment count exceeds
   * GATE_MIN_SEGMENTS (small gradient art stays fully un-gated, byte-identical, so its
   * non-adjacent field reunites are untouched). When engaged, a segment pair reaches
   * the expensive gradient fit only if the groups are ADJACENT, OR (when meanGate > 0)
   * their mean colours are within meanGate. Adjacency alone fuses every contiguous
   * ramp; the optional mean clause additionally re-joins NON-adjacent same-mean pieces
   * (a background a discontinuity split) — but measured on real photos that clause both
   * SLOWS the merge ~10–80× (clusters of similar-mean but distinct objects each pay a
   * fit) and slightly WORSENS fidelity (distant pieces forced into one stretched
   * gradient), so it defaults OFF (0 ⇒ adjacency-only). Raise it to trade speed for
   * recovering non-adjacent reunites on large smooth art. Only consulted when
   * `mergeGradients` is on.
   */
  meanGate: number
  /**
   * Minimum macro-region area (opaque px). After segmentation, any region smaller
   * than this is absorbed into the adjacent region whose mean colour is closest —
   * so anti-alias / colour-ramp TRANSITION SLIVERS don't survive as their own tiny
   * shapes (the user-reported "miniature regions in colour transitions"). Engine-
   * agnostic: it runs in segmentation, so crisp / potrace / planar all benefit.
   * 0 ⇒ disabled (byte-identical to before). Driven by the Despeckle dial.
   */
  minRegionArea: number
  /**
   * "Flat" region markers in NORMALIZED [0,1] coords — DISTINCT from `markers`. Each
   * flat marker's PRE-merge fine segment is EXCLUDED from the Step-3c gradient field
   * merge, so it survives as its own region instead of being fused into a (often
   * nonsensical) gradient with its neighbours. The exclusion happens before the Step-4
   * anti-alias flood, so the flood settles the region's boundary on the true colour
   * edge — clean geometry, and a SINGLE marker suffices. Painted solid downstream
   * (index.ts). Omitted / empty ⇒ no effect. Fixed input order.
   */
  flatMarkers?: { x: number; y: number }[]
  /**
   * User-placed region markers in NORMALIZED [0,1] image coordinates (converted
   * to pixels here against the image's own width/height, so they are correct at
   * any raster resolution). Marker-watershed constraint: each marker seeds a
   * distinct region; two segments carrying DIFFERENT markers must never merge
   * (vetoed in BOTH merge steps — the colour-difference seeded growth and the
   * global union-fit), and a marked segment is exempt from being absorbed away.
   * Omitted / empty ⇒ no behaviour change (byte-identical output). Processed in
   * fixed input order so the veto is deterministic.
   */
  markers?: { x: number; y: number }[]
}

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
 * Fine-segment count above which the Step-3c candidate gate switches on. Below it the
 * un-gated all-pairs merge is already fast (a handful of segments), and skipping the
 * gate keeps simple art byte-identical to before — only complex images (the photos
 * that froze on "analyzing colors") pay the O(S²) fit burst the gate removes.
 */
const GATE_MIN_SEGMENTS = 64

export interface SegmentResult extends QuantizeResult {
  /** Mumford–Shah by-products (diagnostics; not required downstream). */
  ms: MumfordShahResult
  /** Number of fine segments S₀ before discontinuity-aware merging. */
  fineSegments: number
  /**
   * Per-pixel PRE-merge region id — the fine segments (S₀) as they stand BEFORE
   * the Step-3c gradient field-merge fuses them into macro-regions. −1 for
   * anti-aliased / transparent pixels. This is the "region detection before the
   * macro field merging": the editor highlights these on hover, and the user
   * picks one to keep flat. (`labels` is the final, post-merge map.)
   */
  preMergeLabels: Int32Array
  /**
   * Per macro-region (parallel to `palette`/`counts`), the SMOOTH-pixel samples
   * used for the merge — anti-aliased 𝒟 pixels excluded — so Stage 2 fits its
   * paint model on clean colours (this is what makes the §3.3 boundary-distance
   * weighting unnecessary: the boundary AA pixels were never sampled).
   */
  regionSamples: RegionSamples[]
}

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))

/**
 * Nearest SMOOTH pixel to (px,py) by an expanding Chebyshev-ring scan (fixed
 * order ⇒ deterministic). Returns its index, or −1 if the image has none within
 * range. A marker dropped on a discontinuity / transparent pixel snaps to the
 * closest real segment instead of being lost; rings are scanned out to a bound
 * so a wildly-misplaced marker degrades to a no-op rather than a full sweep.
 */
function nearestSmoothPixel(smooth: Uint8Array, w: number, h: number, px: number, py: number): number {
  if (smooth[py * w + px]) return py * w + px
  const maxR = Math.min(Math.max(w, h), 64)
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
 * given) reports a fraction in [0,1] of the segmentation work plus a short label —
 * the Step-3c gradient merge is the long pole on complex images, so it reports per-
 * batch there so the studio's bar keeps moving. Pure-progress only: it never changes
 * the result, so determinism holds.
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

  // Per-pixel CIELAB of the SMOOTHED image (segmentation colour) — eq uses the
  // smooth solution so AA/noise doesn't fragment a region.
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
  // Each marker (normalised [0,1], fixed input order) claims the nearest SMOOTH
  // pixel; duplicate / unreachable seeds are dropped so the set is deterministic.
  // The two kinds act DIFFERENTLY:
  //
  //   • keep-separate `markers` → SEEDED REGION GROWING split (markerControlledSplit
  //     below): a macro-region holding ≥2 of them is partitioned by growing a sub-
  //     region from each, the boundary settling on the colour RIDGE between them.
  //     This recovers a translucent overlap whose colour is within τ_s of the shape
  //     beneath it (their means merge, so an exclusion can't tell them apart, but the
  //     seeded growth still finds the step). Needs ≥2 — one front has nothing to
  //     grow against.
  //
  //   • `flatMarkers` → EXCLUSION from the Step-3c field merge (flatPinned, below):
  //     the marker's fine segment is forbidden from fusing into a macro-region, so it
  //     survives as its own region. Because this happens BEFORE the Step-4 anti-alias
  //     flood, the flood then assigns the boundary AA to the nearest colour and the
  //     region's edge lands on the true colour edge — clean geometry, and a SINGLE
  //     marker is enough. This is the fix for "the merger fused a red sliver into the
  //     white and fit a nonsense ring gradient": the sliver becomes its own flat red.
  //
  // With no markers nothing here changes the output (byte-identical).
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
  // Loop to a TRUE fixpoint (Supplement Alg 1). Termination is guaranteed: every
  // productive pass calls unite() at least once, strictly reducing the live
  // segment count (bounded by n), so a pass with no merge ends it — no fixed cap
  // (a cap could silently under-merge a long serpentine ramp and is unnecessary).
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

  // Flat-marker pins: the fine segment id under each flat marker. These are excluded
  // from the Step-3c field merge (evalPair, below), so each stays its own region in
  // its pre-merge flat form. Held out BEFORE the Step-4 flood so the AA settles on
  // the true colour edge. Empty without flat markers ⇒ the merge proceeds unchanged.
  const flatPinned = new Set<number>()
  for (const seed of flatSeeds) {
    const s = segOf[seed]
    if (s >= 0) flatPinned.add(s)
  }

  report(0.35, 'Detecting edges')
  // --- Step 3a: discontinuity relation 𝒜 (eq 3) -------------------------------
  // For each 𝒟 pixel and each of 3 axes (→, ↓, ↘), find the nearest smooth
  // segment within σ on each side. A pair seen on OPPOSITE sides is a "facing"
  // observation; any pair seen near the same 𝒟 pixel is a "touch". A pair whose
  // facing/touch ratio exceeds τ_a is must-stay-separate.
  //
  // NOTE on calibration: `facing` is tallied per-AXIS (a pixel facing the same
  // pair across →, ↓ and ↘ counts up to 3×) while `touch` is per-PIXEL, so the
  // ratio f/t is intentionally NOT the paper's normalized [0,1] density — it is
  // weighted toward firing the veto. That bias is the SAFE direction: an
  // over-eager edge veto keeps a true edge separate (the plan's §3.2 failure mode
  // to avoid is the opposite — greedy merging BRIDGING a real edge). τ_a is held
  // at the paper's 0.25 but its effective scale differs by this per-axis weighting.
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
  // --- Step 3b: gather per-segment samples (ORIGINAL colours) ------------------
  // Also accumulate each segment's exact colour SUM (every pixel, not the strided
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

  // --- Step 3c: global greedy union-fit merge with both vetoes -----------------
  // Merge the globally-cheapest qualifying (non-vetoed, low-residual, unimodal) pair
  // until none qualifies. Groups carry STABLE ids (never reused) so a pairwise
  // candidate cache survives across merges: only the merged group's row is recomputed.
  // The SELECTION — global-min residual, ties broken by scan position — is byte-for-
  // byte the original, so corpus output is stable. The additions are pure cost cuts:
  //   • CANDIDATE GATE (`meanGate`, only once S exceeds GATE_MIN_SEGMENTS — i.e. the
  //     complex images that froze) — a pair reaches the expensive gradient fit only
  //     when the groups are ADJACENT or their mean colours are within meanGate. It
  //     covers every DESIRABLE merge (adjacent ramp bands; non-adjacent SAME-mean
  //     field pieces) while the ~S²/2 fit burst collapses to the eligible few. NOTE
  //     it is NOT a superset of what un-gated global-min can select: the step-fit
  //     degeneracy (see maxUnwitnessedJump) let the un-gated scan pick non-adjacent
  //     DIFFERENT-mean pairs — pairs this gate would rightly refuse (§10.3).
  //   • INDEXED cache invalidation — each merge drops only the two retired groups'
  //     cache rows via a per-group key index, instead of sweeping the whole cache
  //     (the old `[...cache.keys()]` spread was itself O(S²) per merge).
  const members = new Map<number, number[]>()
  const samples = new Map<number, RegionSamples>()
  const alive: number[] = []
  for (let id = 0; id < S; id++) {
    members.set(id, [id])
    samples.set(id, segSamples[id])
    alive.push(id)
  }
  let nextId = S

  // Gradients OFF ⇒ skip the merge entirely: leave the Step-2 colour-difference
  // bands as the macro-regions so a smooth ramp posterizes into flats instead of
  // fusing into one region that Stage 2 would then average to a muddy mean colour.
  if (opts.mergeGradients) {
    const gated = S > GATE_MIN_SEGMENTS
    const useMean = gated && opts.meanGate > 0 && Number.isFinite(opts.meanGate)

    // Per-group adjacency (always, when gated) + running colour means (only for the
    // optional mean clause). Built lazily so the common adjacency-only path pays
    // nothing for the means it never reads.
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
    // Gate: adjacent OR (optionally) mean-near. Un-gated (small S) ⇒ every pair is
    // eligible, exactly the original all-pairs search. The mean clause is evaluated
    // only when enabled, so adjacency-only never pays for an Oklab distance.
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
    // A flat-pinned segment never merges (it stays its own region). Its group id equals
    // the segment id and is never retired — a vetoed group is never the merge target —
    // so the singleton check stays valid; freshly-merged groups get ids ≥ S, never pinned.
    const evalPair = (gi: number, gj: number): { res: number; samples: RegionSamples } | null => {
      const k = ckey(gi, gj)
      if (cache.has(k)) return cache.get(k)!
      let result: { res: number; samples: RegionSamples } | null = null
      if (!flatPinned.has(gi) && !flatPinned.has(gj) && gateEligible(gi, gj) && !pairVetoed(gi, gj)) {
        const union = strideConcat([samples.get(gi)!, samples.get(gj)!], opts.sampleCap)
        const fit = fitBestGradient(union)
        if (
          fit &&
          fit.oklabResidual <= opts.mergeTol &&
          profileGap(fit.gradient, union) <= opts.maxProfileGap &&
          unwitnessedJump(fit.gradient, union) <= opts.maxUnwitnessedJump
        ) {
          result = { res: fit.oklabResidual, samples: union }
        }
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
          // Creep the bar through the cold first scan (the long pole) so it never
          // freezes; the `seeding` guard makes this zero-overhead once cached.
          if (seeding && (++seedEvals & 8191) === 0) {
            report(0.45 + 0.1 * Math.min(1, (2 * seedEvals) / (A0 * A0)), 'Merging regions')
          }
        }
      }
      seeding = false
      if (!best) break
      const c = nextId++
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
      // Retire the two merged groups: drop them from `alive`, invalidate ONLY their
      // cache rows (same keys the old whole-cache sweep removed ⇒ identical state).
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
  // assigned by repeated nearest-neighbour passes, choosing the adjacent group
  // whose mean ORIGINAL colour best matches the pixel (the §3.4 convex-combo test,
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

  // Any opaque pixel STILL unassigned is an isolated all-𝒟 component — a thin mark
  // on transparency whose every pixel is a discontinuity (no smooth seed), which
  // the flood can never reach. Seed each 4-connected such component as its OWN
  // macro-region so the feature survives, instead of being emitted as the
  // transparent sentinel −1 (which the stacked-mask tracer drops as a hole).
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
  // Any macro-region that ended up containing ≥2 markers is partitioned by growing
  // a sub-region out from each marker (Adams–Bischof seeded region growing on the
  // ORIGINAL-colour Lab, confined to that region's pixels), so the boundary settles
  // on the colour RIDGE between the marked sub-regions. This recovers a translucent
  // overlap cleanly from the shape beneath it at the DEFAULT detail, even though
  // their mean colours merge. No-marker runs skip this entirely and take the exact
  // existing assembly below (byte-identical output).
  if (hasMarkers) {
    // Flat markers already separated their regions by exclusion above; keep-separate
    // markers split here. Only build the original-colour Lab + run the split when
    // there are keep-separate seeds.
    let groupCount = G + extra.length
    if (splitSeeds.length > 0) {
      // Grow on ORIGINAL-colour Lab, not the MS-smoothed Lab: smoothing erases the
      // subtle overlap edges (they fall below its threshold), which would leave the
      // ridge fuzzy and the split boundary off the true edge (a seam). The original
      // colour keeps the step sharp so the boundary settles exactly on it.
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
  // nearest-colour neighbour. Only diverges from the exact existing assembly when
  // a merge actually fires; otherwise the no-marker path stays byte-identical. ---
  if (opts.minRegionArea > 0) {
    const merged = mergeSmallRegions(groupId, G + extra.length, n, w, h, data, opts.minRegionArea, NO_PROTECTED)
    if (merged.changed) return { ...assembleFromGroupId(groupId, merged.count, n, w, data, smooth, ms, S, opts.sampleCap), preMergeLabels: segOf }
  }

  // --- Assemble QuantizeResult over all macro-regions (smooth groups + isolated
  // 𝒟 components), sorted by pixel count desc (largest = bottom full-bleed layer).
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
// Marker-controlled seeded region growing — the split that makes user markers
// recover translucent overlaps cleanly. Adams & Bischof (1994): grow each seed's
// region by repeatedly claiming the unassigned boundary pixel most similar to a
// region's running mean (a priority queue), so the boundary settles on the colour
// RIDGE between regions — works even when the regions' mean colours are within the
// global merge threshold and the step is subtle (the translucent-overlap case),
// and at the default detail (no global τ_s drop, no fragmentation).
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
 * region, so anti-alias / colour-ramp transition SLIVERS don't survive as their
 * own tiny shapes. Each small region is merged into the neighbour whose mean
 * ORIGINAL colour is closest — preferring a neighbour that is itself ≥ minArea, so
 * slivers collapse into real shapes rather than chaining through each other — which
 * minimises the recolour error the merge introduces. `protected` groups (user
 * markers) are never absorbed, though they may absorb. Mutates `groupId` in place
 * (relabelled then COMPACTED to 0..count-1) and returns the new group count +
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
 * Build a SegmentResult straight from a per-pixel `groupId` labelling (used by the
 * marker-split path). Palette = mean ORIGINAL colour over each group's opaque
 * pixels; regionSamples = original colours of each group's SMOOTH pixels (or, for a
 * group with no smooth pixels — an isolated all-𝒟 mark — all its opaque pixels),
 * strided. Groups are ranked by pixel count desc (largest = bottom layer), matching
 * the default assembly. Only reached when markers are present (the no-marker path
 * keeps its exact existing assembly, so its output stays byte-identical).
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
 * Largest Oklab ΔE between the sample populations flanking an EMPTY interior
 * run of the fitted gradient's parameter t — the colour jump the gradient makes
 * where NO sample witnesses it (see SegmentOptions.maxUnwitnessedJump). Each
 * side's colour pools up to two filled bins so a single sparse bin can't fake
 * or hide a jump. 0 when every pair of consecutive filled bins abuts.
 */
function unwitnessedJump(g: GradientFill, s: RegionSamples, bins = 24): number {
  const cnt = new Uint32Array(bins)
  const sL = new Float64Array(bins)
  const sA = new Float64Array(bins)
  const sB = new Float64Array(bins)
  for (let i = 0; i < s.n; i++) {
    const t = gradientParamT(g, s.xs[i], s.ys[i])
    let bi = Math.floor(t * bins)
    if (bi < 0) bi = 0
    else if (bi >= bins) bi = bins - 1
    const o = srgbToOklab(s.rs[i], s.gs[i], s.bs[i])
    cnt[bi]++
    sL[bi] += o[0]
    sA[bi] += o[1]
    sB[bi] += o[2]
  }
  // Pooled mean colour of the filled bin at `b` plus the next filled bin further
  // away from the gap (direction `dir`), if any.
  const sideMean = (b: number, dir: -1 | 1): Oklab => {
    let c = cnt[b]
    let L = sL[b]
    let a = sA[b]
    let bb = sB[b]
    for (let j = b + dir; j >= 0 && j < bins; j += dir) {
      if (!cnt[j]) continue
      c += cnt[j]
      L += sL[j]
      a += sA[j]
      bb += sB[j]
      break
    }
    return [L / c, a / c, bb / c]
  }
  let jump = 0
  let prev = -1
  for (let b = 0; b < bins; b++) {
    if (!cnt[b]) continue
    if (prev >= 0 && b - prev > 1) {
      const d = oklabDeltaE(sideMean(prev, -1), sideMean(b, 1))
      if (d > jump) jump = d
    }
    prev = b
  }
  return jump
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
