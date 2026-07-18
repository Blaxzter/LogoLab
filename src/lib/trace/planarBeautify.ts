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

import type { EdgeRef, PathNode, SharedEdge, Topology, Vec, Vertex } from '../path/types'
import type { BeautifyOptions } from './beautify.ts'
import { reverseEdgeNodes } from '../path/topology.ts'
import {
  anchorSignedArea,
  arcSlice,
  type Circle,
  fitCircle,
  fitEllipse,
  flatten,
  makeCircleSubPath,
  makeEllipseSubPath,
  maxEllipseDev,
  maxEllipseToPolyDev,
  maxRadialDev,
  perpDistance,
  relationSolveCircles,
  type RelationCircle,
} from './circleFit.ts'

const cloneVec = (v: Vec | null): Vec | null => (v ? { x: v.x, y: v.y } : null)
const cloneNode = (n: PathNode): PathNode => ({ x: n.x, y: n.y, hIn: cloneVec(n.hIn), hOut: cloneVec(n.hOut), kind: n.kind })
const cloneEdge = (e: SharedEdge): SharedEdge => ({ ...e, nodes: e.nodes.map(cloneNode) })

/**
 * A circle/ellipse snap is accepted on max RADIAL deviation alone, which is a purely
 * SIZE-relative test: a tiny axis-aligned square deviates from its best-fit circle by
 * well under a pixel (an 8px checker cell: ~0.83px < the 1.5px fidelity), so the disc
 * and co-circular snaps would "round" it into a blob — the fine-checkerboard scalloping
 * (docs/vectorization-benchmarks.md §0 #7, §8.2). Radial deviation cannot see that,
 * because a square IS radially close to a circle at small scale; its TURNING can — a
 * circle bends a few degrees per flatten step while a polygon spikes 90° at each corner.
 * So every circle/ellipse snap is additionally gated on the loop having no corner sharper
 * than this. A real ring split into arcs meets its junctions near-straight (the "pull" is
 * a few degrees), far below the threshold, so genuine round art is unaffected.
 */
const CORNER_TURN = Math.PI / 3 // 60°: veto the circle/ellipse snap past this turn

/**
 * Largest turn angle (radians) between consecutive segments of a flattened loop.
 * Collinear runs (a straight edge's 16 samples) contribute 0; a corner contributes
 * its exterior angle. Zero-length steps are skipped so coincident junction samples
 * don't blind the test. `poly` is treated as closed.
 */
function maxTurnRad(poly: Vec[]): number {
  const dirs: Vec[] = []
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % n]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (len > 1e-6) dirs.push({ x: dx / len, y: dy / len })
  }
  const m = dirs.length
  if (m < 2) return 0
  let maxA = 0
  for (let i = 0; i < m; i++) {
    const d0 = dirs[i]
    const d1 = dirs[(i + 1) % m]
    let dot = d0.x * d1.x + d0.y * d1.y
    dot = dot > 1 ? 1 : dot < -1 ? -1 : dot
    const a = Math.acos(dot)
    if (a > maxA) maxA = a
  }
  return maxA
}

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
  arcSnap = true,
): Topology {
  const fid = opts.fidelity
  if (!(fid > 0)) return topo

  // Work on immutable copies so the input topology is never mutated.
  const edges = topo.edges.map(cloneEdge)
  const vertices = topo.vertices.map((v) => ({ ...v }))
  // Relation-solver detection window scales with the document bbox long side.
  const longSide = bboxLongSide(topo.edges)

  // 1d — co-circular OPEN-arc loops (a ring split into arcs by band junctions) →
  // fit the whole loop to ONE circle, radial-snap its junction vertices onto that
  // circle, and re-emit each arc as a true circular slice. This is what removes the
  // "pull"/kink the user sees where colour bands meet a white ring: the arcs share
  // the circle's tangent at every junction (G¹) instead of meeting as forced,
  // independently-fitted corners. Runs FIRST on the raw fitted arcs; the edges it
  // snaps skip the per-edge 1a/1b passes below.
  const arcSnapped = arcSnap ? snapCoCircularLoops(edges, vertices, loopsByLabel, fid) : new Set<number>()

  const discCircles: DiscCircle[] = []

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    if (e.nodes.length < 2 || arcSnapped.has(e.id)) continue

    if (e.closed) {
      // --- 1a. Disc edge → circle / ellipse --------------------------------
      const raw = flatten({ nodes: e.nodes, closed: true })
      const positive = anchorSignedArea(e.nodes) > 0
      // A sharp-cornered loop is a polygon, not a disc — never round it (a small
      // square is radially circle-close but turns 90° at its corners). See CORNER_TURN.
      const cornered = maxTurnRad(raw) >= CORNER_TURN

      const circle = fitCircle(raw)
      if (!cornered && circle && circle.r > 2 * fid && maxRadialDev(raw, circle) <= fid) {
        e.nodes = makeCircleSubPath(circle.cx, circle.cy, circle.r, positive).nodes
        discCircles.push({ edgeIdx: i, positive, cx: circle.cx, cy: circle.cy, r: circle.r, raw })
        continue
      }

      const ell = fitEllipse(raw)
      // BOTH directions must hold: maxEllipseDev (polygon→ellipse) is blind to
      // the ellipse bulging into space the polygon never visits — see
      // maxEllipseToPolyDev (a 6px bar "fits" a 3.8×278 ellipse otherwise).
      if (
        !cornered && ell && Math.min(ell.rx, ell.ry) > 2 * fid &&
        maxEllipseDev(raw, ell) <= fid && maxEllipseToPolyDev(raw, ell) <= fid
      ) {
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

  // Vertices moved by 1d's radial snap (if any) are carried in `vertices`; every
  // other vertex is an independent copy of the input (honours the "new topology"
  // contract: a later mutation of the input cannot leak into the output).
  return { vertices, edges }
}

// ---------------------------------------------------------------------------
// 1d — co-circular open-arc loop snap
// ---------------------------------------------------------------------------

/** Move a node's anchor to (x, y), carrying its handles by the same delta. */
function shiftNodeTo(n: PathNode, x: number, y: number): void {
  const dx = x - n.x
  const dy = y - n.y
  n.x = x
  n.y = y
  if (n.hIn) { n.hIn.x += dx; n.hIn.y += dy }
  if (n.hOut) { n.hOut.x += dx; n.hOut.y += dy }
}

/**
 * Snap every region loop that is a full circle (a ring's outer/inner boundary split
 * into open arcs by the junctions where other regions meet it) to ONE fitted circle.
 * For each such loop: radial-snap its junction vertices onto the circle (moving every
 * incident edge endpoint — ring arcs AND the T-ing spokes — so the graph stays welded
 * and byte-coincident), then re-emit each of its open edges as a circular-arc slice
 * pinned at those junctions. Both regions on each edge inherit the slice. Returns the
 * set of edge ids it re-emitted, so the per-edge passes leave them alone. Gated on
 * `fid`: the loop must fit a circle within fidelity (radius > 2·fid), exactly as the
 * disc snap (1a) gates. Mutates `edges` / `vertices` in place.
 */
function snapCoCircularLoops(
  edges: SharedEdge[],
  vertices: Vertex[],
  loopsByLabel: Map<number, EdgeRef[][]>,
  fid: number,
): Set<number> {
  const snapped = new Set<number>()
  const byId = new Map<number, SharedEdge>()
  for (const e of edges) byId.set(e.id, e)
  const vById = new Map<number, Vertex>()
  for (const v of vertices) vById.set(v.id, v)

  // Assign each open ring edge + its endpoint vertices to the circle of the first
  // circular loop that claims them (a vertex/edge lies on at most one such circle).
  const edgeCircle = new Map<number, Circle>()
  const vertCircle = new Map<number, Circle>()
  for (const loops of loopsByLabel.values()) {
    for (const loop of loops) {
      if (loop.length < 2) continue // a single closed-loop edge is a disc — 1a's job
      let ok = true
      let hasOpen = false
      const raw: Vec[] = []
      for (const ref of loop) {
        const e = byId.get(ref.edge)
        if (!e || e.nodes.length < 2) { ok = false; break }
        if (!e.closed) hasOpen = true
        const arc = ref.reversed ? reverseEdgeNodes(e.nodes) : e.nodes
        for (const p of flatten({ nodes: arc, closed: e.closed })) raw.push(p)
      }
      if (!ok || !hasOpen || raw.length < 8) continue
      // A loop that turns a sharp corner is a polygon (a checker cell's 4 right
      // angles), not a ring split into arcs — snapping it to a circle is the
      // fine-checkerboard scalloping. Radial deviation is blind to it at small scale;
      // turning is not. See CORNER_TURN.
      if (maxTurnRad(raw) >= CORNER_TURN) continue
      const c = fitCircle(raw)
      if (!c || c.r <= 2 * fid || maxRadialDev(raw, c) > fid) continue
      for (const ref of loop) {
        const e = byId.get(ref.edge)!
        if (e.closed) continue
        if (!edgeCircle.has(e.id)) edgeCircle.set(e.id, c)
        if (e.startVertex != null && e.startVertex >= 0 && !vertCircle.has(e.startVertex)) vertCircle.set(e.startVertex, c)
        if (e.endVertex != null && e.endVertex >= 0 && !vertCircle.has(e.endVertex)) vertCircle.set(e.endVertex, c)
      }
    }
  }
  if (edgeCircle.size === 0) return snapped

  // Radial-snap each claimed vertex onto its circle, moving EVERY incident edge
  // endpoint with it (ring arcs get overwritten below; spokes keep this, so no seam).
  for (const [vid, c] of vertCircle) {
    const v = vById.get(vid)
    if (!v) continue
    const dx = v.x - c.cx
    const dy = v.y - c.cy
    const d = Math.hypot(dx, dy) || 1
    const nx = c.cx + (c.r * dx) / d
    const ny = c.cy + (c.r * dy) / d
    v.x = nx
    v.y = ny
    for (const e of edges) {
      if (e.startVertex === vid) shiftNodeTo(e.nodes[0], nx, ny)
      if (e.endVertex === vid) shiftNodeTo(e.nodes[e.nodes.length - 1], nx, ny)
    }
  }

  // Re-emit each ring arc as a circular slice between its (snapped) junction endpoints.
  for (const [eid, c] of edgeCircle) {
    const e = byId.get(eid)!
    const from = { x: e.nodes[0].x, y: e.nodes[0].y }
    const to = { x: e.nodes[e.nodes.length - 1].x, y: e.nodes[e.nodes.length - 1].y }
    const fl = flatten({ nodes: e.nodes, closed: false })
    const mid = fl[Math.floor(fl.length / 2)] ?? { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
    e.nodes = arcSlice(c.cx, c.cy, c.r, from, to, mid)
    snapped.add(eid)
  }
  return snapped
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
