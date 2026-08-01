// EXPERIMENTAL background layer separation (`VectorizeOptions.backgroundGradient`,
// gradients-OFF planar only).
//
// With gradients off a smooth background ramp posterizes into flat bands. The
// planar tracer then (a) traces every band↔band boundary — a noisy nearest-colour
// frontier that vectorizes SUPER-JAGGED — and (b) mints a junction wherever a band
// touches a foreground outline, splitting e.g. a white ring into independently
// fitted arcs (the user-visible "pull"/dot at each junction). Both defects are the
// bands' existence, not the fit — so the fix is to make the boundary not exist:
//
//   1. seed with the border-ring background label (caller passes it in),
//   2. grow the set over ADJACENT labels, accepting a candidate only when the
//      union's fitted gradient RENDERS the union's own pixels at least as well as
//      the posterized band colours do (a per-pixel CIE76 render gate — the V6
//      "gate on what ships" pattern, not an analytic veto),
//   3. relabel the accepted set to the seed and paint that single region with the
//      fitted gradient (a real SVG gradient — the bottom "layer").
//
// The render gate is what keeps real art out of the union: absorbing a distinct
// flat shape forces the gradient to paint a transition across pixels the source
// renders crisp, so its ΔE loses to the band palette and the shape survives. A
// posterized ramp loses to the gradient (banding steps vs a smooth fit), so it
// merges. Returns null (byte-identical passthrough) when fewer than two labels
// merge. Pure + deterministic: ascending scans, fixed thresholds, no PRNG.

import type { GradientFill } from '../path/types'
import { concatSamples, fitBestGradient, sampleGradient, type RegionSamples } from './gradient.ts'
import { srgbToLab, deltaE76 } from './lab.ts'

/** Cheap pre-filter: max Oklab RMS residual for a candidate union fit (Step-3c's
 *  default `mergeTol`) — skips the render gate for hopeless fits. */
const UNION_TOL = 0.06
/** Cap on the union sample count fed to each candidate's gradient fit. Bounds the
 *  per-candidate cost on a many-label input (a photo forced down this path with
 *  gradients off): the growth re-fits over the whole accepted union once per frontier
 *  candidate per round, so an uncapped union makes that quadratic in the pixel count.
 *  Generous enough that any real posterized band-set stays under it and fits
 *  byte-identically; only a pathological label explosion is subsampled. */
const UNION_FIT_CAP = 12000
/** Hard budget on candidate gradient fits per union, so the greedy growth can never
 *  run away on a pathological many-label input (a photo forced down this path). Far
 *  above what any real posterized ramp needs (a handful of bands ⇒ tens of fits), so
 *  it only trips on a genuine label explosion, where growth simply stops early with
 *  whatever merged so far. */
const MAX_UNION_FITS = 600
/** Candidate render slack: the union gradient may render an absorbed band at most
 *  this much worse (mean CIE76 ΔE) than the band's OWN flat colour. Kept below the
 *  ΔE76 JND (~2.3) so the worst a wrongful absorb can do is imperceptible, yet well
 *  above the ~0.1–0.2 compromise one global gradient makes on a genuine ramp band
 *  (measured: legit bands gap ≤0.14, a distinct foreground shape gaps ≥10). */
const RENDER_MARGIN = 1.0

export interface BackgroundUnion {
  /** Surviving label — the border-ring seed; all merged bands relabel to it. */
  seed: number
  /** Every label merged into the background (seed included), ascending. */
  set: number[]
  /** The gradient fitted over the union's pixels (viewBox == pixel coords). */
  gradient: GradientFill
  /** Relabeled COPY of the input label map. */
  labels: Int32Array
}

/** Deterministically stride a sample set down to at most `cap` points — a no-op when
 *  already under the cap, so small band-sets fit byte-identically. */
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

  // Greedy adjacent growth: each round, try every label adjacent to the set
  // (ascending, deterministic); accept it if the union's gradient renders THIS
  // candidate at least as faithfully as its own flat band. Repeat until stable.
  // A fit budget bounds the worst case (a large gradient split into many bands that
  // each merge one-per-round makes the per-candidate refit ~quadratic in the label
  // count); a real posterized ramp is a handful of bands and never approaches it.
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
      // Gate on the CANDIDATE's OWN pixels, not the whole union. Judging the
      // union-wide mean lets a large accepted background DILUTE a small candidate's
      // error to nothing, so it gets absorbed regardless of whether it belongs —
      // a late band, or (palette path, where a label is a colour CLASS spanning
      // disconnected components) a foreground shape that merely shares a band's
      // colour. With removeBackground composed in, that silent absorb is a DELETE.
      // Asking only whether the union gradient renders the candidate at least as
      // well as its own flat band keeps the test discriminating at any union size.
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
