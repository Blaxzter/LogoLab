// Phase 5 — shared-edge joint editing. Every op here mutates `doc.topology`
// (the source of truth) immutably and then re-materializes only the regions that
// reference a changed edge, so an edit to ONE shared edge propagates to BOTH
// adjacent regions and they stay byte-coincident (each region reads the same
// canonical `SharedEdge.nodes`, one forward, one via `reverseEdgeNodes`).
//
// The ops edit the CANONICAL edge node array (always start→end). Edge node
// arrays are OPEN (start ≠ end, segments 0→1 … len-2→len-1), so — unlike the
// closed-subpath editor in geometry.ts — they never wrap, EXCEPT a pure
// closed-loop edge (a disc, `closed: true`, no junctions) which does wrap. The
// pure cubic/tangent/mirror math is shared with geometry.ts (splitSegmentAt,
// setNodeKindNode, moveHandleNode, translateNode) so the two never drift.

import type { DocItem, EdgeRef, EditableDoc, NodeKind, NodeRef, PathItem, PathNode, SharedEdge, SubPath, Vec, Vertex } from './types'
import { cubicAt, moveHandleNode, segmentControls, segmentCount, setNodeKindNode, splitSegmentAt, translateNode } from './geometry.ts'
import { edgeMap, materializeRegion, rematerializeRegions, reverseEdgeNodes, type NodeProvenance } from './topology.ts'

/** A real (non-sentinel) vertex id. Open-edge endpoints may carry -1/null. */
const hasVertex = (v: number | null): v is number => v != null && v >= 0

/** Replace one edge's node array, returning a fresh doc/topology (immutable). */
function withEdgeNodes(doc: EditableDoc, edgeId: number, nodes: PathNode[]): EditableDoc {
  const topo = doc.topology
  if (!topo) return doc
  const edges = topo.edges.map((e) => (e.id === edgeId ? { ...e, nodes } : e))
  return { ...doc, topology: { ...topo, edges } }
}

/** O(1) edge lookup helper kept local so each op reads the live topology. */
function findEdge(doc: EditableDoc, edgeId: number): SharedEdge | undefined {
  return doc.topology?.edges.find((e) => e.id === edgeId)
}

// ---------------------------------------------------------------------------
// Single-edge ops (changed set = {edgeId} ⇒ both adjacent regions follow)
// ---------------------------------------------------------------------------

/** Translate one interior edge node (anchor + handles) by (dx, dy). */
export function moveEdgeNode(doc: EditableDoc, edgeId: number, nodeIdx: number, dx: number, dy: number): EditableDoc {
  const e = findEdge(doc, edgeId)
  if (!e || nodeIdx < 0 || nodeIdx >= e.nodes.length) return doc
  const nodes = e.nodes.map((n, i) => (i === nodeIdx ? translateNode(n, dx, dy) : n))
  return rematerializeRegions(withEdgeNodes(doc, edgeId, nodes), new Set([edgeId]))
}

/** Drag one edge node's handle. `which` is the CANONICAL side (in/out). */
export function moveEdgeHandle(
  doc: EditableDoc,
  edgeId: number,
  nodeIdx: number,
  which: 'in' | 'out',
  to: Vec,
  mirror: boolean,
): EditableDoc {
  const e = findEdge(doc, edgeId)
  if (!e || nodeIdx < 0 || nodeIdx >= e.nodes.length) return doc
  const nodes = e.nodes.map((n, i) => (i === nodeIdx ? moveHandleNode(n, which, to, mirror) : n))
  return rematerializeRegions(withEdgeNodes(doc, edgeId, nodes), new Set([edgeId]))
}

/** Split segment `segIdx` of an edge at parameter `t` (de Casteljau). */
export function insertNodeOnEdge(doc: EditableDoc, edgeId: number, segIdx: number, t: number): EditableDoc {
  const e = findEdge(doc, edgeId)
  if (!e) return doc
  const len = e.nodes.length
  const maxSeg = e.closed ? len : len - 1 // closed (disc) edges have a wrap segment
  if (segIdx < 0 || segIdx >= maxSeg) return doc
  const iA = segIdx
  const iB = e.closed ? (segIdx + 1) % len : segIdx + 1
  const split = splitSegmentAt(e.nodes[iA], e.nodes[iB], t)
  const nodes = e.nodes.slice()
  if (!split.straight) {
    nodes[iA] = { ...e.nodes[iA], hOut: split.aHOut }
    nodes[iB] = { ...e.nodes[iB], hIn: split.bHIn }
  }
  // Splice after updating iB: when a closed edge wraps (iB === 0) the insert
  // index is nodes.length, leaving index 0 untouched (mirrors geometry.insertNode).
  nodes.splice(segIdx + 1, 0, split.mid)
  return rematerializeRegions(withEdgeNodes(doc, edgeId, nodes), new Set([edgeId]))
}

/** Toggle corner/smooth on one edge node. Open neighbours (no wrap) for an open
 *  edge; wrap-aware for a closed disc edge — mirrors geometry.setNodeKind. */
export function setEdgeNodeKind(doc: EditableDoc, edgeId: number, nodeIdx: number, kind: NodeKind): EditableDoc {
  const e = findEdge(doc, edgeId)
  if (!e || nodeIdx < 0 || nodeIdx >= e.nodes.length) return doc
  const len = e.nodes.length
  const node = e.nodes[nodeIdx]
  const prevAnchor = nodeIdx > 0 ? e.nodes[nodeIdx - 1] : e.closed && len > 1 ? e.nodes[len - 1] : null
  const nextAnchor = nodeIdx < len - 1 ? e.nodes[nodeIdx + 1] : e.closed && len > 1 ? e.nodes[0] : null
  const nodes = e.nodes.map((n, i) => (i === nodeIdx ? setNodeKindNode(node, prevAnchor, nextAnchor, kind) : n))
  return rematerializeRegions(withEdgeNodes(doc, edgeId, nodes), new Set([edgeId]))
}

/**
 * Delete one edge node. No-op if it would leave the edge with < 2 nodes; an open
 * edge's junction endpoints (idx 0 / len-1) are never deletable — removing one
 * would unweld the shared vertex and open a seam. Closed disc edges have no
 * junctions, so any node may go (down to the 2-node floor).
 */
export function deleteEdgeNode(doc: EditableDoc, edgeId: number, nodeIdx: number): EditableDoc {
  const e = findEdge(doc, edgeId)
  if (!e) return doc
  const len = e.nodes.length
  if (len <= 2 || nodeIdx < 0 || nodeIdx >= len) return doc
  if (!e.closed && (nodeIdx === 0 || nodeIdx === len - 1)) return doc
  const nodes = e.nodes.filter((_, i) => i !== nodeIdx)
  return rematerializeRegions(withEdgeNodes(doc, edgeId, nodes), new Set([edgeId]))
}

// ---------------------------------------------------------------------------
// Vertex op (changed set = every incident edge ⇒ all spokes stay welded)
// ---------------------------------------------------------------------------

/**
 * Move a junction: translate the `Vertex` AND the matching endpoint node of
 * EVERY incident edge (any edge whose startVertex/endVertex === vertexId,
 * updating nodes[0] / nodes[len-1]). Missing any incident edge would open a seam,
 * so the changed set is all incident edge ids.
 */
export function moveVertex(doc: EditableDoc, vertexId: number, dx: number, dy: number): EditableDoc {
  const topo = doc.topology
  if (!topo || !topo.vertices.some((v) => v.id === vertexId)) return doc
  const changed = new Set<number>()
  const edges = topo.edges.map((e) => {
    let nodes = e.nodes
    let touched = false
    if (e.startVertex === vertexId) {
      nodes = nodes.map((n, i) => (i === 0 ? translateNode(n, dx, dy) : n))
      touched = true
    }
    if (e.endVertex === vertexId) {
      const last = nodes.length - 1
      nodes = nodes.map((n, i) => (i === last ? translateNode(n, dx, dy) : n))
      touched = true
    }
    if (!touched) return e
    changed.add(e.id)
    return { ...e, nodes }
  })
  const vertices = topo.vertices.map((v) => (v.id === vertexId ? { ...v, x: v.x + dx, y: v.y + dy } : v))
  return rematerializeRegions({ ...doc, topology: { vertices, edges } }, changed)
}

// ---------------------------------------------------------------------------
// Whole-region translate (move every boundary edge + incident vertex; external
// spokes follow at the seam vertices so the planar graph stays consistent)
// ---------------------------------------------------------------------------

export function translateRegion(doc: EditableDoc, item: PathItem, dx: number, dy: number): EditableDoc {
  const topo = doc.topology
  if (!topo || !item.loops) return doc
  const regionEdges = new Set<number>()
  for (const loop of item.loops) for (const ref of loop) regionEdges.add(ref.edge)
  const movedVertices = new Set<number>()
  for (const e of topo.edges) {
    if (!regionEdges.has(e.id)) continue
    if (hasVertex(e.startVertex)) movedVertices.add(e.startVertex)
    if (hasVertex(e.endVertex)) movedVertices.add(e.endVertex)
  }
  const changed = new Set<number>()
  const edges = topo.edges.map((e) => {
    if (regionEdges.has(e.id)) {
      changed.add(e.id)
      return { ...e, nodes: e.nodes.map((n) => translateNode(n, dx, dy)) }
    }
    // External spoke: move only the endpoint(s) on a moved vertex, so the rest of
    // the spoke stretches to keep the neighbour region attached (no seam).
    let nodes = e.nodes
    let touched = false
    if (hasVertex(e.startVertex) && movedVertices.has(e.startVertex)) {
      nodes = nodes.map((n, i) => (i === 0 ? translateNode(n, dx, dy) : n))
      touched = true
    }
    if (hasVertex(e.endVertex) && movedVertices.has(e.endVertex)) {
      const last = nodes.length - 1
      nodes = nodes.map((n, i) => (i === last ? translateNode(n, dx, dy) : n))
      touched = true
    }
    if (!touched) return e
    changed.add(e.id)
    return { ...e, nodes }
  })
  const vertices = topo.vertices.map((v) => (movedVertices.has(v.id) ? { ...v, x: v.x + dx, y: v.y + dy } : v))
  return rematerializeRegions({ ...doc, topology: { vertices, edges } }, changed)
}

// ---------------------------------------------------------------------------
// Provenance-driven routing (materialized NodeRef → graph op). Shared by the
// canvas drag/nudge handlers and the studio keyboard handlers.
// ---------------------------------------------------------------------------

/**
 * Translate a set of materialized node hits through the graph by (dx, dy):
 * junctions (`vertexId != null`) → {@link moveVertex} (all incident spokes
 * follow), interior nodes → {@link moveEdgeNode} (the one edge → both regions
 * follow). Shared targets are de-duped so a vertex/edge node never moves twice.
 * `prov` must be the provenance for the SAME materialization the refs index into.
 */
export function translateRegionNodes(
  doc: EditableDoc,
  prov: NodeProvenance[][],
  refs: readonly NodeRef[],
  dx: number,
  dy: number,
): EditableDoc {
  let next = doc
  const vSeen = new Set<number>()
  const eSeen = new Set<string>()
  for (const ref of refs) {
    const pv = prov[ref.sub]?.[ref.idx]
    if (!pv) continue
    if (pv.vertexId != null) {
      if (vSeen.has(pv.vertexId)) continue
      vSeen.add(pv.vertexId)
      next = moveVertex(next, pv.vertexId, dx, dy)
    } else {
      const key = `${pv.edgeId}:${pv.edgeNodeIdx}`
      if (eSeen.has(key)) continue
      eSeen.add(key)
      next = moveEdgeNode(next, pv.edgeId, pv.edgeNodeIdx, dx, dy)
    }
  }
  return next
}

/**
 * Delete a set of materialized node hits through the graph. Only interior edge
 * nodes are removable (junctions are skipped — they'd unweld the graph); per
 * edge the dead canonical indices are dropped at once, keeping ≥ 2 nodes and
 * open-edge endpoints. Returns the doc unchanged when nothing is deletable.
 */
export function deleteRegionNodes(doc: EditableDoc, prov: NodeProvenance[][], refs: readonly NodeRef[]): EditableDoc {
  const topo = doc.topology
  if (!topo) return doc
  const perEdge = new Map<number, Set<number>>()
  for (const ref of refs) {
    const pv = prov[ref.sub]?.[ref.idx]
    if (!pv || pv.vertexId != null) continue
    let s = perEdge.get(pv.edgeId)
    if (!s) perEdge.set(pv.edgeId, (s = new Set()))
    s.add(pv.edgeNodeIdx)
  }
  if (perEdge.size === 0) return doc
  const changed = new Set<number>()
  const edges = topo.edges.map((e) => {
    const dead = perEdge.get(e.id)
    if (!dead || dead.size === 0) return e
    const len = e.nodes.length
    const keep = e.nodes.filter((_, i) => {
      if (!dead.has(i)) return true
      if (!e.closed && (i === 0 || i === len - 1)) return true // keep junction endpoints
      return false
    })
    if (keep.length < 2 || keep.length === len) return e
    changed.add(e.id)
    return { ...e, nodes: keep }
  })
  if (changed.size === 0) return doc
  return rematerializeRegions({ ...doc, topology: { ...topo, edges } }, changed)
}

/**
 * Resolve which edge a materialized segment (node `seg` → `seg+1` of subpath
 * `sub`) belongs to, plus the local canonical segment index and parameter for a
 * de Casteljau split there. A materialized segment lies within exactly one edge:
 * its start node's `outHandle` and end node's `inHandle` name that edge's two
 * canonical nodes. Returns null if the endpoints disagree (should not happen for
 * a well-formed loop). `t` is the materialized-direction parameter; the returned
 * `t` is flipped to canonical direction when the edge was traversed reversed.
 */
export function resolveEdgeSegment(
  prov: NodeProvenance[][],
  sub: number,
  seg: number,
  subPathLen: number,
  t: number,
): { edgeId: number; segIdx: number; t: number } | null {
  const a = prov[sub]?.[seg]
  const b = prov[sub]?.[(seg + 1) % subPathLen]
  if (!a?.outHandle || !b?.inHandle) return null
  const out = a.outHandle
  const inn = b.inHandle
  if (out.edgeId !== inn.edgeId) return null
  const ko = out.edgeNodeIdx
  const ki = inn.edgeNodeIdx
  if (Math.abs(ko - ki) !== 1) return null
  const segIdx = Math.min(ko, ki)
  return { edgeId: out.edgeId, segIdx, t: ko < ki ? t : 1 - t }
}

// ---------------------------------------------------------------------------
// Remove & heal — dissolve ONE connected section of a planar region and grow the
// neighbour(s) into the freed area, live on the graph (no re-trace). The clean,
// well-defined heal: absorb the section F entirely into the single neighbour G it
// shares the most boundary with (a face-merge). Edges shared only between F and G
// dissolve; F's remaining boundary (facing other regions / EXT) becomes G's. This
// is the live-graph equivalent of the trace-time `applyRemoveMarkers` flood.
// ---------------------------------------------------------------------------

// --- small geometry helpers (replicated from planarAssemble so lib/path stays
// self-contained: flatten a loop to a dense polygon, winding sign, containment) -

/** Flatten an EdgeRef loop into a dense polygon for winding / containment tests. */
function flattenLoop(loop: EdgeRef[], edges: Map<number, SharedEdge>): Vec[] {
  const nodes: PathNode[] = []
  for (const ref of loop) {
    const e = edges.get(ref.edge)
    if (!e) continue
    const arc = ref.reversed ? reverseEdgeNodes(e.nodes) : e.nodes
    for (const n of arc) nodes.push({ x: n.x, y: n.y, hIn: n.hIn, hOut: n.hOut, kind: n.kind })
  }
  if (nodes.length < 2) return nodes.map((n) => ({ x: n.x, y: n.y }))
  const sp: SubPath = { nodes, closed: true }
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
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
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

/** Majority of sampled `inner` points fall inside `outer` (containment for nesting). */
function loopInside(inner: Vec[], outer: Vec[]): boolean {
  const samples = Math.min(9, inner.length)
  let inside = 0
  let total = 0
  for (let s = 0; s < samples; s++) {
    total++
    if (pointInPolygon(inner[Math.floor((s * inner.length) / samples)], outer)) inside++
  }
  return inside * 2 > total
}

/** Anchor-polyline length of an edge (cheap "shared boundary" weight). */
function edgeArcLength(e: SharedEdge | undefined): number {
  if (!e) return 0
  let L = 0
  for (let i = 1; i < e.nodes.length; i++) L += Math.hypot(e.nodes[i].x - e.nodes[i - 1].x, e.nodes[i].y - e.nodes[i - 1].y)
  return L
}

// --- orientation (mirrors planarAssemble.orientLoops; flips EdgeRef loops so the
// loops carry the winding and materialize stays a forward concatenation) --------

function flipLoop(loop: EdgeRef[]): void {
  loop.reverse()
  for (const r of loop) r.reversed = !r.reversed
}

function orientLoops(loops: EdgeRef[][], edges: Map<number, SharedEdge>): void {
  const polys = loops.map((loop) => flattenLoop(loop, edges))
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

// --- section identification: the loops of ONE blob (outer ring + nested holes) --

interface Section {
  /** Index into item.loops of the outer ring containing the seed. */
  outerIdx: number
  /** Indices of the hole loops nested directly inside that ring. */
  holeIdxs: number[]
}

/** Whether p lies within a polygon's axis-aligned bounding box (a cheap pre-gate). */
function inBBox(p: Vec, poly: Vec[]): boolean {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const q of poly) {
    if (q.x < minX) minX = q.x
    if (q.x > maxX) maxX = q.x
    if (q.y < minY) minY = q.y
    if (q.y > maxY) maxY = q.y
  }
  return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY
}

/** Squared distance from p to the nearest vertex of a polygon. */
function nearestVertexDist2(p: Vec, poly: Vec[]): number {
  let best = Infinity
  for (const q of poly) {
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2
    if (d < best) best = d
  }
  return best
}

/** Hole loops whose innermost containing ring is `outerIdx` (its nested holes). */
function holesNestedIn(polys: Vec[][], areas: number[], outerIdx: number): number[] {
  const holeIdxs: number[] = []
  for (let i = 0; i < polys.length; i++) {
    if (i === outerIdx || areas[i] >= 0) continue
    // Assign each hole to the smallest-area ring that contains it; keep ours.
    let bestOuter = -1
    let bestA = Infinity
    for (let j = 0; j < polys.length; j++) {
      if (areas[j] <= 0) continue
      if (!loopInside(polys[i], polys[j])) continue
      if (areas[j] < bestA) {
        bestA = areas[j]
        bestOuter = j
      }
    }
    if (bestOuter === outerIdx) holeIdxs.push(i)
  }
  return holeIdxs
}

/**
 * Which connected section of a planar item the seed sits in: the smallest-area
 * outer ring (signed area > 0) containing the seed, plus its nested holes. When no
 * ring strictly contains the seed, falls back to the ring NEAREST the seed — but
 * only among rings whose bounding box contains it, so a thin sliver's flattened
 * polygon can miss a click that visually landed on it WITHOUT a click in a wholly
 * different region resolving to the wrong blob. Null when nothing qualifies.
 */
function findSection(loops: EdgeRef[][], edges: Map<number, SharedEdge>, seed: Vec): Section | null {
  const polys = loops.map((l) => flattenLoop(l, edges))
  const areas = polys.map(polySignedArea)
  let outerIdx = -1
  let bestArea = Infinity
  for (let i = 0; i < loops.length; i++) {
    if (areas[i] <= 0) continue // holes have area < 0
    if (!pointInPolygon(seed, polys[i])) continue
    if (areas[i] < bestArea) {
      bestArea = areas[i]
      outerIdx = i
    }
  }
  if (outerIdx < 0) {
    // Near-miss: the nearest ring whose bbox still contains the seed (bounded so a
    // click elsewhere doesn't snap to an arbitrary far blob).
    let bestD = Infinity
    for (let i = 0; i < loops.length; i++) {
      if (areas[i] <= 0 || !inBBox(seed, polys[i])) continue
      const d = nearestVertexDist2(seed, polys[i])
      if (d < bestD) {
        bestD = d
        outerIdx = i
      }
    }
  }
  if (outerIdx < 0) return null
  return { outerIdx, holeIdxs: holesNestedIn(polys, areas, outerIdx) }
}

/**
 * The section a given loop index belongs to (the loop the user's selected nodes sit
 * on): that loop if it is an outer ring, else the ring that owns it as a hole. Lets
 * the editor remove the exact blob whose junctions are selected — no seed needed.
 */
function sectionForLoop(loops: EdgeRef[][], edges: Map<number, SharedEdge>, loopIdx: number): Section | null {
  if (loopIdx < 0 || loopIdx >= loops.length) return null
  const polys = loops.map((l) => flattenLoop(l, edges))
  const areas = polys.map(polySignedArea)
  let outerIdx = loopIdx
  if (areas[loopIdx] <= 0) {
    // A hole boundary was selected: target the smallest ring enclosing it.
    let bestA = Infinity
    outerIdx = -1
    for (let j = 0; j < loops.length; j++) {
      if (areas[j] <= 0) continue
      if (!loopInside(polys[loopIdx], polys[j])) continue
      if (areas[j] < bestA) {
        bestA = areas[j]
        outerIdx = j
      }
    }
    if (outerIdx < 0) return null
  }
  return { outerIdx, holeIdxs: holesNestedIn(polys, areas, outerIdx) }
}

// --- edge-side index (find the neighbour across an edge; prune unreferenced) ----

interface EdgeSide {
  itemId: string
  reversed: boolean
}

function buildEdgeSides(items: readonly DocItem[]): Map<number, EdgeSide[]> {
  const m = new Map<number, EdgeSide[]>()
  for (const it of items) {
    if (it.kind !== 'path' || !it.loops) continue
    for (const loop of it.loops) {
      for (const r of loop) {
        let a = m.get(r.edge)
        if (!a) m.set(r.edge, (a = []))
        a.push({ itemId: it.id, reversed: r.reversed })
      }
    }
  }
  return m
}

/** The region on the other side of an edge from `selfId`, or null (EXT / dropped bg). */
function otherSide(sides: Map<number, EdgeSide[]>, edgeId: number, selfId: string): string | null {
  const ss = sides.get(edgeId)
  if (!ss) return null
  for (const s of ss) if (s.itemId !== selfId) return s.itemId
  return null
}

// --- re-chaining surviving directed refs into oriented loops -------------------

const PKEY = (p: Vec): string => `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)}`

interface DirectedRef {
  ref: EdgeRef
  tail: Vec
  head: Vec
  /** Direction leaving the tail / arriving the head (screen-space atan2). */
  leaveDir: number
  arriveDir: number
}

/**
 * Chain a bag of directed edge-refs (each already oriented with the merged face on
 * the correct side) into closed loops by endpoint coincidence — robust to -1/null
 * vertex ids (border arcs) since it matches actual arc endpoints, not vertex table
 * entries. At a point where the boundary passes more than once, the continuation is
 * the next edge clockwise from the reverse of the arrival direction (the planar
 * rotational system — same rule as planarAssemble's face walk). Returns null if a
 * walk fails to close (deferred silhouette cases), so the caller can no-op rather
 * than emit a broken tiling.
 */
function chainRefs(refs: readonly EdgeRef[], edges: Map<number, SharedEdge>): EdgeRef[][] | null {
  const loops: EdgeRef[][] = []
  const open: DirectedRef[] = []
  for (const ref of refs) {
    const e = edges.get(ref.edge)
    if (!e) return null
    if (e.closed) {
      loops.push([{ edge: ref.edge, reversed: ref.reversed }]) // a disc is its own loop
      continue
    }
    const arc = ref.reversed ? reverseEdgeNodes(e.nodes) : e.nodes
    if (arc.length < 2) return null
    const a0 = arc[0]
    const a1 = arc[1]
    const an = arc[arc.length - 1]
    const am = arc[arc.length - 2]
    open.push({
      ref: { edge: ref.edge, reversed: ref.reversed },
      tail: { x: a0.x, y: a0.y },
      head: { x: an.x, y: an.y },
      leaveDir: Math.atan2(a1.y - a0.y, a1.x - a0.x),
      arriveDir: Math.atan2(an.y - am.y, an.x - am.x),
    })
  }
  const byTail = new Map<string, DirectedRef[]>()
  for (const d of open) {
    const k = PKEY(d.tail)
    let a = byTail.get(k)
    if (!a) byTail.set(k, (a = []))
    a.push(d)
  }
  const used = new Set<DirectedRef>()
  const TWO_PI = Math.PI * 2
  const pickNext = (arrived: DirectedRef, avail: DirectedRef[]): DirectedRef => {
    if (avail.length === 1) return avail[0]
    const reverse = arrived.arriveDir + Math.PI
    let best = avail[0]
    let bestDelta = Infinity
    for (const d of avail) {
      let delta = d.leaveDir - reverse
      delta -= TWO_PI * Math.floor(delta / TWO_PI) // → [0, 2π)
      if (delta < 1e-9) delta += TWO_PI // skip the immediate U-turn back along `arrived`
      if (delta < bestDelta) {
        bestDelta = delta
        best = d
      }
    }
    return best
  }
  for (const start of open) {
    if (used.has(start)) continue
    const loop: EdgeRef[] = []
    let cur: DirectedRef | undefined = start
    let guard = 0
    const maxIter = open.length + 4
    while (cur && !used.has(cur) && guard++ < maxIter) {
      used.add(cur)
      loop.push(cur.ref)
      const avail = (byTail.get(PKEY(cur.head)) ?? []).filter((d) => !used.has(d) || d === start)
      if (avail.length === 0) return null // dangling end — cannot close (deferred)
      const nxt = pickNext(cur, avail)
      if (nxt === start) {
        cur = undefined
        break
      }
      cur = nxt
    }
    if (loop.length > 0) loops.push(loop)
  }
  return loops
}

// --- mutators on the immutable doc --------------------------------------------

/** Vertices still referenced by a surviving edge (drops the isolated ones). */
function pruneVertices(vertices: readonly Vertex[], edges: readonly SharedEdge[]): Vertex[] {
  const used = new Set<number>()
  for (const e of edges) {
    if (e.startVertex != null && e.startVertex >= 0) used.add(e.startVertex)
    if (e.endVertex != null && e.endVertex >= 0) used.add(e.endVertex)
  }
  return vertices.filter((v) => used.has(v.id))
}

/** Remove F's section loops from its item; drop the item entirely if none remain. */
function dropFLoops(items: readonly DocItem[], itemId: string, dead: ReadonlySet<number>, edges: Map<number, SharedEdge>): DocItem[] {
  const out: DocItem[] = []
  for (const it of items) {
    if (it.id !== itemId) {
      out.push(it)
      continue
    }
    if (it.kind !== 'path' || !it.loops) {
      out.push(it)
      continue
    }
    const kept = it.loops.filter((_, li) => !dead.has(li))
    if (kept.length === 0) continue // F's whole item is gone
    out.push({ ...it, loops: kept, subPaths: materializeRegion(kept, edges) })
  }
  return out
}

/**
 * The shared merge core: dissolve `section` of `item` and heal the gap. Resolves
 * the dominant opaque neighbour across the section's outward ring, face-merges F
 * into it (symmetric-difference of edge refs, re-chain, re-orient), drops F's loops
 * (and the item if empty), and prunes the now-unreferenced edges/vertices. Returns
 * the SAME doc when it can't act (not adjacent / re-chain can't close).
 */
function mergeOrDropSection(doc: EditableDoc, item: PathItem, edges: Map<number, SharedEdge>, section: Section): EditableDoc {
  const topo = doc.topology!
  const loops = item.loops! // callers guarantee a planar item
  const itemId = item.id
  const fLoopIdxs = [section.outerIdx, ...section.holeIdxs]
  const fLoopSet = new Set(fLoopIdxs)

  // Every edge of the section (ring + holes) and the ring's outward edges alone.
  const fEdges = new Set<number>()
  for (const li of fLoopIdxs) for (const r of loops[li]) fEdges.add(r.edge)
  const ring = loops[section.outerIdx]

  // Dominant opaque neighbour across the outward ring: the most shared arc length.
  const sides = buildEdgeSides(doc.items)
  const lenByNeighbour = new Map<string, number>()
  for (const r of ring) {
    const other = otherSide(sides, r.edge, itemId)
    if (other == null || other === itemId) continue // EXT / background heals transparent
    lenByNeighbour.set(other, (lenByNeighbour.get(other) ?? 0) + edgeArcLength(edges.get(r.edge)))
  }
  let gId: string | null = null
  let gLen = -1
  for (const [id, L] of lenByNeighbour) {
    if (L > gLen || (L === gLen && (gId == null || id < gId))) {
      gLen = L
      gId = id
    }
  }

  // No opaque neighbour: a plain transparent delete of the section (nothing to heal
  // into). Drop F's loops, prune edges/vertices nobody references any more.
  if (gId == null) {
    const items = dropFLoops(doc.items, itemId, fLoopSet, edges)
    const stillRef = new Set<number>()
    for (const it of items) if (it.kind === 'path' && it.loops) for (const loop of it.loops) for (const r of loop) stillRef.add(r.edge)
    const nextEdges = topo.edges.filter((e) => stillRef.has(e.id))
    return { ...doc, items, topology: { vertices: pruneVertices(topo.vertices, nextEdges), edges: nextEdges } }
  }

  const g = doc.items.find((it) => it.id === gId) as PathItem
  const gEdges = new Set<number>()
  for (const loop of g.loops!) for (const r of loop) gEdges.add(r.edge)
  // Edges shared between F and G dissolve; both faces release them.
  const shared = new Set<number>()
  for (const e of fEdges) if (gEdges.has(e)) shared.add(e)
  if (shared.size === 0) return doc // not actually adjacent — bail

  // Boundary of the merged face = (G's refs) ⊕ (F's refs), shared edges cancelling.
  // F's refs keep F's-side orientation: F's interior becomes G's interior, so the
  // winding is already right (re-asserted by orientLoops below).
  const survivors: EdgeRef[] = []
  for (const loop of g.loops!) for (const r of loop) if (!shared.has(r.edge)) survivors.push(r)
  for (const li of fLoopIdxs) for (const r of loops[li]) if (!shared.has(r.edge)) survivors.push(r)

  // The dissolved edges are gone from the graph before re-chaining/orienting.
  const nextEdges = topo.edges.filter((e) => !shared.has(e.id))
  const edgesAfter = edgeMap({ vertices: topo.vertices, edges: nextEdges })
  const newGLoops = chainRefs(survivors, edgesAfter)
  if (!newGLoops) return doc // re-chain could not close — defer rather than corrupt
  orientLoops(newGLoops, edgesAfter)

  // Assemble: F loses its section (drop item if empty), G adopts the merged loops.
  const items: DocItem[] = []
  for (const it of doc.items) {
    if (it.id === itemId) {
      if (it.kind !== 'path' || !it.loops) {
        items.push(it)
        continue
      }
      const kept = it.loops.filter((_, li) => !fLoopSet.has(li))
      if (kept.length === 0) continue
      items.push({ ...it, loops: kept, subPaths: materializeRegion(kept, edgesAfter) })
    } else if (it.id === gId) {
      items.push({ ...g, loops: newGLoops, subPaths: materializeRegion(newGLoops, edgesAfter) })
    } else {
      items.push(it)
    }
  }
  return { ...doc, items, topology: { vertices: pruneVertices(topo.vertices, nextEdges), edges: nextEdges } }
}

/**
 * Remove & heal a single connected section of a planar region, seeded by a point
 * inside (or nearest) the section — e.g. the click that selected the blob. Grows
 * the neighbour it shares the most boundary with into the freed area, leaving a
 * valid planar tiling (no hole, no overlap, no seam); all other geometry/edits are
 * untouched. Returns a fresh immutable doc the caller commits through history
 * (undoable), or the SAME doc when it can't act (no topology, legacy/non-planar
 * item, the item has no ring, or a deferred silhouette case the re-chain can't
 * close).
 */
export function removeRegionAndHeal(doc: EditableDoc, itemId: string, seed: Vec): EditableDoc {
  const topo = doc.topology
  if (!topo) return doc
  const item = doc.items.find((it) => it.id === itemId)
  if (!item || item.kind !== 'path' || !item.loops) return doc
  const edges = edgeMap(topo)
  const section = findSection(item.loops, edges, seed)
  if (!section) return doc
  return mergeOrDropSection(doc, item, edges, section)
}

/**
 * Like {@link removeRegionAndHeal} but targets the section by a loop / subpath index
 * (the loop the editor's selected nodes sit on) instead of a seed point — used when
 * a whole blob's junctions are selected (which {@link deleteRegionNodes} can't thin)
 * so ⌫ dissolves that blob and heals it. Same return contract.
 */
export function removeRegionSection(doc: EditableDoc, itemId: string, loopIdx: number): EditableDoc {
  const topo = doc.topology
  if (!topo) return doc
  const item = doc.items.find((it) => it.id === itemId)
  if (!item || item.kind !== 'path' || !item.loops) return doc
  const edges = edgeMap(topo)
  const section = sectionForLoop(item.loops, edges, loopIdx)
  if (!section) return doc
  return mergeOrDropSection(doc, item, edges, section)
}

