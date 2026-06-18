// Shared-edge (planar) topology helpers: materialize each region's render/hit
// `subPaths` cache from the doc's edge graph, and (Phase 5) edge-aware editing.
//
// The graph (EditableDoc.topology = {vertices, edges}) is the source of truth.
// A region (PathItem) carries `loops: EdgeRef[][]` — ordered shared-edge
// references forming its outer boundary + holes. Two adjacent regions reference
// the SAME SharedEdge (one forward, one reversed), so their materialized
// boundaries are byte-coincident: no overlap, no hairline seam.

import type { EdgeRef, EditableDoc, PathItem, PathNode, SharedEdge, SubPath, Topology, Vec } from './types'

const EPS = 1e-6

const clone = (v: Vec | null): Vec | null => (v ? { x: v.x, y: v.y } : null)
const cloneNode = (n: PathNode): PathNode => ({ x: n.x, y: n.y, hIn: clone(n.hIn), hOut: clone(n.hOut), kind: n.kind })
const samePoint = (a: Vec, b: Vec): boolean => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS

/**
 * Reverse a shared edge's node list for backward traversal: reverse order and
 * swap each node's hIn/hOut (a pure reindex+swap — introduces no new arithmetic,
 * so the reversed view is byte-coincident with the forward one).
 */
export function reverseEdgeNodes(nodes: PathNode[]): PathNode[] {
  const out = nodes.map((n) => ({ x: n.x, y: n.y, hIn: clone(n.hOut), hOut: clone(n.hIn), kind: n.kind }))
  out.reverse()
  return out
}

/** Index a topology's edges by id for O(1) lookup during materialization. */
export function edgeMap(topo: Topology): Map<number, SharedEdge> {
  const m = new Map<number, SharedEdge>()
  for (const e of topo.edges) m.set(e.id, e)
  return m
}

/**
 * Build one region's `subPaths` from its edge-ref loops. Each loop concatenates
 * its edges' node arrays (reversed when the ref says so), dropping the shared
 * junction anchor that the previous arc already emitted, and closes by merging
 * the final duplicate junction back onto the first node. The loops are assumed
 * already oriented for nonzero (outer CCW, holes CW) by the assembler, so this
 * is a pure forward concatenation — the materialized node order matches the loop
 * order, which the editor relies on to map a node hit back to its edge.
 */
export function materializeRegion(loops: EdgeRef[][], edges: Map<number, SharedEdge>): SubPath[] {
  const subPaths: SubPath[] = []
  for (const loop of loops) {
    if (loop.length === 0) continue
    // A single closed-loop edge is its own subpath (no junctions to dedup).
    if (loop.length === 1) {
      const e = edges.get(loop[0].edge)
      if (!e) continue
      const arc = loop[0].reversed ? reverseEdgeNodes(e.nodes) : e.nodes.map(cloneNode)
      if (arc.length >= 2) subPaths.push({ nodes: arc, closed: true })
      continue
    }
    const nodes: PathNode[] = []
    for (const ref of loop) {
      const e = edges.get(ref.edge)
      if (!e) continue
      const arc = ref.reversed ? reverseEdgeNodes(e.nodes) : e.nodes.map(cloneNode)
      if (arc.length === 0) continue
      let start = 0
      const last = nodes[nodes.length - 1]
      if (last && samePoint(last, arc[0])) {
        // Shared junction anchor: carry the incoming arc's outgoing handle onto it.
        last.hOut = clone(arc[0].hOut)
        start = 1
      }
      for (let i = start; i < arc.length; i++) nodes.push(arc[i])
    }
    // Close: the trailing junction anchor duplicates the first node — fold it in.
    if (nodes.length > 1 && samePoint(nodes[0], nodes[nodes.length - 1])) {
      const tail = nodes.pop()!
      nodes[0].hIn = clone(tail.hIn)
    }
    if (nodes.length >= 2) subPaths.push({ nodes, closed: true })
  }
  return subPaths
}

/** Rebuild the `subPaths` cache of every topological PathItem from the graph. */
export function materializeDoc(doc: EditableDoc): EditableDoc {
  if (!doc.topology) return doc
  const edges = edgeMap(doc.topology)
  const items = doc.items.map((it) =>
    it.kind === 'path' && it.loops ? { ...it, subPaths: materializeRegion(it.loops, edges) } : it,
  )
  return { ...doc, items }
}

/** Rebuild only the regions whose loops reference any edge in `changed`. */
export function rematerializeRegions(doc: EditableDoc, changed: ReadonlySet<number>): EditableDoc {
  if (!doc.topology) return doc
  const edges = edgeMap(doc.topology)
  const touches = (it: PathItem): boolean => !!it.loops?.some((loop) => loop.some((r) => changed.has(r.edge)))
  const items = doc.items.map((it) =>
    it.kind === 'path' && it.loops && touches(it) ? { ...it, subPaths: materializeRegion(it.loops, edges) } : it,
  )
  return { ...doc, items }
}
