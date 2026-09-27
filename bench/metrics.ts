// Usefulness + determinism metrics for the vectorization scoreboard (plan §5).
//
// Usefulness: path / node / gradient counts. Determinism: a canonical hash of
// the doc, so a byte-identical re-run can be asserted. Plus the planar topology
// metrics (junction clusters, boundary jaggedness).
//
// FIDELITY (render vs source: ΔE, SSIM, the seam score) moved to
// src/lib/render/fidelity.ts when the studio started showing the number — a score
// a user reads off the status bar is no longer harness-only, and two copies of it
// would make "1.8 ΔE" on screen and "1.8 ΔE" in the benchmark table two different
// claims. Re-exported here unchanged for the harness's existing imports, exactly
// as raster.ts shims the rasterizer.
//
// All pure: no DOM, no Node APIs. serializeDoc/docStats are themselves pure
// string work, so they run here under `node --test` unchanged.

import type { EditableDoc, GradientFill, PathNode } from '../src/lib/path/types.ts'
import { serializeDoc, docStats } from '../src/lib/path/model.ts'
import { segmentControls, segmentCount, cubicAt } from '../src/lib/path/geometry.ts'

export { fidelity, type FidelityMetrics } from '../src/lib/render/fidelity.ts'

export interface UsefulnessMetrics {
  paths: number
  nodes: number
  gradients: number
}

// ---------------------------------------------------------------------------
// Topology metrics (planar shared-edge graph quality)
// ---------------------------------------------------------------------------

export interface TopologyMetrics {
  /** Junction vertices in the shared-edge graph (0 when the doc carries none). */
  junctions: number
  /**
   * Clusters of ≥2 junction vertices within 3px of each other — a rasterized
   * crossing that failed to resolve into one point (bloom's X lands as
   * near-coincident degree-3 junctions joined by micro-edges). 0 on clean output.
   */
  junctionClusters: number
  /** Largest pairwise distance (px) inside any such cluster; 0 when none. */
  clusterSpanMax: number
  /**
   * Mean absolute turn per unit length (deg/px) over the boundary curves —
   * a posterization staircase or noisy band frontier scores high, smooth fitted
   * arcs low (a circle of radius r scores ≈ 57.3/r). Measured on the shared-edge
   * graph when present (each boundary counted ONCE), else on the items' subpaths.
   */
  jaggedness: number
}

/** Radius (px) within which two junction vertices count as one unresolved cluster. */
const JUNCTION_CLUSTER_R = 3

function polylineTurnStats(pts: { x: number; y: number }[], closed: boolean): { turnDeg: number; length: number } {
  let turnDeg = 0
  let length = 0
  const dirs: { x: number; y: number }[] = []
  const limit = closed ? pts.length : pts.length - 1
  for (let i = 0; i < limit; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l = Math.hypot(dx, dy)
    if (l < 1e-9) continue
    length += l
    dirs.push({ x: dx / l, y: dy / l })
  }
  const joins = closed ? dirs.length : dirs.length - 1
  for (let i = 0; i < joins; i++) {
    const d1 = dirs[i]
    const d2 = dirs[(i + 1) % dirs.length]
    const cos = Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y))
    turnDeg += (Math.acos(cos) * 180) / Math.PI
  }
  return { turnDeg, length }
}

function flattenNodes(nodes: PathNode[], closed: boolean, perSeg = 8): { x: number; y: number }[] {
  const sp = { nodes, closed }
  const count = segmentCount(sp)
  const pts: { x: number; y: number }[] = []
  for (let seg = 0; seg < count; seg++) {
    const { p0, c1, c2, p3 } = segmentControls(sp, seg)
    for (let k = 0; k < perSeg; k++) pts.push(cubicAt(p0, c1, c2, p3, k / perSeg))
  }
  if (!closed && nodes.length > 0) {
    const last = nodes[nodes.length - 1]
    pts.push({ x: last.x, y: last.y })
  }
  return pts
}

/** Junction-cluster + boundary-jaggedness quality of a traced doc (see fields). */
export function topologyMetrics(doc: EditableDoc): TopologyMetrics {
  const verts = doc.topology?.vertices ?? []
  // single-linkage clusters of junction vertices within JUNCTION_CLUSTER_R
  const parent = verts.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < verts.length; i++)
    for (let j = i + 1; j < verts.length; j++) {
      if (Math.hypot(verts[i].x - verts[j].x, verts[i].y - verts[j].y) <= JUNCTION_CLUSTER_R) {
        const a = find(i)
        const b = find(j)
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
      }
    }
  const members = new Map<number, number[]>()
  for (let i = 0; i < verts.length; i++) {
    const r = find(i)
    let arr = members.get(r)
    if (!arr) members.set(r, (arr = []))
    arr.push(i)
  }
  let junctionClusters = 0
  let clusterSpanMax = 0
  for (const arr of members.values()) {
    if (arr.length < 2) continue
    junctionClusters++
    for (let i = 0; i < arr.length; i++)
      for (let j = i + 1; j < arr.length; j++) {
        const a = verts[arr[i]]
        const b = verts[arr[j]]
        clusterSpanMax = Math.max(clusterSpanMax, Math.hypot(a.x - b.x, a.y - b.y))
      }
  }

  // jaggedness — over shared edges when the doc carries the graph (each boundary
  // once), otherwise over every visible path item's subpaths.
  //
  // NOT directly comparable across the two branches: the subpaths fallback walks each
  // region's CLOSED loop, so (a) an interior boundary shared by two regions is counted
  // TWICE and (b) the turn at every junction CORNER between edges is included — whereas
  // the topology branch flattens each open edge in isolation (shared boundary once, no
  // junction-corner turn). The double-count roughly cancels in the turn/len RATIO, but
  // the extra junction turns bias the fallback higher. So compare jaggedness only WITHIN
  // one engine/branch (the golden corpus is all planar ⇒ topology branch throughout).
  let turn = 0
  let len = 0
  if (doc.topology && doc.topology.edges.length > 0) {
    for (const e of doc.topology.edges) {
      if (e.nodes.length < 2) continue
      const s = polylineTurnStats(flattenNodes(e.nodes, e.closed), e.closed)
      turn += s.turnDeg
      len += s.length
    }
  } else {
    for (const item of doc.items) {
      if (item.kind !== 'path' || !item.visible) continue
      for (const sp of item.subPaths) {
        if (sp.nodes.length < 2) continue
        const s = polylineTurnStats(flattenNodes(sp.nodes, sp.closed), sp.closed)
        turn += s.turnDeg
        len += s.length
      }
    }
  }
  return {
    junctions: verts.length,
    junctionClusters,
    clusterSpanMax,
    jaggedness: len > 0 ? turn / len : 0,
  }
}

/** Path / node counts (via docStats) plus distinct gradient paint-server count. */
export function usefulness(doc: EditableDoc): UsefulnessMetrics {
  const s = docStats(doc)
  const grads = new Set<GradientFill>()
  for (const item of doc.items) {
    if (item.kind === 'path' && item.visible && item.gradient) grads.add(item.gradient)
  }
  return { paths: s.paths, nodes: s.nodes, gradients: grads.size }
}

/** Canonical, high-precision serialization used for the determinism check. */
export function canonicalDoc(doc: EditableDoc): string {
  return serializeDoc(doc, 6)
}

/** FNV-1a hash of the canonical doc string (compact determinism fingerprint). */
export function hashDoc(doc: EditableDoc): string {
  const str = canonicalDoc(doc)
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
