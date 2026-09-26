// Shading fusion for the flat (palette-first) path.
//
// A single ink with soft shading (an AI-generated icon, a hand-shaded sheet) reaches the
// palette path as two or three tone clusters. Each tone is a wide flat plateau, and the tones
// can sit as close or as far apart as two genuinely distinct authored colours, so colour
// distance cannot tell them apart. Left alone, nearest-colour assignment cuts every shape
// along the line where the tone flips. This pass reads where two entries meet instead:
//
//   - Two authored flats meet at an anti-aliased seam. Nearest-colour assignment sends the
//     blend pixel to the nearer side, so across the label boundary the source colour still
//     jumps by at least half the two colours' distance. That follows from what "nearest"
//     means; it is not a calibration.
//   - Shading tones meet through a ramp. The boundary falls at the ramp's midpoint, where
//     neighbouring source pixels differ by about one 8-bit level.
//
// So a pair is soft when few of its boundary pixel pairs are hard (source step ≥ half the
// pair distance). Softness alone is not enough, because a real gradient traced flat is soft
// too; fusing it would collapse the gradient into one blot. Soft pairs are chained into
// components, and only a component whose colour diameter (max pairwise ΔE of its members'
// modal colours) stays within SHADE_SPAN is treated as one ink.
//
// Only interior boundary pairs are counted (both pixels' 4-neighbourhoods lie within the
// pair): a darker tone's anti-alias rim passes through the lighter tone's colours and forms a
// 1px halo whose boundary with the dark interior is a real step.
// Design notes and measurements: docs/vectorization-benchmarks.md.

import type { PaletteColor, QuantizeResult } from './types'
import { srgbToLab, deltaE76 } from './lab.ts'

/** A boundary pixel pair is hard when the source step is at least this fraction of the two
 *  entries' modal-colour distance. ½ is the floor nearest-colour assignment guarantees at an
 *  anti-aliased seam. */
const HARD_RATIO = 0.5
/** A pair is soft when at most this share of its interior boundary pairs are hard. Ramps
 *  sit near 0, authored seams near 1. */
const SOFT_HARD_MAX = 0.1
/** Minimum interior boundary pairs before a verdict is read; below this the pair barely
 *  meets and the share is noise. */
const SOFT_MIN_BOUNDARY = 24
/** Largest colour diameter (CIE76 ΔE) a soft component may span and still be one ink. A
 *  product choice: under a flat trace, tonal variation this small becomes one colour, while
 *  wider soft chains (gradients) keep posterizing. */
export const SHADE_SPAN = 16

/** Per-entry modal exact source colour: the hex `snapPaletteToModes` will emit, and a fairer
 *  distance between two entries than centroids, which are pulled toward a shared ramp. */
function modalColours(q: QuantizeResult, data: Uint8ClampedArray): PaletteColor[] {
  const K = q.palette.length
  const hist: Map<number, number>[] = Array.from({ length: K }, () => new Map())
  for (let i = 0; i < q.labels.length; i++) {
    const l = q.labels[i]
    if (l < 0) continue
    const o = i * 4
    const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]
    const h = hist[l]
    h.set(key, (h.get(key) ?? 0) + 1)
  }
  return q.palette.map((c, l) => {
    let bestKey = -1,
      bestCount = 0
    for (const [key, count] of hist[l]) {
      if (count > bestCount || (count === bestCount && key < bestKey)) {
        bestCount = count
        bestKey = key
      }
    }
    return bestKey < 0 ? c : { r: (bestKey >> 16) & 255, g: (bestKey >> 8) & 255, b: bestKey & 255 }
  })
}

export interface ShadingFuseResult {
  q: QuantizeResult
  /** The fused groups, as palette indices into the input. Empty when nothing fused, in which
   *  case `q` is the input object itself. */
  groups: number[][]
}

/**
 * Fuse palette entries that are one ink's shading tones (see the header). Pure: returns the
 * input `q` untouched when no component qualifies; otherwise a fresh QuantizeResult with the
 * fused entries' pixels relabelled, counts summed, centroids count-weighted, and the palette
 * re-sorted by count (the order quantize guarantees and classifyBlends relies on).
 */
export function fuseShadingTones(
  img: { width: number; height: number; data: Uint8ClampedArray },
  q: QuantizeResult,
): ShadingFuseResult {
  const K = q.palette.length
  if (K < 2) return { q, groups: [] }
  const { width: w, height: h, data } = img
  const labels = q.labels
  const modes = modalColours(q, data)
  const md2 = new Float64Array(K * K)
  for (let a = 0; a < K; a++) {
    for (let b = 0; b < K; b++) {
      const dr = modes[a].r - modes[b].r,
        dg = modes[a].g - modes[b].g,
        db = modes[a].b - modes[b].b
      md2[a * K + b] = dr * dr + dg * dg + db * db
    }
  }

  // Boundary census over 4-adjacent pixel pairs (right and down), interior pairs only.
  const nInt = new Int32Array(K * K)
  const hardInt = new Int32Array(K * K)
  const within = (i: number, x: number, y: number, a: number, b: number): boolean => {
    if (x > 0) {
      const l = labels[i - 1]
      if (l !== a && l !== b) return false
    }
    if (x < w - 1) {
      const l = labels[i + 1]
      if (l !== a && l !== b) return false
    }
    if (y > 0) {
      const l = labels[i - w]
      if (l !== a && l !== b) return false
    }
    if (y < h - 1) {
      const l = labels[i + w]
      if (l !== a && l !== b) return false
    }
    return true
  }
  const visit = (i: number, x: number, y: number, j: number, xj: number, yj: number): void => {
    const a = labels[i],
      b = labels[j]
    if (a < 0 || b < 0 || a === b) return
    if (!within(i, x, y, a, b) || !within(j, xj, yj, a, b)) return
    const lo = a < b ? a : b,
      hi = a < b ? b : a
    const k = lo * K + hi
    nInt[k]++
    const oi = i * 4,
      oj = j * 4
    const dr = data[oi] - data[oj],
      dg = data[oi + 1] - data[oj + 1],
      db = data[oi + 2] - data[oj + 2]
    const step2 = dr * dr + dg * dg + db * db
    if (step2 >= HARD_RATIO * HARD_RATIO * md2[k]) hardInt[k]++
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (x < w - 1) visit(i, x, y, i + 1, x + 1, y)
      if (y < h - 1) visit(i, x, y, i + w, x, y + 1)
    }
  }

  // Soft pairs → union-find components.
  const parent = Int32Array.from({ length: K }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  let anySoft = false
  for (let a = 0; a < K; a++) {
    for (let b = a + 1; b < K; b++) {
      const k = a * K + b
      if (nInt[k] < SOFT_MIN_BOUNDARY) continue
      // Identical modal colours cannot be two inks; otherwise read the hard share.
      if (md2[k] > 0 && hardInt[k] > SOFT_HARD_MAX * nInt[k]) continue
      const ra = find(a),
        rb = find(b)
      if (ra !== rb) {
        parent[ra] = rb
        anySoft = true
      }
    }
  }
  if (!anySoft) return { q, groups: [] }

  // A component is one ink only if its colour diameter stays within SHADE_SPAN; a wider soft
  // chain is a gradient traced flat and is left to posterize.
  const members = new Map<number, number[]>()
  for (let i = 0; i < K; i++) {
    const r = find(i)
    let m = members.get(r)
    if (!m) members.set(r, (m = []))
    m.push(i)
  }
  const labs = modes.map((c) => srgbToLab(c.r, c.g, c.b))
  const groups: number[][] = []
  for (const m of members.values()) {
    if (m.length < 2) continue
    let diameter = 0
    for (let i = 0; i < m.length; i++)
      for (let j = i + 1; j < m.length; j++) diameter = Math.max(diameter, deltaE76(labs[m[i]], labs[m[j]]))
    if (diameter <= SHADE_SPAN) groups.push(m)
  }
  if (!groups.length) return { q, groups: [] }
  groups.sort((x, y) => x[0] - y[0])

  // Relabel: every member of a group goes to the group's largest entry (its count-weighted
  // centroid becomes the fused centroid); then re-sort by count so the contract holds.
  const target = Int32Array.from({ length: K }, (_, i) => i)
  const count = q.counts.slice()
  const sumR = q.palette.map((c, i) => c.r * q.counts[i])
  const sumG = q.palette.map((c, i) => c.g * q.counts[i])
  const sumB = q.palette.map((c, i) => c.b * q.counts[i])
  for (const g of groups) {
    const head = g.reduce(
      (best, i) => (q.counts[i] > q.counts[best] || (q.counts[i] === q.counts[best] && i < best) ? i : best),
      g[0],
    )
    for (const i of g) {
      if (i === head) continue
      target[i] = head
      count[head] += q.counts[i]
      count[i] = 0
      sumR[head] += sumR[i]
      sumG[head] += sumG[i]
      sumB[head] += sumB[i]
    }
  }
  const survivors: number[] = []
  for (let i = 0; i < K; i++) if (target[i] === i) survivors.push(i)
  survivors.sort((a, b) => count[b] - count[a] || a - b)
  const rank = new Int32Array(K).fill(-1)
  survivors.forEach((s, pos) => {
    rank[s] = pos
  })
  const out = new Int32Array(labels.length)
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    out[i] = l < 0 ? -1 : rank[target[l]]
  }
  const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))
  return {
    q: {
      palette: survivors.map((s) =>
        count[s] > 0
          ? { r: clamp255(sumR[s] / count[s]), g: clamp255(sumG[s] / count[s]), b: clamp255(sumB[s] / count[s]) }
          : q.palette[s],
      ),
      labels: out,
      counts: survivors.map((s) => count[s]),
    },
    groups,
  }
}
