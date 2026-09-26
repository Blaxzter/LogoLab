// Palette-first segmentation for flat art (gradients off).
//
// The Mumford–Shah segmenter (segment.ts) groups by smoothness, so the 1–2px
// anti-aliased ramp between two flat colours is itself a smooth field and becomes
// its own region with a blended colour. No area-based merge removes such a band:
// it runs the whole length of a contact edge, so its area clears any threshold.
//
// Palette-first inverts the order: pick a small palette of the dominant colours,
// then assign every pixel, anti-aliased ones included, to the nearest palette
// colour. A blend pixel snaps to the nearer real colour, so the boundary collapses
// to one edge at the 50% isophote. It is limited to flat art because
// nearest-colour assignment would band a real gradient; gradient art goes through
// the Mumford–Shah path.
// Design notes and measurements: docs/vectorization-benchmarks.md.

import type { PaletteColor, QuantizeResult } from './types'
import { quantize, dropMinorColors, modeFilter } from './quantize.ts'
import { fuseShadingTones } from './shadingFuse.ts'

export interface PaletteSegmentOptions {
  /** k-means cluster budget. Over-provisioned: dropMinorColors trims the extras,
   *  so this only needs to be ≥ the true colour count (logos: a handful). */
  maxColors: number
  /** Drop palette entries holding less than this share of the opaque pixels into
   *  their nearest survivor. AA blend bands are each a small share, so this removes
   *  spurious blend colours. A small genuine region can hold less than a long
   *  edge's blend band, so entries with flat-interior evidence ≥ minRegionArea are
   *  exempted (see flatInteriorCounts). */
  minShare: number
  /** 3×3 majority-vote passes to melt the 1px stair-step the nearest-colour
   *  assignment leaves along each boundary (a clean single edge afterwards). */
  modePasses: number
  /** Connected components smaller than this (opaque px) are dissolved into the
   *  label that borders them most, so specks and pinholes from source noise don't
   *  each become an extra traced loop. */
  minRegionArea: number
  /** Spare a sub-`minRegionArea` component that carries flat-interior evidence:
   *  at least one pixel whose whole 3×3 source block is exactly its palette hex.
   *  Default true; false applies the area floor unconditionally. */
  regionEvidence: boolean
  /** Fuse palette entries that are one ink's shading tones (plateaus joined by a soft
   *  ramp rather than an anti-aliased seam), so a softly shaded flat shape traces as one
   *  region instead of being carved where the nearest tone flips. See shadingFuse.ts.
   *  Default true. */
  shadingFuse?: boolean
}

export const DEFAULT_PALETTE_SEGMENT: PaletteSegmentOptions = {
  maxColors: 16,
  minShare: 0.006,
  modePasses: 2,
  minRegionArea: 64,
  regionEvidence: true,
  shadingFuse: true,
}

/**
 * Dissolve connected components below `minArea` into the label that borders them
 * most. 4-connectivity, iterative scan-flood (deterministic order). A label class
 * can span many components; only the tiny ones are absorbed. Returns a copy.
 *
 * Don't switch this to 8-connectivity: the planar tracer reads a 4-disconnected
 * pixel set as separate faces, so 8-chained AA fragments kept here would each
 * still trace as a tiny loop. Restored thin diagonals are 4-connected by
 * restoreErasedComponents' pinch fill, so they pass this floor as one component.
 *
 * `evidence` enables the veto: a sub-floor component is spared when it carries
 * flat-interior evidence (see hasFlatInterior). Omitted ⇒ the unconditional floor.
 */
function despeckleComponents(
  labels: Int32Array,
  w: number,
  h: number,
  minArea: number,
  evidence?: { data: Uint8ClampedArray; palette: PaletteColor[] },
): Int32Array {
  if (minArea <= 0) return labels
  const n = w * h
  const out = labels.slice()
  const comp = new Int32Array(n).fill(-1)
  const stack: number[] = []
  let cid = 0
  for (let start = 0; start < n; start++) {
    if (comp[start] !== -1 || out[start] < 0) continue
    const lab = out[start]
    comp[start] = cid
    stack.length = 0
    stack.push(start)
    const pixels: number[] = []
    while (stack.length) {
      const p = stack.pop()!
      pixels.push(p)
      const x = p % w, y = (p / w) | 0
      if (x > 0 && comp[p - 1] === -1 && out[p - 1] === lab) { comp[p - 1] = cid; stack.push(p - 1) }
      if (x < w - 1 && comp[p + 1] === -1 && out[p + 1] === lab) { comp[p + 1] = cid; stack.push(p + 1) }
      if (y > 0 && comp[p - w] === -1 && out[p - w] === lab) { comp[p - w] = cid; stack.push(p - w) }
      if (y < h - 1 && comp[p + w] === -1 && out[p + w] === lab) { comp[p + w] = cid; stack.push(p + w) }
    }
    if (pixels.length < minArea && !(evidence && hasFlatInterior(pixels, lab, w, h, evidence))) {
      // Majority bordering label (≠ lab, ≥ 0); fall back to leaving it if isolated.
      const border = new Map<number, number>()
      for (const p of pixels) {
        const x = p % w, y = (p / w) | 0
        const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]
        for (const q of nb) {
          if (q < 0) continue
          const l = out[q]
          if (l === lab || l < 0) continue
          border.set(l, (border.get(l) ?? 0) + 1)
        }
      }
      let best = -1, bestC = 0
      for (const [l, c] of border) if (c > bestC) { bestC = c; best = l }
      if (best >= 0) for (const p of pixels) out[p] = best
    }
    cid++
  }
  return out
}

/**
 * Does this connected component carry flat-interior evidence? True when at least
 * one of its pixels has a full 3×3 source block of exactly its own palette hex
 * (flatInteriorCounts' criterion, asked per component instead of per label).
 * Nine adjacent pixels at full coverage of one colour is solid ink; a coverage
 * ramp cannot produce it, because consecutive AA pixels differ.
 *
 * This is a one-sided veto: it can only spare a component, never dissolve one.
 * It misses some small solid features but essentially never spares AA fringe.
 * Don't substitute "share of pixels equal to the palette hex": a k-means centroid
 * need not equal any source pixel.
 *
 * A 3×3 block needs nine pixels, so nothing under 9px can ever be spared.
 */
function hasFlatInterior(
  pixels: readonly number[],
  lab: number,
  w: number,
  h: number,
  evidence: { data: Uint8ClampedArray; palette: PaletteColor[] },
): boolean {
  const c = evidence.palette[lab]
  if (!c) return false
  const { data } = evidence
  const key = (c.r << 16) | (c.g << 8) | c.b
  const rgbAt = (i: number): number => (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2]
  for (const i of pixels) {
    const x = i % w, y = (i / w) | 0
    if (x < 1 || y < 1 || x > w - 2 || y > h - 2) continue
    if (
      rgbAt(i) === key &&
      rgbAt(i - w - 1) === key && rgbAt(i - w) === key && rgbAt(i - w + 1) === key &&
      rgbAt(i - 1) === key && rgbAt(i + 1) === key &&
      rgbAt(i + w - 1) === key && rgbAt(i + w) === key && rgbAt(i + w + 1) === key
    ) return true
  }
  return false
}

/**
 * Per-label count of flat-interior source pixels: pixels whose 8 neighbours all
 * carry the exact same source colour. This separates a real small region from an
 * anti-alias blend smear where area cannot: a blend band runs the whole length of
 * a contact edge, but its pixels are one-off blends that are essentially never
 * surrounded by eight identical pixels, while a genuine region interior always is.
 */
function flatInteriorCounts(
  img: { width: number; height: number; data: Uint8ClampedArray },
  labels: Int32Array,
  paletteLen: number,
): Int32Array {
  const { width: w, height: h, data } = img
  const counts = new Int32Array(paletteLen)
  const rgbAt = (i: number): number => (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2]
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const l = labels[i]
      if (l < 0) continue
      const k = rgbAt(i)
      if (
        rgbAt(i - w - 1) === k && rgbAt(i - w) === k && rgbAt(i - w + 1) === k &&
        rgbAt(i - 1) === k && rgbAt(i + 1) === k &&
        rgbAt(i + w - 1) === k && rgbAt(i + w) === k && rgbAt(i + w + 1) === k
      ) counts[l]++
    }
  }
  return counts
}

/**
 * Max RGB distance from the segment between two accepted palette colours at which
 * an entry counts as their coverage blend. Anti-aliasing interpolates in sRGB, so
 * a true blend cluster sits essentially on the segment. Same scale as quantize's
 * MERGE_DISTANCE, below which colours already count as the same.
 */
const BLEND_LINE_EPS = 10

/** Squared RGB distance from colour c to the segment a—b (not the infinite line:
 *  clamping makes "near an endpoint" read as "near that colour"). */
function segDist2(c: PaletteColor, a: PaletteColor, b: PaletteColor): number {
  const abr = b.r - a.r, abg = b.g - a.g, abb = b.b - a.b
  const len2 = abr * abr + abg * abg + abb * abb
  let t = len2 > 0 ? ((c.r - a.r) * abr + (c.g - a.g) * abg + (c.b - a.b) * abb) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const dr = c.r - (a.r + t * abr), dg = c.g - (a.g + t * abg), db = c.b - (a.b + t * abb)
  return dr * dr + dg * dg + db * db
}

/**
 * Alpha-feather thresholds. Some exported PNGs surround opaque shapes with a
 * several-px alpha ramp, which quantize slices into translucent shell clusters.
 * Their RGB is a mix of parent hue, background glow and alpha, so the pairwise
 * blend model cannot explain them. What separates a feather from an authored
 * translucent flat is the alpha distribution: a feather ramps (high α std, no
 * dominant α mode), while a translucent flat has one alpha. Fully opaque art has
 * α mode 255 everywhere, so this never fires on it.
 */
const FEATHER_ALPHA_STD = 10
const FEATHER_MODE_SHARE = 0.15

/** Per-label alpha statistics over kept pixels: mode, mode's share of the label's
 *  pixels, and standard deviation. Empty label → opaque constants (mode 255,
 *  share 1, std 0), which can never read as a feather. */
function regionAlphaStats(
  labels: Int32Array,
  data: Uint8ClampedArray,
  paletteLen: number,
): { mode: number; modeShare: number; std: number }[] {
  const hist = Array.from({ length: paletteLen }, () => new Uint32Array(256))
  const total = new Uint32Array(paletteLen)
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    if (l < 0) continue
    hist[l][data[i * 4 + 3]]++
    total[l]++
  }
  return Array.from({ length: paletteLen }, (_, l) => {
    const n = total[l]
    if (n === 0) return { mode: 255, modeShare: 1, std: 0 }
    const h = hist[l]
    let mode = 255, modeC = 0, sum = 0, sum2 = 0
    for (let a = 0; a < 256; a++) {
      const c = h[a]
      if (c === 0) continue
      if (c > modeC || (c === modeC && a < mode)) {
        modeC = c
        mode = a
      }
      sum += a * c
      sum2 += a * a * c
    }
    const mean = sum / n
    return { mode, modeShare: modeC / n, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) }
  })
}

/**
 * Classify each palette entry as an anti-alias coverage blend or not. AA mixes a
 * pixel's colour linearly (in sRGB) between a feature and its background, so a
 * blend cluster lies on the RGB segment between two real colours, while an
 * authored colour generally does not. This is the evidence flat-interior area
 * cannot supply for thin features: a sub-pixel bar and its blend smear both lack
 * a 3×3 flat interior, but only the smear is a mix of two other colours.
 *
 * Collinearity alone is not enough: the middle band of a posterized ramp is the
 * midpoint of its neighbours by construction. A coverage blend is also an edge
 * phenomenon (a 1–2px zone where nearly every pixel touches another class), so
 * only edge-local entries (`edgy`) are candidates; a wide band is accepted no
 * matter how collinear it is.
 *
 * Greedy, in palette order (count-descending, as quantize guarantees): an entry
 * with real-region evidence (`real`) is accepted; otherwise it is a blend iff it
 * is edge-local and within BLEND_LINE_EPS of the segment between two already
 * accepted entries. Large-first usually means a blend's two sources are accepted
 * before the blend comes up.
 *
 * At low resolution that order can invert (a blend cluster outnumbers the thin
 * feature it fringes), so the blend is accepted before its second endpoint and
 * becomes a fake palette colour. The greedy pass is therefore followed by
 * fixpoint passes that re-test each accepted entry against two other currently
 * accepted entries, pass-synchronously for determinism, until nothing changes.
 * Routes are then path-compressed (see compressRoutes).
 *
 * `routeTo[i]` is the nearer endpoint of the explaining segment (-1 for accepted
 * entries). Don't route blends to the globally nearest survivor: a mid-grey blend
 * can be nearer in RGB to an unrelated colour than to either of its own sources,
 * and would flood that entry. A blend is a mixture of its two endpoints, so it
 * goes to one of them.
 *
 * Alpha feathers: a translucent feather shell is a blend whose second endpoint is
 * transparency, so the RGB segment test cannot explain it (see FEATHER_ALPHA_STD).
 * An edge-local, non-real entry with the feather alpha signature (`feather[i]`)
 * dissolves into the nearest accepted entry by RGB; count-descending order ensures
 * the opaque parent is accepted first.
 */
function classifyBlends(
  palette: PaletteColor[],
  real: readonly boolean[],
  edgy: readonly boolean[],
  feather: readonly boolean[],
): { blend: boolean[]; routeTo: Int32Array } {
  const eps2 = BLEND_LINE_EPS * BLEND_LINE_EPS
  const accepted: number[] = []
  const blend = new Array<boolean>(palette.length).fill(false)
  const routeTo = new Int32Array(palette.length).fill(-1)
  const d2 = (a: PaletteColor, b: PaletteColor): number => {
    const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b
    return dr * dr + dg * dg + db * db
  }
  for (let i = 0; i < palette.length; i++) {
    let bestD = Infinity
    if (!real[i] && edgy[i]) {
      for (let a = 0; a < accepted.length; a++) {
        for (let b = a + 1; b < accepted.length; b++) {
          const d = segDist2(palette[i], palette[accepted[a]], palette[accepted[b]])
          if (d <= eps2 && d < bestD) {
            bestD = d
            const ia = accepted[a], ib = accepted[b]
            routeTo[i] = d2(palette[i], palette[ia]) <= d2(palette[i], palette[ib]) ? ia : ib
          }
        }
      }
      if (routeTo[i] < 0 && feather[i]) {
        let best = -1, bd = Infinity
        for (const a of accepted) {
          const d = d2(palette[i], palette[a])
          if (d < bd) {
            bd = d
            best = a
          }
        }
        routeTo[i] = best
      }
    }
    if (routeTo[i] >= 0) blend[i] = true
    else accepted.push(i)
  }

  // Fixpoint passes: re-test every still-accepted entry against the current
  // accepted set. Pass-synchronous (tests read the pass-start set, dissolutions
  // commit at pass end), so the result does not depend on order within a pass.
  // Terminates because the accepted set only shrinks. The feather clause does not
  // re-run; its first-pass routing stands.
  for (;;) {
    const live = accepted.filter((i) => !blend[i])
    const found: { i: number; route: number }[] = []
    for (const i of live) {
      if (real[i] || !edgy[i]) continue
      let bestD = Infinity
      let route = -1
      for (let a = 0; a < live.length; a++) {
        if (live[a] === i) continue
        for (let b = a + 1; b < live.length; b++) {
          if (live[b] === i) continue
          const d = segDist2(palette[i], palette[live[a]], palette[live[b]])
          if (d <= eps2 && d < bestD) {
            bestD = d
            const ia = live[a], ib = live[b]
            route = d2(palette[i], palette[ia]) <= d2(palette[i], palette[ib]) ? ia : ib
          }
        }
      }
      if (route >= 0) found.push({ i, route })
    }
    if (found.length === 0) break
    for (const { i, route } of found) {
      blend[i] = true
      routeTo[i] = route
    }
  }
  return { blend, routeTo: compressRoutes(blend, routeTo) }
}

/**
 * Path-compress the blend routes: a route into an entry that a later pass
 * dissolved follows it to its own endpoint.
 *
 * Chains are almost acyclic: a route targets an entry that was accepted when the
 * route was chosen, so it points backwards in dissolution time, except within one
 * fixpoint pass, which commits all its findings at once. Two entries found in the
 * same pass can explain each other, leaving a cycle with no accepted endpoint
 * (following it would loop forever). In that case the evidence prefers neither,
 * so the cycle's members are restored as accepted palette colours. Acyclic input
 * is unchanged.
 */
export function compressRoutes(blend: boolean[], routeTo: Int32Array): Int32Array {
  for (let i = 0; i < blend.length; i++) {
    if (!blend[i]) continue
    const chain: number[] = []
    let t = i
    while (t >= 0 && blend[t] && !chain.includes(t)) {
      chain.push(t)
      t = routeTo[t]
    }
    if (t >= 0 && blend[t]) {
      // Closed on itself: drop the cycle's members back to accepted.
      for (let k = chain.indexOf(t); k < chain.length; k++) {
        blend[chain[k]] = false
        routeTo[chain[k]] = -1
      }
    }
  }
  for (let i = 0; i < blend.length; i++) {
    if (!blend[i]) continue
    while (routeTo[i] >= 0 && blend[routeTo[i]]) routeTo[i] = routeTo[routeTo[i]]
  }
  return routeTo
}

/** An entry is edge-local (a candidate AA transition zone) when at least this
 *  fraction of its pixels have a 4-neighbour in a different colour class. A 1px
 *  band scores 1.0 and a 2px band close to it (each column touches the far side);
 *  a 3px band drops to ~⅔ and real bands fall towards 0 with width. */
const EDGE_LOCAL_MIN = 0.6

/**
 * Per-label fraction of pixels with a 4-neighbour in a different label
 * (transparent counts as different, since the alpha silhouette is an edge too;
 * the image border does not). See EDGE_LOCAL_MIN.
 */
function edgeFractions(labels: Int32Array, w: number, h: number, paletteLen: number): Float64Array {
  const total = new Int32Array(paletteLen)
  const edge = new Int32Array(paletteLen)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const l = labels[i]
      if (l < 0) continue
      total[l]++
      if (
        (x > 0 && labels[i - 1] !== l) || (x < w - 1 && labels[i + 1] !== l) ||
        (y > 0 && labels[i - w] !== l) || (y < h - 1 && labels[i + w] !== l)
      ) edge[l]++
    }
  }
  const out = new Float64Array(paletteLen)
  for (let l = 0; l < paletteLen; l++) out[l] = total[l] > 0 ? edge[l] / total[l] : 0
  return out
}

/**
 * Per-label count of the most frequent exact source colour among its pixels: the
 * thin-feature analogue of flat-interior area. A sub-pixel feature has no 3×3
 * flat interior, but its fully covered pixels still repeat the authored colour
 * exactly, while sensor or JPEG noise rarely repeats one RGB value. Used to
 * protect small non-blend entries from the share threshold.
 */
function modalColorCounts(labels: Int32Array, data: Uint8ClampedArray, paletteLen: number): Int32Array {
  const hist: Map<number, number>[] = Array.from({ length: paletteLen }, () => new Map<number, number>())
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    if (l < 0) continue
    const o = i * 4
    const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]
    const h = hist[l]
    h.set(key, (h.get(key) ?? 0) + 1)
  }
  const out = new Int32Array(paletteLen)
  for (let l = 0; l < paletteLen; l++) {
    let best = 0
    for (const c of hist[l].values()) if (c > best) best = c
    out[l] = best
  }
  return out
}

/**
 * Restore connected components that modeFilter destroyed. The 3×3 majority vote
 * melts 1px stair-steps along boundaries, but a straight 1px-wide feature loses
 * the vote everywhere (3 own vs 6 background) and is deleted wholesale. A
 * stair-step cleanup only shifts a boundary by about a pixel, so a real blob keeps
 * most of itself; a component that keeps at most RESTORE_MAX_SURVIVAL of its
 * pixels was destroyed, not smoothed, and is put back from the pre-filter labels.
 * Components below minArea stay removed; despeckle would dissolve them anyway.
 *
 * Grouping is 8-connected (unlike despeckleComponents): a thin diagonal feature
 * is 4-disconnected into fragments too small to pass any floor, but is one
 * 8-component.
 */
function restoreErasedComponents(
  pre: Int32Array,
  post: Int32Array,
  w: number,
  h: number,
  minArea: number,
  data: Uint8ClampedArray,
): Int32Array {
  const n = w * h
  let out = post
  const comp = new Int32Array(n).fill(-1)
  const stack: number[] = []
  let cid = 0
  for (let start = 0; start < n; start++) {
    if (comp[start] !== -1 || pre[start] < 0) continue
    const lab = pre[start]
    comp[start] = cid
    stack.length = 0
    stack.push(start)
    const pixels: number[] = []
    let kept = 0
    while (stack.length) {
      const p = stack.pop()!
      pixels.push(p)
      if (post[p] === lab) kept++
      const x = p % w, y = (p / w) | 0
      const x0 = x > 0, x1 = x < w - 1, y0 = y > 0, y1 = y < h - 1
      const nb = [
        x0 ? p - 1 : -1, x1 ? p + 1 : -1, y0 ? p - w : -1, y1 ? p + w : -1,
        x0 && y0 ? p - w - 1 : -1, x1 && y0 ? p - w + 1 : -1,
        x0 && y1 ? p + w - 1 : -1, x1 && y1 ? p + w + 1 : -1,
      ]
      for (const q of nb) {
        if (q >= 0 && comp[q] === -1 && pre[q] === lab) { comp[q] = cid; stack.push(q) }
      }
    }
    if (kept <= pixels.length * RESTORE_MAX_SURVIVAL && pixels.length >= minArea) {
      if (out === post) out = post.slice()
      for (const p of pixels) out[p] = lab
      // 4-connect the restored chain. A diagonal step (p ↘ q with no shared
      // 4-neighbour in the label) is a checkerboard pinch, which the planar tracer
      // reads as a junction pair; a restored 45° stroke would become hundreds of
      // them. At each pinch, claim the side pixel whose source colour is closer to
      // the component's mean: it is the same feature's blend shade, so this widens
      // the stroke toward its true footprint. An axis-aligned bar has no diagonal
      // steps, so this is a no-op there.
      let mr = 0, mg = 0, mb = 0
      for (const p of pixels) {
        mr += data[p * 4]
        mg += data[p * 4 + 1]
        mb += data[p * 4 + 2]
      }
      mr /= pixels.length
      mg /= pixels.length
      mb /= pixels.length
      const d2mean = (p: number): number => {
        const dr = data[p * 4] - mr, dg = data[p * 4 + 1] - mg, db = data[p * 4 + 2] - mb
        return dr * dr + dg * dg + db * db
      }
      for (const p of pixels) {
        const x = p % w, y = (p / w) | 0
        if (y >= h - 1) continue
        for (const dx of [-1, 1]) {
          const qx = x + dx
          if (qx < 0 || qx >= w) continue
          const q = p + w + dx
          if (out[q] !== lab) continue
          const s1 = p + dx // (x+dx, y)
          const s2 = p + w //  (x,    y+1)
          if (out[s1] === lab || out[s2] === lab) continue
          if (out[s1] < 0 && out[s2] < 0) continue
          const pick = out[s1] < 0 ? s2 : out[s2] < 0 ? s1 : d2mean(s1) <= d2mean(s2) ? s1 : s2
          out[pick] = lab
        }
      }
    }
    cid++
  }
  return out
}

/** A pre-filter component keeping at most this fraction of itself through the mode
 *  filter was destroyed (a thin feature), not boundary-smoothed (a real blob keeps
 *  about 1 − perimeter/area, typically 0.7 or more), so it is restored whole.
 *  0 restores only components erased completely. */
const RESTORE_MAX_SURVIVAL = 0.3

export interface FlatPaletteResult extends QuantizeResult {
  /**
   * Fraction of opaque pixels whose original colour sits within a tight Δ of the
   * flat colour they were assigned. High (≈1) ⇒ flat regions plus thin AA, where
   * palette-first is ideal. Low ⇒ continuous tone that a small palette would
   * over-posterize; the caller should use the smoothness segmenter instead.
   */
  flatCoverage: number
  /**
   * How many palette entries survive share/real-region evidence alone, before
   * blend-line dissolution. This is what the caller's flat-vs-rich test must count:
   * on continuous tone many clusters lie between other clusters, so blend
   * dissolution can shrink a photo's palette under the colour ceiling and misroute
   * it into palette-first.
   */
  dominantColors: number
}

/** RGB² distance under which a pixel counts as "is its flat colour" (not AA/tone). */
const FLAT_TIGHT2 = 32 * 32

/**
 * Assign every kept pixel (alpha ≥ 128) to a palette colour; pixels below the alpha
 * mask (< 128) get -1. Used by the locked-palette path: the user supplies the
 * colours, so there is no clustering — just nearest-colour snapping over a fixed
 * palette.
 *
 * Hue is strict RGB-nearest; alpha only breaks ties among entries at the same RGB
 * distance (duplicate-RGB swatches), picking the one whose alpha is nearest the
 * pixel's. So locking one hue at two opacities separates more and less transparent
 * pixels, while editing one swatch's alpha never changes which region it owns; it
 * only repaints that region's opacity. An all-opaque palette is plain RGB-nearest.
 */
function assignNearest(
  img: { width: number; height: number; data: Uint8ClampedArray },
  palette: PaletteColor[],
): Int32Array {
  const { data } = img
  const n = img.width * img.height
  const labels = new Int32Array(n)
  const pa = palette.map((c) => c.a ?? 255)
  const rgbD = new Float64Array(palette.length)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (data[o + 3] < 128) {
      labels[i] = -1
      continue
    }
    const r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3]
    let minD = Infinity
    for (let c = 0; c < palette.length; c++) {
      const dr = r - palette[c].r, dg = g - palette[c].g, db = b - palette[c].b
      const d = dr * dr + dg * dg + db * db
      rgbD[c] = d
      if (d < minD) minD = d
    }
    // Among the RGB-nearest entries (exact ties from duplicate-RGB swatches), the one
    // whose alpha is closest to the pixel's wins; otherwise the single nearest hue.
    let best = 0, bestAlphaD = Infinity
    for (let c = 0; c < palette.length; c++) {
      if (rgbD[c] !== minD) continue
      const da = a - pa[c]
      const ad = da * da
      if (ad < bestAlphaD) { bestAlphaD = ad; best = c }
    }
    labels[i] = best
  }
  return labels
}

/**
 * Per-label mode of the source alpha (over kept pixels). A flat region's interior
 * is one constant alpha that dominates its anti-aliased rim, so the mode is the
 * region's true opacity (the alpha analogue of snapPaletteToModes). Returns 255 for
 * an empty label. Ties break to the lower alpha for determinism.
 */
function regionAlphaModes(labels: Int32Array, data: Uint8ClampedArray, paletteLen: number): number[] {
  const hist: Map<number, number>[] = Array.from({ length: paletteLen }, () => new Map<number, number>())
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    if (l < 0) continue
    const a = data[i * 4 + 3]
    const h = hist[l]
    h.set(a, (h.get(a) ?? 0) + 1)
  }
  return hist.map((h) => {
    let bestA = 255, bestC = 0
    for (const [a, c] of h) {
      if (c > bestC || (c === bestC && a < bestA)) {
        bestC = c
        bestA = a
      }
    }
    return bestC > 0 ? bestA : 255
  })
}

/**
 * Snap each palette entry to the most frequent exact source colour among its
 * pixels (the mode) instead of the k-means mean. A flat region's interior is many
 * pixels of one design colour while its anti-aliased boundary pixels are each rare,
 * so the mode lands on the design hex rather than the centroid's drift.
 *
 * Each distinct source colour maps to exactly one cluster, so no two labels can
 * share a modal colour. Ties break to the lower packed-RGB key for determinism.
 * Returns a fresh palette; an empty label keeps its original entry.
 *
 * `exclude` masks pixels out of the census: the caller passes the pixels of
 * dissolved blend clusters. A routed-in blend is a coverage mixture, not a
 * candidate design colour, and at low resolution it can out-count the entry's own
 * colour. An entry whose pixels are all excluded keeps its centroid.
 */
function snapPaletteToModes(
  palette: PaletteColor[],
  labels: Int32Array,
  data: Uint8ClampedArray,
  exclude?: Uint8Array,
): PaletteColor[] {
  const hist: Map<number, number>[] = palette.map(() => new Map<number, number>())
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    if (l < 0 || exclude?.[i]) continue
    const o = i * 4
    const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]
    const h = hist[l]
    h.set(key, (h.get(key) ?? 0) + 1)
  }
  return palette.map((c, l) => {
    let bestKey = -1, bestCount = 0
    for (const [key, count] of hist[l]) {
      if (count > bestCount || (count === bestCount && key < bestKey)) {
        bestCount = count
        bestKey = key
      }
    }
    if (bestKey < 0) return { r: c.r, g: c.g, b: c.b } // empty label — keep centroid
    return { r: (bestKey >> 16) & 0xff, g: (bestKey >> 8) & 0xff, b: bestKey & 0xff }
  })
}

/**
 * Segment flat art by palette-then-assign. Returns a QuantizeResult (labels are
 * colour classes, 0..palette.length-1, largest first) in the same shape as
 * segmentImage's output, plus a `flatCoverage` suitability signal for the caller's
 * flat-vs-photo test.
 *
 * When `lockedPalette` is supplied (the user-edited palette), quantization is
 * skipped: every pixel snaps to the nearest given colour and the colours are
 * emitted verbatim (no mode snap; the user's hex is authoritative). Otherwise the
 * dominant palette is extracted and each entry is snapped to its design hex (mode).
 */
export function segmentFlatPalette(
  img: { width: number; height: number; data: Uint8ClampedArray },
  opts: PaletteSegmentOptions = DEFAULT_PALETTE_SEGMENT,
  lockedPalette?: PaletteColor[],
): FlatPaletteResult {
  const locked = lockedPalette && lockedPalette.length > 0 ? lockedPalette : null
  let palette: PaletteColor[]
  let labels: Int32Array
  let dominantColors: number
  // Pixels that belonged to a dissolved blend cluster, excluded from the mode-snap
  // census below (see snapPaletteToModes). Unset when nothing dissolved.
  let snapExclude: Uint8Array | undefined
  if (locked) {
    // User-locked palette: no clustering; assign every pixel to the nearest of the
    // user's colours (RGBA) and keep them exactly as given. Opaque entries omit
    // `a` so they serialize without a redundant fill-opacity.
    palette = locked.map((c) => (c.a !== undefined && c.a < 255 ? { r: c.r, g: c.g, b: c.b, a: c.a } : { r: c.r, g: c.g, b: c.b }))
    labels = assignNearest(img, palette)
    dominantColors = palette.length // the user owns the count; the caller's gates are bypassed anyway
  } else {
    // 1. Over-provisioned palette. quantize maps every distinct colour (AA blends
    //    included) to its nearest centroid. The third argument enables quantize's
    //    evidence-based merge veto, since two authored colours can sit inside
    //    MERGE_DISTANCE of each other; same floor as the region protection below.
    let q = quantize(img as ImageData, opts.maxColors, opts.minRegionArea)
    // 1b. Fuse one ink's shading tones (see shadingFuse.ts). Runs on quantize's raw
    //     labels, before any cleanup moves a pixel; a no-op returns the same object.
    if (opts.shadingFuse !== false) q = fuseShadingTones(img, q).q
    // 2. Dissolve low-share entries (blend smears) into their nearest real colour,
    //    but protect entries with enough flat-interior evidence to be a real region:
    //    share alone cannot tell a small region from a blend band, and dropping a
    //    real region repaints it with the nearest surviving colour. The floor is
    //    minRegionArea, since anything smaller is despeckled below anyway, and it
    //    scales with the user's Despeckle setting.
    //
    //    Thin features have no flat interior, so for them the share test is
    //    corrected from both sides with colour-line evidence (classifyBlends): an
    //    entry that is a coverage blend of two accepted colours is dissolved into
    //    its nearer endpoint even when parallel thin features push it over
    //    minShare, and a non-blend entry that repeats one exact colour
    //    ≥ minRegionArea times is kept even under minShare.
    const flat = flatInteriorCounts(img, q.labels, q.palette.length)
    const real = Array.from(flat, (c) => c >= opts.minRegionArea)
    const edgy = Array.from(edgeFractions(q.labels, img.width, img.height, q.palette.length), (f) => f >= EDGE_LOCAL_MIN)
    const alphaStats = regionAlphaStats(q.labels, img.data, q.palette.length)
    const feather = alphaStats.map((s) => s.mode < 255 && s.std >= FEATHER_ALPHA_STD && s.modeShare <= FEATHER_MODE_SHARE)
    const { blend, routeTo } = classifyBlends(q.palette, real, edgy, feather)
    const modal = modalColorCounts(q.labels, img.data, q.palette.length)
    // Richness for the caller's flat-vs-rich test: survivors under share/real
    // evidence alone, before blend dissolution (see FlatPaletteResult).
    const total = q.counts.reduce((a, b) => a + b, 0)
    dominantColors = q.counts.filter((c, i) => (total > 0 && c / total >= opts.minShare) || real[i]).length
    if (blend.some(Boolean)) {
      // Relabel each blend entry into its endpoint before the share drop (endpoints
      // are accepted entries after path compression), so the emptied entries fall
      // out of dropMinorColors with no pixels to misroute. The moved pixels are
      // remembered (`snapExclude`) so a routed-in blend colour cannot out-vote the
      // entry's own hex in the mode snap.
      const counts = q.counts.slice()
      for (let i = 0; i < counts.length; i++) {
        if (!blend[i]) continue
        counts[routeTo[i]] += counts[i]
        counts[i] = 0
      }
      const labels = q.labels.slice()
      snapExclude = new Uint8Array(labels.length)
      for (let i = 0; i < labels.length; i++) {
        const l = labels[i]
        if (l >= 0 && blend[l]) {
          labels[i] = routeTo[l]
          snapExclude[i] = 1
        }
      }
      q = { palette: q.palette, labels, counts }
    }
    const protect = real.map((r, i) => r || (!blend[i] && modal[i] >= opts.minRegionArea))
    q = dropMinorColors(q, opts.minShare, protect)
    palette = q.palette
    labels = q.labels
  }

  // Suitability: how much of the image is its assigned flat colour. AA pixels and
  // photo tones miss; flat interiors hit. Measured on the post-drop labels, before
  // boundary cleanup and before the mode snap, so the flat-vs-photo threshold
  // applies to centroids.
  let opaque = 0, flat = 0
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    if (l < 0) continue
    opaque++
    const o = i * 4
    const c = palette[l]
    const dr = img.data[o] - c.r, dg = img.data[o + 1] - c.g, db = img.data[o + 2] - c.b
    if (dr * dr + dg * dg + db * db <= FLAT_TIGHT2) flat++
  }
  const flatCoverage = opaque > 0 ? flat / opaque : 0

  // Snap the auto palette to design hex (mode, not mean) and tag each region with
  // its alpha mode so a flat semi-transparent region keeps its opacity (only when
  // < 255, so opaque art stays alpha-free). A locked palette is left verbatim.
  if (!locked) {
    palette = snapPaletteToModes(palette, labels, img.data, snapExclude)
    const alphas = regionAlphaModes(labels, img.data, palette.length)
    palette = palette.map((c, l) => (alphas[l] < 255 ? { ...c, a: alphas[l] } : c))
  }

  // 3. Melt the residual 1px boundary stair-step into the dominant neighbour, then
  //    put back components the vote destroyed (see restoreErasedComponents).
  //    Restore before despeckle so a restored thin feature is measured at full size.
  const smoothed = modeFilter(labels, img.width, img.height, opts.modePasses)
  const restored = restoreErasedComponents(labels, smoothed, img.width, img.height, opts.minRegionArea, img.data)
  // 4. Dissolve sub-threshold specks and pinholes so they don't each become a loop,
  //    unless the component carries flat-interior evidence that it is real art (a
  //    small glyph of an otherwise large ink can be one such component).
  const cleaned = despeckleComponents(
    restored,
    img.width,
    img.height,
    opts.minRegionArea,
    opts.regionEvidence !== false ? { data: img.data, palette } : undefined,
  )

  // modeFilter and despeckle move pixels between labels; recompute exact counts.
  const counts = new Array<number>(palette.length).fill(0)
  for (let i = 0; i < cleaned.length; i++) {
    const l = cleaned[i]
    if (l >= 0) counts[l]++
  }
  return { palette, labels: cleaned, counts, flatCoverage, dominantColors }
}
