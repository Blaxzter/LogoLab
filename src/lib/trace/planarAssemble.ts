// Phase 3 of the planar tracer: fit every edge once, build the shared-edge graph
// (vertices + edges), then assemble each region's boundary as ordered loops of
// shared-edge references via a half-edge face walk on the lattice rotational
// system. Loops are oriented for nonzero fill (outer CCW, holes CW) by flipping
// EdgeRef loops — so materializeRegion stays a pure forward concatenation and the
// two regions on a shared edge reference byte-identical geometry.

import type { EdgeRef, PathNode, SharedEdge, Vec, Vertex } from '../path/types'
import { cubicAt, segmentControls, segmentCount } from '../path/geometry.ts'
import { buildPlanarNetwork, EXT, type PlanarNetwork } from './planarNetwork.ts'
import { fitLoopEdge, fitOpenArc, presmooth, type PlanarFitOptions, DEFAULT_PLANAR_FIT } from './planarFit.ts'
import { reverseEdgeNodes } from '../path/topology.ts'

export interface PlanarTrace {
  vertices: Vertex[]
  edges: SharedEdge[]
  /** Per region label → its boundary loops (outer + holes), oriented for nonzero. */
  loopsByLabel: Map<number, EdgeRef[][]>
}

/** Direction rotation that selects the next half-edge keeping the face on one
 *  consistent side (validated by the per-pixel relabel check). */
const ROT = [1, 2, 3] // try clockwise turns from the reverse direction first

/** Build the full planar trace from a label map. */
export function tracePlanar(
  labels: Int32Array,
  width: number,
  height: number,
  opts: PlanarFitOptions = DEFAULT_PLANAR_FIT,
): PlanarTrace {
  const net = buildPlanarNetwork(labels, width, height)
  return assemblePlanar(net, opts)
}

export function assemblePlanar(net: PlanarNetwork, opts: PlanarFitOptions): PlanarTrace {
  // --- vertices: one per junction corner ---
  const vidByCorner = new Map<number, number>()
  const vertices: Vertex[] = []
  const cw = net.width + 1
  for (const c of net.junctions) {
    const id = vertices.length
    vidByCorner.set(c, id)
    vertices.push({ id, x: c % cw, y: (c / cw) | 0 })
  }

  // --- fit every edge once ---
  const edges: SharedEdge[] = []
  interface EdgeMeta {
    left: number
    right: number
    dirStart: number
    dirEnd: number
    startV: number // vertex id or -1
    endV: number
    closed: boolean
  }
  const meta: EdgeMeta[] = []
  for (const e of net.edges) {
    let nodes: PathNode[]
    if (e.closed) {
      nodes = fitLoopEdge(presmooth(e.pts, opts.smoothPasses, false), opts)
    } else {
      nodes = fitOpenArc(presmooth(e.pts, opts.smoothPasses, true), opts)
    }
    const startV = e.startV >= 0 ? vidByCorner.get(e.startV)! : -1
    const endV = e.endV >= 0 ? vidByCorner.get(e.endV)! : -1
    edges.push({ id: e.id, nodes, closed: e.closed, startVertex: e.closed ? null : startV, endVertex: e.closed ? null : endV })
    meta.push({ left: e.left, right: e.right, dirStart: e.dirStart, dirEnd: e.dirEnd, startV, endV, closed: e.closed })
  }

  // --- directed half-edges over the non-closed edges ---
  // heId = edgeIndex*2 + (reversed?1:0). label = region on the left of travel.
  interface HalfEdge {
    edgeIdx: number
    reversed: boolean
    label: number
    tailV: number
    headV: number
    leaveDir: number
    arriveDir: number
  }
  const halfEdges: HalfEdge[] = []
  const outDir = new Map<number, number[]>() // vertexId → [E,S,W,N] heId or -1
  const ensureOut = (v: number): number[] => {
    let a = outDir.get(v)
    if (!a) outDir.set(v, (a = [-1, -1, -1, -1]))
    return a
  }
  for (let i = 0; i < net.edges.length; i++) {
    const m = meta[i]
    if (m.closed) continue
    const fwd: HalfEdge = { edgeIdx: i, reversed: false, label: m.left, tailV: m.startV, headV: m.endV, leaveDir: m.dirStart, arriveDir: m.dirEnd }
    const rev: HalfEdge = { edgeIdx: i, reversed: true, label: m.right, tailV: m.endV, headV: m.startV, leaveDir: (m.dirEnd + 2) % 4, arriveDir: (m.dirStart + 2) % 4 }
    const fId = halfEdges.push(fwd) - 1
    const rId = halfEdges.push(rev) - 1
    ensureOut(fwd.tailV)[fwd.leaveDir] = fId
    ensureOut(rev.tailV)[rev.leaveDir] = rId
  }

  // next(he): at the head vertex, rotate clockwise from the reverse of the
  // arrival direction to the first present outgoing half-edge (rotational system).
  const nextHe = (heId: number): number => {
    const he = halfEdges[heId]
    const out = outDir.get(he.headV)
    if (!out) return -1
    const reverse = (he.arriveDir + 2) % 4
    for (const step of ROT) {
      const k = (reverse + step) % 4
      if (out[k] >= 0) return out[k]
    }
    return out[reverse] >= 0 ? out[reverse] : -1
  }

  const loopsByLabel = new Map<number, EdgeRef[][]>()
  const pushLoop = (label: number, loop: EdgeRef[]): void => {
    if (label === EXT) return
    let arr = loopsByLabel.get(label)
    if (!arr) loopsByLabel.set(label, (arr = []))
    arr.push(loop)
  }

  // --- face walk over junction-anchored half-edges ---
  const visited = new Uint8Array(halfEdges.length)
  for (let h0 = 0; h0 < halfEdges.length; h0++) {
    if (visited[h0]) continue
    const loop: EdgeRef[] = []
    let h = h0
    let guard = 0
    const maxIter = halfEdges.length + 4
    while (h >= 0 && !visited[h] && guard++ < maxIter) {
      visited[h] = 1
      const he = halfEdges[h]
      loop.push({ edge: net.edges[he.edgeIdx].id, reversed: he.reversed })
      h = nextHe(h)
      if (h === h0) break
    }
    if (loop.length > 0) pushLoop(halfEdges[h0].label, loop)
  }

  // --- closed-loop edges: each is one single-edge loop for both adjacent labels ---
  for (let i = 0; i < net.edges.length; i++) {
    const m = meta[i]
    if (!m.closed) continue
    const id = net.edges[i].id
    pushLoop(m.left, [{ edge: id, reversed: false }])
    pushLoop(m.right, [{ edge: id, reversed: true }])
  }

  // --- orient each region's loops for nonzero (outer CCW, holes CW) ---
  const edgeById = new Map<number, SharedEdge>()
  for (const e of edges) edgeById.set(e.id, e)
  for (const loops of loopsByLabel.values()) orientLoops(loops, edgeById)

  return { vertices, edges, loopsByLabel }
}

// ---------------------------------------------------------------------------
// Orientation (mirrors subpixel.orientForNonzero, but flips EdgeRef loops so the
// loops themselves carry the correct winding and materialize stays forward-only).
// ---------------------------------------------------------------------------

function orientLoops(loops: EdgeRef[][], edges: Map<number, SharedEdge>): void {
  const polys = loops.map((loop) => flattenEdgeRefLoop(loop, edges))
  if (loops.length === 1) {
    if (polySignedArea(polys[0]) < 0) flipLoop(loops[0])
    return
  }
  for (let i = 0; i < loops.length; i++) {
    let depth = 0
    for (let j = 0; j < loops.length; j++) if (j !== i && loopInside(polys[i], polys[j])) depth++
    const wantPositive = depth % 2 === 0
    if (polySignedArea(polys[i]) > 0 !== wantPositive) flipLoop(loops[i])
  }
}

/** Reverse a loop's traversal: reverse edge order and toggle each ref. */
function flipLoop(loop: EdgeRef[]): void {
  loop.reverse()
  for (const r of loop) r.reversed = !r.reversed
}

/** Flatten an EdgeRef loop into a dense polygon for winding/containment tests. */
function flattenEdgeRefLoop(loop: EdgeRef[], edges: Map<number, SharedEdge>): Vec[] {
  const nodes: PathNode[] = []
  for (const ref of loop) {
    const e = edges.get(ref.edge)
    if (!e) continue
    const arc = ref.reversed ? reverseEdgeNodes(e.nodes) : e.nodes
    for (const n of arc) nodes.push(n)
  }
  if (nodes.length < 2) return nodes.map((n) => ({ x: n.x, y: n.y }))
  const sp = { nodes, closed: true }
  const pts: Vec[] = []
  const count = segmentCount(sp)
  for (let seg = 0; seg < count; seg++) {
    const { p0, c1, c2, p3 } = segmentControls(sp, seg)
    for (let k = 0; k < 6; k++) pts.push(cubicAt(p0, c1, c2, p3, k / 6))
  }
  return pts
}

function polySignedArea(poly: Vec[]): number {
  let a = 0
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

function loopInside(inner: Vec[], outer: Vec[]): boolean {
  const samples = Math.min(9, inner.length)
  let inside = 0
  let total = 0
  for (let s = 0; s < samples; s++) {
    const k = Math.floor((s * inner.length) / samples)
    total++
    if (pointInPolygon(inner[k], outer)) inside++
  }
  return inside * 2 > total
}

function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
