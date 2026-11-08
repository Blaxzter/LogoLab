// Shared edges that cross. In a planar map two boundaries meet only at a vertex; where two cross,
// the regions between them overlap on one side of the crossing and leave a gap on the other.
// The boundary solve (planarSolve.ts) moves every edge at once and has no notion of that, so it
// asks this after each round.
//
// Each edge is flattened within FLAT_TOL of the curve (Wang's bound on the chord count) and every
// pair of chords in one grid cell is tested for a crossing: each chord's ends lie on opposite
// sides of the other (`left`). So a crossing this misses, or one it reports where
// the curves only come close, is under 2 × FLAT_TOL deep: nothing a render can show. Touching,
// and a crossing within NEAR_END of an end of either edge, is not counted: arms leave a junction
// from one point. Pure; no DOM.

import type { PathNode, SharedEdge, Vec } from '../path/types'

/** A crossing this close to an edge's end vertex is the junction itself (px). */
const NEAR_END = 0.5
/** Grid cell for the pair search (px). */
const CELL = 8
/** How far a chord may stray from its cubic (px). Chords at 1 px of length missed a crossing a
 *  tenth of a pixel deep, where two near-tangent sides of a sliver met. */
const FLAT_TOL = 0.02
/** Chords per cubic, at most. */
const MAX_CHORDS = 256

/** `a:b` with a ≤ b: the two edges' ids (equal for an edge that crosses itself). */
export const crossingKey = (a: number, b: number): string => (a <= b ? `${a}:${b}` : `${b}:${a}`)

function flatten(nodes: readonly PathNode[], closed: boolean): Vec[] {
  const out: Vec[] = [{ x: nodes[0].x, y: nodes[0].y }]
  const n = nodes.length
  const count = closed ? n : n - 1
  for (let i = 0; i < count; i++) {
    const a = nodes[i]
    const b = nodes[(i + 1) % n]
    const c1 = a.hOut ?? a
    const c2 = b.hIn ?? b
    // Wang: k chords keep a cubic within (3/4)·M / k² of its curve, M its largest second difference.
    const m = Math.max(
      Math.hypot(a.x - 2 * c1.x + c2.x, a.y - 2 * c1.y + c2.y),
      Math.hypot(c1.x - 2 * c2.x + b.x, c1.y - 2 * c2.y + b.y),
    )
    const k = Math.min(MAX_CHORDS, Math.max(1, Math.ceil(Math.sqrt((0.75 * m) / FLAT_TOL))))
    for (let j = 1; j <= k; j++) {
      const t = j / k
      const u = 1 - t
      out.push({
        x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
      })
    }
  }
  return out
}

const orient = (p: Vec, q: Vec, r: Vec): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)

/** A point ON the other chord's line counts as to its left, so where two chains cross exactly at
 *  a chord end of each (two pixel-grid lines meeting at a whole coordinate) one pair of chords
 *  still sees it, and a chain running along the other's line sees nothing. */
const left = (d: number): boolean => d >= 0

/** Where chords p0p1 and q0q1 cross, or null. */
function properCrossing(p0: Vec, p1: Vec, q0: Vec, q1: Vec): Vec | null {
  const d1 = orient(q0, q1, p0)
  const d2 = orient(q0, q1, p1)
  if (left(d1) === left(d2)) return null
  const d3 = orient(p0, p1, q0)
  const d4 = orient(p0, p1, q1)
  if (left(d3) === left(d4)) return null
  const t = d1 / (d1 - d2)
  return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t }
}

/**
 * Every pair of edges that cross, as `crossingKey`s. `only`, when given, limits the search to
 * pairs with at least one edge in it (the edges that moved).
 */
export function edgeCrossings(edges: readonly SharedEdge[], only?: ReadonlySet<number>): Set<string> {
  interface Chord {
    edge: number
    /** Index of the chord along its edge. */
    i: number
    a: Vec
    b: Vec
  }
  const chords: Chord[] = []
  const chains: Vec[][] = []
  const ends: Vec[][] = []
  const closed: boolean[] = []
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei]
    const pts = e.nodes.length >= 2 ? flatten(e.nodes, e.closed) : []
    chains.push(pts)
    closed.push(e.closed)
    ends.push(e.closed || pts.length === 0 ? [] : [pts[0], pts[pts.length - 1]])
    for (let i = 1; i < pts.length; i++) chords.push({ edge: ei, i: i - 1, a: pts[i - 1], b: pts[i] })
  }

  const grid = new Map<number, number[]>()
  const cellKey = (cx: number, cy: number): number => cx * 1_000_003 + cy
  for (let c = 0; c < chords.length; c++) {
    const { a, b } = chords[c]
    const x0 = Math.floor(Math.min(a.x, b.x) / CELL)
    const x1 = Math.floor(Math.max(a.x, b.x) / CELL)
    const y0 = Math.floor(Math.min(a.y, b.y) / CELL)
    const y1 = Math.floor(Math.max(a.y, b.y) / CELL)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = cellKey(cx, cy)
        const list = grid.get(k)
        if (list) list.push(c)
        else grid.set(k, [c])
      }
    }
  }

  const found = new Set<string>()
  const atEnd = (p: Vec, ei: number): boolean => ends[ei].some((q) => Math.hypot(p.x - q.x, p.y - q.y) < NEAR_END)
  for (const list of grid.values()) {
    for (let s = 0; s < list.length; s++) {
      const P = chords[list[s]]
      for (let t = s + 1; t < list.length; t++) {
        const Q = chords[list[t]]
        const pe = edges[P.edge].id
        const qe = edges[Q.edge].id
        if (only && !only.has(pe) && !only.has(qe)) continue
        const key = crossingKey(pe, qe)
        if (found.has(key)) continue
        if (P.edge === Q.edge) {
          // Neighbouring chords of one chain share a point; so do a closed chain's first and last.
          const gap = Math.abs(P.i - Q.i)
          const n = chains[P.edge].length - 1
          if (gap < 2 || (closed[P.edge] && gap === n - 1)) continue
        }
        const x = properCrossing(P.a, P.b, Q.a, Q.b)
        if (!x || atEnd(x, P.edge) || atEnd(x, Q.edge)) continue
        found.add(key)
      }
    }
  }
  return found
}
