// Junction-cluster weld machinery — since 2026-07-21 consumed ONLY by the §10.4
// evidence-gated converged-pair weld (planarReseat.weldConvergedJunctions), via the
// `eligible` filter. The old per-trace blanket flag (`PlanarFitOptions.weldJunctions`,
// contract EVERY ≤radius micro-edge, off by default) was REMOVED the same day:
// re-measured against the §10.4 tracer it newly crossed two tier-2 gates
// (peanuts/custard boundary) and DEGRADED its own target cases (bloom p95 0.41→0.63,
// overlap 0.41→0.46) — running before the junction re-seat, its blind centroid
// fusion preempts the primitive-intersection correction that now handles crossings
// better. docs/vectorization-benchmarks.md §10.4 has the numbers; §9.3 has the
// original beverage-box case for why bare shortness was never enough evidence.
//
// The physics is unchanged: a degree-4 crossing in the source (bloom's X, two
// boundaries crossing at a point) almost never rasterizes to ONE degree-4 lattice
// corner — AA + posterization split it into 2+ near-coincident degree-3 junctions
// joined by 1–3px micro-edges (and an occluded crossing is *structurally* a tiny
// quad of degree-3 Ts). The planar graph traces those micro-edges faithfully, so
// the crossing renders as a tiny jog/notch that pops at zoom, and the vertices that
// "should" be one point never merge.
//
// `weldJunctionClusters` contracts every OPEN edge whose two endpoints are distinct
// junction vertices and whose fitted arc is no longer than the weld radius (further
// narrowed by `eligible` when given):
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
// Mutates vertices/edges/loops in place (the §10.4 caller owns all three).
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
 * result = graph untouched). `width`/`height` are the image bounds — a fused cluster
 * that includes a frame junction is kept ON that frame edge so the boundary stays
 * full-bleed. `eligible` optionally narrows the candidate set beyond shortness
 * (the §10.4 converged-pair weld passes a re-seat-evidence filter); omitted ⇒
 * every short-enough micro-edge is a candidate (the experimental blanket weld).
 */
export function weldJunctionClusters(
  vertices: Vertex[],
  edges: SharedEdge[],
  loopsByLabel: Map<number, EdgeRef[][]>,
  width: number,
  height: number,
  radius: number,
  eligible?: (e: SharedEdge) => boolean,
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
    if (eligible && !eligible(e)) continue
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
  for (const e of candidates) union(e.startVertex!, e.endVertex!)

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
  // Fuse a cluster ONLY when it is a tight local knot (a rasterized crossing). The
  // union-find is transitive over ≤radius micro-edges, so a noisy/textured patch —
  // where junctions sit within radius all across it — would otherwise chain into ONE
  // cluster and collapse a whole region to a point, dragging even border vertices to
  // the centroid. Bounding the cluster's pairwise SPAN keeps the weld a local crossing
  // merge; an over-spread cluster is left untouched (its micro-edges survive), the safe
  // pre-weld fallback.
  const spanCap = radius * 2
  // A cluster whose fusion would pinch together the two endpoints of a LONG edge is
  // not a rasterized crossing — it is the NECK of a lollipop: a region attached to
  // the graph through one narrow gap, whose outline runs junction-to-junction the
  // long way round (beverage-box-flat's straw: 129px outline over a 2.8px neck @256,
  // 5.6px @512 — the §10.4 weld deleted the whole region at BOTH resolutions, §12).
  // Contracting the neck then either deletes the outline from every loop (the old
  // removal — the region silently vanishes from the doc, since index.ts skips a
  // label whose loops are gone) or drags both of its ends onto one point (a pinch
  // that collapses the region to a sliver). Neither is a weld; skip fusing the
  // cluster and leave its micro-edges as real edges — the same safe fallback the
  // over-spread rule above uses. A true crossing is unaffected: its second edge
  // between the fused pair is itself micro (§10.4's lens tips).
  const rootOf = new Map<number, number>()
  for (const v of parent.keys()) rootOf.set(v, find(v))
  const poisoned = new Set<number>()
  for (const e of edges) {
    if (e.closed || e.startVertex == null || e.endVertex == null) continue
    const rs = rootOf.get(e.startVertex)
    if (rs === undefined || rs !== rootOf.get(e.endVertex)) continue
    if (edgeLength(e) > radius) poisoned.add(rs)
  }
  const target = new Map<number, { x: number; y: number }>() // vertex id → fused position
  const fusedRoots = new Set<number>()
  for (const [root, members] of [...clusters.entries()].sort((a, b) => a[0] - b[0])) {
    if (members.length < 2) continue
    if (poisoned.has(root)) continue // a lollipop neck, not a crossing — leave it
    members.sort((a, b) => a - b)
    const live = members.map((id) => byId.get(id)).filter((v): v is Vertex => v != null)
    if (live.length < 2) continue
    let span = 0
    let sx = 0
    let sy = 0
    for (let i = 0; i < live.length; i++) {
      sx += live[i].x
      sy += live[i].y
      for (let j = i + 1; j < live.length; j++) span = Math.max(span, Math.hypot(live[i].x - live[j].x, live[i].y - live[j].y))
    }
    if (span > spanCap) continue // too spread to be a single crossing — leave it
    let cx = sx / live.length
    let cy = sy / live.length
    // A cluster that includes a frame junction stays ON the frame: moving it inward
    // would pull the region's boundary off the image edge, opening a sliver gap where
    // it should bleed to the border. Clamp each axis to any frame edge a member sits on.
    for (const v of live) {
      if (v.x <= 0) cx = 0
      else if (v.x >= width) cx = width
      if (v.y <= 0) cy = 0
      else if (v.y >= height) cy = height
    }
    fusedRoots.add(root)
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
  // Contract only the micro-edges inside a FUSED cluster; those in a rejected
  // (over-spread) cluster stay as real edges, so a noisy patch is left as-is.
  for (const e of candidates) if (fusedRoots.has(find(e.startVertex!))) removedEdges.add(e.id)
  if (fused.size === 0) return { fused, removedEdges }

  // --- drop the contracted micro-edges, re-anchor every survivor on the fused vertex
  const survivorOf = (v: number | null | undefined): number | null =>
    v == null ? null : fused.get(v) ?? v
  let w = 0
  for (const e of edges) {
    if (removedEdges.has(e.id)) continue
    if (!e.closed) {
      // An edge whose BOTH endpoints fuse into the SAME survivor collapses to a
      // self-loop (start===end — a zero-length degenerate when it had no interior).
      // Contract it too, exactly like a micro-edge: leaving a start===end open edge
      // in the graph would strand snapCoCircularLoops (it keys arcs on the endpoints)
      // and the node editor. Excised from every loop below. Only MICRO edges can
      // reach this branch: a cluster that would pinch a LONG edge's endpoints
      // together is a lollipop neck and its fuse was vetoed above (`poisoned`).
      const sFused = e.startVertex != null && fused.has(e.startVertex)
      const eFused = e.endVertex != null && fused.has(e.endVertex)
      if ((sFused || eFused) && survivorOf(e.startVertex) === survivorOf(e.endVertex)) {
        removedEdges.add(e.id)
        continue
      }
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
