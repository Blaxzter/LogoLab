// Phase 3 of the planar tracer: fit every edge once, build the shared-edge graph
// (vertices + edges), then assemble each region's boundary as ordered loops of
// shared-edge references via a half-edge face walk on the lattice rotational
// system. Loops are oriented for nonzero fill (outer CCW, holes CW) by flipping
// EdgeRef loops — so materializeRegion stays a pure forward concatenation and the
// two regions on a shared edge reference byte-identical geometry.

import type { EdgeRef, PathNode, SharedEdge, Vec, Vertex } from '../path/types'
import { cubicAt, segmentControls, segmentCount } from '../path/geometry.ts'
import { buildPlanarNetwork, EXT, type PlanarNetwork } from './planarNetwork.ts'
import { detectCorners, detectLoopCorners, fitCorneredLoop, fitCorneredOpen, fitLoopEdge, fitOpenArc, presmooth, type PlanarFitOptions, DEFAULT_PLANAR_FIT } from './planarFit.ts'
import { subpixelJunctions, smoothThroughJunctions } from './planarJunction.ts'
import { weldJunctionClusters } from './planarWeld.ts'
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
  // With refineJunctions (experimental, off by default) each junction is placed at
  // the sub-pixel arm intersection and every incident edge endpoint is pinned to it
  // below; otherwise it stays the raw integer lattice corner (the shipped path).
  const cw = net.width + 1
  const juncPos = opts.refineJunctions ? subpixelJunctions(net, cw) : null
  const vidByCorner = new Map<number, number>()
  const vertices: Vertex[] = []
  for (const c of net.junctions) {
    const id = vertices.length
    vidByCorner.set(c, id)
    const p = juncPos?.get(c)
    vertices.push({ id, x: p ? p.x : c % cw, y: p ? p.y : (c / cw) | 0 })
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
    // refineJunctions: pin open-edge endpoints to the sub-pixel junction positions
    // so the fitted arc ends exactly on the shared vertex (both regions stay
    // byte-coincident). No-op / e.pts unchanged when refinement is off or closed.
    let pts = e.pts
    if (juncPos && !e.closed) {
      const sp0 = e.startV >= 0 ? juncPos.get(e.startV) : undefined
      const sp1 = e.endV >= 0 ? juncPos.get(e.endV) : undefined
      if (sp0 || sp1) {
        pts = e.pts.map((p) => ({ x: p.x, y: p.y }))
        if (sp0) pts[0] = { x: sp0.x, y: sp0.y }
        if (sp1) pts[pts.length - 1] = { x: sp1.x, y: sp1.y }
      }
    }
    // Sharp corners are found on the RAW staircase and pinned through pre-smoothing
    // so a valley/point isn't melted into a curve before the fitter detects it.
    const corners = detectCorners(pts, opts.cornerTurnDeg, e.closed)
    if (e.closed) {
      // A closed loop with ≥2 genuine sharp corners is fitted corner-first (snap
      // each corner to its sub-pixel arm intersection, then fit the arcs between
      // them) so the apex is an exact node, not a beveled pair. Smooth loops have
      // <2 corners and fall through to the unchanged closed-loop fitter.
      const loopCorners = detectLoopCorners(pts, opts.cornerTurnDeg)
      nodes =
        loopCorners.length >= 2
          ? fitCorneredLoop(pts, loopCorners, opts)
          : fitLoopEdge(presmooth(pts, opts.smoothPasses, false, corners), opts)
      // AREA GUARD. A fit can keep every boundary sample within ε and still
      // pinch a thin loop's two walls together — a thin bar's cap shoulder-
      // corners (1–2px apart) fuse to a single apex in detectLoopCorners, the
      // wall-arcs pin to the same point, and the region loses its width: bar 7
      // of hairlines became a ZERO-AREA 2-node line, bar 6 a 3-node triangle
      // pinched at one end (exactly 50% area — a one-end pinch of a rectangle
      // is always half). Boundary tolerance cannot see this failure; area can.
      // If the fit kept < 75% of the raw loop's area, emit the exact staircase
      // corners instead. For a feature thin enough to trip this, "exact" beats
      // "smooth" outright (an axis-aligned bar is just its 4 corners); for
      // normal blobs a real fit's area drift is a small fraction of ε·perimeter
      // and never approaches 25% (tier 2 measured byte-identical under this).
      const rawArea = Math.abs(polySignedArea(pts))
      if (rawArea >= 4 && Math.abs(polySignedArea(flattenNodes(nodes))) < rawArea * 0.75) {
        nodes = staircaseCorners(pts)
      }
    } else {
      // An open edge with genuinely sharp interior corners (a tip that a junction
      // split onto this edge) gets the same sub-pixel corner snap as closed loops
      // (fitCorneredOpen); without corners this is the unchanged legacy fit.
      nodes =
        corners.size > 0
          ? fitCorneredOpen(pts, corners, opts)
          : fitOpenArc(presmooth(pts, opts.smoothPasses, true, corners), opts)
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

  // weldJunctions (experimental, 0 = off): contract micro-edges between
  // near-coincident junctions so a rasterized crossing becomes ONE vertex. Runs
  // before the G¹ smooth-through so straight-through pairs across the fused
  // crossing become discoverable.
  if (opts.weldJunctions > 0) weldJunctionClusters(vertices, edges, loopsByLabel, net.width, net.height, opts.weldJunctions)

  // refineJunctions: weld straight-through junctions to a shared G¹ tangent.
  if (opts.refineJunctions) smoothThroughJunctions(edges, loopsByLabel)

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

/** Flatten a fitted closed node loop to a polygon (6 samples per segment — the
 *  same density flattenEdgeRefLoop uses; area only needs the coarse shape). */
function flattenNodes(nodes: PathNode[]): Vec[] {
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

/** The exact polygon of a raw crack-lattice ring: direction-change points only
 *  (collinear runs merged — an axis-aligned bar reduces to its 4 corners). The
 *  area-guard fallback: zero drift from the label map, at staircase node cost. */
function staircaseCorners(pts: Vec[]): PathNode[] {
  // Drop a duplicated closing point so the cyclic direction test is clean.
  const ring = pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y ? pts.slice(0, -1) : pts.slice()
  const n = ring.length
  const out: PathNode[] = []
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n]
    const b = ring[i]
    const c = ring[(i + 1) % n]
    const abx = b.x - a.x, aby = b.y - a.y
    const bcx = c.x - b.x, bcy = c.y - b.y
    // Keep b when the direction changes (turn or reversal); skip mid-run points.
    if (abx * bcy - aby * bcx !== 0 || abx * bcx + aby * bcy <= 0) {
      out.push({ x: b.x, y: b.y, hIn: null, hOut: null, kind: 'corner' })
    }
  }
  return out.length >= 3 ? out : ring.map((p) => ({ x: p.x, y: p.y, hIn: null, hOut: null, kind: 'corner' as const }))
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
