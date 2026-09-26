// Small-region merge: absorb sub-`minRegionArea` slivers into their nearest-colour neighbour.

import { srgbToLab, deltaE76 } from '../lab.ts'

/** Iteration cap for the small-region merge (a fixpoint is reached well before). */
const MAX_MERGE_PASSES = 64

/**
 * Absorb every macro-region smaller than `minArea` opaque pixels into an adjacent
 * region, so AA and colour-ramp transition slivers don't survive as tiny shapes.
 * Each small region is merged into the neighbour whose mean original colour is
 * closest, preferring a neighbour that is itself ≥ minArea so slivers collapse
 * into real shapes rather than chaining through each other. `protectedGroups`
 * (user markers) are never absorbed, though they may absorb. Mutates `groupId` in
 * place (relabelled, then compacted to 0..count-1) and returns the new count and
 * whether anything changed. Deterministic: small groups scanned in ascending id,
 * target ties broken by shared-boundary length then id; iterates to a fixpoint.
 */
export function mergeSmallRegions(
  groupId: Int32Array,
  groupCount: number,
  n: number,
  w: number,
  h: number,
  data: Uint8ClampedArray,
  minArea: number,
  protectedGroups: ReadonlySet<number>,
): { count: number; changed: boolean } {
  if (!(minArea > 0)) return { count: groupCount, changed: false }
  const G = groupCount
  let changed = false

  for (let pass = 0; pass < MAX_MERGE_PASSES; pass++) {
    // Per-group opaque count + mean original colour.
    const cnt = new Float64Array(G)
    const sumR = new Float64Array(G)
    const sumG = new Float64Array(G)
    const sumB = new Float64Array(G)
    for (let i = 0; i < n; i++) {
      const g = groupId[i]
      if (g < 0) continue
      const o = i * 4
      cnt[g]++
      sumR[g] += data[o]
      sumG[g] += data[o + 1]
      sumB[g] += data[o + 2]
    }
    // Region adjacency with shared-boundary length (4-connectivity).
    const adj = new Map<number, Map<number, number>>()
    const bump = (a: number, b: number): void => {
      let m = adj.get(a)
      if (!m) adj.set(a, (m = new Map()))
      m.set(b, (m.get(b) ?? 0) + 1)
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const g = groupId[i]
        if (g < 0) continue
        if (x + 1 < w) {
          const r = groupId[i + 1]
          if (r >= 0 && r !== g) {
            bump(g, r)
            bump(r, g)
          }
        }
        if (y + 1 < h) {
          const d = groupId[i + w]
          if (d >= 0 && d !== g) {
            bump(g, d)
            bump(d, g)
          }
        }
      }
    }

    // Qualifying small groups (ascending id ⇒ deterministic).
    const small: number[] = []
    for (let g = 0; g < G; g++) {
      if (cnt[g] > 0 && cnt[g] < minArea && !protectedGroups.has(g) && (adj.get(g)?.size ?? 0) > 0) small.push(g)
    }
    if (small.length === 0) break

    const labCache = new Map<number, [number, number, number]>()
    const labOf = (g: number): [number, number, number] => {
      let l = labCache.get(g)
      if (!l) labCache.set(g, (l = srgbToLab(sumR[g] / cnt[g], sumG[g] / cnt[g], sumB[g] / cnt[g])))
      return l
    }

    // Union-find over group ids; the more "keepable" group wins the root.
    const parent = Array.from({ length: G }, (_, i) => i)
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]]
        x = parent[x]
      }
      return x
    }
    const keepScore = (g: number): number => (protectedGroups.has(g) ? 2 : cnt[g] >= minArea ? 1 : 0)
    const union = (a: number, b: number): void => {
      const ra = find(a)
      const rb = find(b)
      if (ra === rb) return
      const sa = keepScore(ra)
      const sb = keepScore(rb)
      const bWins = sb > sa || (sb === sa && (cnt[rb] > cnt[ra] || (cnt[rb] === cnt[ra] && rb < ra)))
      if (bWins) parent[ra] = rb
      else parent[rb] = ra
    }

    for (const g of small) {
      const nbrs = adj.get(g)!
      let bestT = -1
      let bestDE = Infinity
      let bestBoundary = -1
      const consider = (preferReal: boolean): void => {
        for (const [t, boundary] of nbrs) {
          if (preferReal && cnt[t] < minArea && !protectedGroups.has(t)) continue
          const de = deltaE76(labOf(g), labOf(t))
          if (de < bestDE || (de === bestDE && (boundary > bestBoundary || (boundary === bestBoundary && t < bestT)))) {
            bestDE = de
            bestT = t
            bestBoundary = boundary
          }
        }
      }
      consider(true) // prefer a real (≥ minArea) neighbour
      if (bestT < 0) consider(false) // else any neighbour
      if (bestT >= 0) union(g, bestT)
    }

    // Apply the relabel.
    let any = false
    for (let i = 0; i < n; i++) {
      const g = groupId[i]
      if (g < 0) continue
      const r = find(g)
      if (r !== g) {
        groupId[i] = r
        any = true
      }
    }
    if (!any) break
    changed = true
  }

  if (!changed) return { count: G, changed: false }

  // Compact surviving ids → 0..count-1 (ascending original id ⇒ deterministic).
  const remap = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const g = groupId[i]
    if (g >= 0 && !remap.has(g)) remap.set(g, 0)
  }
  const roots = [...remap.keys()].sort((a, b) => a - b)
  roots.forEach((g, idx) => remap.set(g, idx))
  for (let i = 0; i < n; i++) {
    const g = groupId[i]
    if (g >= 0) groupId[i] = remap.get(g)!
  }
  return { count: roots.length, changed: true }
}
