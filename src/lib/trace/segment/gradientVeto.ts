// Step-3c merge vetoes: flat-flank residual, unwitnessed jump and profile gap of a union fit.

import { srgbToOklab, oklabDeltaE, type Oklab } from '../oklab.ts'
import { gradientParamT, type RegionSamples } from '../gradient.ts'
import type { GradientFill } from '../../path/types'

/**
 * A group whose samples sit within this RMS Oklab ΔE of their own mean is a flat
 * colour block for the unwitnessed-jump veto's flat-flank condition. Flat sides of
 * real step fusions read near 0, pieces of smooth fields roughly twice this or
 * more; the threshold sits in the gap between them.
 */
export const FLAT_FLANK_RES = 0.008

/** RMS Oklab ΔE of a sample set from its own mean colour — how far the group is
 *  from being a single flat colour. */
export function solidResidual(s: RegionSamples): number {
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
export function unwitnessedJump(g: GradientFill, s: RegionSamples): number {
  return unwitnessedStep(g, s).jump
}

/** unwitnessedJump with its location (`at`, in t) and the widest sample-free stretch of
 *  t strictly inside the union's own range (reported to the observer). */
export function unwitnessedStep(g: GradientFill, s: RegionSamples): { jump: number; at: number; holeT: number } {
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
export function tBins(g: GradientFill, s: RegionSamples, bins = 24): number[] {
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
export function profileGap(g: GradientFill, s: RegionSamples, bins = 24): number {
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
