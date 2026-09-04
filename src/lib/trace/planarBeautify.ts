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
import { reseatJunctions, type ChordObserver } from './planarReseat.ts'
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
/** §24 — an open edge needs this many flattened points before its own circle fit means
 *  anything; below it a two-anchor stub would join a family on noise. */
const FAMILY_MIN_PTS = 6
/** §24 — how closely two independently fitted arcs must agree, relative to the radius, to
 *  be the same ring. Generous on purpose: the disagreement being clustered over IS the
 *  error the snap removes. The family's own refit is the real acceptance test. */
const FAMILY_CLUSTER_REL = 0.06
/**
 * §24 — total angular sweep (radians) a family must cover. This is the guard that keeps
 * the pass from ASSERTING a circle it has not seen: several arcs are claimed to be one ring,
 * and that claim needs them to cover enough of the ring to be more than a guess. A ring cut
 * by crossings keeps most of its 2π by construction, so the bar can be high.
 *
 * CALIBRATED on the family census (`ringDiag --families`), both lanes @512. On the fixture
 * corpus every family the pass finds sweeps 285–358° — near-complete rings, as the mechanism
 * predicts. The gallery is a continuum from 45° up, and the low end is where the one measured
 * REGRESSION came from: at 0.6 rad (34°) the pass fired on `schild-flat` with two arcs
 * covering 65° together and took its worst seam from 68.5 to 77.4 ΔE. Half a turn admits
 * every fixture family and all eight of `olympic-rings`, and refuses the short pairs.
 */
const FAMILY_MIN_SPAN = Math.PI
/** §24 — grow rounds for a family. The first refit already lands sub-pixel, so two is
 *  enough in practice; the loop exits early the moment the membership settles. */
const FAMILY_GROW_ROUNDS = 3
/** §24 — how far a junction may travel to reach the intersection of the two circles that
 *  claim it. It is already within ~1px of both, so a bigger jump means the pairing is
 *  wrong and the radial snap is the safer answer (§10.4's MIN_MOVE lesson, from the other
 *  side: a junction move needs positive evidence, and a far intersection is not it). */
const JUNCTION_XING_MAX_MOVE = 3

/**
 * Snap-gate tuning passed down from the planar fit options (§10 prototype).
 *  • `arcSnap`      — run the co-circular open-arc loop snap (§1d).
 *  • `localScaleK`  — scale-relative fidelity coefficient. 0 ⇒ off (absolute px,
 *    the shipped behaviour). > 0 ⇒ each circle/ellipse/ring snap is accepted only
 *    within `min(fidelity, localScaleK · localScale)`, `localScale` = the fitted
 *    primitive's radius (its medial radius). See PlanarFitOptions.localScaleK.
 *  • `cornerVeto`   — apply the §9.8 corner-turn veto (never round a sharp-cornered
 *    loop). Default on; exposed so the scale-relative gate can be A/B'd without it.
 *  • `reseat`       — re-seat slid degree-3 junctions on the intersection of their
 *    incident fitted primitives (§10.4, planarReseat.ts). Default on.
 *  • `width`/`height` — raster size (px), used only by the re-seat border guard
 *    (a junction on the canvas frame must stay on the frame). Omitted ⇒ no guard.
 *  • `onReseat`     — out-sink: receives the ids of the vertices the re-seat
 *    moved. The converged-pair weld (§10.4, weldConvergedJunctions) keys on
 *    them, and it must run in the CALLER — contracting a micro-edge rewrites
 *    the region loops, which this function treats as read-only input.
 *  • `onChord`      — out-sink: one record per candidate the occluder-chord pass
 *    weighed, with the value each gate saw (chordDiag.ts / issue #14). Undefined
 *    in production, and the pass is byte-identical without it.
 *  • `onArcLoop`    — out-sink: one record per region loop the §1d co-circular snap
 *    weighed, naming the gate that declined it (ringDiag.ts / issue #10). Same
 *    contract: undefined in production, byte-identical without it.
 */
export interface SnapOptions {
  arcSnap?: boolean
  localScaleK?: number
  cornerVeto?: boolean
  reseat?: boolean
  width?: number
  height?: number
  onReseat?: (movedVertexIds: ReadonlySet<number>) => void
  onChord?: ChordObserver
  onArcLoop?: ArcLoopObserver
}

/**
 * One §1d co-circular candidate loop, and what stopped it. `verdict` names the FIRST gate
 * that declined, in evaluation order — that is the actionable fact (issue #10 asks "why
 * does the arc snap not hold on the olympic rings", and the answer is a gate name plus the
 * value it saw, not a guess).
 */
export interface ArcLoopRecord {
  label: number
  edges: number
  openEdges: number
  /** Fitted circle radius (px), when a circle could be fitted at all. */
  r: number
  /** Max radial deviation of the loop's flattened points from that circle (px). */
  radialDev: number
  /** Effective budget the deviation is compared against (fidelity, scale-relative if on). */
  budget: number
  /** Max turn along the loop (deg) — the corner veto's comparand, bar at 60. */
  turnDeg: number
  verdict:
    | 'snapped'
    | 'single-edge-loop'
    | 'carries-chord'
    | 'no-open-edge'
    | 'too-few-points'
    | 'corner-veto'
    | 'circle-fit-failed'
    | 'radius-too-small'
    | 'dev-exceeds-budget'
    /** §24 — not a loop verdict at all: one co-circular FAMILY of open edges, clustered
     *  across the whole topology and snapped to its own refit. Reported with `label` -1
     *  (document-wide), `edges` = member arcs and `turnDeg` = the family's angular sweep.
     *  This is the crossing-ring path — a ring's arcs are spread over several faces, so
     *  no per-loop grouping can reach them. */
    | 'family-snapped'
}
export type ArcLoopObserver = (r: ArcLoopRecord) => void

/**
 * Effective snap tolerance at a given local feature scale (§10). With `localScaleK`
 * off this is the plain absolute `fid`; on, it tightens to a fraction of the shape's
 * own size so a small primitive must fit far better — in radial px — than a large one.
 */
function effFidelity(fid: number, localScale: number, localScaleK: number): number {
  return localScaleK > 0 ? Math.min(fid, localScaleK * localScale) : fid
}

/**
 * Largest turn angle (radians) between consecutive segments of a flattened chain.
 * Collinear runs (a straight edge's 16 samples) contribute 0; a corner contributes
 * its exterior angle. Zero-length steps are skipped so coincident junction samples
 * don't blind the test.
 *
 * `closed` (the default) wraps the last direction back onto the first, which is right for
 * a region loop. Pass false for a single OPEN edge (§24's per-edge corner self-guard):
 * wrapping there would compare an arc's two free ends and read the whole arc's sweep as
 * one corner, vetoing every arc worth snapping.
 */
function maxTurnRad(poly: Vec[], closed = true): number {
  const dirs: Vec[] = []
  const n = poly.length
  // Open chains stop one short: the wrap-around step is the CLOSING CHORD from the last
  // point back to the first, and on an arc it runs the opposite way — comparing a real
  // step against it reads the arc's own sweep as a 150° corner and vetoes every arc worth
  // snapping. (Measured: ring-cross's eight ring arcs read 132–162° that way, on fits of
  // dev 0.53–1.04px.)
  for (let i = 0; i < (closed ? n : n - 1); i++) {
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
  for (let i = 0; i < (closed ? m : m - 1); i++) {
    const d0 = dirs[i]
    const d1 = dirs[(i + 1) % m]
    let dot = d0.x * d1.x + d0.y * d1.y
    dot = dot > 1 ? 1 : dot < -1 ? -1 : dot
    const a = Math.acos(dot)
    if (a > maxA) maxA = a
  }
  return maxA
}

/** Total angular sweep (radians) a flattened chain covers about `c`, unwrapped so a chain
 *  crossing the ±π seam still reads its true extent. Signed turns are summed and the
 *  magnitude returned: a chain that doubles back nets out, which is the intent — that is
 *  not an arc. */
function arcSweep(pts: Vec[], c: Circle): number {
  if (pts.length < 2) return 0
  let prev = Math.atan2(pts[0].y - c.cy, pts[0].x - c.cx)
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const a = Math.atan2(pts[i].y - c.cy, pts[i].x - c.cx)
    let d = a - prev
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    acc += d
    prev = a
  }
  return Math.abs(acc)
}

/**
 * The intersection of two circles nearest to `near`, or null when they do not meet (nested,
 * separate, or concentric). Standard radical-line construction: the two solutions sit
 * symmetrically about the point where the centre line crosses the radical axis.
 */
function circleIntersectNear(a: Circle, b: Circle, near: Vec): Vec | null {
  const dx = b.cx - a.cx
  const dy = b.cy - a.cy
  const d = Math.hypot(dx, dy)
  if (d < 1e-9) return null // concentric: no isolated crossing to move to
  if (d > a.r + b.r || d < Math.abs(a.r - b.r)) return null
  const t = (a.r * a.r - b.r * b.r + d * d) / (2 * d)
  const h2 = a.r * a.r - t * t
  const h = h2 > 0 ? Math.sqrt(h2) : 0
  const mx = a.cx + (t * dx) / d
  const my = a.cy + (t * dy) / d
  const ox = (-dy / d) * h
  const oy = (dx / d) * h
  const p1 = { x: mx + ox, y: my + oy }
  const p2 = { x: mx - ox, y: my - oy }
  return Math.hypot(p1.x - near.x, p1.y - near.y) <= Math.hypot(p2.x - near.x, p2.y - near.y) ? p1 : p2
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
  snap: SnapOptions = {},
): Topology {
  const fid = opts.fidelity
  if (!(fid > 0)) return topo
  const arcSnap = snap.arcSnap ?? true
  const localScaleK = snap.localScaleK ?? 0
  const cornerVeto = snap.cornerVeto ?? true

  // Work on immutable copies so the input topology is never mutated.
  const edges = topo.edges.map(cloneEdge)
  const vertices = topo.vertices.map((v) => ({ ...v }))
  // Relation-solver detection window scales with the document bbox long side.
  const longSide = bboxLongSide(topo.edges)

  // §10.4 — junction re-seat, FIRST: a junction that slid along a near-tangent
  // boundary crossing moves back to the intersection of its incident fitted
  // primitives (and the mangled terminal caps are repaired), so every snap below
  // — 1d's radial vertex snap included — works from corrected anchors. Edges it
  // straightened as occluder CHORDS carry positive evidence of a straight cut
  // (a disc crossed by a line is a "D"): 1d must not absorb them into a circle.
  let chordEdges: ReadonlySet<number> = new Set<number>()
  if (snap.reseat ?? true) {
    const r = reseatJunctions(edges, vertices, snap.width, snap.height, snap.onChord)
    chordEdges = r.chords
    snap.onReseat?.(r.moved)
  }

  // 1d — co-circular OPEN-arc loops (a ring split into arcs by band junctions) →
  // fit the whole loop to ONE circle, radial-snap its junction vertices onto that
  // circle, and re-emit each arc as a true circular slice. This is what removes the
  // "pull"/kink the user sees where colour bands meet a white ring: the arcs share
  // the circle's tangent at every junction (G¹) instead of meeting as forced,
  // independently-fitted corners. Runs FIRST on the raw fitted arcs; the edges it
  // snaps skip the per-edge 1a/1b passes below.
  const arcSnapped = arcSnap
    ? snapCoCircularLoops(edges, vertices, loopsByLabel, fid, localScaleK, cornerVeto, chordEdges, snap.onArcLoop)
    : new Set<number>()

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
      const cornered = cornerVeto && maxTurnRad(raw) >= CORNER_TURN

      const circle = fitCircle(raw)
      // Scale-relative tolerance (§10): a big disc keeps the full fidelity budget, a
      // tiny one must fit within a fraction of its own radius — so a small square's
      // radial deviation exceeds it and the round never fires (localScaleK off ⇒ fid).
      if (!cornered && circle && circle.r > 2 * fid && maxRadialDev(raw, circle) <= effFidelity(fid, circle.r, localScaleK)) {
        e.nodes = makeCircleSubPath(circle.cx, circle.cy, circle.r, positive).nodes
        discCircles.push({ edgeIdx: i, positive, cx: circle.cx, cy: circle.cy, r: circle.r, raw })
        continue
      }

      const ell = fitEllipse(raw)
      // BOTH directions must hold: maxEllipseDev (polygon→ellipse) is blind to
      // the ellipse bulging into space the polygon never visits — see
      // maxEllipseToPolyDev (a 6px bar "fits" a 3.8×278 ellipse otherwise).
      const ellFid = ell ? effFidelity(fid, Math.min(ell.rx, ell.ry), localScaleK) : fid
      if (
        !cornered && ell && Math.min(ell.rx, ell.ry) > 2 * fid &&
        maxEllipseDev(raw, ell) <= ellFid && maxEllipseToPolyDev(raw, ell) <= ellFid
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
  localScaleK = 0,
  cornerVeto = true,
  chordEdges: ReadonlySet<number> = new Set(),
  onArcLoop?: ArcLoopObserver,
): Set<number> {
  const snapped = new Set<number>()
  const byId = new Map<number, SharedEdge>()
  for (const e of edges) byId.set(e.id, e)
  const vById = new Map<number, Vertex>()
  for (const v of vertices) vById.set(v.id, v)

  // Assign each open ring edge + its endpoint vertices to the circle of the first
  // circular loop that claims them (a vertex/edge lies on at most one such circle).
  const edgeCircle = new Map<number, Circle>()
  /**
   * Every circle that claims a vertex, not just the first. A crossing junction genuinely
   * lies on TWO rings, and snapping it radially onto whichever happened to be fitted first
   * leaves it off the other — which is exactly what defeated the family snap when it was
   * first measured: a sub-90° `arcSlice` emits ONLY its two pinned endpoints, so an arc
   * whose junctions sit on the neighbouring ring's circle is displaced bodily off its own
   * (ring-cross's middle ring landed at r 80.6 while its family circle was 79.86). Where
   * two circles claim a vertex, it belongs at their INTERSECTION — see the snap below.
   */
  const vertCircle = new Map<number, Circle[]>()
  const claimVertex = (vid: number | null | undefined, c: Circle): void => {
    if (vid == null || vid < 0) return
    const list = vertCircle.get(vid)
    if (!list) { vertCircle.set(vid, [c]); return }
    // Same circle twice (two arcs of one ring meeting) adds nothing.
    if (list.some((o) => o === c || (Math.abs(o.r - c.r) < 1e-6 && Math.hypot(o.cx - c.cx, o.cy - c.cy) < 1e-6))) return
    list.push(c)
  }

  for (const [label, loops] of loopsByLabel) {
    for (const loop of loops) {
      // The observer (issue #10) needs the gate NAME plus what it saw; production only
      // needs the `continue`. `say` is a no-op when nothing is listening, so the pass
      // stays byte-identical and costs nothing extra.
      const openEdges = loop.filter((ref) => byId.get(ref.edge)?.closed === false).length
      const say = (verdict: ArcLoopRecord['verdict'], r = NaN, radialDev = NaN, budget = NaN, turnDeg = NaN): void =>
        onArcLoop?.({ label, edges: loop.length, openEdges, r, radialDev, budget, turnDeg, verdict })
      if (loop.length < 2) { say('single-edge-loop'); continue } // a single closed-loop edge is a disc — 1a's job
      // A loop carrying a re-seated occluder chord is a disc CUT by a line (a
      // "D") — snapping it to one circle would absorb the chord into the arc.
      if (loop.some((ref) => chordEdges.has(ref.edge))) { say('carries-chord'); continue }
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
      if (!ok || !hasOpen || raw.length < 8) { say(ok && !hasOpen ? 'no-open-edge' : 'too-few-points'); continue }
      // A loop that turns a sharp corner is a polygon (a checker cell's 4 right
      // angles), not a ring split into arcs — snapping it to a circle is the
      // fine-checkerboard scalloping. Radial deviation is blind to it at small scale;
      // turning is not. See CORNER_TURN.
      const turn = maxTurnRad(raw)
      const turnDeg = (turn * 180) / Math.PI
      if (cornerVeto && turn >= CORNER_TURN) { say('corner-veto', NaN, NaN, NaN, turnDeg); continue }
      const c = fitCircle(raw)
      // Scale-relative tolerance (§10): the ring's own radius is its local scale, so a
      // genuine large ring keeps the full budget and a tiny fake one must fit tightly.
      if (!c) { say('circle-fit-failed', NaN, NaN, NaN, turnDeg); continue }
      const dev = maxRadialDev(raw, c)
      const budget = effFidelity(fid, c.r, localScaleK)
      if (c.r <= 2 * fid) { say('radius-too-small', c.r, dev, budget, turnDeg); continue }
      if (dev > budget) { say('dev-exceeds-budget', c.r, dev, budget, turnDeg); continue }
      say('snapped', c.r, dev, budget, turnDeg)
      for (const ref of loop) {
        const e = byId.get(ref.edge)!
        if (e.closed) continue
        if (!edgeCircle.has(e.id)) edgeCircle.set(e.id, c)
        claimVertex(e.startVertex, c)
        claimVertex(e.endVertex, c)
      }
    }
  }

  // §24 — the CO-CIRCULAR FAMILY pass (issue #10), for the rings the loop pass above
  // structurally cannot serve. Runs ONCE over the whole topology, on the open edges the
  // loop pass did not claim.
  //
  // The loop pass asks "is this LOOP one circle". For a ring split by T-ing spokes it is,
  // and that is the case §1d was built for. For a ring CUT BY A CROSSING it is not, twice
  // over, and no threshold reaches either half:
  //
  //   • where a band passes over another, the covered ring's annulus loses a chunk, and
  //     what is left is a "C" whose single boundary loop runs outer arc → cap → inner arc
  //     → cap. Those points come from TWO concentric circles a band-width apart, so the
  //     best single circle sits between them and misses by half the band — `ring-cross`
  //     @512 reads radialDev 12–18px against a 1.5px budget, on a 16px band;
  //   • and the ring's arcs are then spread across SEVERAL faces. `ring-cross`'s middle
  //     ring is cut into four C-faces, each holding exactly one outer arc and one inner
  //     arc — so no per-loop grouping, however it fits, can ever put two arcs of the same
  //     circle together. The ring is a document-level object, not a face-level one.
  //
  // So the grouping moves down one level and out one: fit each OPEN edge on its own,
  // cluster ALL of them by the circle each found, and snap every cluster to its own refit.
  // A ring's outer arcs become one family and its inner arcs another, wherever in the
  // document they were traced.
  //
  // WHY THIS DOES NOT RE-OPEN THE CHECKER SCALLOPING. `CORNER_TURN` exists to stop a
  // checker cell rounding into a disc, and measurement says it earns its keep: with
  // `cornerVeto` off, 992 of checker's 1760 loops snap. But the veto reads a whole loop,
  // and a checker cell's 90° turns sit at its VERTICES — exactly where a crossing ring's
  // do, which is why the veto cannot tell the two apart. Read per EDGE and they separate
  // cleanly: a cell's side is a straight chain that turns 0° and fits no circle worth
  // having, while a ring's arc turns smoothly and fits its own radius. The guard is
  // therefore kept and applied at the level where it says what it means, joined by three
  // more a straight chain cannot pass — its own fit must hold within budget, a family
  // needs at least two member arcs, and their combined angular sweep must reach
  // FAMILY_MIN_SPAN (a false circle through short near-straight edges has an enormous
  // radius and almost no sweep).
  const cands: { e: SharedEdge; pts: Vec[]; c: Circle; span: number }[] = []
  for (const e of edges) {
    if (e.closed || e.nodes.length < 2 || edgeCircle.has(e.id) || chordEdges.has(e.id)) continue
    const pts = flatten({ nodes: e.nodes, closed: false })
    if (pts.length < FAMILY_MIN_PTS) continue
    // The corner self-guard, at the level where it means what it says (see above).
    if (cornerVeto && maxTurnRad(pts, false) >= CORNER_TURN) continue
    const c = fitCircle(pts)
    if (!c || c.r <= 2 * fid) continue
    if (maxRadialDev(pts, c) > effFidelity(fid, c.r, localScaleK)) continue
    cands.push({ e, pts, c, span: arcSweep(pts, c) })
  }
  // SEED AND GROW, widest arc first, against the family's own REFIT rather than a pairwise
  // test on (cx, cy, r). A short arc's circle fit is badly conditioned — `ring-cross`'s four
  // ring arcs fit r 78.0–78.4 with centres scattered over 2.6px, on a ring authored at
  // r 80.0 — so a pairwise proxy either misses real members or merges wrong ones (measured:
  // it left one of the four inner arcs behind). A refit over several arcs is conditioned by
  // their combined sweep and lands within 0.14px of the authored circle, so each round grows
  // from a better estimate than the last, and the test is the one that actually matters:
  // does this candidate's own polyline lie within budget of the family's circle.
  cands.sort((a, b) => b.span - a.span || a.e.id - b.e.id)
  const taken = new Array<boolean>(cands.length).fill(false)
  for (let i = 0; i < cands.length; i++) {
    if (taken[i]) continue
    let cf: Circle = cands[i].c
    let group = [i]
    for (let round = 0; round < FAMILY_GROW_ROUNDS; round++) {
      const budget = effFidelity(fid, cf.r, localScaleK)
      const tol = FAMILY_CLUSTER_REL * cf.r
      const grown = [i]
      for (let j = 0; j < cands.length; j++) {
        if (j === i || taken[j]) continue
        // ROUND 0 has only the seed's own badly-conditioned circle to go on, so it groups
        // on the loose (centre, radius) proxy — strict enough to keep two different rings
        // apart, loose enough to survive centres scattered by a couple of px. From round 1
        // the family circle is the refit, and the test becomes the one that matters:
        // does this candidate's polyline lie within budget of it. Members can leave as
        // well as join, and the final acceptance below re-checks the whole set.
        const joins = round === 0
          ? Math.abs(cands[j].c.r - cf.r) <= tol && Math.hypot(cands[j].c.cx - cf.cx, cands[j].c.cy - cf.cy) <= tol
          : Math.abs(cands[j].c.r - cf.r) <= tol + budget && maxRadialDev(cands[j].pts, cf) <= budget
        if (joins) grown.push(j)
      }
      const settled = grown.length === group.length && grown.every((v, n) => v === group[n])
      group = grown
      if (group.length < 2) break
      if (settled && round > 0) break
      const all: Vec[] = []
      for (const k of group) for (const p of cands[k].pts) all.push(p)
      const refit = fitCircle(all)
      if (!refit) break
      cf = refit
    }
    // NO member-count rule. "At least two arcs" was a proxy for "enough evidence", and
    // FAMILY_MIN_SPAN below is the real measure: a single arc sweeping 266° constrains its
    // circle better than two 90° ones. The proxy had a hole — a ring cut only once leaves
    // ONE long open arc, which the closed-disc snap (1a) never sees and the line snap (1b)
    // is not for, so it was left as a freehand chain. That is `olympic-rings`' red ring
    // inner boundary (e24, r 66.5, sweep 266°) and most of what still pulled after §24.
    const all: Vec[] = []
    let sweep = 0
    for (const k of group) {
      for (const p of cands[k].pts) all.push(p)
      sweep += arcSweep(cands[k].pts, cf)
    }
    if (sweep < FAMILY_MIN_SPAN || cf.r <= 2 * fid) continue
    const fdev = maxRadialDev(all, cf)
    const fbudget = effFidelity(fid, cf.r, localScaleK)
    if (fdev > fbudget) continue
    for (const k of group) {
      taken[k] = true
      const e = cands[k].e
      edgeCircle.set(e.id, cf)
      claimVertex(e.startVertex, cf)
      claimVertex(e.endVertex, cf)
    }
    onArcLoop?.({ label: -1, edges: group.length, openEdges: group.length, r: cf.r, radialDev: fdev, budget: fbudget, turnDeg: (sweep * 180) / Math.PI, verdict: 'family-snapped' })
  }

  if (edgeCircle.size === 0) return snapped

  // Place each claimed vertex on its circle, moving EVERY incident edge endpoint with it
  // (ring arcs get overwritten below; spokes keep this, so no seam). One circle ⇒ the
  // radial snap. TWO OR MORE ⇒ the crossing of the PAIR whose intersection lies nearest the
  // raw junction (§24): a junction where two snapped rings cross is a point of both, and the
  // radial snap can only ever satisfy one of them.
  //
  // "Nearest pair", not "first two". Three boundaries can meet inside a couple of pixels —
  // `bloom`'s lower two discs cross at (256, 277.9) and the upper disc's own bottom is at
  // (256, 276.0), 1.9px away — and taking the circles in the order they happened to claim
  // the vertex then picks an arbitrary one of the three crossings. That is not merely
  // imprecise, it is ASYMMETRIC: bloom is mirror-symmetric about x=256 by construction, and
  // claim order is not, so the mirror-image junction chose a different pair and the traced
  // lens came back with one side bitten in. Ranking every pair by how far its crossing sits
  // from the raw junction is order-independent, mirrors correctly, and picks the crossing
  // the art actually has — the raw junction is already within ~1px of it.
  for (const [vid, circles] of vertCircle) {
    const v = vById.get(vid)
    if (!v) continue
    const c = circles[0]
    let nx = 0
    let ny = 0
    let best: Vec | null = null
    let bestD = Infinity
    for (let a = 0; a < circles.length; a++) {
      for (let b = a + 1; b < circles.length; b++) {
        const x = circleIntersectNear(circles[a], circles[b], v)
        if (!x) continue
        const d = Math.hypot(x.x - v.x, x.y - v.y)
        if (d < bestD) { bestD = d; best = x }
      }
    }
    if (best && bestD <= JUNCTION_XING_MAX_MOVE) {
      nx = best.x
      ny = best.y
    } else {
      const dx = v.x - c.cx
      const dy = v.y - c.cy
      const d = Math.hypot(dx, dy) || 1
      nx = c.cx + (c.r * dx) / d
      ny = c.cy + (c.r * dy) / d
    }
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
