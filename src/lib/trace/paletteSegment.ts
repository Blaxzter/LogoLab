// Palette-first segmentation for FLAT art (gradients off) — the structural fix for
// anti-alias "blend regions". The Mumford–Shah segmenter (segment.ts) groups by
// SMOOTHNESS, so the ~1–2px anti-aliased ramp between two flat colours is itself a
// smooth field and becomes its OWN region with a blended colour (the olive sliver
// between orange and teal, the brown bands where a colour fades to black, …). No
// area- or detail-based merge removes them: a band runs the whole length of a
// contact edge, so its area clears any threshold.
//
// Palette-first inverts the order (this is the old V1 posterize path, rebuilt on
// quantize.ts): pick a small palette of the DOMINANT colours, then assign EVERY
// pixel — anti-aliased ones included — to the nearest palette colour. A blend pixel
// snaps to whichever real colour it is closest to, so the boundary collapses to a
// single clean edge at the 50% isophote and no intermediate region can exist. It is
// gated to flat art because assigning-to-nearest would band a real gradient (the MS
// path still owns gradient art, where the smooth-field grouping is correct).

import type { PaletteColor, QuantizeResult } from './types'
import { quantize, dropMinorColors, modeFilter } from './quantize.ts'

export interface PaletteSegmentOptions {
  /** k-means cluster budget. Over-provisioned: dropMinorColors trims the extras,
   *  so this only needs to be ≥ the true colour count (logos: a handful). */
  maxColors: number
  /** Drop palette entries holding less than this share of the opaque pixels into
   *  their nearest survivor. AA blend bands are each a small share, so this is what
   *  removes the spurious blend colours. Real flats are NOT always above it — a
   *  small genuine region (a pencil tip, a backpack) can hold less than a long
   *  edge's blend band — so entries with flat-interior evidence ≥ minRegionArea are
   *  exempted (see flatInteriorCounts). */
  minShare: number
  /** 3×3 majority-vote passes to melt the 1px stair-step the nearest-colour
   *  assignment leaves along each boundary (a clean single edge afterwards). */
  modePasses: number
  /** Connected components smaller than this (opaque px) are dissolved into the
   *  label that borders them most — kills salt-and-pepper specks / pinholes from
   *  source noise that would otherwise each become an extra traced loop. */
  minRegionArea: number
}

export const DEFAULT_PALETTE_SEGMENT: PaletteSegmentOptions = {
  maxColors: 16,
  minShare: 0.006,
  modePasses: 2,
  minRegionArea: 64,
}

/**
 * Dissolve connected components below `minArea` into the label that borders them
 * most. 4-connectivity, iterative scan-flood (deterministic order). A label class
 * can span many components; only the tiny ones are absorbed, so real shapes (text
 * bars, ring strokes — thousands of px) are untouched. Mutates a copy.
 *
 * Deliberately 4-connected, unlike restoreErasedComponents' grouping (§0 #6): the
 * planar tracer reads a 4-disconnected pixel set as separate faces, so 8-chained
 * AA shrapnel that despeckle "kept" would each still become its own tiny loop —
 * an 8-connected despeckle was tried here and shattered pencil-flat @256 into 166
 * fringe loops (parsimony 1.5× → 10.1×). Restored thin diagonals don't need it:
 * the restore pinch-fill 4-connects them, so they pass this floor as one comp.
 */
function despeckleComponents(labels: Int32Array, w: number, h: number, minArea: number): Int32Array {
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
    if (pixels.length < minArea) {
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
 * Per-label count of FLAT-INTERIOR source pixels: a pixel whose 8 neighbours all
 * carry the exact same source colour. This is the evidence that separates a REAL
 * small region from an anti-alias blend smear, and area alone cannot: a blend band
 * runs the whole length of a contact edge (its pixel count clears any share
 * threshold a small region can clear) but every one of its pixels is a one-off
 * blend, essentially never surrounded by eight identical pixels — while a genuine
 * region interior always is. Measured on the tier-2 corpus: every real dropped
 * region had 300+ flat-interior pixels, every blend-smear entry had 0 (§9.1).
 * (Same criterion scoreRegions uses to count true regions, for the same reason.)
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
 * a true blend cluster sits essentially ON the segment (hairlines' #88888d is the
 * exact bg↔bar midpoint; the red↔bg fringe clusters measure ≤ 6 off their line).
 * Same scale as quantize's MERGE_DISTANCE: colours closer than 10 already count
 * as "the same colour" there, so within 10 of a blend LINE is plausibly a blend.
 */
const BLEND_LINE_EPS = 10

/** Squared RGB distance from colour c to the SEGMENT a—b (not the infinite line —
 *  clamping means "near an endpoint" reads as "near that colour", which routes
 *  near-duplicates the same way dropMinorColors would anyway). */
function segDist2(c: PaletteColor, a: PaletteColor, b: PaletteColor): number {
  const abr = b.r - a.r, abg = b.g - a.g, abb = b.b - a.b
  const len2 = abr * abr + abg * abg + abb * abb
  let t = len2 > 0 ? ((c.r - a.r) * abr + (c.g - a.g) * abg + (c.b - a.b) * abb) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const dr = c.r - (a.r + t * abr), dg = c.g - (a.g + t * abg), db = c.b - (a.b + t * abb)
  return dr * dr + dg * dg + db * db
}

/**
 * Alpha-feather evidence thresholds (§0 #13). An AI-export PNG surrounds its
 * opaque shapes with a 3–6px ALPHA ramp; quantize slices that ramp into
 * translucent shell clusters whose RGB the pairwise blend model can NEVER explain
 * (the colour is a 3-way mix — parent hue × under-glow × alpha ramp — measured
 * 13.5–21.2 RGB off every accepted-pair segment on the repro, eps 10; and a
 * per-pixel RGB(α) ramp fit extrapolated to α=255 lands 18.8–101 off the parent,
 * so an RGB-explainability test cannot be the gate either). What separates a
 * feather from an AUTHORED translucent flat is the alpha DISTRIBUTION: a feather
 * RAMPS (per-cluster α std ≥ 16.1 on the repro, no plateau — top α mode holds
 * ≤ 6% of pixels), a genuine translucent flat is ONE alpha (authored controls:
 * std 0.0–0.3, mode share 1.00; the worst healthy AA fringe measured std 6.6,
 * share 0.38). The thresholds sit in those gaps with ≥ 1.5× margin on both
 * sides. Fully-opaque art has α mode 255 everywhere, so the gate is inert on
 * every gated corpus (truth gate rasterizes on white) — byte-identical.
 */
const FEATHER_ALPHA_STD = 10
const FEATHER_MODE_SHARE = 0.15

/** Per-label alpha statistics over kept pixels: MODE, mode's share of the label's
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
 * Classify each palette entry as an anti-alias COVERAGE BLEND or not. AA blends a
 * pixel's colour linearly (in sRGB) between the feature and its background, so a
 * blend cluster's colour lies ON the RGB segment between two real colours — while
 * an authored colour does not (hairlines' red is ~100 off every such line). That
 * is the evidence flat-interior area cannot supply for THIN features: a sub-pixel
 * bar and its blend smear both have zero 3×3-flat interior, but only the smear is
 * explainable as a mix of two other colours.
 *
 * Collinearity alone is NOT sufficient evidence: the middle band of a posterized
 * ramp is the exact midpoint of its neighbours BY CONSTRUCTION (aurora), and
 * dissolving it repaints a wide authored stripe. What separates an AA blend from
 * a mid-ramp band is that a coverage blend is an EDGE phenomenon — a 1–2px
 * transition zone where essentially every pixel touches another colour class —
 * so only entries that are also edge-local (`edgy`) are candidates. A wide band
 * is mostly interior (aurora's dissolved stripe measured ~7% edge contact) and
 * is accepted no matter how collinear it is.
 *
 * Greedy, in palette order (count-descending — quantize guarantees it): an entry
 * with real-region evidence (`real`) is accepted outright; otherwise it is a blend
 * iff it is edge-local AND sits within BLEND_LINE_EPS of the segment between two
 * ALREADY-accepted entries, else accepted too. Processing large-first means a
 * blend's two source colours are accepted before the blend itself comes up (a
 * region outweighs its own edge band; a feature's pure core outweighs each of its
 * fringe clusters).
 *
 * …usually. At LOW resolution the order INVERTS (§0 #6): hairlines @256 puts the
 * bars' 25%-coverage blend cluster (1,009px) ABOVE the pure bar colour (816px), so
 * the blend is processed first, cannot be explained (its second endpoint is not
 * accepted yet), and is accepted itself — a fake palette colour that then absorbs
 * the mid-grey and paints the thin bars. So after the greedy pass the
 * classification is iterated to a FIXPOINT: each still-accepted entry is re-tested
 * (same evidence — edge-local, non-real, within eps of a segment between two OTHER
 * currently-accepted entries), pass-synchronously for determinism, until nothing
 * changes. When the greedy order was already right (every gated case @512) the
 * first re-pass finds nothing and the output is byte-identical. Routes are
 * path-compressed at the end: an entry routed into a colour that a later pass
 * dissolved follows it to ITS endpoint (grey mid-blend → 25%-grey → the bar
 * colour), which preserves the endpoint-routing principle transitively — chains
 * are acyclic because a route target always dissolves in a strictly later pass
 * than its source.
 *
 * `routeTo[i]` is the nearer ENDPOINT of the explaining segment (-1 for accepted
 * entries). Routing matters as much as dropping: the globally-nearest surviving
 * colour can be the WRONG side entirely — hairlines' bg↔bar midpoint #88888d is
 * nearer in raw RGB to the red diagonal (d² 17713) than to either of its own
 * sources (35649/35864), so nearest-survivor routing floods 4059 grey pixels into
 * the red entry and the mode-snap then renames red to grey. A blend can only ever
 * be a mixture of its two endpoints, so it goes to one of THEM.
 *
 * ALPHA-FEATHER endpoint (§0 #13): a translucent shell of an alpha feather is a
 * blend whose second endpoint is TRANSPARENCY, so the pairwise RGB segment test
 * above can never explain it (see FEATHER_ALPHA_STD). An entry that is edge-local,
 * has no real-region evidence, and carries the measured feather alpha signature
 * (`feather[i]`) dissolves into the nearest ACCEPTED entry by RGB — measured 100%
 * unanimous with per-pixel nearest routing on the repro (count-descending order
 * guarantees the opaque parents are accepted before their own shells come up).
 * This reproduces the user-approved delete-the-swatch workaround automatically.
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

  // Fixpoint passes (§0 #6): re-test every still-accepted entry against the CURRENT
  // accepted set. Pass-synchronous — all tests read the pass-start set, dissolutions
  // commit at pass end — so the result does not depend on palette order within a
  // pass. Terminates: the accepted set only shrinks. The feather clause does not
  // re-run (it is not segment evidence; its pass-1 routing stands).
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
 * The chains are ALMOST acyclic. A route always targets an entry that was
 * accepted when the route was chosen, so a route can only ever point "backwards"
 * in dissolution time — except inside ONE fixpoint pass, which commits every
 * entry it found at the same moment. Two such entries can explain each other
 * (i's best segment ends at j and j's at i), and that closed pair has no accepted
 * endpoint to route to at all: following it looped forever, hanging the tracer on
 * the image that produced the pair.
 *
 * A mutual pair is exactly the case where the evidence does not prefer either
 * entry, so neither is dissolved — the cycle is un-dissolved and both stay real
 * palette colours. Acyclic input is untouched, so every image that traced before
 * traces byte-identically.
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

/** An entry is "edge-local" — a candidate AA transition zone — when at least this
 *  fraction of its pixels have a 4-neighbour in a different colour class. A 1px
 *  band scores 1.0 and a 2px band close to it (each column touches the far side);
 *  a 3px band drops to ~⅔ and real bands fall towards 0 with width. */
const EDGE_LOCAL_MIN = 0.6

/**
 * Per-label fraction of pixels that touch a DIFFERENT label 4-connexionally
 * (transparent counts as different — the alpha silhouette is an edge too; the
 * image border does not). See EDGE_LOCAL_MIN.
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
 * Per-label count of the MOST FREQUENT exact source colour among its pixels. This
 * is the thin-feature analogue of flat-interior area: a sub-pixel feature never
 * has a 3×3 flat interior, but its fully-covered pixels still repeat the authored
 * colour EXACTLY, hundreds of times (hairlines' red diagonal: 620 × #b4283c) —
 * while sensor/JPEG noise almost never repeats one exact RGB value. Used to
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
 * Restore connected components that modeFilter erased ENTIRELY. The 3×3 majority
 * vote exists to melt 1px stair-steps along boundaries, but a straight 1px-wide
 * feature loses that vote everywhere (3 own vs 6 background) — so a sub-pixel bar
 * that survived quantization is deleted wholesale (hairlines' 0.5px bar: all 408px
 * gone in one pass, p95 55.9). A stair-step cleanup can only shift a boundary by
 * ~1px locally — it can never consume a ≥ minArea component completely — so "the
 * whole component vanished" is precise evidence the filter ate a thin feature,
 * and those components (from the PRE-filter labels) are put back verbatim.
 * Components below minArea stay dead: despeckle would dissolve them regardless.
 *
 * 8-connected like despeckleComponents, and for the same reason (§0 #6): the thin
 * features this rescue EXISTS FOR are 4-disconnected whenever they run diagonally —
 * hairlines' 45° stroke @256 fragments into ~6px 4-components that no floor can
 * pass, while the feature is one ~300px 8-component. (Grouping only — the restored
 * pixels are the pre-filter labels verbatim, exactly as before.)
 *
 * And "erased ENTIRELY" is measured as an EROSION FRACTION, not survived-at-all
 * (§0 #6): under 8-connected grouping one surviving pixel would poison a whole
 * chain's rescue — hairlines' @256 diagonal keeps a handful of its ~300px through
 * the vote and was therefore "eroded, not erased", invisible to the old test. The
 * §9.5 evidence argument quantifies: a majority vote can only melt ~a perimeter's
 * worth of a real blob (survival stays near 1), while a thin feature loses almost
 * everything — so a component that keeps ≤ RESTORE_MAX_SURVIVAL of itself was
 * destroyed, not smoothed, and comes back whole.
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
      // 4-CONNECT the restored chain. A restored diagonal step (p ↘ q, no shared
      // 4-neighbour in the label) is a checkerboard PINCH: the planar tracer reads
      // each one as a junction pair, and a restored 45° stroke becomes a chain of
      // hundreds of them (hairlines @256 parsimony 1.1× → 4.7× — geometry right,
      // node economy destroyed). Claim, at each pinch, the side pixel whose SOURCE
      // colour sits closer to the component's own mean — that pixel is the same
      // feature's blend shade, so the claim widens the stroke toward its true
      // footprint rather than inventing area. Restored components only: an
      // axis-aligned restored bar (all of §9.5's cases @512) has no diagonal
      // steps, so this is a no-op there by construction.
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
 *  filter was DESTROYED (thin feature), not boundary-smoothed (real blob keeps
 *  ≥ ~1 − perimeter/area ≈ 0.7+) — restore it whole. 0 reproduces the old
 *  erased-whole-only rescue. Sits far from both measured populations: hairlines'
 *  @256 diagonal keeps ~2% of its 306px; the smallest healthy corpus blobs keep
 *  ≥ ~70%. */
const RESTORE_MAX_SURVIVAL = 0.3

export interface FlatPaletteResult extends QuantizeResult {
  /**
   * Fraction of opaque pixels whose ORIGINAL colour sits within a tight Δ of the
   * flat colour they were assigned. High (≈1) ⇒ the image really is flat regions +
   * thin AA (a logo) and palette-first is ideal. Low ⇒ continuous tone (a photo)
   * that a small palette would over-posterize — the caller should fall back to the
   * smoothness segmenter instead.
   */
  flatCoverage: number
  /**
   * How many palette entries survive share/real-region evidence alone — BEFORE the
   * blend-line dissolution. This is what the caller's flat-vs-rich gate must count:
   * on continuous tone many clusters sit near lines between other clusters (that is
   * what continuous tone IS), so blend dissolution can shrink a photo's palette
   * under the MAX_COLORS ceiling and misroute it into palette-first (headphones:
   * 16 → 11 entries, meanΔE 3.9 → 5.5). The image's richness is a property of the
   * image, not of how aggressively AA smears were cleaned.
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
 * HUE is strict RGB-nearest; ALPHA only breaks ties among entries at the SAME RGB
 * distance (i.e. duplicate-RGB swatches), picking the one whose alpha is nearest the
 * pixel's. This keeps the two key behaviours decoupled: locking the SAME hue at two
 * opacities separates the more- and less-transparent pixels (the swatches share an
 * RGB so every pixel ties on RGB → alpha decides), while editing ONE swatch's alpha
 * never changes which region it owns (its RGB is unchanged, so the RGB-nearest set is
 * unchanged) — it just repaints that region's opacity. An all-opaque palette reduces
 * to plain RGB-nearest, identical to before.
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
    // Among the RGB-nearest entries (exact ties — duplicate-RGB swatches), the one
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
 * Per-label MODE of the source alpha (over kept pixels). A flat region's interior
 * is one constant alpha that dominates its anti-aliased rim, so the mode is the
 * region's true opacity — the alpha analogue of snapPaletteToModes. Returns 255 for
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
 * Snap each palette entry to the DOMINANT EXACT source colour among the pixels
 * assigned to it (the MODE), instead of the k-means count-weighted MEAN. A flat
 * region's interior is thousands of pixels of one true design colour while its
 * anti-aliased boundary pixels are each rare and distinct, so the mode lands on
 * the true design hex (#fc6304) rather than the centroid's drift (#fd6403).
 *
 * Each distinct source colour maps to exactly one cluster (nearest-centroid), so
 * no two labels can share a modal colour ⇒ the snapped palette has no colliding
 * entries. Ties break to the lower packed-RGB key for determinism. Pure: returns
 * a fresh palette; an empty label (no pixels) keeps its original entry.
 *
 * `exclude` masks pixels out of the census: the caller passes the pixels that
 * belonged to DISSOLVED BLEND clusters. A blend routed into an entry is a
 * coverage mixture, not a candidate design colour — and at low resolution it can
 * OUT-COUNT the entry's own colour (hairlines @256: the bars' 25%-coverage grey
 * columns, 1,006px of one exact value, vs the pure bar colour's 816px — the
 * census would rename the bar entry to the grey; §9.5's "mode-snap renames red
 * to grey" failure re-appearing one stage later, §0 #6). An entry whose pixels
 * are ALL excluded keeps its centroid, exactly like an empty label.
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
 * colour classes, 0..palette.length-1, largest first) — drop-in for the planar /
 * stacked-mask tracers, exactly like segmentImage's output — plus a `flatCoverage`
 * suitability signal for the caller's flat-vs-photo gate.
 *
 * When `lockedPalette` is supplied (the user-edited palette), quantization is
 * skipped entirely: every pixel snaps to the nearest GIVEN colour, the colours are
 * emitted verbatim (no mode-snap — the user's hex is authoritative), and the count
 * is whatever the user chose. Otherwise the dominant palette is extracted
 * automatically and each entry is snapped to its true design hex (mode).
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
  // Pixels that belonged to a dissolved BLEND cluster — excluded from the
  // mode-snap census below (see snapPaletteToModes). Unset when nothing dissolved.
  let snapExclude: Uint8Array | undefined
  if (locked) {
    // User-locked palette: no clustering — assign every pixel to the nearest of
    // the user's colours (RGBA) and keep them exactly as given. Opaque entries omit
    // `a` so they serialize without a redundant fill-opacity.
    palette = locked.map((c) => (c.a !== undefined && c.a < 255 ? { r: c.r, g: c.g, b: c.b, a: c.a } : { r: c.r, g: c.g, b: c.b }))
    labels = assignNearest(img, palette)
    dominantColors = palette.length // the user owns the count; the caller's gates are bypassed anyway
  } else {
    // 1. Over-provisioned palette. quantize maps every DISTINCT colour (AA blends
    //    included) to its nearest centroid, so no pixel keeps a blend value. The
    //    third argument arms quantize's evidence-based merge veto: two authored
    //    colours can sit inside MERGE_DISTANCE of each other (flute's
    //    #f5a165/#fea069, 9.9 apart — §0 #5), and only flat-interior evidence
    //    tells that apart from a split pixel cloud. Same floor as the region
    //    protection below, for the same reason.
    let q = quantize(img as ImageData, opts.maxColors, opts.minRegionArea)
    // 2. Dissolve the low-share entries (the blend smears) into their nearest real
    //    colour — this is what kills the olive/brown sliver colours. PROTECT any
    //    entry with enough flat-interior evidence to be a real region: share alone
    //    cannot tell a small region from a blend band, and dropping a real region
    //    repaints it with the nearest SURVIVING colour — arbitrarily wrong for an
    //    isolated dark detail (§9.1: pencil's tip painted eraser-pink, ΔE 76).
    //    The floor is minRegionArea: anything smaller is dissolved by despeckle
    //    below anyway, so protecting it would be pointless — and the floor scales
    //    with the user's Despeckle dial like the rest of the cleanup.
    //
    //    THIN features have no flat interior at all (a sub-pixel bar never contains
    //    a 3×3 pure block), so for them the share test is corrected from BOTH sides
    //    with colour-line evidence (classifyBlends): an entry that IS a coverage
    //    blend of two accepted colours is dissolved into its nearer blend ENDPOINT
    //    even when parallel thin features pile it over minShare (#88888d, 1.5% of
    //    hairlines — it would otherwise survive and paint every thin bar grey),
    //    and an entry that is NOT a blend and repeats one exact authored colour
    //    ≥ minRegionArea times is kept even under minShare (the red diagonal,
    //    0.24% share — it would otherwise be dissolved into that surviving grey).
    const flat = flatInteriorCounts(img, q.labels, q.palette.length)
    const real = Array.from(flat, (c) => c >= opts.minRegionArea)
    const edgy = Array.from(edgeFractions(q.labels, img.width, img.height, q.palette.length), (f) => f >= EDGE_LOCAL_MIN)
    const alphaStats = regionAlphaStats(q.labels, img.data, q.palette.length)
    const feather = alphaStats.map((s) => s.mode < 255 && s.std >= FEATHER_ALPHA_STD && s.modeShare <= FEATHER_MODE_SHARE)
    const { blend, routeTo } = classifyBlends(q.palette, real, edgy, feather)
    const modal = modalColorCounts(q.labels, img.data, q.palette.length)
    // Richness for the caller's flat-vs-rich gate: survivors under share/real
    // evidence alone, UNTOUCHED by blend dissolution (see FlatPaletteResult).
    const total = q.counts.reduce((a, b) => a + b, 0)
    dominantColors = q.counts.filter((c, i) => (total > 0 && c / total >= opts.minShare) || real[i]).length
    if (blend.some(Boolean)) {
      // Relabel each blend entry into its endpoint BEFORE the share drop — endpoints
      // are accepted entries (route chains are path-compressed in classifyBlends), so
      // the emptied entries then fall out of dropMinorColors with zero pixels to
      // misroute. The moved pixels are remembered (`snapExclude`) so the mode-snap
      // census cannot let a routed-in blend colour out-vote the entry's own hex.
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

  // Suitability: how much of the image actually IS its assigned flat colour. AA
  // pixels and photo tones miss; flat-region interiors hit. Measured on the post-
  // drop labels (the colours we'd emit), before the boundary clean-up — and before
  // the mode-snap, so the flat-vs-photo gate stays calibrated on the centroids.
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

  // Snap the AUTO palette to true design hex (mode, not mean) and tag each region
  // with its alpha MODE so a flat semi-transparent region round-trips its opacity
  // (only when < 255 — opaque art stays alpha-free → byte-identical). A locked
  // palette is left verbatim: the user's chosen colours + alphas are authoritative.
  if (!locked) {
    palette = snapPaletteToModes(palette, labels, img.data, snapExclude)
    const alphas = regionAlphaModes(labels, img.data, palette.length)
    palette = palette.map((c, l) => (alphas[l] < 255 ? { ...c, a: alphas[l] } : c))
  }

  // 3. Melt the residual 1px boundary stair-step into the dominant neighbour —
  //    then put back any ≥ minRegionArea component the vote consumed WHOLE (a
  //    straight 1px feature loses 3-vs-6 everywhere; a stair-step never loses a
  //    whole component). Restore before despeckle so a restored thin feature is
  //    measured at its full size, not against the hole the filter left.
  const smoothed = modeFilter(labels, img.width, img.height, opts.modePasses)
  const restored = restoreErasedComponents(labels, smoothed, img.width, img.height, opts.minRegionArea, img.data)
  // 4. Dissolve sub-threshold specks/pinholes so they don't each become a loop.
  const cleaned = despeckleComponents(restored, img.width, img.height, opts.minRegionArea)

  // modeFilter can move pixels between labels → recompute counts so they stay exact
  // (downstream paint/order never depend on them here, but keep the contract honest).
  const counts = new Array<number>(palette.length).fill(0)
  for (let i = 0; i < cleaned.length; i++) {
    const l = cleaned[i]
    if (l >= 0) counts[l]++
  }
  return { palette, labels: cleaned, counts, flatCoverage, dominantColors }
}
