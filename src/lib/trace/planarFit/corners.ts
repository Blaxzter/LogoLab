// Corner detection: the ±win macro-turn reading and the plain / loop / open detectors.

import type { Vec } from '../../path/types'
import { dist, perpDistance, sub, unit } from './geom.ts'

/** ±px window the macro-turn corner test looks across (spans the unit staircase). */
export const CORNER_WINDOW = 4
/** Apex-merge distance (px) for the loop/open corner detectors. It sits between the two
 *  scales it must separate: above a rasterized tip's shoulder pair (≤ ~2px), below the
 *  spacing of real neighbouring corners. Raising it fuses corner pairs 3–5px apart. */
export const CORNER_MERGE = 3

/**
 * The macro-turn cosine at every index — what all four readers (`detectCorners`,
 * `detectLoopCorners`, `detectOpenCorners`, `resolveLoopCaps`) test against their
 * threshold. Outside [lo, hi) the value is 1 (no turn).
 *
 * The reading is the angle between two chords taken ±`win` points along the chain.
 */
export function readTurnCos(pts: Vec[], closed: boolean, win: number, lo: number, hi: number): Float64Array {
  const n = pts.length
  const cos = new Float64Array(n)
  cos.fill(1)
  const wrap = (i: number): number => ((i % n) + n) % n
  for (let i = lo; i < hi; i++) {
    const b = closed ? pts[wrap(i - win)] : pts[Math.max(0, i - win)]
    const a = closed ? pts[wrap(i + win)] : pts[Math.min(n - 1, i + win)]
    const inDir = unit(sub(pts[i], b))
    const outDir = unit(sub(a, pts[i]))
    cos[i] = inDir.x * outDir.x + inDir.y * outDir.y
  }
  return cos
}

/**
 * Indices of macro corners on a lattice staircase: vertices where the path
 * direction turns by more than `turnDeg`, measured over a ±`win` px window so the
 * unit stair-steps of a straight diagonal (constant macro direction) are not
 * corners but a genuine sharp valley/point is. Non-max-suppressed within the
 * window. `closed` wraps the windows; otherwise the endpoint region (already
 * pinned by `presmooth`) is skipped. A smooth shape — even a tiny circle — returns
 * ∅ at the default threshold, so its pre-smoothing is unchanged. `turnDeg ≥ 180`
 * ⇒ ∅ (corner pinning disabled).
 */
export function detectCorners(pts: Vec[], turnDeg: number, closed: boolean, win = CORNER_WINDOW): Set<number> {
  const out = new Set<number>()
  const n = pts.length
  if (turnDeg >= 180 || n < 2 * win + 1) return out
  const wrap = (i: number): number => ((i % n) + n) % n
  const thr = Math.cos((turnDeg * Math.PI) / 180)
  const lo = closed ? 0 : win
  const hi = closed ? n : n - win
  const cos = readTurnCos(pts, closed, win, lo, hi)
  for (let i = lo; i < hi; i++) {
    if (cos[i] >= thr) continue // not sharp enough
    let isLocalMin = true
    for (let j = i - win; j <= i + win; j++) {
      const k = closed ? wrap(j) : j
      if (k === i || (!closed && (k < lo || k >= hi))) continue
      if (cos[k] < cos[i]) {
        isLocalMin = false
        break
      }
    }
    if (isLocalMin) out.add(wrap(i))
  }
  return out
}

/**
 * Indices of the sharp corners on a closed staircase loop — one per corner. The
 * same ±`win` macro-turn test as `detectCorners`, but each cluster of sub-threshold
 * vertices is collapsed to its geometric apex (the vertex farthest from its window
 * chord), and apexes within `mergeDist` px fuse (a rasterized tip is often a 1-px
 * plateau = two "shoulder" vertices, possibly split across the loop seam). Sorted
 * ascending. `turnDeg ≥ 180` ⇒ ∅ (disabled). Don't add finer-scale apexes: they
 * poison their neighbours' fitted tangents, and a staircase reads ~90° at ordinary step
 * vertices at small windows.
 */
export function detectLoopCorners(
  pts: Vec[],
  turnDeg: number,
  win = CORNER_WINDOW,
  mergeDist = CORNER_MERGE,
): number[] {
  const n = pts.length
  if (turnDeg >= 180 || n < 2 * win + 1) return []
  const wrap = (i: number): number => ((i % n) + n) % n
  const thr = Math.cos((turnDeg * Math.PI) / 180)
  const cos = readTurnCos(pts, true, win, 0, n)
  // Cluster consecutive sub-threshold (sharp) vertices; apex = max perp-to-chord.
  const used = new Uint8Array(n)
  const apexes: number[] = []
  for (let s = 0; s < n; s++) {
    if (cos[s] >= thr || used[s]) continue
    let best = s
    let bestDev = -1
    let i = s
    while (cos[wrap(i)] < thr && !used[wrap(i)]) {
      const k = wrap(i)
      used[k] = 1
      const dev = perpDistance(pts[k], pts[wrap(k - win)], pts[wrap(k + win)])
      if (dev > bestDev) {
        bestDev = dev
        best = k
      }
      i++
    }
    apexes.push(best)
  }
  apexes.sort((a, b) => a - b)
  if (apexes.length < 2) return apexes
  // Fuse near-coincident apexes (consecutive, plus the cyclic first/last pair).
  const merged: number[] = []
  for (const a of apexes) {
    const last = merged[merged.length - 1]
    if (last !== undefined && dist(pts[a], pts[last]) <= mergeDist) continue
    merged.push(a)
  }
  if (merged.length >= 2 && dist(pts[merged[0]], pts[merged[merged.length - 1]]) <= mergeDist) merged.pop()
  return merged
}

/**
 * Indices of the sharp corners interior to an open staircase polyline — one per
 * corner. `detectLoopCorners` with the cyclic wrap replaced by clamped windows:
 * each cluster of sub-threshold vertices collapses to its geometric apex (max
 * perp deviation from the window chord) and apexes within `mergeDist` px fuse,
 * so a vertex's two staircase shoulders never yield two corners. The endpoint
 * regions (± `win`, junction anchors) are excluded, as in `detectCorners`.
 */
export function detectOpenCorners(
  pts: Vec[],
  turnDeg: number,
  win = CORNER_WINDOW,
  mergeDist = CORNER_MERGE,
): number[] {
  const n = pts.length
  if (turnDeg >= 180 || n < 2 * win + 1) return []
  const thr = Math.cos((turnDeg * Math.PI) / 180)
  const lo = win
  const hi = n - win
  const cos = readTurnCos(pts, false, win, lo, hi)
  const apexes: number[] = []
  for (let s = lo; s < hi; s++) {
    if (cos[s] >= thr) continue
    let best = s
    let bestDev = -1
    let i = s
    while (i < hi && cos[i] < thr) {
      const dev = perpDistance(pts[i], pts[Math.max(0, i - win)], pts[Math.min(n - 1, i + win)])
      if (dev > bestDev) {
        bestDev = dev
        best = i
      }
      i++
    }
    apexes.push(best)
    s = i // resume after the cluster (loop's s++ steps past it)
  }
  // Fuse near-coincident apexes (consecutive; keep the first, as the loop does).
  const merged: number[] = []
  for (const a of apexes) {
    const last = merged[merged.length - 1]
    if (last !== undefined && dist(pts[a], pts[last]) <= mergeDist) continue
    merged.push(a)
  }
  return merged
}
