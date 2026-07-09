// Junction-cluster weld (experimental, `PlanarFitOptions.weldJunctions` px, 0 = off).
//
// A degree-4 crossing in the source (bloom's X, two boundaries crossing at a point)
// almost never rasterizes to ONE degree-4 lattice corner: AA + posterization split it
// into 2+ near-coincident degree-3 junctions joined by 1–3px micro-edges (and an
// occluded crossing is *structurally* a tiny quad of degree-3 Ts). The planar graph
// traces those micro-edges faithfully, so the crossing renders as a tiny jog/notch
// that pops at zoom, and the vertices that "should" be one point never merge.
//
// `weldJunctionClusters` contracts every OPEN edge whose two endpoints are distinct
// junction vertices and whose fitted arc is no longer than the weld radius:
//  • the endpoint vertices union into a cluster; each cluster fuses into its
//    lowest-id vertex, placed at the cluster centroid;
//  • every surviving incident edge re-anchors on the fused vertex (terminal anchor
//    moved, handles carried by the same delta — the shiftNodeTo pattern), so the
//    graph stays welded and both regions on each edge stay byte-coincident;
//  • the contracted micro-edges are dropped from the edge table and excised from
//    every region loop; loops emptied by the excision (micro-faces — e.g. the
//    occlusion quad itself) are dropped, and their label vanishes if that was its
//    last loop. Neighbouring refs then chain endpoint-coincident through the fused
//    vertex, so materializeLoop merges them into ONE anchor at the crossing.
//
// Mutates the trace in place (called from assemblePlanar on freshly-built arrays).
// Deterministic: candidates scan in edge order, clusters fuse to the lowest vertex
// id, centroid is an unweighted mean over member ids ascending.

import type { EdgeRef, PathNode, SharedEdge, Vertex } from '../path/types'
import { cubicAt, segmentControls, segmentCount } from '../path/geometry.ts'

/** Arc length of a fitted edge, sampled like the assembler's loop flattener. */
function edgeLength(e: SharedEdge): number {
  const sp = { nodes: e.nodes, closed: false }
  const count = segmentCount(sp)
  let len = 0
  for (let seg = 0; seg < count; seg++) {
    const { p0, c1, c2, p3 } = segmentControls(sp, seg)
    let prev = p0
    for (let k = 1; k <= 6; k++) {
      const p = cubicAt(p0, c1, c2, p3, k / 6)
      len += Math.hypot(p.x - prev.x, p.y - prev.y)
      prev = p
    }
  }
  return len
}

/** Move a terminal node's anchor to (x,y), carrying its handles by the same delta. */
function shiftNode(n: PathNode, x: number, y: number): PathNode {
  const dx = x - n.x
  const dy = y - n.y
  return {
    ...n,
    x,
    y,
    hIn: n.hIn ? { x: n.hIn.x + dx, y: n.hIn.y + dy } : n.hIn,
    hOut: n.hOut ? { x: n.hOut.x + dx, y: n.hOut.y + dy } : n.hOut,
  }
}

export interface WeldResult {
  /** Vertices removed by fusing (old id → surviving id). */
  fused: Map<number, number>
  /** Ids of the contracted (removed) micro-edges. */
  removedEdges: Set<number>
}

/**
 * Contract micro-edges between near-coincident junction vertices. Mutates
 * `vertices`, `edges` and `loopsByLabel` in place; returns what moved (empty
 * result = graph untouched).
 */
export function weldJunctionClusters(
  vertices: Vertex[],
  edges: SharedEdge[],
  loopsByLabel: Map<number, EdgeRef[][]>,
  radius: number,
): WeldResult {
  const fused = new Map<number, number>()
  const removedEdges = new Set<number>()
  if (!(radius > 0)) return { fused, removedEdges }

  // --- collect contraction candidates: short open edges between two distinct junctions
  const candidates: SharedEdge[] = []
  for (const e of edges) {
    if (e.closed || e.startVertex == null || e.endVertex == null) continue
    if (e.startVertex === e.endVertex || e.startVertex < 0 || e.endVertex < 0) continue
    if (e.nodes.length < 2) continue
    if (edgeLength(e) <= radius) candidates.push(e)
  }
  if (candidates.length === 0) return { fused, removedEdges }

  // --- union-find the endpoint vertices of every candidate (lowest root wins)
  const parent = new Map<number, number>()
  const find = (v: number): number => {
    let r = v
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!
    // path compress
    let c = v
    while (parent.get(c) !== undefined && parent.get(c) !== c) {
      const next = parent.get(c)!
      parent.set(c, r)
      c = next
    }
    return r
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    const lo = Math.min(ra, rb)
    const hi = Math.max(ra, rb)
    parent.set(hi, lo)
    parent.set(lo, lo)
  }
  for (const e of candidates) {
    union(e.startVertex!, e.endVertex!)
    removedEdges.add(e.id)
  }

  // --- clusters → survivor (lowest id) at the members' centroid
  const byId = new Map<number, Vertex>()
  for (const v of vertices) byId.set(v.id, v)
  const clusters = new Map<number, number[]>()
  for (const v of parent.keys()) {
    const r = find(v)
    let arr = clusters.get(r)
    if (!arr) clusters.set(r, (arr = []))
    arr.push(v)
  }
  const target = new Map<number, { x: number; y: number }>() // vertex id → fused position
  for (const [root, members] of [...clusters.entries()].sort((a, b) => a[0] - b[0])) {
    if (members.length < 2) continue
    members.sort((a, b) => a - b)
    let sx = 0
    let sy = 0
    let n = 0
    for (const id of members) {
      const v = byId.get(id)
      if (!v) continue
      sx += v.x
      sy += v.y
      n++
    }
    if (n === 0) continue
    const cx = sx / n
    const cy = sy / n
    for (const id of members) {
      target.set(id, { x: cx, y: cy })
      if (id !== root) fused.set(id, root)
    }
    const sv = byId.get(root)
    if (sv) {
      sv.x = cx
      sv.y = cy
    }
  }
  if (fused.size === 0) {
    removedEdges.clear()
    return { fused, removedEdges }
  }

  // --- drop the contracted micro-edges, re-anchor every survivor on the fused vertex
  let w = 0
  for (const e of edges) {
    if (removedEdges.has(e.id)) continue
    if (!e.closed) {
      const sPos = e.startVertex != null ? target.get(e.startVertex) : undefined
      if (sPos) {
        e.nodes[0] = shiftNode(e.nodes[0], sPos.x, sPos.y)
        e.startVertex = fused.get(e.startVertex!) ?? e.startVertex
      }
      const ePos = e.endVertex != null ? target.get(e.endVertex) : undefined
      if (ePos) {
        e.nodes[e.nodes.length - 1] = shiftNode(e.nodes[e.nodes.length - 1], ePos.x, ePos.y)
        e.endVertex = fused.get(e.endVertex!) ?? e.endVertex
      }
    }
    edges[w++] = e
  }
  edges.length = w

  // --- excise the removed refs from every loop; drop emptied loops / labels
  for (const [label, loops] of loopsByLabel) {
    let lw = 0
    for (const loop of loops) {
      const kept = loop.filter((r) => !removedEdges.has(r.edge))
      if (kept.length === 0) continue
      kept.length === loop.length ? (loops[lw++] = loop) : (loops[lw++] = kept)
    }
    loops.length = lw
    if (loops.length === 0) loopsByLabel.delete(label)
  }

  // --- prune fused-away vertices (everything references vertices by id, not index)
  let vw = 0
  for (const v of vertices) {
    if (!fused.has(v.id)) vertices[vw++] = v
  }
  vertices.length = vw

  return { fused, removedEdges }
}
