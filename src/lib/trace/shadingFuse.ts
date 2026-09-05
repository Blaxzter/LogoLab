// Shading fusion for the flat (palette-first) path — issue #15, docs/vectorization-benchmarks.md §27.
//
// A single ink with SOFT SHADING (an AI-generated icon, a hand-shaded sheet) reaches the
// palette path as two or three tone clusters: each tone is a wide flat plateau, so every one
// of them carries the flat-interior evidence that marks a REAL authored colour, and the tones
// sit ΔE 4–11 apart — exactly where two genuinely distinct authored colours can also sit
// (fluent-flute-flat's pair is ΔE 4.5). Nearest-colour assignment then cuts every shape along
// the line where the tone flips: a disc loses an arc, a bar is sliced lengthwise. No colour
// DISTANCE can separate the two populations (the `shaded-ink` fixture puts them 0.2 ΔE apart
// on purpose), so this reads the evidence the distance cannot: WHERE the two entries meet.
//
//   • two AUTHORED flats meet at an anti-aliased seam. The assignment sends the one blend pixel
//     to whichever side it is nearer, so across the label boundary the SOURCE colour still
//     jumps by at least HALF the two colours' distance (a pixel-aligned seam: the whole
//     distance). That is not a calibration — it is what "nearest" means.
//   • shading tones meet through a RAMP. The boundary falls at the ramp's midpoint and the
//     source pixels either side of it differ by one 8-bit level — a small fraction of the
//     tone distance.
//
// Measured over the truth fixtures + 152 gallery marks @512 and @256 (`softPairDiag --census`),
// the interior HARD share (boundary pixel pairs whose source step is ≥ ½ the pair distance) is
// bimodal with nothing from a gradient-free source under 14%: 426 pairs at 0–10%, every one
// from art that authors a gradient, against 379 at 90–100%. So a pair is SOFT below
// SOFT_HARD_MAX and the sign is unambiguous.
//
// Softness alone is not the rule, because a real GRADIENT traced flat is soft too: aurora's
// eleven k-means bands chain softly across ΔE 49. The flat path posterizes such art today (the
// gradient lane is where it belongs, and `suggestGradients` sends it there), and this must not
// turn a gradient into one flat blot. What separates a shading from a gradient is the SPAN:
// soft pairs are chained into components and only a component whose colour diameter (max
// pairwise ΔE of its members' modal colours) stays within SHADE_SPAN is one ink. The fixture's
// three tones span 11.1; the gallery's gradient chains span 25–130. Between them the census is
// continuous (subtle brand gradients at 12–16), so SHADE_SPAN is a product choice, not a gap:
// under a FLAT trace a soft tonal variation this small is one flat colour, a wider one keeps
// posterizing as before.
//
// The interior restriction matters: a darker tone's anti-alias rim passes through the lighter
// tone's colour cloud and forms a 1px halo whose boundary with the dark interior is a real
// step. Counted, that halo read the fixture's knife-edge pair as 26% hard; requiring both
// pixels' 4-neighbourhoods to lie within the pair drops it to 0%.

import type { PaletteColor, QuantizeResult } from './types'
import { srgbToLab, deltaE76 } from './lab.ts'

/** A boundary pixel pair is HARD when the source step is at least this fraction of the two
 *  entries' modal-colour distance. ½ is the floor nearest-colour assignment guarantees at an
 *  anti-aliased seam (the blend pixel goes to the nearer side, leaving ≥ half the jump). */
const HARD_RATIO = 0.5
/** A pair is SOFT when at most this share of its interior boundary pairs are hard. Measured
 *  populations: ramps 0–10%, seams 90–100%, nothing gradient-free under 14%. */
const SOFT_HARD_MAX = 0.1
/** Minimum interior boundary pairs before a verdict is read at all — below this a pair barely
 *  meets and the share is noise. The fixture's pairs measure 364–771 @256/@512. */
const SOFT_MIN_BOUNDARY = 24
/** Largest colour diameter (CIE76 ΔE) a soft component may span and still be ONE ink. The
 *  fixture's real-sheet tones span 11.1; gradient chains traced flat span 25+. */
export const SHADE_SPAN = 16

/** Per-entry MODAL exact source colour — the hex `snapPaletteToModes` will emit, and the
 *  honest distance between two entries (a centroid is pulled toward the ramp it shares). */
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
    let bestKey = -1, bestCount = 0
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
  /** The fused groups, as palette indices INTO THE INPUT — empty when nothing fused (and
   *  then `q` is the input object itself, so the no-op is byte-identical by construction). */
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
      const dr = modes[a].r - modes[b].r, dg = modes[a].g - modes[b].g, db = modes[a].b - modes[b].b
      md2[a * K + b] = dr * dr + dg * dg + db * db
    }
  }

  // Boundary census over 4-adjacent pixel pairs (right and down), INTERIOR pairs only.
  const nInt = new Int32Array(K * K)
  const hardInt = new Int32Array(K * K)
  const within = (i: number, x: number, y: number, a: number, b: number): boolean => {
    if (x > 0) { const l = labels[i - 1]; if (l !== a && l !== b) return false }
    if (x < w - 1) { const l = labels[i + 1]; if (l !== a && l !== b) return false }
    if (y > 0) { const l = labels[i - w]; if (l !== a && l !== b) return false }
    if (y < h - 1) { const l = labels[i + w]; if (l !== a && l !== b) return false }
    return true
  }
  const visit = (i: number, x: number, y: number, j: number, xj: number, yj: number): void => {
    const a = labels[i], b = labels[j]
    if (a < 0 || b < 0 || a === b) return
    if (!within(i, x, y, a, b) || !within(j, xj, yj, a, b)) return
    const lo = a < b ? a : b, hi = a < b ? b : a
    const k = lo * K + hi
    nInt[k]++
    const oi = i * 4, oj = j * 4
    const dr = data[oi] - data[oj], dg = data[oi + 1] - data[oj + 1], db = data[oi + 2] - data[oj + 2]
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
      const ra = find(a), rb = find(b)
      if (ra !== rb) {
        parent[ra] = rb
        anySoft = true
      }
    }
  }
  if (!anySoft) return { q, groups: [] }

  // A component is one ink only if its colour diameter stays within SHADE_SPAN — a soft chain
  // spanning more is a gradient traced flat, left to posterize exactly as before.
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
    const head = g.reduce((best, i) => (q.counts[i] > q.counts[best] || (q.counts[i] === q.counts[best] && i < best) ? i : best), g[0])
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
  survivors.forEach((s, pos) => { rank[s] = pos })
  const out = new Int32Array(labels.length)
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    out[i] = l < 0 ? -1 : rank[target[l]]
  }
  const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))
  return {
    q: {
      palette: survivors.map((s) =>
        count[s] > 0 ? { r: clamp255(sumR[s] / count[s]), g: clamp255(sumG[s] / count[s]), b: clamp255(sumB[s] / count[s]) } : q.palette[s],
      ),
      labels: out,
      counts: survivors.map((s) => count[s]),
    },
    groups,
  }
}
