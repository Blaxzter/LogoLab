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

import type { PaletteColor } from './types'
import { solveMumfordShah } from './mumfordShah.ts'
import { srgbToLab, deltaE76 } from './lab.ts'
import { srgbToOklab, oklabDeltaE, type Oklab } from './oklab.ts'
import { fitBestGradient, type RegionSamples } from './gradient.ts'
import { DEFAULT_SEGMENT_OPTIONS, type SegmentOptions, type SegmentResult, type MergePairRecord } from './segment/options.ts'
import { clamp255, strideSamples, strideConcat } from './segment/samples.ts'
import { nearestSmoothPixel, markerControlledSplit } from './segment/markers.ts'
import { mergeSmallRegions } from './segment/smallRegions.ts'
import { assembleFromGroupId, fallbackSingleRegion } from './segment/assemble.ts'
import { FLAT_FLANK_RES, solidResidual, unwitnessedJump, unwitnessedStep, tBins, profileGap } from './segment/gradientVeto.ts'

export { DEFAULT_SEGMENT_OPTIONS } from './segment/options.ts'
export type { SegmentOptions, MergePairRecord, MergePairObserver, SegmentResult } from './segment/options.ts'
export { MARKER_SNAP_FRAC, MARKER_SNAP_MIN, markerSnapRadius } from './segment/markers.ts'

/** Reusable empty protected-group set (the no-marker merge protects nothing). */
const NO_PROTECTED: ReadonlySet<number> = new Set<number>()

/**
 * Fine-segment count above which the Step-3c candidate gate switches on. Below it
 * the ungated all-pairs merge is already fast, and simple art keeps its
 * non-adjacent reunites.
 */
const GATE_MIN_SEGMENTS = 64

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
