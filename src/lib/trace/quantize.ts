// Alpha-aware color quantization + label cleanup for the tracing pipeline.
//
// Logos are mostly a handful of flat hues plus anti-aliasing gradients between
// them, so clustering runs over the distinct-color histogram (count-weighted),
// never over raw pixels. The cleanup passes (modeFilter, dropMinorColors) then
// melt single-pixel AA slivers and dissolve sub-threshold colors so the tracer
// sees clean, contiguous regions.

import type { PaletteColor, QuantizeResult } from './types'
import { srgbToLab, deltaE76 } from './lab.ts'

/** Largest histogram fed to k-means; rarer colors map to centroids afterward. */
const MAX_CLUSTER_ENTRIES = 65536

/** Palette entries closer than this (euclidean RGB) merge after clustering. */
const MERGE_DISTANCE = 10

/**
 * Two flat-interior anchor colours must be at least this far apart (CIE76 ΔE) for
 * the merge veto and the split to treat them as two authored colours. Flat-interior
 * evidence alone is not enough: a paper-white background holds large exact runs of
 * neighbouring tonal values (ΔE ≈ 0.5), and a smooth ramp's 8-bit posterization
 * bands are wide, flat and a few ΔE apart. Keeping those apart speckles the
 * background or explodes the palette. A fusion below ΔE 4 is near-invisible, and
 * matches the tolerance the region scorer (MATCH_DELTA_E) accepts.
 */
const ANCHOR_DISTINCT_DE = 4.0

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))

const keyToColor = (key: number): PaletteColor => ({
  r: (key >> 16) & 0xff,
  g: (key >> 8) & 0xff,
  b: key & 0xff,
})

/**
 * Deterministic 32-bit PRNG (mulberry32) for k-means++ seeding. Seeded from the
 * image content so the same input and settings give byte-identical output. Don't
 * use Math.random here: it makes traces non-reproducible and untestable.
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

/** FNV-1a hash of an image's bytes, used as the PRNG seed. */
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
 * `keepDistinctMinArea` > 0 enables the evidence-based merge veto: two clusters
 * each anchored by a different exact colour with at least that many flat-interior
 * pixels, whose anchors are ≥ ANCHOR_DISTINCT_DE apart, are two authored colours
 * and are never fused, however close their centroids sit. The same evidence also
 * splits a single cluster that holds two authored colours (at low resolution a
 * small colour cloud may never win a centroid). 0 uses the distance-only merge.
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

  // Map every distinct color (not just the clustered subset) to its nearest
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

  // Evidence for the merge veto and split.
  //
  // MERGE_DISTANCE re-fuses k-means centroids that split one colour's pixel
  // cloud, but two authored colours can sit closer than it, and fusing them
  // paints a region a colour the art does not contain. Flat-interior evidence
  // separates the cases where area or share cannot: every distinct colour maps
  // to exactly one cluster, so a split cloud carries its 8-neighbour-exact block
  // in one half only, while two authored colours each anchor their own cluster.
  // A cluster's anchor is its exact colour with the most flat-interior pixels,
  // at ≥ keepDistinctMinArea (the floor paletteSegment protects real regions
  // with; anything smaller is despeckled regardless).
  //
  // The split can add clusters, so from here on the cluster set lives in
  // growable arrays holding the same doubles as cr/cg/cb/clusterCounts.
  const cR: number[] = Array.from(cr)
  const cG: number[] = Array.from(cg)
  const cB: number[] = Array.from(cb)
  const cCount: number[] = Array.from(clusterCounts)

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

    // Anchor-guided cluster split, the dual of the merge veto below. The veto can
    // only refuse a merge; at low resolution k-means may put two authored colours
    // in one cluster from the start, since a small colour cloud does not reliably
    // win a centroid. Same evidence and thresholds as the veto: a cluster holding
    // two or more anchors ≥ ANCHOR_DISTINCT_DE apart is split, each member colour
    // going to its nearest anchor. When k-means separated properly every cluster
    // has one anchor and this is a no-op.
    const keyLab = (key: number) => srgbToLab((key >> 16) & 255, (key >> 8) & 255, key & 255)
    const anchorsBy = new Map<number, { key: number; area: number }[]>()
    for (const [key, area] of flatCount) {
      if (area < keepDistinctMinArea) continue
      const c = colorToCluster.get(key)
      if (c === undefined) continue
      let arr = anchorsBy.get(c)
      if (!arr) anchorsBy.set(c, (arr = []))
      arr.push({ key, area })
    }
    for (const [c, anchors] of [...anchorsBy.entries()].sort((a, b) => a[0] - b[0])) {
      if (anchors.length < 2) continue
      anchors.sort((a, b) => b.area - a.area || a.key - b.key)
      const chosen: number[] = [anchors[0].key]
      for (let i = 1; i < anchors.length; i++) {
        const lab = keyLab(anchors[i].key)
        if (chosen.every((o) => deltaE76(lab, keyLab(o)) >= ANCHOR_DISTINCT_DE)) chosen.push(anchors[i].key)
      }
      if (chosen.length < 2) continue
      const ids = [c]
      for (let j = 1; j < chosen.length; j++) {
        ids.push(cR.length)
        cR.push(0)
        cG.push(0)
        cB.push(0)
        cCount.push(0)
      }
      // Reassign every member colour to its nearest anchor, and rebuild the split
      // clusters' centroids as count-weighted means for the post-merge
      // (snapPaletteToModes downstream picks the final hex).
      const sums = ids.map(() => ({ r: 0, g: 0, b: 0, w: 0 }))
      for (const [key, cl] of colorToCluster) {
        if (cl !== c) continue
        const r = (key >> 16) & 255, g = (key >> 8) & 255, b = key & 255
        let best = 0
        let bestD = Infinity
        for (let j = 0; j < chosen.length; j++) {
          const ak = chosen[j]
          const dr = r - ((ak >> 16) & 255)
          const dg = g - ((ak >> 8) & 255)
          const db = b - (ak & 255)
          const d = dr * dr + dg * dg + db * db
          if (d < bestD) {
            bestD = d
            best = j
          }
        }
        colorToCluster.set(key, ids[best])
        const cnt = hist.get(key) ?? 0
        const s = sums[best]
        s.r += r * cnt
        s.g += g * cnt
        s.b += b * cnt
        s.w += cnt
      }
      ids.forEach((id, j) => {
        const s = sums[j]
        if (s.w > 0) {
          cR[id] = s.r / s.w
          cG[id] = s.g / s.w
          cB[id] = s.b / s.w
        } else {
          const ak = chosen[j]
          cR[id] = (ak >> 16) & 255
          cG[id] = (ak >> 8) & 255
          cB[id] = ak & 255
        }
        cCount[id] = s.w
      })
    }

    anchorOf = new Int32Array(cR.length).fill(-1)
    const anchorArea = new Float64Array(cR.length)
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
  const kk = cR.length
  const mergedR: number[] = []
  const mergedG: number[] = []
  const mergedB: number[] = []
  const mergedCount: number[] = []
  const mergedAnchor: number[] = []
  const remap = new Int32Array(kk)
  for (let c = 0; c < kk; c++) {
    if (cCount[c] === 0) {
      remap[c] = 0 // nothing maps here; value is never read
      continue
    }
    const w = cCount[c]
    const anchor = anchorOf ? anchorOf[c] : -1
    let target = -1
    for (let j = 0; j < mergedR.length; j++) {
      const dr = cR[c] - mergedR[j]
      const dg = cG[c] - mergedG[j]
      const db = cB[c] - mergedB[j]
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
      mergedR.push(cR[c])
      mergedG.push(cG[c])
      mergedB.push(cB[c])
      mergedCount.push(w)
      mergedAnchor.push(anchor)
    } else {
      const tw = mergedCount[target] + w
      mergedR[target] = (mergedR[target] * mergedCount[target] + cR[c] * w) / tw
      mergedG[target] = (mergedG[target] * mergedCount[target] + cG[c] * w) / tw
      mergedB[target] = (mergedB[target] * mergedCount[target] + cB[c] * w) / tw
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
 * `protect[i]` exempts entry i from the share test. The share threshold removes
 * anti-alias blend smears, but share alone cannot tell a smear from a real small
 * region: a small dark detail can hold fewer pixels than a long boundary's blend
 * band. Dropping a real region relabels its pixels to the nearest surviving
 * colour, which for an isolated region can be a very different colour. The caller
 * supplies the evidence that an entry is real (paletteSegment: flat-interior area).
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
