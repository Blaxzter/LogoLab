// Sample-set helpers shared by the segmenter: colour clamp and deterministic striding.

import { concatSamples, type RegionSamples } from '../gradient.ts'

export const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))

/** Build a RegionSamples from JS arrays, strided down to at most `cap` points. */
export function strideSamples(
  xs: number[],
  ys: number[],
  rs: number[],
  gs: number[],
  bs: number[],
  cap: number,
): RegionSamples {
  const total = xs.length
  const stride = total > cap ? Math.ceil(total / cap) : 1
  const m = Math.ceil(total / stride)
  const X = new Float64Array(m)
  const Y = new Float64Array(m)
  const R = new Float64Array(m)
  const Gc = new Float64Array(m)
  const B = new Float64Array(m)
  let k = 0
  for (let i = 0; i < total && k < m; i += stride) {
    X[k] = xs[i]
    Y[k] = ys[i]
    R[k] = rs[i]
    Gc[k] = gs[i]
    B[k] = bs[i]
    k++
  }
  return { xs: X, ys: Y, rs: R, gs: Gc, bs: B, n: k }
}

/** Concatenate sample sets then stride to `cap` (deterministic). */
export function strideConcat(list: RegionSamples[], cap: number): RegionSamples {
  const all = concatSamples(list)
  if (all.n <= cap) return all
  const stride = Math.ceil(all.n / cap)
  const m = Math.ceil(all.n / stride)
  const X = new Float64Array(m)
  const Y = new Float64Array(m)
  const R = new Float64Array(m)
  const Gc = new Float64Array(m)
  const B = new Float64Array(m)
  let k = 0
  for (let i = 0; i < all.n && k < m; i += stride) {
    X[k] = all.xs[i]
    Y[k] = all.ys[i]
    R[k] = all.rs[i]
    Gc[k] = all.gs[i]
    B[k] = all.bs[i]
    k++
  }
  return { xs: X, ys: Y, rs: R, gs: Gc, bs: B, n: k }
}
