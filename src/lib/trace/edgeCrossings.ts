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
// from one point. Nor is an edge crossing itself around less than MIN_LOOP_AREA: `edgeEars`
// reports those, and the solve cuts them off once it is done. Pure; no DOM.

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
/**
 * A corner's fishtail is not counted: an edge crossing itself where one of the two loops lies
 * within FISHTAIL_REACH of the crossing and the smaller is under this area (px²). The solve moved
 * an anchor a fraction of a pixel past its own handle, and the ear it draws is painted by the
 * regions on both sides, so no page shows through. Counted, it held the whole edge, which for a
 * letter is its whole outline: Waypoint's "n" stayed on the pixel grid for loops of 0.05 px²
 * (ΔE 0.51; 0.28 with them let through). Every other crossing counts: two edges (a gap: aurora's
 * white hairline), and an edge crossing itself around more than an ear, however little area
 * that encloses: a sliver pressed until its sides cross (Instagram), a flap or a spike with a
 * loop at its foot. The signed area of a twisted loop cancels, so area alone does not say which.
 * Let through, it is still a bow tie in an outline view or an editor (acute-counter's tip), so
 * the solve cuts it off at the crossing when its rounds are done (planarSolve `trimEars`).
 */
export const MIN_LOOP_AREA = 0.5
/** How far a fishtail's ear reaches from where the curves cross (px). */
export const FISHTAIL_REACH = 1

/** `a:b` with a ≤ b: the two edges' ids (equal for an edge that crosses itself). */
export const crossingKey = (a: number, b: number): string => (a <= b ? `${a}:${b}` : `${b}:${a}`)

/** An edge flattened to chords, and where on its curves each point lies: `seg[j]` is the curve
 *  (index of its first node) of the chord ending at `pts[j]`, `t[j]` the point's parameter on it. */
interface Chain {
  pts: Vec[]
  seg: number[]
  t: number[]
}

function flatten(nodes: readonly PathNode[], closed: boolean): Chain {
  const out: Vec[] = [{ x: nodes[0].x, y: nodes[0].y }]
  const seg: number[] = [-1]
  const ts: number[] = [0]
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
      seg.push(i)
      ts.push(t)
    }
  }
  return { pts: out, seg, t: ts }
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
  return new Set(scan(edges, only, false).map((s) => s.key))
}

/** Where two edges cross: for each, its index in the list and the curve the crossing lies on
 *  (the index of that curve's first node). */
export interface CrossingSite {
  key: string
  a: { edge: number; seg: number }
  b: { edge: number; seg: number }
}

/** Every place two edges cross (or one crosses itself), once per pair of curves: the boundary
 *  solve holds just those curves rather than the whole edges. */
export function crossingSites(edges: readonly SharedEdge[], only?: ReadonlySet<number>): CrossingSite[] {
  return scan(edges, only, true)
}

/** A place on an edge: the curve (index of its first node) and the parameter on it. */
export interface CurveAt {
  seg: number
  t: number
}

/**
 * A corner's fishtail, which `edgeCrossings` lets through: edge `edge` (its index in the list)
 * runs past `at` into the ear at `into`, turns, and crosses itself there again at `outOf`. The
 * ear is what lies between the two going forward along the edge, through its first node when
 * `wraps` (a closed edge only).
 */
export interface Ear {
  edge: number
  at: Vec
  into: CurveAt
  outOf: CurveAt
  wraps: boolean
}

/** Every fishtail on the edges, in no particular order (an edge may have several). */
export function edgeEars(edges: readonly SharedEdge[], only?: ReadonlySet<number>): Ear[] {
  const ears: Ear[] = []
  scan(edges, only, true, ears)
  return ears
}

function scan(
  edges: readonly SharedEdge[],
  only: ReadonlySet<number> | undefined,
  every: boolean,
  ears?: Ear[],
): CrossingSite[] {
  interface Chord {
    edge: number
    /** Index of the chord along its edge. */
    i: number
    /** The curve it lies on, and its ends' parameters on it. */
    seg: number
    t0: number
    t1: number
    a: Vec
    b: Vec
  }
  const chords: Chord[] = []
  const chains: Vec[][] = []
  const ends: Vec[][] = []
  const closed: boolean[] = []
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei]
    const { pts, seg, t } = e.nodes.length >= 2 ? flatten(e.nodes, e.closed) : { pts: [], seg: [], t: [] }
    chains.push(pts)
    closed.push(e.closed)
    ends.push(e.closed || pts.length === 0 ? [] : [pts[0], pts[pts.length - 1]])
    for (let i = 1; i < pts.length; i++) {
      // A chord's first point ends the curve before it (t = 1) unless both lie on one curve.
      const t0 = seg[i - 1] === seg[i] ? t[i - 1] : 0
      chords.push({ edge: ei, i: i - 1, seg: seg[i], t0, t1: t[i], a: pts[i - 1], b: pts[i] })
    }
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

  // Without `every`, one crossing per pair of edges answers; with it, one per pair of curves.
  const found = new Set<string>()
  const earsSeen = new Set<string>()
  const sites: CrossingSite[] = []
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
        // A cell lists its chords in the order they were made, edge by edge, so P comes first.
        const at = every ? `${P.edge}:${P.seg}|${Q.edge}:${Q.seg}` : key
        if (found.has(at)) continue
        if (P.edge === Q.edge) {
          // Neighbouring chords of one chain share a point; so do a closed chain's first and last.
          const gap = Math.abs(P.i - Q.i)
          const n = chains[P.edge].length - 1
          if (gap < 2 || (closed[P.edge] && gap === n - 1)) continue
        }
        const x = properCrossing(P.a, P.b, Q.a, Q.b)
        if (!x || atEnd(x, P.edge) || atEnd(x, Q.edge)) continue
        const ear = P.edge === Q.edge ? earSide(chains[P.edge], closed[P.edge], P.i, Q.i, x) : null
        if (ear) {
          // A pair of chords spanning two cells is met in both.
          const pair = `${P.edge}:${P.i}:${Q.i}`
          if (ears && !earsSeen.has(pair)) {
            earsSeen.add(pair)
            // The chain runs into the inner ear on the earlier chord, into the wrapping one on the later.
            const [lo, hi] = P.i < Q.i ? [P, Q] : [Q, P]
            const [into, outOf] = ear === 'inner' ? [lo, hi] : [hi, lo]
            const along = (c: Chord): CurveAt => {
              const len = Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y)
              const u = len > 0 ? Math.hypot(x.x - c.a.x, x.y - c.a.y) / len : 0
              return { seg: c.seg, t: closestT(edges[c.edge].nodes, c.seg, c.t0 + (c.t1 - c.t0) * u, x) }
            }
            ears.push({ edge: P.edge, at: x, into: along(into), outOf: along(outOf), wraps: ear === 'wrap' })
          }
          continue
        }
        found.add(at)
        sites.push({ key, a: { edge: P.edge, seg: P.seg }, b: { edge: Q.edge, seg: Q.seg } })
      }
    }
  }
  return sites
}

/** The parameter on curve `seg` closest to `x`, from `t` by Newton on (B − x)·B′. Along a chord
 *  `t` is only interpolated, and a cubic's parameter does not run evenly (a line's least of all,
 *  slowest at its ends): 0.01 px off on a line 14 px long. */
function closestT(nodes: readonly PathNode[], seg: number, t: number, x: Vec): number {
  const a = nodes[seg]
  const b = nodes[(seg + 1) % nodes.length]
  const c1 = a.hOut ?? a
  const c2 = b.hIn ?? b
  for (let k = 0; k < 8; k++) {
    const u = 1 - t
    const px = u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x - x.x
    const py = u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y - x.y
    const dx = 3 * (u * u * (c1.x - a.x) + 2 * u * t * (c2.x - c1.x) + t * t * (b.x - c2.x))
    const dy = 3 * (u * u * (c1.y - a.y) + 2 * u * t * (c2.y - c1.y) + t * t * (b.y - c2.y))
    const ddx = 6 * (u * (c2.x - 2 * c1.x + a.x) + t * (b.x - 2 * c2.x + c1.x))
    const ddy = 6 * (u * (c2.y - 2 * c1.y + a.y) + t * (b.y - 2 * c2.y + c1.y))
    const f = px * dx + py * dy
    const fp = dx * dx + dy * dy + px * ddx + py * ddy
    if (!(fp > 0)) break
    const next = Math.max(0, Math.min(1, t - f / fp))
    const done = Math.abs(next - t) < 1e-12
    t = next
    if (done) break
  }
  return t
}

/** Chords `i` and `j` cross at `x` as a corner's fishtail: one of the two loops lies within
 *  FISHTAIL_REACH of the crossing, and the smaller one is under MIN_LOOP_AREA. Which loop is the
 *  ear: the points between the chords (`inner`), or a closed chain's rest (`wrap`). */
function earSide(pts: readonly Vec[], closed: boolean, i: number, j: number, x: Vec): 'inner' | 'wrap' | null {
  const [a, b] = i < j ? [i, j] : [j, i]
  const near = (from: number, to: number): boolean => {
    for (let k = from; k <= to; k++) if (Math.hypot(pts[k].x - x.x, pts[k].y - x.y) > FISHTAIL_REACH) return false
    return true
  }
  const side = near(a + 1, b) ? 'inner' : closed && near(b + 1, pts.length - 1) && near(0, a) ? 'wrap' : null
  return side && loopArea(pts, closed, i, j, x) < MIN_LOOP_AREA ? side : null
}

/**
 * The smaller of the two loops a chain closes where its chords `i` and `j` cross at `x` (px²):
 * the points between the two chords, and for a closed chain also the rest of it.
 */
function loopArea(pts: readonly Vec[], closed: boolean, i: number, j: number, x: Vec): number {
  const [a, b] = i < j ? [i, j] : [j, i]
  // Shoelace over x, pts[a+1] … pts[b], back to x.
  let twice = 0
  let prev = x
  for (let k = a + 1; k <= b; k++) {
    twice += prev.x * pts[k].y - pts[k].x * prev.y
    prev = pts[k]
  }
  twice += prev.x * x.y - x.x * prev.y
  if (!closed) return Math.abs(twice) / 2
  // The rest of the chain closes the other loop: the whole chain's signed area minus this one.
  let all = 0
  for (let k = 1; k < pts.length; k++) all += pts[k - 1].x * pts[k].y - pts[k].x * pts[k - 1].y
  const n = pts.length - 1
  all += pts[n].x * pts[0].y - pts[0].x * pts[n].y
  return Math.min(Math.abs(twice), Math.abs(all - twice)) / 2
}
