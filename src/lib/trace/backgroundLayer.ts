// Experimental background layer separation (`VectorizeOptions.backgroundGradient`,
// planar tracer with gradients off).
//
// With gradients off, a smooth background ramp posterizes into flat bands. The
// tracer then traces every band-to-band boundary (a noisy nearest-colour frontier
// that vectorizes jagged) and mints a junction wherever a band touches a
// foreground outline, splitting e.g. a ring into separately fitted arcs. Both
// defects come from the bands existing, so this pass removes them:
//
//   1. seed with the border-ring background label (passed in by the caller),
//   2. grow the set over adjacent labels, accepting a candidate only when the
//      union's fitted gradient renders the candidate's pixels about as well as
//      its own flat band colour does (a per-pixel CIE76 render test),
//   3. relabel the accepted set to the seed and paint that one region with the
//      fitted gradient.
//
// The render test keeps real art out of the union: absorbing a distinct flat
// shape forces the gradient across pixels the source renders crisp, so it loses
// to the band colour. A posterized ramp's banding loses to a smooth fit, so it
// merges. Deterministic: ascending scans, fixed thresholds.

import type { GradientFill } from '../path/types'
import { concatSamples, fitBestGradient, sampleGradient, type RegionSamples } from './gradient.ts'
import { srgbToLab, deltaE76 } from './lab.ts'

/** Cheap pre-filter: max Oklab RMS residual for a candidate union fit (the same
 *  default as the gradient merge's `mergeTol`). Skips the render test for hopeless fits. */
const UNION_TOL = 0.06
/** Cap on the union sample count fed to each candidate's fit. Growth re-fits the
 *  whole union once per candidate per round, so an uncapped union is quadratic in
 *  pixel count on a many-label input. Real band sets stay under the cap. */
const UNION_FIT_CAP = 12000
/** Budget of candidate fits per union. A real posterized ramp needs tens; on a
 *  label explosion growth stops early and keeps what merged so far. */
const MAX_UNION_FITS = 600
/** How much worse (mean CIE76 ΔE) the union gradient may render a candidate than
 *  the candidate's own flat colour. Below the ΔE76 JND (~2.3) so a wrong absorb is
 *  imperceptible, above the small compromise one gradient makes on a genuine band. */
const RENDER_MARGIN = 1.0

export interface BackgroundUnion {
  /** Surviving label — the border-ring seed; all merged bands relabel to it. */
  seed: number
  /** Every label merged into the background (seed included), ascending. */
  set: number[]
  /** The gradient fitted over the union's pixels (viewBox == pixel coords). */
  gradient: GradientFill
  /** Relabeled copy of the input label map. */
  labels: Int32Array
}

/** Deterministically stride a sample set down to at most `cap` points; a no-op
 *  when already under the cap. */
function capSamples(s: RegionSamples, cap: number): RegionSamples {
  if (s.n <= cap) return s
  const step = Math.ceil(s.n / cap)
  const m = Math.ceil(s.n / step)
  const xs = new Float64Array(m)
  const ys = new Float64Array(m)
  const rs = new Float64Array(m)
  const gs = new Float64Array(m)
  const bs = new Float64Array(m)
  let k = 0
  for (let i = 0; i < s.n && k < m; i += step) {
    xs[k] = s.xs[i]
    ys[k] = s.ys[i]
    rs[k] = s.rs[i]
    gs[k] = s.gs[i]
    bs[k] = s.bs[i]
    k++
  }
  return { xs, ys, rs, gs, bs, n: k }
}

/** Label adjacency from 4-neighbour pixel pairs (ignores transparent −1). */
function labelAdjacency(labels: Int32Array, width: number, height: number, paletteSize: number): Set<number>[] {
  const adj: Set<number>[] = Array.from({ length: paletteSize }, () => new Set<number>())
  const link = (a: number, b: number): void => {
    if (a === b || a < 0 || b < 0 || a >= paletteSize || b >= paletteSize) return
    adj[a].add(b)
    adj[b].add(a)
  }
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const l = labels[row + x]
      if (l < 0) continue
      if (x + 1 < width) link(l, labels[row + x + 1])
      if (y + 1 < height) link(l, labels[row + width + x])
    }
  }
  return adj
}

/** Mean CIE76 ΔE of a gradient's per-pixel prediction over a sample set. */
function gradientRenderError(g: GradientFill, s: RegionSamples): number {
  if (s.n === 0) return 0
  let sum = 0
  for (let i = 0; i < s.n; i++) {
    const [r, gg, b] = sampleGradient(g, s.xs[i], s.ys[i])
    sum += deltaE76(srgbToLab(s.rs[i], s.gs[i], s.bs[i]), srgbToLab(r, gg, b))
  }
  return sum / s.n
}

/** Mean CIE76 ΔE of one flat band colour over its own sample set — what the
 *  posterized stack renders for those pixels. */
function bandRenderError(s: RegionSamples, c: { r: number; g: number; b: number }): number {
  if (s.n === 0) return 0
  const flat = srgbToLab(c.r, c.g, c.b)
  let sum = 0
  for (let i = 0; i < s.n; i++) sum += deltaE76(srgbToLab(s.rs[i], s.gs[i], s.bs[i]), flat)
  return sum / s.n
}

/**
 * Grow the border-seeded background set while the union's fitted gradient renders
 * its pixels at least as faithfully as the flat bands do. `samples` must be
 * parallel to label values (e.g. `fullRegionSamples`); labels with no samples
 * never join. `pinned` labels (a flat marker's "keep this region flat") are never
 * absorbed and never used as the seed — the user's explicit intent overrides the
 * union even where the gradient could explain the region. Returns null when nothing
 * merges.
 */
export function uniteBackgroundGradient(
  labels: Int32Array,
  width: number,
  height: number,
  seed: number,
  samples: RegionSamples[],
  palette: { r: number; g: number; b: number }[],
  pinned: Set<number> = new Set(),
): BackgroundUnion | null {
  const paletteSize = palette.length
  if (seed < 0 || seed >= paletteSize) return null
  if (!samples[seed] || samples[seed].n === 0) return null
  if (pinned.has(seed)) return null

  const adj = labelAdjacency(labels, width, height, paletteSize)
  const bandErr = palette.map((c, l) => (samples[l] ? bandRenderError(samples[l], c) : 0))
  const set = new Set<number>([seed])

  const unionOf = (members: number[]): RegionSamples => concatSamples(members.map((l) => samples[l]))

  // Greedy adjacent growth: each round, try every label adjacent to the set in
  // ascending order and accept it if the union's gradient renders that candidate
  // about as well as its own flat band. Repeat until stable or out of fit budget.
  let best: { gradient: GradientFill } | null = null
  let fits = 0
  outer: for (;;) {
    let added = false
    const candidates = new Set<number>()
    for (const m of set) for (const n of adj[m]) if (!set.has(n)) candidates.add(n)
    for (const cand of [...candidates].sort((a, b) => a - b)) {
      if (pinned.has(cand)) continue // flat-marker pin: keep this region flat
      if (!samples[cand] || samples[cand].n === 0) continue
      if (++fits > MAX_UNION_FITS) break outer // cost guard; keep what merged so far
      const members = [...set, cand].sort((a, b) => a - b)
      const union = capSamples(unionOf(members), UNION_FIT_CAP)
      const fit = fitBestGradient(union)
      if (!fit || fit.oklabResidual > UNION_TOL) continue
      // Judge the candidate's own pixels, not the union-wide mean: a large union
      // dilutes a small candidate's error to nothing, which would absorb a
      // foreground shape that merely shares a band colour (on the palette path a
      // label spans disconnected components). With background removal enabled,
      // such an absorb deletes the shape.
      if (gradientRenderError(fit.gradient, samples[cand]) > bandErr[cand] + RENDER_MARGIN) continue
      set.add(cand)
      best = fit
      added = true
    }
    if (!added) break
  }
  if (set.size < 2 || !best) return null

  const members = [...set].sort((a, b) => a - b)
  const finalFit = fitBestGradient(capSamples(unionOf(members), UNION_FIT_CAP))
  const gradient = (finalFit && finalFit.oklabResidual <= UNION_TOL ? finalFit : best).gradient

  const out = new Int32Array(labels.length)
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    out[i] = l >= 0 && set.has(l) ? seed : l
  }
  return { seed, set: members, gradient, labels: out }
}
