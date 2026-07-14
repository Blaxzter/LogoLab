// Alpha-aware color quantization + label cleanup for the tracing pipeline.
//
// Logos are mostly a handful of flat hues plus anti-aliasing gradients between
// them, so clustering runs over the distinct-color histogram (count-weighted),
// never over raw pixels. The cleanup passes (modeFilter, dropMinorColors) then
// melt single-pixel AA slivers and dissolve sub-threshold colors so potrace
// sees clean, contiguous regions.

import type { PaletteColor, QuantizeResult } from './types'
import { srgbToLab, deltaE76 } from './lab.ts'

/** Largest histogram fed to k-means; rarer colors map to centroids afterward. */
const MAX_CLUSTER_ENTRIES = 65536

/** Palette entries closer than this (euclidean RGB) merge after clustering. */
const MERGE_DISTANCE = 10

/**
 * Two flat-interior ANCHOR colours must be at least this far apart (CIE76 ΔE) for
 * the merge veto to treat them as two AUTHORED colours. Flat-interior evidence
 * alone is not enough — two measured counter-examples:
 *
 *   • schild: the paper-white background carries large exact-colour runs of
 *     neighbouring tonal values (#f4f3f1 vs #f5f4f2, ΔE ≈ 0.5, thousands of
 *     flat-interior px each) — splitting them speckles the background,
 *     180 → 546 nodes;
 *   • aurora traced flat: a smooth ramp's 8-bit posterization bands are wide,
 *     flat and ~ΔE 2.9 apart — vetoing their merges at a perceptual-JND floor
 *     (2.0) pushed dominantColors past FLAT_PALETTE_MAX_COLORS and flipped the
 *     whole image out of palette-first into MS (visibly coarser bands).
 *
 * The floor is scoreRegions' own MATCH_DELTA_E: a region painted within ΔE 4 of
 * its truth counts as recovered, so a fusion below 4 is invisible to the region
 * gate (and, per §9.4, near-invisible to eyes); above it the fusion is a scored
 * drop (flute's pair: ΔE 4.5). The veto defends exactly the fusions that would
 * be scored — and cannot invent palette entries the art does not show.
 */
const ANCHOR_DISTINCT_DE = 4.0

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))

const keyToColor = (key: number): PaletteColor => ({
  r: (key >> 16) & 0xff,
  g: (key >> 8) & 0xff,
  b: key & 0xff,
})

/**
 * Deterministic 32-bit PRNG (mulberry32). k-means++ seeding used to draw from
 * Math.random, which made the whole pipeline non-reproducible and impossible to
 * regression-test; seeding a fixed PRNG from the image content makes the same
 * input + settings yield byte-identical output every run.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a hash of an image's bytes — the PRNG seed (so each image is stable). */
function hashImageData(data: Uint8ClampedArray): number {
  let h = 0x811c9dc5
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Pick an index, weighted by `weights`, using the supplied PRNG (k-means++). */
function weightedPick(weights: Float64Array, rand: () => number): number {
  let total = 0
  for (let i = 0; i < weights.length; i++) total += weights[i]
  if (total <= 0) return 0
  let t = rand() * total
  for (let i = 0; i < weights.length; i++) {
    t -= weights[i]
    if (t <= 0) return i
  }
  return weights.length - 1
}

/**
 * Quantize an image to at most `maxColors` opaque colors. Transparent pixels
 * (alpha < 128) get label -1 and never join a cluster. Palette and counts come
 * back sorted by pixel count, descending (largest region first).
 *
 * `keepDistinctMinArea` > 0 arms the evidence-based MERGE veto: two clusters
 * that are each anchored by a DIFFERENT exact colour with at least that many
 * flat-interior pixels — and whose anchors are perceptually distinct
 * (≥ ANCHOR_DISTINCT_DE) — are treated as two authored colours and never fused,
 * however close their centroids sit (see the veto block below). 0 keeps the
 * pre-existing distance-only merge.
 */
export function quantize(img: ImageData, maxColors: number, keepDistinctMinArea = 0): QuantizeResult {
  const { data, width, height } = img
  const n = width * height
  const labels = new Int32Array(n)
  const hist = new Map<number, number>()

  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (data[o + 3] < 128) {
      labels[i] = -1
      continue
    }
    const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]
    hist.set(key, (hist.get(key) ?? 0) + 1)
  }

  const k = Math.max(1, Math.round(maxColors))

  // Fast path: few enough distinct colors → exact palette, exact labels.
  if (hist.size <= k) {
    const entries = [...hist.entries()].sort((a, b) => b[1] - a[1])
    const index = new Map<number, number>()
    entries.forEach(([key], i) => index.set(key, i))
    for (let i = 0; i < n; i++) {
      if (labels[i] === -1) continue
      const o = i * 4
      labels[i] = index.get((data[o] << 16) | (data[o + 1] << 8) | data[o + 2])!
    }
    return {
      palette: entries.map(([key]) => keyToColor(key)),
      labels,
      counts: entries.map(([, count]) => count),
    }
  }

  // Weighted k-means over histogram entries. Huge histograms (photos pasted
  // as logos) cluster over the most frequent colors only; every distinct
  // color still maps to its nearest centroid afterward.
  let entries = [...hist.entries()]
  if (entries.length > MAX_CLUSTER_ENTRIES) {
    entries.sort((a, b) => b[1] - a[1])
    entries = entries.slice(0, MAX_CLUSTER_ENTRIES)
  }
  // Deterministic PRNG keyed by image content (replaces Math.random).
  const rand = mulberry32(hashImageData(data))

  const m = entries.length
  const pr = new Float64Array(m)
  const pg = new Float64Array(m)
  const pb = new Float64Array(m)
  const pw = new Float64Array(m)
  for (let i = 0; i < m; i++) {
    const [key, count] = entries[i]
    pr[i] = (key >> 16) & 0xff
    pg[i] = (key >> 8) & 0xff
    pb[i] = key & 0xff
    pw[i] = count
  }

  // k-means++ seeding: first centroid by count, the rest by count·D².
  const cr = new Float64Array(k)
  const cg = new Float64Array(k)
  const cb = new Float64Array(k)
  let seed = weightedPick(pw, rand)
  cr[0] = pr[seed]
  cg[0] = pg[seed]
  cb[0] = pb[seed]
  const d2 = new Float64Array(m).fill(Infinity)
  const seedWeight = new Float64Array(m)
  for (let c = 1; c < k; c++) {
    for (let i = 0; i < m; i++) {
      const dr = pr[i] - cr[c - 1]
      const dg = pg[i] - cg[c - 1]
      const db = pb[i] - cb[c - 1]
      const d = dr * dr + dg * dg + db * db
      if (d < d2[i]) d2[i] = d
      seedWeight[i] = pw[i] * d2[i]
    }
    seed = weightedPick(seedWeight, rand)
    cr[c] = pr[seed]
    cg[c] = pg[seed]
    cb[c] = pb[seed]
  }

  // Lloyd iterations to convergence (max centroid shift < 0.5) or 24 rounds.
  const assign = new Int32Array(m)
  const sumR = new Float64Array(k)
  const sumG = new Float64Array(k)
  const sumB = new Float64Array(k)
  const sumW = new Float64Array(k)
  for (let iter = 0; iter < 24; iter++) {
    for (let i = 0; i < m; i++) {
      let best = 0
      let bestD = Infinity
      for (let c = 0; c < k; c++) {
        const dr = pr[i] - cr[c]
        const dg = pg[i] - cg[c]
        const db = pb[i] - cb[c]
        const d = dr * dr + dg * dg + db * db
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
      assign[i] = best
    }
    sumR.fill(0)
    sumG.fill(0)
    sumB.fill(0)
    sumW.fill(0)
    for (let i = 0; i < m; i++) {
      const c = assign[i]
      sumR[c] += pr[i] * pw[i]
      sumG[c] += pg[i] * pw[i]
      sumB[c] += pb[i] * pw[i]
      sumW[c] += pw[i]
    }
    let maxShift = 0
    for (let c = 0; c < k; c++) {
      if (sumW[c] === 0) continue // empty cluster keeps its position
      const nr = sumR[c] / sumW[c]
      const ng = sumG[c] / sumW[c]
      const nb = sumB[c] / sumW[c]
      const dr = nr - cr[c]
      const dg = ng - cg[c]
      const db = nb - cb[c]
      const shift = Math.sqrt(dr * dr + dg * dg + db * db)
      if (shift > maxShift) maxShift = shift
      cr[c] = nr
      cg[c] = ng
      cb[c] = nb
    }
    if (maxShift < 0.5) break
  }

  // Map EVERY distinct color (not just the clustered subset) to its nearest
  // centroid; cluster counts come from this full mapping.
  const colorToCluster = new Map<number, number>()
  const clusterCounts = new Float64Array(k)
  for (const [key, count] of hist) {
    const r = (key >> 16) & 0xff
    const g = (key >> 8) & 0xff
    const b = key & 0xff
    let best = 0
    let bestD = Infinity
    for (let c = 0; c < k; c++) {
      const dr = r - cr[c]
      const dg = g - cg[c]
      const db = b - cb[c]
      const d = dr * dr + dg * dg + db * db
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    colorToCluster.set(key, best)
    clusterCounts[best] += count
  }

  // ---------------------------------------------------------------------------
  // Evidence for the merge veto (docs/vectorization-benchmarks.md §0 #5).
  //
  // MERGE_DISTANCE exists to re-fuse k-means centroids that SPLIT one colour's
  // pixel cloud — but two AUTHORED colours can sit closer than it (flute's
  // #f5a165/#fea069 are 9.9 apart; fusing them paints a 2796px region a colour
  // the art does not contain — the last tier-2 region drop). Flat-interior
  // evidence separates the two cases, and area/share cannot (§9.4): every
  // distinct colour maps to exactly ONE cluster, so a split cloud carries its
  // 8-neighbour-exact block in one half only, while two authored colours each
  // anchor their own cluster with such a block. A cluster's anchor is its
  // highest-flat-interior exact colour at ≥ keepDistinctMinArea px (the same
  // floor paletteSegment protects real regions with: anything smaller is
  // despeckled away regardless, so vetoing for it would be pointless).
  // ---------------------------------------------------------------------------
  let anchorOf: Int32Array | null = null // per cluster: packed-RGB anchor colour, -1 = none
  if (keepDistinctMinArea > 0) {
    const rgbAt = (i: number): number => (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2]
    const flatCount = new Map<number, number>()
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x
        if (labels[i] === -1) continue
        const key = rgbAt(i)
        if (
          rgbAt(i - width - 1) === key && rgbAt(i - width) === key && rgbAt(i - width + 1) === key &&
          rgbAt(i - 1) === key && rgbAt(i + 1) === key &&
          rgbAt(i + width - 1) === key && rgbAt(i + width) === key && rgbAt(i + width + 1) === key
        ) flatCount.set(key, (flatCount.get(key) ?? 0) + 1)
      }
    }
    anchorOf = new Int32Array(k).fill(-1)
    const anchorArea = new Float64Array(k)
    for (const [key, area] of flatCount) {
      if (area < keepDistinctMinArea) continue
      const c = colorToCluster.get(key)
      if (c === undefined) continue
      if (area > anchorArea[c]) {
        anchorArea[c] = area
        anchorOf[c] = key
      }
    }
  }

  // Post-merge near-identical clusters into count-weighted averages.
  const mergedR: number[] = []
  const mergedG: number[] = []
  const mergedB: number[] = []
  const mergedCount: number[] = []
  const mergedAnchor: number[] = []
  const remap = new Int32Array(k)
  for (let c = 0; c < k; c++) {
    if (clusterCounts[c] === 0) {
      remap[c] = 0 // nothing maps here; value is never read
      continue
    }
    const w = clusterCounts[c]
    const anchor = anchorOf ? anchorOf[c] : -1
    let target = -1
    for (let j = 0; j < mergedR.length; j++) {
      const dr = cr[c] - mergedR[j]
      const dg = cg[c] - mergedG[j]
      const db = cb[c] - mergedB[j]
      if (Math.sqrt(dr * dr + dg * dg + db * db) < MERGE_DISTANCE) {
        // Both sides anchored by different authored colours ⇒ two real colours;
        // keep looking for a compatible target instead of fusing them. The ΔE
        // floor keeps tonal noise mergeable (see ANCHOR_DISTINCT_DE).
        if (anchor >= 0 && mergedAnchor[j] >= 0 && mergedAnchor[j] !== anchor) {
          const other = mergedAnchor[j]
          const de = deltaE76(
            srgbToLab((anchor >> 16) & 255, (anchor >> 8) & 255, anchor & 255),
            srgbToLab((other >> 16) & 255, (other >> 8) & 255, other & 255),
          )
          if (de >= ANCHOR_DISTINCT_DE) continue
        }
        target = j
        break
      }
    }
    if (target === -1) {
      remap[c] = mergedR.length
      mergedR.push(cr[c])
      mergedG.push(cg[c])
      mergedB.push(cb[c])
      mergedCount.push(w)
      mergedAnchor.push(anchor)
    } else {
      const tw = mergedCount[target] + w
      mergedR[target] = (mergedR[target] * mergedCount[target] + cr[c] * w) / tw
      mergedG[target] = (mergedG[target] * mergedCount[target] + cg[c] * w) / tw
      mergedB[target] = (mergedB[target] * mergedCount[target] + cb[c] * w) / tw
      mergedCount[target] = tw
      if (mergedAnchor[target] < 0) mergedAnchor[target] = anchor
      remap[c] = target
    }
  }

  // Sort the final palette by count desc and remap labels accordingly.
  const order = mergedCount.map((_, i) => i).sort((a, b) => mergedCount[b] - mergedCount[a])
  const rank = new Int32Array(order.length)
  order.forEach((mi, pos) => {
    rank[mi] = pos
  })
  const finalIndex = new Map<number, number>()
  for (const [key, c] of colorToCluster) finalIndex.set(key, rank[remap[c]])
  for (let i = 0; i < n; i++) {
    if (labels[i] === -1) continue
    const o = i * 4
    labels[i] = finalIndex.get((data[o] << 16) | (data[o + 1] << 8) | data[o + 2])!
  }

  return {
    palette: order.map((mi) => ({
      r: clamp255(mergedR[mi]),
      g: clamp255(mergedG[mi]),
      b: clamp255(mergedB[mi]),
    })),
    labels,
    counts: order.map((mi) => mergedCount[mi]),
  }
}

/**
 * 3×3 majority-vote smoothing over a label map, `passes` times. Melts the
 * single-pixel anti-aliasing slivers quantization leaves between regions.
 * Only labeled pixels (>= 0) are recomputed and only labeled pixels vote;
 * ties keep the current label, and -1 (transparent) pixels never change.
 * Returns a new array (or the input untouched when passes <= 0).
 */
export function modeFilter(labels: Int32Array, width: number, height: number, passes: number): Int32Array {
  if (passes <= 0) return labels
  let maxLabel = -1
  for (let i = 0; i < labels.length; i++) if (labels[i] > maxLabel) maxLabel = labels[i]
  if (maxLabel < 0) return labels

  const votes = new Int32Array(maxLabel + 1)
  const touched = new Int32Array(9)
  let src = labels

  for (let p = 0; p < passes; p++) {
    const dst = new Int32Array(src)
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - 1)
      const y1 = Math.min(height - 1, y + 1)
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        const cur = src[i]
        if (cur < 0) continue
        const x0 = Math.max(0, x - 1)
        const x1 = Math.min(width - 1, x + 1)
        let touchedCount = 0
        for (let yy = y0; yy <= y1; yy++) {
          const row = yy * width
          for (let xx = x0; xx <= x1; xx++) {
            const v = src[row + xx]
            if (v < 0) continue
            if (votes[v] === 0) touched[touchedCount++] = v
            votes[v]++
          }
        }
        // Strict > so any tie (including with the center's own vote) keeps cur.
        let best = cur
        let bestVotes = votes[cur]
        for (let t = 0; t < touchedCount; t++) {
          const v = touched[t]
          if (votes[v] > bestVotes) {
            best = v
            bestVotes = votes[v]
          }
          votes[v] = 0
        }
        dst[i] = best
      }
    }
    src = dst
  }
  return src
}

/**
 * Dissolve palette entries holding less than `minShare` of the opaque pixels
 * into their nearest surviving color (relabel + merge counts). At least one
 * color always survives. Result is re-sorted by count, descending.
 *
 * `protect[i]` exempts entry i from the share test. The share threshold exists to
 * kill anti-alias blend smears, but share alone cannot tell a smear from a REAL
 * small region — a logo's small dark detail can hold fewer pixels than a long
 * boundary's blend band. Dropping a real region does not just lose its outline:
 * every pixel is relabelled to the nearest SURVIVING colour, which for an isolated
 * dark region can be wildly wrong (a #402a32 pencil tip repainted with the #f92f60
 * eraser pink, ΔE 76 — docs/vectorization-benchmarks.md §9.1). The caller supplies
 * the evidence that an entry is a real region (paletteSegment: flat-interior area).
 */
export function dropMinorColors(q: QuantizeResult, minShare: number, protect?: readonly boolean[]): QuantizeResult {
  const { palette, counts } = q
  if (palette.length <= 1) return q
  const totalOpaque = counts.reduce((a, b) => a + b, 0)
  if (totalOpaque === 0) return q

  const keep = counts.map((c, i) => c / totalOpaque >= minShare || protect?.[i] === true)
  if (!keep.some(Boolean)) {
    let maxIdx = 0
    for (let i = 1; i < counts.length; i++) if (counts[i] > counts[maxIdx]) maxIdx = i
    keep[maxIdx] = true
  }
  if (keep.every(Boolean)) return q

  const survivors: number[] = []
  for (let i = 0; i < palette.length; i++) if (keep[i]) survivors.push(i)

  // Route every dropped entry to its nearest survivor and merge its count.
  const target = new Int32Array(palette.length)
  const mergedCounts = palette.map((_, i) => (keep[i] ? counts[i] : 0))
  for (let i = 0; i < palette.length; i++) {
    if (keep[i]) {
      target[i] = i
      continue
    }
    let best = survivors[0]
    let bestD = Infinity
    for (const s of survivors) {
      const dr = palette[i].r - palette[s].r
      const dg = palette[i].g - palette[s].g
      const db = palette[i].b - palette[s].b
      const d = dr * dr + dg * dg + db * db
      if (d < bestD) {
        bestD = d
        best = s
      }
    }
    target[i] = best
    mergedCounts[best] += counts[i]
  }

  const order = survivors.slice().sort((a, b) => mergedCounts[b] - mergedCounts[a])
  const rank = new Int32Array(palette.length)
  order.forEach((s, pos) => {
    rank[s] = pos
  })

  const labels = new Int32Array(q.labels.length)
  for (let i = 0; i < q.labels.length; i++) {
    const l = q.labels[i]
    labels[i] = l < 0 ? -1 : rank[target[l]]
  }

  return {
    palette: order.map((s) => palette[s]),
    labels,
    counts: order.map((s) => mergedCounts[s]),
  }
}
