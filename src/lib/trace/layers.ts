// V6 — translucent layer decomposition (plan §9: "the real fix — layered/
// translucent decomposition"). The RESTRICTED, closed-form, logo-scale version
// of Photo2ClipArt / Du-et-al, structurally a sibling of the V4 glow-stack:
// per-region closed-form fit + an MDL/CIE76 gate that only fires when it beats
// the opaque model; otherwise a byte-identical no-op.
//
// The motivation (plan §9 "Translucent overlaps", V5 "Stage B abandoned"):
// petals/bloom are N see-through overlapping circles. The structure-first
// pipeline renders each segmented region as an OPAQUE flat band, so the
// translucent overlaps are split into many opaque puzzle-pieces. The source IS a
// few translucent shapes the renderer blends — so N circles at one opacity
// reproduce it EXACTLY with the fewest, most editable elements. This module turns
// the marker-recovered opaque pieces back into translucent stacked shapes.
//
// THE MATH. Straight alpha-over compositing of a shape (colour C, opacity α) over
// a colour X is linear in RGB: result = α·C + (1−α)·X. For a region covered by a
// subset of shapes over a known background BG, with a fixed stacking order, the
// observed colour is the iterated composite. Writing Eₛ = α·Cₛ + (1−α)·BG for a
// shape's EXCLUSIVE (single-shape-over-BG) colour, the composite telescopes to a
// recurrence that needs only Eₛ, BG and α (no per-shape colour):
//
//     X ← BG;  for each covering shape s, bottom→top:  X ← Eₛ + (1−α)·(X − BG)
//
// so a region covered by {i bottom, j top} reads Eⱼ + (1−α)(Eᵢ − BG), a triple
// reads Eₖ + (1−α)Eⱼ⁻ᴮᴳ + (1−α)²Eᵢ⁻ᴮᴳ, etc. Hence: the EXCLUSIVE region colours
// are measured directly (the atoms), the only free scalar is the shared α, and
// every overlap colour is determined. We recover α by a 1-D line search (a scalar
// fit, NOT a global/MCTS search), the shape colours close-form as
// Cₛ = (Eₛ − (1−α)·BG)/α, and discover which regions are the atoms + the stacking
// order by a tiny bounded enumeration (N ≤ 3 shapes; logo-scale).
//
// Pure + deterministic (fixed scan/enumeration orders, no Math.random/Date.now),
// no new dependencies — runs unchanged in the browser worker and under
// `node --test`.

import type { PaletteColor } from './types'
import type { RegionSamples } from './gradient.ts'
import { srgbToLab, deltaE76, type Lab } from './lab.ts'

/** One recovered translucent shape: the union of macro-regions it covers, its
 *  fitted opaque colour, and its opacity. */
export interface TranslucentShape {
  /** Macro-region labels whose UNION is this shape's mask (sorted, dedup). */
  labels: number[]
  /** Emitted fill colour #rrggbb (rounded to 8-bit — exactly what is rendered). */
  color: string
  /** Fill opacity α ∈ (0,1). */
  alpha: number
  /** Stacking rank, 0 = bottom-most translucent shape (paint order). */
  order: number
}

export interface Decomposition {
  /** Translucent shapes, returned in paint order (bottom-first). */
  shapes: TranslucentShape[]
  /** Labels consumed by the shapes (their opaque bands are REPLACED). Sorted. */
  consumed: number[]
  /** Background label — stays an opaque full-bleed layer beneath the shapes. */
  background: number
  /** Diagnostics for tuning / tests / the plan log. */
  debug: {
    shapeCount: number
    alpha: number
    /** Full-region mean CIE76 ΔE of the opaque (region-mean) model over consumed px. */
    opaqueMeanDE: number
    /** Full-region mean CIE76 ΔE of the translucent composite over consumed px. */
    transMeanDE: number
    /** opaqueMeanDE − transMeanDE (the gate margin). */
    gain: number
  }
}

export interface DecomposeOptions {
  /** Cap on translucent shapes (the verified 2–3 case; >3 is logged, not truncated). */
  maxShapes: number
  /** Above this many non-bg macro-regions, decline (caller keeps opaque — no truncation). */
  maxRegions: number
  /** Ignore macro-regions smaller than this (specks). */
  minRegionPixels: number
  /**
   * A region must be at least this CIE76 ΔE from the background to be part of the
   * decomposition. Excludes BACKGROUND FRAGMENTS — at high Region detail a slightly
   * noisy flat background can split into near-identical pieces; without this guard
   * one such piece gets promoted to a translucent "shape" the colour of the bg,
   * producing a garbage layer (measured on petals). Near-bg regions stay opaque.
   */
  bgMinDelta: number
  /** A multi-shape region must be at least this big to count as a real overlap. */
  minOverlapPixels: number
  /** CIE76 ΔE: a region must fit its best subset within this to be consumed. */
  colorTol: number
  /**
   * Full-region mean CIE76 ΔE the translucent composite must stay under to be
   * accepted — it must genuinely reproduce the consumed pixels. (On clean flat
   * overlaps the opaque region-mean model fits interiors just as well, so the
   * decomposition is selected on MDL — far fewer, cleaner elements at equal
   * fidelity — rather than on beating the opaque interior residual; see the V6
   * plan-log note. This ceiling is the fidelity guard.)
   */
  maxResidual: number
  /**
   * The translucent model may be at most this much WORSE than the opaque model on
   * the full-region residual (CIE76) — a safety guard so a bad decomposition that
   * is clearly less faithful is rejected even though it uses fewer elements.
   */
  maxWorseThanOpaque: number
  /** Shared-opacity search bounds. */
  alphaMin: number
  alphaMax: number
  /** Border ring must be at least this fraction opaque to anchor a background. */
  borderOpaqueFrac: number
}

export const DEFAULT_DECOMPOSE_OPTIONS: DecomposeOptions = {
  maxShapes: 3,
  maxRegions: 12,
  minRegionPixels: 24,
  bgMinDelta: 6,
  minOverlapPixels: 48,
  colorTol: 9,
  maxResidual: 4,
  maxWorseThanOpaque: 1,
  alphaMin: 0.3,
  alphaMax: 0.98,
  borderOpaqueFrac: 0.5,
}

type RGB = [number, number, number]

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v)
const hex2 = (n: number): string => {
  const s = Math.round(clamp255(n)).toString(16)
  return s.length < 2 ? '0' + s : s
}
const toHex = (c: RGB): string => '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2])

/**
 * Attempt a translucent decomposition of the segmented image. Returns null
 * (a no-op) whenever no clean translucent model beats the opaque one — i.e. when
 * there is no background to composite over, no overlap-shaped regions, the
 * structure exceeds the supported 2–3 shape case, or the gate margin isn't met.
 *
 * `palette`, `counts`, `fullSamples` are all parallel to the label values
 * (index = macro-region label); `fullSamples` are the FULL-region samples (every
 * labelled pixel incl. anti-aliased boundary px, strided), the same gate set the
 * glow-stack uses — so acceptance is measured on what the rasterizer renders, not
 * on the AA-free subset (the V4 lesson).
 */
export function decomposeTranslucent(
  labels: Int32Array,
  width: number,
  height: number,
  palette: PaletteColor[],
  counts: number[],
  fullSamples: RegionSamples[],
  opts: DecomposeOptions = DEFAULT_DECOMPOSE_OPTIONS,
): Decomposition | null {
  const paletteSize = palette.length
  if (paletteSize < 4) return null // need bg + ≥2 shapes + ≥1 overlap

  const bg = detectBackground(labels, width, height, paletteSize, opts.borderOpaqueFrac)
  if (bg < 0) return null
  const BG: RGB = [palette[bg].r, palette[bg].g, palette[bg].b]

  // Candidate (non-bg, non-speck, background-distinct) regions, in fixed label
  // order. Near-bg regions are dropped (background fragments — see bgMinDelta);
  // they stay opaque and are emitted normally by the caller.
  const bgLab = srgbToLab(BG[0], BG[1], BG[2])
  const regions: number[] = []
  for (let l = 0; l < paletteSize; l++) {
    if (l === bg) continue
    if ((counts[l] ?? 0) < opts.minRegionPixels) continue
    if (deltaE76(srgbToLab(palette[l].r, palette[l].g, palette[l].b), bgLab) < opts.bgMinDelta) continue
    regions.push(l)
  }
  if (regions.length < 3) return null // 2 shapes + 1 overlap is the minimum
  if (regions.length > opts.maxRegions) return null // too complex — keep opaque (not truncated)

  // Region observed colours (RGB) + Lab, parallel to `regions`.
  const E: RGB[] = regions.map((l) => [palette[l].r, palette[l].g, palette[l].b])

  // Atoms (the exclusive single-shape regions) must touch the background — this
  // excludes interior overlaps (e.g. a triple-overlap, which is surrounded by
  // pairwise overlaps) from ever being mistaken for a shape's body, and prunes
  // the enumeration. Pairwise overlaps also touch bg, so the colour fit + gate
  // still decide which bg-touching regions are the true atoms.
  const touchesBg = regionsTouchingBackground(labels, width, height, bg, regions)
  const atomCandidates: number[] = regions.filter((_, i) => touchesBg[i])
  if (atomCandidates.length < 2) return null

  // Index regions 0..m-1; bestSubset/fit work on indices, not labels.
  const idxOf = new Map<number, number>()
  regions.forEach((l, i) => idxOf.set(l, i))
  const candIdx = atomCandidates.map((l) => idxOf.get(l)!)

  type Cand = { shapes: TranslucentShape[]; consumed: number[]; gain: number; alpha: number; opaque: number; trans: number }
  let best: Cand | null = null
  // Prefer the MOST COMPLETE decomposition (explains the most regions), then the
  // best-fitting (lowest residual), then the simplest (fewest shapes). This picks
  // the true N-circle decomposition over a partial one that leaves regions opaque.
  // Strict comparisons + fixed enumeration order ⇒ deterministic first-found ties.
  const better = (c: Cand, b: Cand): boolean =>
    c.consumed.length > b.consumed.length ||
    (c.consumed.length === b.consumed.length && c.trans < b.trans - 1e-9) ||
    (c.consumed.length === b.consumed.length && Math.abs(c.trans - b.trans) <= 1e-9 && c.shapes.length < b.shapes.length)

  for (let N = 2; N <= opts.maxShapes; N++) {
    if (candIdx.length < N) break
    for (const atomSet of combinations(candIdx, N)) {
      for (const order of permutations(atomSet)) {
        const cand = evalHypothesis(order, regions, E, BG, counts, fullSamples, opts)
        if (cand && (!best || better(cand, best))) best = cand
      }
    }
  }

  if (!best) return null
  return {
    shapes: best.shapes,
    consumed: best.consumed,
    background: bg,
    debug: {
      shapeCount: best.shapes.length,
      alpha: best.alpha,
      opaqueMeanDE: best.opaque,
      transMeanDE: best.trans,
      gain: best.gain,
    },
  }
}

/**
 * Evaluate one hypothesis: a stacking order `order` (atom REGION-INDICES,
 * bottom→top) defines the N shapes. Fit the shared α (1-D line search), assign
 * every region to the covering subset whose composite best matches it, build the
 * shapes, and gate the result on the full-region CIE76 residual vs the opaque
 * (region-mean) model. Returns null when the hypothesis has no real overlap or
 * fails the gate.
 */
function evalHypothesis(
  order: number[],
  regions: number[],
  E: RGB[],
  BG: RGB,
  counts: number[],
  fullSamples: RegionSamples[],
  opts: DecomposeOptions,
): { shapes: TranslucentShape[]; consumed: number[]; gain: number; alpha: number; opaque: number; trans: number } | null {
  const N = order.length
  // pos[atomIndex] = its stacking rank; atomE[k] = the k-th atom's colour.
  // We index shapes by their position 0..N-1 in `order` for the bitmask/colour.
  const atomE: RGB[] = order.map((ri) => E[ri])

  // 1-D fit of the shared α: coarse grid then a refinement pass. The residual is
  // the pixel-weighted region-mean fit (cheap, monotone enough for a line search).
  const fitAt = (alpha: number): number => assignAndResidual(alpha, order, atomE, regions, E, BG, counts, opts).residual
  let aBest = opts.alphaMin
  let rBest = Infinity
  const coarse = 36
  for (let i = 0; i <= coarse; i++) {
    const a = opts.alphaMin + ((opts.alphaMax - opts.alphaMin) * i) / coarse
    const r = fitAt(a)
    if (r < rBest) {
      rBest = r
      aBest = a
    }
  }
  const span = (opts.alphaMax - opts.alphaMin) / coarse
  const fine = 20
  for (let i = -fine; i <= fine; i++) {
    const a = aBest + (span * i) / fine
    if (a < opts.alphaMin || a > opts.alphaMax) continue
    const r = fitAt(a)
    if (r < rBest - 1e-9) {
      rBest = r
      aBest = a
    }
  }
  const alpha = aBest

  // Final assignment at the chosen α.
  const asn = assignAndResidual(alpha, order, atomE, regions, E, BG, counts, opts)

  // Require at least one genuine multi-shape overlap region, else this is just
  // N opaque shapes — no translucency to gain.
  let realOverlap = false
  for (let i = 0; i < regions.length; i++) {
    if (!asn.consumed[i]) continue
    if (bitCount(asn.mask[i]) >= 2 && (counts[regions[i]] ?? 0) >= opts.minOverlapPixels) realOverlap = true
  }
  if (!realOverlap) return null

  // Emitted shape colours (rounded — exactly what the SVG paints).
  const inv = 1 / alpha
  const shapeRGB: RGB[] = atomE.map((e) => [
    clamp255((e[0] - (1 - alpha) * BG[0]) * inv),
    clamp255((e[1] - (1 - alpha) * BG[1]) * inv),
    clamp255((e[2] - (1 - alpha) * BG[2]) * inv),
  ])
  const shapeRGBRounded: RGB[] = shapeRGB.map((c) => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])])

  // GATE on the FULL region (every labelled pixel of the consumed regions, AA
  // included), in CIE76 — the glow-stack methodology. Opaque model paints each
  // pixel its region mean (palette); translucent model composites the rounded
  // shape colours over BG in stacking order (mirrors raster.ts compositeItem).
  let opaqueSum = 0
  let transSum = 0
  let nPix = 0
  for (let i = 0; i < regions.length; i++) {
    if (!asn.consumed[i]) continue
    const s = fullSamples[regions[i]]
    if (!s) continue
    const regLab = srgbToLab(E[i][0], E[i][1], E[i][2])
    const comp = compositeMask(asn.mask[i], order, alpha, shapeRGBRounded, BG)
    const compLab = srgbToLab(comp[0], comp[1], comp[2])
    for (let p = 0; p < s.n; p++) {
      const pxLab = srgbToLab(s.rs[p], s.gs[p], s.bs[p])
      opaqueSum += deltaE76(pxLab, regLab)
      transSum += deltaE76(pxLab, compLab)
      nPix++
    }
  }
  if (nPix === 0) return null
  const opaque = opaqueSum / nPix
  const trans = transSum / nPix
  const gain = opaque - trans

  // Fidelity gate: the translucent composite must reproduce the consumed pixels
  // well in absolute terms AND not be materially worse than the opaque model.
  // (It need not BEAT the opaque interior residual — on clean flat overlaps both
  // fit interiors equally; the decomposition wins on MDL: far fewer, cleaner
  // elements + exact composited overlap geometry. See the V6 plan-log note.)
  if (trans > opts.maxResidual) return null
  if (trans > opaque + opts.maxWorseThanOpaque) return null

  // Build the shapes: shape k covers every consumed region whose subset includes k.
  const shapes: TranslucentShape[] = []
  const consumedSet = new Set<number>()
  for (let k = 0; k < N; k++) {
    const lbls: number[] = []
    for (let i = 0; i < regions.length; i++) {
      if (asn.consumed[i] && asn.mask[i] & (1 << k)) {
        lbls.push(regions[i])
        consumedSet.add(regions[i])
      }
    }
    if (lbls.length === 0) return null // a shape with no body — degenerate
    shapes.push({ labels: lbls.sort((a, b) => a - b), color: toHex(shapeRGBRounded[k]), alpha, order: k })
  }
  const consumed = [...consumedSet].sort((a, b) => a - b)
  // Element reduction: the translucent shapes must be FEWER than the opaque bands
  // they replace, else there is no MDL win (and nothing to gain).
  if (shapes.length >= consumed.length) return null
  return { shapes, consumed, gain, alpha, opaque, trans }
}

/**
 * For a fixed α and stacking order, assign every region to the covering subset
 * (bitmask over the N shape positions) whose composite best matches its observed
 * colour; consume it when that fit is within `colorTol`. Returns the per-region
 * masks/consumed flags + the pixel-weighted mean fit residual (consumed only).
 */
function assignAndResidual(
  alpha: number,
  order: number[],
  atomE: RGB[],
  regions: number[],
  E: RGB[],
  BG: RGB,
  counts: number[],
  opts: DecomposeOptions,
): { mask: number[]; consumed: boolean[]; residual: number } {
  const N = order.length
  const full = (1 << N) - 1
  // Precompute each subset's predicted colour (atom-fold form: needs only Eₛ/BG).
  const pred: RGB[] = new Array(full + 1)
  for (let mask = 1; mask <= full; mask++) pred[mask] = foldAtoms(mask, alpha, atomE, BG)

  const maskOut: number[] = new Array(regions.length).fill(0)
  const consumed: boolean[] = new Array(regions.length).fill(false)
  let wsum = 0
  let dsum = 0
  for (let i = 0; i < regions.length; i++) {
    const target = srgbToLab(E[i][0], E[i][1], E[i][2])
    let bestMask = 1
    let bestDE = Infinity
    for (let mask = 1; mask <= full; mask++) {
      const c = pred[mask]
      const de = deltaE76(target, srgbToLab(c[0], c[1], c[2]))
      // Prefer the simpler (fewer-shape) subset on a near-tie — keeps overlaps
      // from being explained by spurious extra layers.
      if (de < bestDE - 1e-9 || (de < bestDE + 0.25 && bitCount(mask) < bitCount(bestMask))) {
        bestDE = de
        bestMask = mask
      }
    }
    maskOut[i] = bestMask
    if (bestDE <= opts.colorTol) consumed[i] = true
    // Residual for the α-fit is over ALL regions (capped), NOT only consumed: an
    // EXCLUSIVE region fits perfectly at ANY α (its atom colour absorbs α), so only
    // the OVERLAP regions' fit varies with α. Measuring over all regions therefore
    // drives the search to the α that best explains the overlaps; measuring over
    // only-consumed would instead let α→1 drop the hard overlaps and win on the
    // trivially-fit exclusives (a degenerate optimum).
    const w = counts[regions[i]] ?? 1
    wsum += w
    dsum += w * Math.min(bestDE, opts.colorTol * 3)
  }
  return { mask: maskOut, consumed, residual: wsum > 0 ? dsum / wsum : Infinity }
}

/** Atom-fold composite (uses exclusive colours Eₛ, no per-shape colour): the
 *  exact reconstruction the α-fit minimises. `mask` is over the N positions of
 *  `order`; folds bottom→top per `order`. */
function foldAtoms(mask: number, alpha: number, atomE: RGB[], BG: RGB): RGB {
  let X: RGB = [BG[0], BG[1], BG[2]]
  const t = 1 - alpha
  for (let p = 0; p < atomE.length; p++) {
    if (!(mask & (1 << p))) continue
    const e = atomE[p]
    X = [e[0] + t * (X[0] - BG[0]), e[1] + t * (X[1] - BG[1]), e[2] + t * (X[2] - BG[2])]
  }
  return X
}

/** Straight alpha-over composite of the masked shapes' ROUNDED colours over BG,
 *  bottom→top per `order` — mirrors raster.ts compositeItem exactly, so the gate
 *  measures what the renderer paints. */
function compositeMask(mask: number, order: number[], alpha: number, shapeRGB: RGB[], BG: RGB): RGB {
  let X: RGB = [BG[0], BG[1], BG[2]]
  const ia = 1 - alpha
  for (let p = 0; p < order.length; p++) {
    if (!(mask & (1 << p))) continue
    const c = shapeRGB[p]
    X = [c[0] * alpha + X[0] * ia, c[1] * alpha + X[1] * ia, c[2] * alpha + X[2] * ia]
  }
  return X
}

const bitCount = (m: number): number => {
  let c = 0
  while (m) {
    m &= m - 1
    c++
  }
  return c
}

/**
 * Background = the most frequent label on the 1px border ring, when the ring is
 * at least `frac` opaque (an image floating on transparency, or with no dominant
 * border colour, returns −1 — nothing to composite over). Mirrors index.ts
 * detectBorderBackground.
 */
function detectBackground(labels: Int32Array, width: number, height: number, paletteSize: number, frac: number): number {
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
  if (ringTotal === 0 || opaque / ringTotal < frac) return -1
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

/** For each region (in `regions` order), whether any of its pixels 4-touches a
 *  background pixel — the atom-candidate filter. */
function regionsTouchingBackground(labels: Int32Array, width: number, height: number, bg: number, regions: number[]): boolean[] {
  const touch = new Set<number>()
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (labels[i] !== bg) continue
      if (x > 0 && labels[i - 1] >= 0 && labels[i - 1] !== bg) touch.add(labels[i - 1])
      if (x + 1 < width && labels[i + 1] >= 0 && labels[i + 1] !== bg) touch.add(labels[i + 1])
      if (y > 0 && labels[i - width] >= 0 && labels[i - width] !== bg) touch.add(labels[i - width])
      if (y + 1 < height && labels[i + width] >= 0 && labels[i + width] !== bg) touch.add(labels[i + width])
    }
  }
  return regions.map((l) => touch.has(l))
}

/** All N-element combinations of `arr` (lexicographic by input order — deterministic). */
function combinations(arr: number[], k: number): number[][] {
  const out: number[][] = []
  const combo: number[] = []
  const rec = (start: number): void => {
    if (combo.length === k) {
      out.push(combo.slice())
      return
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i])
      rec(i + 1)
      combo.pop()
    }
  }
  rec(0)
  return out
}

/** All permutations of `arr` (Heap-free recursive, fixed order — deterministic). */
function permutations(arr: number[]): number[][] {
  if (arr.length <= 1) return [arr.slice()]
  const out: number[][] = []
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1))
    for (const p of permutations(rest)) out.push([arr[i], ...p])
  }
  return out
}
