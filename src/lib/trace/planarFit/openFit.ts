// Open-arc fitting: open RDP, evidence-based corner score, and the open linear DP.

import type { PathNode, Vec } from '../../path/types'
import { fitSingleCubic, junctionCosts, lineFit } from '../curveFit.ts'
import { circleMaxDev, dedup, neg, perpDistance, sub, unit } from './geom.ts'
import type { PlanarFitOptions } from './options.ts'

const MAX_SPAN = 20
const MAX_FIT_POINTS = 64
const MAX_EVIDENCE_WINDOW = 24

// --- open Ramer–Douglas–Peucker (endpoints always kept) ---------------------
function openRDP(pts: Vec[], eps: number): number[] {
  const n = pts.length
  if (n <= 2) return pts.map((_, i) => i)
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()!
    if (hi - lo < 2) continue
    const a = pts[lo]
    const b = pts[hi]
    let maxD = -1
    let idx = -1
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistance(pts[i], a, b)
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > eps && idx >= 0) {
      keep[idx] = 1
      stack.push([lo, idx], [idx, hi])
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i)
  return out
}

// --- evidence-based corner score over an open arc (clamped windows) ---------
/** Points dense[i-k .. i+k] clamped to [0, n-1] (side<0: i-k..i, side>0: i..i+k). */
function windowClamped(dense: Vec[], i: number, k: number, side = 0): Vec[] {
  const n = dense.length
  const lo = Math.max(0, side > 0 ? i : i - k)
  const hi = Math.min(n - 1, side < 0 ? i : i + k)
  const out: Vec[] = []
  for (let o = lo; o <= hi; o++) out.push(dense[o])
  return out
}

function coverage(dense: Vec[], i: number, eps: number, kind: 'line' | 'circle' | 'wedge'): number {
  const kMax = Math.min(dense.length, MAX_EVIDENCE_WINDOW)
  let cover = 1
  for (let k = 1; k <= kMax; k++) {
    if (kind === 'wedge') {
      const lf = lineFit(windowClamped(dense, i, k, -1))
      const rf = lineFit(windowClamped(dense, i, k, 1))
      if (!lf || !rf) break
      if (Math.max(lf.maxDev, rf.maxDev) > eps) break
    } else if (kind === 'circle') {
      const dev = circleMaxDev(windowClamped(dense, i, k))
      if (dev !== null && dev > eps) break
    } else {
      const fit = lineFit(windowClamped(dense, i, k))
      if (!fit) break
      if (fit.maxDev > eps) break
    }
    cover = 2 * k + 1
  }
  return cover
}
function softF(x: number): number {
  return 1 - 1 / (1 + 5 * (x - 1))
}
/** c ∈ [−1 smooth … +1 corner] at open-arc index i (mirrors cornerScoreAtIndex). */
function openCornerScore(dense: Vec[], i: number, eps: number): number {
  const L = coverage(dense, i, eps, 'line')
  const S = coverage(dense, i, eps, 'circle')
  const C = coverage(dense, i, eps, 'wedge')
  if (L >= S) return -L / Math.max(L, C)
  if (S >= C) return -softF((S + 1) / (C + 1))
  return softF((C + 1) / (S + 1))
}

/** One-sided tangent at an open-arc index, oriented forward (toward +i). */
function openTangent(dense: Vec[], i: number, eps: number): Vec {
  const n = dense.length
  const half = eps / 2
  const fwd = unit(sub(dense[Math.min(n - 1, i + 1)], dense[Math.max(0, i - 1)]))
  let best = fwd
  const kMax = Math.min(n, MAX_EVIDENCE_WINDOW)
  for (let k = 1; k <= kMax; k++) {
    const fit = lineFit(windowClamped(dense, i, k))
    if (!fit) break
    if (fit.rms > half) break
    best = fit.dir
  }
  return best.x * fwd.x + best.y * fwd.y < 0 ? neg(best) : best
}

// --- candidates + open DP ---------------------------------------------------
/**
 * How a candidate meets a key vertex: 0 a corner (C⁰); otherwise along one of the vertex's
 * tangents, and two candidates meeting on the SAME tangent are G¹ there.
 *   1  the local estimate (`openTangent`), which two cubics share;
 *   2  the direction of the line ARRIVING at the vertex: a line ending there, or a cubic
 *      starting there along it;
 *   3  the direction of the line LEAVING it: a line starting there, or a cubic ending there
 *      along it.
 * 2 and 3 exist only where that line fits within ε (`lineTangents`), and only ever join a
 * line to the cubic beside it, G¹. Offering a run's direction to two cubics as well (the
 * run not emitted) was measured: 4 fewer kinks on the 100 emoji, a worse edge error and
 * ΔE, two cases worse, 20% slower.
 */
type Cont = 0 | 1 | 2 | 3
const CONTS: Cont[] = [0, 1, 2, 3]
interface Candidate {
  a: number
  len: number
  line: boolean
  startCont: Cont
  endCont: Cont
  cost: number
  c1: Vec
  c2: Vec
}

function orient(t: Vec, ref: Vec): Vec {
  return t.x * ref.x + t.y * ref.y < 0 ? neg(t) : t
}
function subsample(arc: Vec[], cap: number): Vec[] {
  const n = arc.length
  if (n <= cap) return arc
  const out: Vec[] = []
  for (let i = 0; i < cap - 1; i++) out.push(arc[Math.floor((i * (n - 1)) / (cap - 1))])
  out.push(arc[n - 1])
  return out
}
function lineDeviation(arc: Vec[]): { maxDev: number; sqErr: number } {
  const a = arc[0]
  const b = arc[arc.length - 1]
  let maxD = 0
  let sq = 0
  for (let i = 1; i < arc.length - 1; i++) {
    const d = perpDistance(arc[i], a, b)
    sq += d * d
    if (d > maxD) maxD = d
  }
  return { maxDev: maxD, sqErr: sq }
}

/** Tangent an open edge must leave each endpoint along: unit, pointing INTO the edge.
 *  Set where the edge is one half of a boundary that runs straight through a junction
 *  (planarThread's through pair), so both halves leave the junction on one line. */
export interface EndTangents {
  start?: Vec | null
  end?: Vec | null
}

/** A line candidate may start a constrained end only if it already runs along the
 *  tangent; a chord a few degrees off is the kink the tangent is there to remove. */
const END_LINE_COS = Math.cos((2 * Math.PI) / 180)

/**
 * Fit an open dense polyline (junction→junction) to PathNodes. Endpoints are
 * pinned and forced to corner; interior joins choose corner vs smooth from the
 * evidence score via a min-cost linear DP over an over-complete candidate set.
 *
 * `ends` fixes the first / last segment's end tangent. Without it the first segment
 * leaves along the chord to the NEXT sample, which at a junction is a staircase step,
 * and the cubic shrinks its handle to fit it: the outline dips into a cusp at every
 * junction it runs through. If no fit within ε exists along the given tangent, the edge
 * is fitted as if none was given.
 */
export function fitOpenArc(densePts: Vec[], opts: PlanarFitOptions, ends?: EndTangents): PathNode[] {
  if (ends && (ends.start || ends.end)) {
    const tied = fitOpenArcWith(densePts, opts, ends)
    if (tied) return tied
  }
  return fitOpenArcWith(densePts, opts, null) ?? []
}

function fitOpenArcWith(densePts: Vec[], opts: PlanarFitOptions, ends: EndTangents | null): PathNode[] | null {
  const dense = dedup(densePts)
  const n = dense.length
  if (n < 2) return []
  if (n === 2) {
    return [
      { x: dense[0].x, y: dense[0].y, hIn: null, hOut: null, kind: 'corner' },
      { x: dense[1].x, y: dense[1].y, hIn: null, hOut: null, kind: 'corner' },
    ]
  }
  const eps = opts.epsilon
  const keyIdx = openRDP(dense, eps)
  const m = keyIdx.length
  if (m < 2) {
    return [
      { x: dense[0].x, y: dense[0].y, hIn: null, hOut: null, kind: 'corner' },
      { x: dense[n - 1].x, y: dense[n - 1].y, hIn: null, hOut: null, kind: 'corner' },
    ]
  }
  const tangents = keyIdx.map((i) => openTangent(dense, i, eps))
  const scores = keyIdx.map((i) => openCornerScore(dense, i, eps))
  const junc = scores.map(junctionCosts)
  const delta = 1e-6 * eps

  // Candidate set: a line between adjacent key vertices, plus cubics between any
  // pair (≤ MAX_SPAN) for the four C⁰/G¹ endpoint combos, each discarded if its
  // deviation exceeds ε.
  const byStart: Candidate[][] = Array.from({ length: m }, () => [])
  // The line between each pair of adjacent key vertices, where one fits within ε: its
  // direction is a tangent its neighbours may join on (Cont 2 / 3).
  const lineOk: boolean[] = []
  for (let a = 0; a + 1 < m; a++) {
    const arc = subsample(dense.slice(keyIdx[a], keyIdx[a + 1] + 1), MAX_FIT_POINTS)
    lineOk.push(arc.length >= 2 && lineDeviation(arc).maxDev <= eps)
  }
  const lineDir = (a: number): Vec => unit(sub(dense[keyIdx[a + 1]], dense[keyIdx[a]]))
  const lineTangents = opts.lineTangents !== false
  for (let a = 0; a < m; a++) {
    const fromIdx = keyIdx[a]
    const maxLen = Math.min(m - 1 - a, MAX_SPAN)
    for (let len = 1; len <= maxLen; len++) {
      const b = a + len
      const toIdx = keyIdx[b]
      const arc = subsample(dense.slice(fromIdx, toIdx + 1), MAX_FIT_POINTS)
      if (arc.length < 2) break
      const sT = a === 0 ? (ends?.start ?? null) : null
      const eT = b === m - 1 ? (ends?.end ?? null) : null
      if (len === 1) {
        const ld = lineDeviation(arc)
        const chord = unit(sub(dense[toIdx], dense[fromIdx]))
        const along =
          (!sT || chord.x * sT.x + chord.y * sT.y >= END_LINE_COS) &&
          (!eT || -(chord.x * eT.x + chord.y * eT.y) >= END_LINE_COS)
        if (ld.maxDev <= eps && along) {
          // A line meets its ends at a corner, or along its own direction where the
          // neighbour can take it (a cubic fitted to leave / arrive along it).
          const starts: Cont[] = lineTangents && !sT && a > 0 ? [0, 3] : [0]
          const endsC: Cont[] = lineTangents && !eT && b < m - 1 ? [0, 2] : [0]
          for (const startCont of starts)
            for (const endCont of endsC)
              byStart[a].push({
                a,
                len,
                line: true,
                startCont,
                endCont,
                cost: opts.lineCost + delta * ld.sqErr,
                c1: arc[0],
                c2: arc[arc.length - 1],
              })
        }
      }
      const freeStart = unit(sub(dense[fromIdx + 1], dense[fromIdx]))
      const freeEnd = unit(sub(dense[toIdx - 1], dense[toIdx]))
      const startDirs: [Cont, Vec][] = sT
        ? [[0, sT]]
        : [
            [0, freeStart],
            [1, orient(tangents[a], freeStart)],
          ]
      // Along the line arriving at `a` / leaving `b`: the join beside a line made G¹.
      if (!sT && lineTangents && a > 0 && lineOk[a - 1]) startDirs.push([2, lineDir(a - 1)])
      const endDirs: [Cont, Vec][] = eT
        ? [[0, eT]]
        : [
            [0, freeEnd],
            [1, orient(neg(tangents[b]), freeEnd)],
          ]
      if (!eT && lineTangents && b < m - 1 && lineOk[b]) endDirs.push([3, neg(lineDir(b))])
      let interG1 = 0
      for (let p = 1; p < len; p++) interG1 += junc[a + p].g1
      let anyFit = false
      for (const [sc, sd] of startDirs) {
        for (const [ec, ed] of endDirs) {
          const fit = fitSingleCubic(arc, sd, ed)
          if (fit.maxDev > eps) continue
          anyFit = true
          byStart[a].push({
            a,
            len,
            line: false,
            startCont: sc,
            endCont: ec,
            cost: opts.cubicCost + delta * fit.sqErr + interG1,
            c1: fit.c1,
            c2: fit.c2,
          })
        }
      }
      if (!anyFit && len > 1) break
    }
  }

  // Open linear DP. dp[p][cont] = min cost to reach key-vertex p arriving with
  // continuity `cont`. Endpoints (0 and m-1) are corners: the first candidate
  // starts C⁰, the last ends C⁰.
  const INF = Infinity
  const cost: number[][] = Array.from({ length: m }, () => [INF, INF, INF, INF])
  const back: ({ from: number; fromCont: Cont; cand: Candidate } | null)[][] = Array.from({ length: m }, () => [
    null,
    null,
    null,
    null,
  ])
  cost[0][0] = 0
  for (let p = 0; p < m - 1; p++) {
    for (const tin of CONTS) {
      const base = cost[p][tin]
      if (!Number.isFinite(base)) continue
      for (const c of byStart[p]) {
        const isFirst = p === 0
        let jcost = 0
        if (isFirst) {
          if (c.startCont !== 0) continue // endpoint is a forced corner
        } else {
          // A line's direction is a tangent only for the pair it joins: a cubic bent onto a
          // neighbour's line and then met at a corner points nowhere in particular (the
          // office building's roof gained four kinks that way). Lines have C⁰ variants.
          if ((tin === 2 || tin === 3 || c.startCont === 2 || c.startCont === 3) && c.startCont !== tin) continue
          jcost = tin !== 0 && c.startCont === tin ? junc[p].g1 : junc[p].c0
        }
        const q = p + c.len
        if (q > m - 1) continue
        const total = base + jcost + c.cost
        if (total < cost[q][c.endCont]) {
          cost[q][c.endCont] = total
          back[q][c.endCont] = { from: p, fromCont: tin, cand: c }
        }
      }
    }
  }
  // Final endpoint must arrive as a corner (endCont 0).
  let endCont: Cont = 0
  if (!Number.isFinite(cost[m - 1][0])) {
    const any = CONTS.find((c) => Number.isFinite(cost[m - 1][c]))
    if (any == null) return ends ? null : polylineNodes(keyIdx, dense) // fallback: corner polyline
    endCont = any
  }

  // Reconstruct the chosen candidates (forward order).
  const chosen: Candidate[] = []
  let p = m - 1
  let t: Cont = endCont
  while (p > 0) {
    const b = back[p][t]
    if (!b) break
    chosen.push(b.cand)
    p = b.from
    t = b.fromCont
  }
  chosen.reverse()
  if (chosen.length === 0) return ends ? null : polylineNodes(keyIdx, dense)

  // Materialize to open PathNodes (no wrap). Anchor i shared between seg i-1/i.
  const segs = chosen.map((c) => ({
    p0: dense[keyIdx[c.a]],
    p3: dense[keyIdx[c.a + c.len]],
    hOut: c.line ? null : { x: c.c1.x, y: c.c1.y },
    hIn: c.line ? null : { x: c.c2.x, y: c.c2.y },
    startCont: c.startCont,
    endCont: c.endCont,
  }))
  const nodes: PathNode[] = []
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s]
    const prev = s > 0 ? segs[s - 1] : null
    const smooth = prev !== null && seg.startCont !== 0 && seg.startCont === prev.endCont
    nodes.push({
      x: seg.p0.x,
      y: seg.p0.y,
      hIn: prev && prev.hIn ? { x: prev.hIn.x, y: prev.hIn.y } : null,
      hOut: seg.hOut ? { x: seg.hOut.x, y: seg.hOut.y } : null,
      kind: smooth ? 'smooth' : 'corner',
    })
  }
  // Final endpoint anchor.
  const lastSeg = segs[segs.length - 1]
  nodes.push({
    x: lastSeg.p3.x,
    y: lastSeg.p3.y,
    hIn: lastSeg.hIn ? { x: lastSeg.hIn.x, y: lastSeg.hIn.y } : null,
    hOut: null,
    kind: 'corner',
  })
  return nodes
}

/** Fallback: straight polyline through the key vertices, all corners. */
function polylineNodes(keyIdx: number[], dense: Vec[]): PathNode[] {
  return keyIdx.map((i) => ({ x: dense[i].x, y: dense[i].y, hIn: null, hOut: null, kind: 'corner' as const }))
}
