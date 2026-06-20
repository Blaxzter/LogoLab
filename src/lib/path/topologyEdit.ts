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

import type { EditableDoc, NodeKind, NodeRef, PathItem, PathNode, SharedEdge, Vec } from './types'
import { moveHandleNode, setNodeKindNode, splitSegmentAt, translateNode } from './geometry.ts'
import { rematerializeRegions, type NodeProvenance } from './topology.ts'

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

