// Shared-edge (planar) topology: materialize each region's `subPaths` cache
// from the doc's edge graph.
//
// The graph (`EditableDoc.topology`) is the source of truth. A region carries
// `loops: EdgeRef[][]` (outer boundary + holes). Adjacent regions reference the
// same SharedEdge, one forward and one reversed, so their boundaries coincide
// exactly: no overlap, no hairline seam.

import type { EdgeRef, EditableDoc, PathItem, PathNode, SharedEdge, SubPath, Topology, Vec } from './types'

const EPS = 1e-6

const clone = (v: Vec | null): Vec | null => (v ? { x: v.x, y: v.y } : null)
const cloneNode = (n: PathNode): PathNode => ({ x: n.x, y: n.y, hIn: clone(n.hIn), hOut: clone(n.hOut), kind: n.kind })
const samePoint = (a: Vec, b: Vec): boolean => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS

/**
 * Reverse a shared edge's node list for backward traversal: reverse order and
 * swap each node's hIn/hOut. No arithmetic, so the reversed view coincides
 * exactly with the forward one.
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
 * Where a displayed handle lives in the graph: a canonical edge node and which
 * of its two canonical handles (`in`/`out`) the handle maps to. A reversed
 * traversal swaps the displayed in/out relative to canonical (see
 * `reverseEdgeNodes`), so this records the canonical side, not the displayed one.
 */
export interface HandleSite {
  edgeId: number
  edgeNodeIdx: number
  which: 'in' | 'out'
}

/**
 * The graph origin of one materialized node: how the editor maps a
 * `NodeRef{sub,idx}` (into the derived `subPaths`) back onto `doc.topology`.
 *
 * - Interior edge node: `vertexId === null`; `edgeId`/`edgeNodeIdx` name the
 *   canonical node; `inHandle`/`outHandle` point at the same node.
 * - Junction anchor: `vertexId` is the owning vertex (drag moves every incident
 *   edge). `edgeId`/`edgeNodeIdx` still name the surviving (previous-edge)
 *   endpoint, but `inHandle` belongs to the arriving edge and `outHandle` to the
 *   departing edge — the two arcs that meet at the junction.
 */
export interface NodeProvenance {
  edgeId: number
  edgeNodeIdx: number
  vertexId: number | null
  reversed: boolean
  inHandle: HandleSite | null
  outHandle: HandleSite | null
}

/** Treat a missing/sentinel (-1) vertex id as "no vertex". */
const vid = (v: number | null): number | null => (v != null && v >= 0 ? v : null)

/** Provenance for a plain interior node taken from arc position → canonical idx. */
function interiorProvenance(edgeId: number, edgeNodeIdx: number, reversed: boolean): NodeProvenance {
  return {
    edgeId,
    edgeNodeIdx,
    vertexId: null,
    reversed,
    inHandle: { edgeId, edgeNodeIdx, which: reversed ? 'out' : 'in' },
    outHandle: { edgeId, edgeNodeIdx, which: reversed ? 'in' : 'out' },
  }
}

/**
 * The single shared walk behind both materializers: concatenate a loop's edge
 * arcs (reversed per ref), drop each shared junction anchor the previous arc
 * already emitted (carrying its `hOut`), and fold the trailing junction back
 * onto the first node to close. Returns the subpath plus per-node provenance
 * aligned 1:1, or null when the loop yields fewer than two nodes.
 */
function materializeLoop(
  loop: EdgeRef[],
  edges: Map<number, SharedEdge>,
): { subPath: SubPath; provenance: NodeProvenance[] } | null {
  if (loop.length === 0) return null

  // A single closed-loop edge (a disc) is its own subpath: no junctions to dedup.
  if (loop.length === 1) {
    const ref = loop[0]
    const e = edges.get(ref.edge)
    if (!e) return null
    const arc = ref.reversed ? reverseEdgeNodes(e.nodes) : e.nodes.map(cloneNode)
    if (arc.length < 2) return null
    const len = e.nodes.length
    const provenance = arc.map((_, k) => interiorProvenance(ref.edge, ref.reversed ? len - 1 - k : k, ref.reversed))
    return { subPath: { nodes: arc, closed: true }, provenance }
  }

  const nodes: PathNode[] = []
  const prov: NodeProvenance[] = []
  for (const ref of loop) {
    const e = edges.get(ref.edge)
    if (!e) continue
    const arc = ref.reversed ? reverseEdgeNodes(e.nodes) : e.nodes.map(cloneNode)
    if (arc.length === 0) continue
    const len = e.nodes.length
    let start = 0
    const last = nodes[nodes.length - 1]
    if (last && samePoint(last, arc[0])) {
      // Shared junction anchor: keep the previous node, give it this arc's hOut,
      // and mark its provenance as a junction whose hOut belongs to this edge.
      last.hOut = clone(arc[0].hOut)
      const pv = prov[prov.length - 1]
      pv.vertexId = vid(ref.reversed ? e.endVertex : e.startVertex)
      pv.outHandle = { edgeId: ref.edge, edgeNodeIdx: ref.reversed ? len - 1 : 0, which: ref.reversed ? 'in' : 'out' }
      start = 1
    }
    for (let i = start; i < arc.length; i++) {
      nodes.push(arc[i])
      prov.push(interiorProvenance(ref.edge, ref.reversed ? len - 1 - i : i, ref.reversed))
    }
  }
  // Close: the trailing junction anchor duplicates the first node — fold it in.
  // nodes[0] becomes the wrap junction: it keeps its own hOut (departing edge) but
  // inherits the trailing node's hIn (arriving edge) and vertex.
  if (nodes.length > 1 && samePoint(nodes[0], nodes[nodes.length - 1])) {
    const tail = nodes.pop()!
    const tailProv = prov.pop()!
    nodes[0].hIn = clone(tail.hIn)
    prov[0].inHandle = tailProv.inHandle
    const firstE = edges.get(prov[0].edgeId)
    prov[0].vertexId = firstE ? vid(prov[0].reversed ? firstE.endVertex : firstE.startVertex) : prov[0].vertexId
  }
  if (nodes.length < 2) return null
  return { subPath: { nodes, closed: true }, provenance: prov }
}

/**
 * Build one region's `subPaths` from its edge-ref loops. Loops are assumed
 * already oriented for nonzero (outer CCW, holes CW), so this is a forward
 * concatenation and node order matches loop order, which the editor relies on
 * to map a node hit back to its edge.
 */
export function materializeRegion(loops: EdgeRef[][], edges: Map<number, SharedEdge>): SubPath[] {
  const subPaths: SubPath[] = []
  for (const loop of loops) {
    const m = materializeLoop(loop, edges)
    if (m) subPaths.push(m.subPath)
  }
  return subPaths
}

/**
 * Like {@link materializeRegion}, but also returns each node's
 * {@link NodeProvenance}, aligned 1:1 with `subPaths[sub].nodes[idx]`. Uses the
 * same walk, so the two cannot drift.
 */
export function materializeRegionWithProvenance(
  loops: EdgeRef[][],
  edges: Map<number, SharedEdge>,
): { subPaths: SubPath[]; provenance: NodeProvenance[][] } {
  const subPaths: SubPath[] = []
  const provenance: NodeProvenance[][] = []
  for (const loop of loops) {
    const m = materializeLoop(loop, edges)
    if (m) {
      subPaths.push(m.subPath)
      provenance.push(m.provenance)
    }
  }
  return { subPaths, provenance }
}

/** Provenance for a topological PathItem (null when it has no loops/topology). */
export function regionProvenance(doc: EditableDoc, item: PathItem): NodeProvenance[][] | null {
  if (!item.loops || !doc.topology) return null
  return materializeRegionWithProvenance(item.loops, edgeMap(doc.topology)).provenance
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
