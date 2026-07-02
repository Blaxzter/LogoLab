// Junction refinement for the planar tracer — an EXPERIMENTAL alternative to the
// co-circular arc snap (planarBeautify §1d) for the ring "pull"/kink where a third
// region T-junctions into a smooth boundary. Off by default (`refineJunctions`);
// wire it on via `planarFit.refineJunctions` (the Test view drives this for A/B).
//
// Two moves, both keyed on the raw junction geometry (NOT on co-circularity):
//   1. subpixelJunctions — place each junction Vertex at the least-squares
//      intersection of its incident edge arms instead of the integer lattice corner.
//   2. smoothThroughJunctions — where a REGION traverses two edges straight through a
//      junction (small turn), rotate their shared-endpoint handles to one common
//      tangent so the boundary is G¹.
//
// NOTE (measured, kept for the record): on a synthetic ring this removes far less
// kink than the co-circular snap and the sub-pixel move can re-fit an arc WORSE; on
// the corpus it moved petals/headphones seam. Retained behind the flag so the Test
// view can show the trade rather than assert it. Pure & deterministic.

import type { EdgeRef, SharedEdge, Vec } from '../path/types'
import type { PlanarEdge, PlanarNetwork } from './planarNetwork.ts'
import { armLine } from './planarFit.ts'

const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y })
const neg = (a: Vec): Vec => ({ x: -a.x, y: -a.y })
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y
function unit(a: Vec): Vec | null {
  const l = Math.hypot(a.x, a.y)
  return l < 1e-9 ? null : { x: a.x / l, y: a.y / l }
}

// --- 1. sub-pixel junction placement ----------------------------------------

const ARM_GAP = 1
const ARM_SPAN = 10
const MIN_ARM_PTS = 2
const MAX_DISP = 2.0

function armPoints(e: PlanarEdge, atStart: boolean): Vec[] {
  const pts = e.pts
  const n = pts.length
  const hi = Math.min(ARM_SPAN, n - 1)
  const out: Vec[] = []
  for (let o = ARM_GAP; o <= hi; o++) out.push(atStart ? pts[o] : pts[n - 1 - o])
  return out
}

/**
 * Sub-pixel position for every junction corner: the point minimising the summed
 * squared distance to its incident edge arms' lines (2×2 normal equations). Falls
 * back to the integer lattice corner when ill-conditioned (<2 usable arms, near-
 * parallel) or the solution runs away. Returns cornerIndex → position for EVERY
 * junction.
 */
export function subpixelJunctions(net: PlanarNetwork, cw: number): Map<number, Vec> {
  const incident = new Map<number, { e: PlanarEdge; atStart: boolean }[]>()
  const add = (c: number, e: PlanarEdge, atStart: boolean): void => {
    if (c < 0) return
    let a = incident.get(c)
    if (!a) incident.set(c, (a = []))
    a.push({ e, atStart })
  }
  for (const e of net.edges) {
    if (e.closed) continue
    add(e.startV, e, true)
    add(e.endV, e, false)
  }

  const out = new Map<number, Vec>()
  for (const c of net.junctions) {
    const cx = c % cw
    const cy = (c / cw) | 0
    let m00 = 0, m01 = 0, m11 = 0, b0 = 0, b1 = 0, used = 0
    for (const { e, atStart } of incident.get(c) ?? []) {
      const ap = armPoints(e, atStart)
      if (ap.length < MIN_ARM_PTS) continue
      const { c: a, d } = armLine(ap)
      const nx = -d.y
      const ny = d.x
      const k = nx * a.x + ny * a.y
      m00 += nx * nx
      m01 += nx * ny
      m11 += ny * ny
      b0 += k * nx
      b1 += k * ny
      used++
    }
    const det = m00 * m11 - m01 * m01
    if (used < 2 || Math.abs(det) < 1e-6) {
      out.set(c, { x: cx, y: cy })
      continue
    }
    const px = (m11 * b0 - m01 * b1) / det
    const py = (m00 * b1 - m01 * b0) / det
    if (!Number.isFinite(px) || !Number.isFinite(py) || Math.hypot(px - cx, py - cy) > MAX_DISP) {
      out.set(c, { x: cx, y: cy })
      continue
    }
    out.set(c, { x: px, y: py })
  }
  return out
}

// --- 2. G¹ smooth-through at junctions ---------------------------------------

const STRAIGHT_TURN_DEG = 20
const MAX_ROTATE_DEG = 25
const COS_STRAIGHT = Math.cos((STRAIGHT_TURN_DEG * Math.PI) / 180)
const COS_CAP = Math.cos((MAX_ROTATE_DEG * Math.PI) / 180)

const endNode = (e: SharedEdge, atEnd: boolean): SharedEdge['nodes'][number] =>
  atEnd ? e.nodes[e.nodes.length - 1] : e.nodes[0]

function interiorHandle(e: SharedEdge, atEnd: boolean): Vec | null {
  const nd = endNode(e, atEnd)
  return atEnd ? nd.hIn : nd.hOut
}

function interiorTangent(e: SharedEdge, atEnd: boolean): Vec | null {
  const nd = endNode(e, atEnd)
  const h = interiorHandle(e, atEnd)
  if (h) return unit(sub(h, nd))
  const neighbour = atEnd ? e.nodes[e.nodes.length - 2] : e.nodes[1]
  return neighbour ? unit(sub(neighbour, nd)) : null
}

function setInteriorTangent(e: SharedEdge, atEnd: boolean, dir: Vec): void {
  const nd = endNode(e, atEnd)
  const h = interiorHandle(e, atEnd)
  if (!h) return
  const len = Math.hypot(h.x - nd.x, h.y - nd.y)
  const c = { x: nd.x + len * dir.x, y: nd.y + len * dir.y }
  if (atEnd) nd.hIn = c
  else nd.hOut = c
}

interface Pair {
  e1: SharedEdge
  end1: boolean
  e2: SharedEdge
  end2: boolean
}

/**
 * Make boundaries a region traverses STRAIGHT through a junction meet G¹. Discovers
 * pairs from the assembled loops (consecutive edges of a region turning
 * < STRAIGHT_TURN_DEG at their shared junction) so only real continuations smooth,
 * then rotates each pair's shared-endpoint handles to one common tangent. Mutates
 * `edges` in place; both regions on each edge inherit the change.
 */
export function smoothThroughJunctions(edges: SharedEdge[], loopsByLabel: Map<number, EdgeRef[][]>): void {
  const byId = new Map<number, SharedEdge>()
  for (const e of edges) byId.set(e.id, e)

  const pairs = new Map<string, Pair>()
  for (const loops of loopsByLabel.values()) {
    for (const loop of loops) {
      const L = loop.length
      if (L < 2) continue
      for (let k = 0; k < L; k++) {
        const rk = loop[k]
        const rn = loop[(k + 1) % L]
        const ek = byId.get(rk.edge)
        const en = byId.get(rn.edge)
        if (!ek || !en || ek.closed || en.closed || ek === en) continue
        if (ek.nodes.length < 2 || en.nodes.length < 2) continue
        const end1 = !rk.reversed
        const end2 = rn.reversed
        const v1 = end1 ? ek.endVertex : ek.startVertex
        const v2 = end2 ? en.endVertex : en.startVertex
        if (v1 == null || v1 < 0 || v1 !== v2) continue
        const t1 = interiorTangent(ek, end1)
        const t2 = interiorTangent(en, end2)
        if (!t1 || !t2 || dot(t1, t2) >= -COS_STRAIGHT) continue
        const s1 = `${ek.id}:${end1 ? 1 : 0}`
        const s2 = `${en.id}:${end2 ? 1 : 0}`
        pairs.set(s1 < s2 ? `${s1}|${s2}` : `${s2}|${s1}`, { e1: ek, end1, e2: en, end2 })
      }
    }
  }

  for (const { e1, end1, e2, end2 } of pairs.values()) {
    const h1 = interiorHandle(e1, end1)
    const h2 = interiorHandle(e2, end2)
    const t1 = interiorTangent(e1, end1)
    const t2 = interiorTangent(e2, end2)
    if (!t1 || !t2) continue
    let u: Vec | null
    if (h1 && h2) u = unit(sub(t1, t2))
    else if (h1 && !h2) u = neg(t2)
    else if (!h1 && h2) u = t1
    else continue
    if (!u) continue
    if (h1 && dot(u, t1) >= COS_CAP) setInteriorTangent(e1, end1, u)
    if (h2 && dot(neg(u), t2) >= COS_CAP) setInteriorTangent(e2, end2, neg(u))
  }
}
