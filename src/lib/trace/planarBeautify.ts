// Phase 6 of the planar tracer: edge-level beautify. Restores the circle /
// ellipse / line snapping that the loop-level `beautify.ts` provides for the
// crisp / potrace engines but which the planar engine deliberately skips —
// beautify moves each loop's vertices independently, which would desync the
// byte-coincident geometry two regions share on a boundary.
//
// The planar model makes snapping EASIER, not harder: a boundary is ONE shared
// edge by construction, so snapping the edge once propagates to BOTH adjacent
// regions automatically (they re-materialize from the same canonical nodes),
// with zero desync risk. This pass runs at trace time on `topology.edges`,
// BEFORE per-region materialization.
//
// Every snap reuses the SAME math as beautify.ts (lifted into `circleFit.ts`):
// circle/ellipse fit, kappa-Bézier emit, and the concentric / equal-radius
// relation solver — there is no forked copy. Each snap is gated on the user
// fidelity tolerance against the edge's RAW flattened fitted arc, exactly as
// beautify.ts gates. Pure & deterministic (fixed edge/cluster order, no PRNG /
// Date): `fidelity ≤ 0` is a pure no-op (the input topology is returned
// unchanged), so planar output stays byte-identical to the unbeautified trace.

import type { EdgeRef, PathNode, SharedEdge, Topology, Vec } from '../path/types'
import type { BeautifyOptions } from './beautify.ts'
import {
  anchorSignedArea,
  fitCircle,
  fitEllipse,
  flatten,
  makeCircleSubPath,
  makeEllipseSubPath,
  maxEllipseDev,
  maxRadialDev,
  perpDistance,
  relationSolveCircles,
  type RelationCircle,
} from './circleFit.ts'

const cloneVec = (v: Vec | null): Vec | null => (v ? { x: v.x, y: v.y } : null)
const cloneNode = (n: PathNode): PathNode => ({ x: n.x, y: n.y, hIn: cloneVec(n.hIn), hOut: cloneVec(n.hOut), kind: n.kind })
const cloneEdge = (e: SharedEdge): SharedEdge => ({ ...e, nodes: e.nodes.map(cloneNode) })

/** A disc-edge circle the relation solver may reconcile; carries its owning edge
 *  index + winding so the snapped 4-node circle can be regenerated after a move. */
interface DiscCircle extends RelationCircle {
  edgeIdx: number
  positive: boolean
}

/**
 * Snap the shared edges of a planar topology to primitives where the fit is
 * tight enough, returning a NEW topology (vertices unchanged). Reuses
 * `circleFit.ts` throughout. `loopsByLabel` is accepted for symmetry with the
 * trace output (and any future single-edge-loop heuristics); a disc edge is
 * already identified by `closed === true`.
 *
 *   1a. Disc edges (closed) → circle / ellipse, oriented to the edge's existing
 *       winding so both the disc region and its surrounding field inherit it.
 *   1b. Open edges (junction→junction) whose arc is near-straight → exactly two
 *       corner nodes at the UNCHANGED junction endpoints (pinned, handles
 *       dropped) so the planar graph stays welded.
 *   1c. Concentric-centre / equal-radius relation solver across the disc circles
 *       (each adjustment re-gated against that circle's RAW flattened arc).
 *
 * `fidelity ≤ 0` ⇒ the input topology is returned unchanged (pure no-op).
 */
export function planarBeautify(
  topo: Topology,
  loopsByLabel: Map<number, EdgeRef[][]>,
  opts: BeautifyOptions,
): Topology {
  void loopsByLabel
  const fid = opts.fidelity
  if (!(fid > 0)) return topo

  // Work on an immutable copy so the input topology is never mutated.
  const edges = topo.edges.map(cloneEdge)
  // Relation-solver detection window scales with the document bbox long side.
  const longSide = bboxLongSide(topo.edges)

  const discCircles: DiscCircle[] = []

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    if (e.nodes.length < 2) continue

    if (e.closed) {
      // --- 1a. Disc edge → circle / ellipse --------------------------------
      const raw = flatten({ nodes: e.nodes, closed: true })
      const positive = anchorSignedArea(e.nodes) > 0

      const circle = fitCircle(raw)
      if (circle && circle.r > 2 * fid && maxRadialDev(raw, circle) <= fid) {
        e.nodes = makeCircleSubPath(circle.cx, circle.cy, circle.r, positive).nodes
        discCircles.push({ edgeIdx: i, positive, cx: circle.cx, cy: circle.cy, r: circle.r, raw })
        continue
      }

      const ell = fitEllipse(raw)
      if (ell && Math.min(ell.rx, ell.ry) > 2 * fid && maxEllipseDev(raw, ell) <= fid) {
        e.nodes = makeEllipseSubPath(ell.cx, ell.cy, ell.rx, ell.ry, positive).nodes
      }
      continue
    }

    // --- 1b. Open edge → straight line ------------------------------------
    // Replace the fitted arc with the straight chord between its two PINNED
    // junction endpoints when every interior sample lies within fidelity of it.
    // The endpoints are kept byte-exact so every other edge meeting at those
    // junctions stays welded; both adjacent regions inherit the same chord.
    const a = e.nodes[0]
    const b = e.nodes[e.nodes.length - 1]
    const raw = flatten({ nodes: e.nodes, closed: false })
    let maxDev = 0
    for (const p of raw) {
      const d = perpDistance(p, a, b)
      if (d > maxDev) maxDev = d
    }
    if (maxDev <= fid) {
      e.nodes = [
        { x: a.x, y: a.y, hIn: null, hOut: null, kind: 'corner' },
        { x: b.x, y: b.y, hIn: null, hOut: null, kind: 'corner' },
      ]
    }
  }

  // --- 1c. Relation solver over the disc circles ---------------------------
  if (discCircles.length >= 2) {
    const changed = relationSolveCircles(discCircles, opts, longSide)
    for (let i = 0; i < discCircles.length; i++) {
      if (!changed[i]) continue
      const c = discCircles[i]
      edges[c.edgeIdx].nodes = makeCircleSubPath(c.cx, c.cy, c.r, c.positive).nodes
    }
  }

  // Vertices are never moved by this pass, but copy them so the returned
  // topology is fully independent of the input (honours the "new topology"
  // contract: a later mutation of the input cannot leak into the output).
  return { vertices: topo.vertices.map((v) => ({ ...v })), edges }
}

/** Long side of the bbox over every edge node anchor (the relation-solver scale). */
function bboxLongSide(edges: SharedEdge[]): number {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const e of edges) {
    for (const n of e.nodes) {
      if (n.x < minX) minX = n.x
      if (n.x > maxX) maxX = n.x
      if (n.y < minY) minY = n.y
      if (n.y > maxY) maxY = n.y
    }
  }
  if (minX === Infinity) return 0
  return Math.max(maxX - minX, maxY - minY)
}
