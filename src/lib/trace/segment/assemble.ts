// Build a SegmentResult from a per-pixel group labelling, plus the one-region fallback.

import type { PaletteColor } from '../types'
import type { MumfordShahResult } from '../mumfordShah.ts'
import type { RegionSamples } from '../gradient.ts'
import type { SegmentResult } from './options.ts'
import { clamp255, strideSamples } from './samples.ts'

/**
 * Build a SegmentResult from a per-pixel `groupId` labelling (used after marker
 * splits and small-region merges). Palette = mean original colour over each
 * group's opaque pixels; regionSamples = original colours of each group's smooth
 * pixels (or all its opaque pixels for an isolated all-𝒟 mark), strided. Groups
 * are ranked by pixel count desc, matching the default assembly.
 */
export function assembleFromGroupId(
  groupId: Int32Array,
  groupCount: number,
  n: number,
  w: number,
  data: Uint8ClampedArray,
  smooth: Uint8Array,
  ms: MumfordShahResult,
  S: number,
  sampleCap: number,
): Omit<SegmentResult, 'preMergeLabels'> {
  const G = groupCount
  const cnt = new Float64Array(G)
  const sumR = new Float64Array(G)
  const sumG = new Float64Array(G)
  const sumB = new Float64Array(G)
  const xs: number[][] = Array.from({ length: G }, () => [])
  const ys: number[][] = Array.from({ length: G }, () => [])
  const rs: number[][] = Array.from({ length: G }, () => [])
  const gs: number[][] = Array.from({ length: G }, () => [])
  const bs: number[][] = Array.from({ length: G }, () => [])
  for (let i = 0; i < n; i++) {
    const g = groupId[i]
    if (g < 0) continue
    const o = i * 4
    cnt[g]++
    sumR[g] += data[o]
    sumG[g] += data[o + 1]
    sumB[g] += data[o + 2]
    if (smooth[i]) {
      xs[g].push(i % w)
      ys[g].push((i / w) | 0)
      rs[g].push(data[o])
      gs[g].push(data[o + 1])
      bs[g].push(data[o + 2])
    }
  }
  // Groups with no smooth pixels (isolated all-𝒟 marks) → sample all opaque pixels.
  let anyNeedAll = false
  const needAll = new Uint8Array(G)
  for (let g = 0; g < G; g++) {
    if (cnt[g] > 0 && xs[g].length === 0) {
      needAll[g] = 1
      anyNeedAll = true
    }
  }
  if (anyNeedAll) {
    for (let i = 0; i < n; i++) {
      const g = groupId[i]
      if (g < 0 || !needAll[g]) continue
      const o = i * 4
      xs[g].push(i % w)
      ys[g].push((i / w) | 0)
      rs[g].push(data[o])
      gs[g].push(data[o + 1])
      bs[g].push(data[o + 2])
    }
  }
  const order = Array.from({ length: G }, (_, g) => g).sort((a, b) => cnt[b] - cnt[a])
  const rank = new Int32Array(G)
  order.forEach((g, pos) => {
    rank[g] = pos
  })
  const palette: PaletteColor[] = order.map((g) => {
    const c = cnt[g] || 1
    return { r: clamp255(sumR[g] / c), g: clamp255(sumG[g] / c), b: clamp255(sumB[g] / c) }
  })
  const counts = order.map((g) => cnt[g])
  const regionSamples = order.map((g) => strideSamples(xs[g], ys[g], rs[g], gs[g], bs[g], sampleCap))
  const labels = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const g = groupId[i]
    labels[i] = g < 0 ? -1 : rank[g]
  }
  return { palette, labels, counts, ms, fineSegments: S, regionSamples }
}

/** Everything-one-region fallback (degenerate inputs). */
export function fallbackSingleRegion(
  img: { width: number; height: number; data: Uint8ClampedArray },
  ms: MumfordShahResult,
): SegmentResult {
  const { width: w, height: h, data } = img
  const n = w * h
  const labels = new Int32Array(n)
  let r = 0
  let g = 0
  let b = 0
  let c = 0
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] < 128) {
      labels[i] = -1
      continue
    }
    labels[i] = 0
    r += data[i * 4]
    g += data[i * 4 + 1]
    b += data[i * 4 + 2]
    c++
  }
  const palette: PaletteColor[] = [{ r: clamp255(r / (c || 1)), g: clamp255(g / (c || 1)), b: clamp255(b / (c || 1)) }]
  const empty: RegionSamples = { xs: new Float64Array(0), ys: new Float64Array(0), rs: new Float64Array(0), gs: new Float64Array(0), bs: new Float64Array(0), n: 0 }
  return { palette, labels, counts: [c], ms, fineSegments: 1, regionSamples: [empty], preMergeLabels: labels }
}
