// Edge-level beautify for the planar tracer: snaps shared edges to circles,
// ellipses and lines. Loop-level beautify (`beautify.ts`) moves each loop's
// vertices independently, which would desync the geometry two regions share;
// here a boundary is one shared edge, so snapping it once updates both regions.
// Runs on `topology.edges` before per-region materialization.
//
// The fitting math (circle/ellipse fit, kappa-Bézier emit, relation solver) is
// shared with beautify.ts via `circleFit.ts`. Each snap is gated on the fidelity
// tolerance against the edge's flattened fitted arc. Deterministic (fixed edge
// and cluster order); `fidelity ≤ 0` returns the input topology unchanged.
//
// Design notes and measurements: docs/vectorization-benchmarks.md.

import type { EdgeRef, PathNode, SharedEdge, Topology, Vec, Vertex } from '../path/types'
import type { BeautifyOptions } from './beautify.ts'
import { reverseEdgeNodes } from '../path/topology.ts'
import { reseatJunctions, type ChordObserver, type ReseatObserver, type ReseatTune } from './planarReseat.ts'
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
const cloneNode = (n: PathNode): PathNode => ({
  x: n.x,
  y: n.y,
  hIn: cloneVec(n.hIn),
  hOut: cloneVec(n.hOut),
  kind: n.kind,
})
const cloneEdge = (e: SharedEdge): SharedEdge => ({ ...e, nodes: e.nodes.map(cloneNode) })

/**
 * Maximum turn (60°) a loop may make and still be snapped to a circle or ellipse.
 * Radial deviation alone cannot reject a small square: an 8px cell deviates from its
 * best-fit circle by under a pixel. Its turning can — a circle bends a few degrees per
 * flatten step, a polygon 90° at each corner. Ring arcs meet their junctions nearly
 * straight, so genuine round art stays well below this.
 */
const CORNER_TURN = Math.PI / 3
/** Minimum flattened points for an open edge's own circle fit to mean anything. */
const FAMILY_MIN_PTS = 6
/** How closely two independently fitted arcs must agree, relative to the radius, to seed
 *  one ring. Deliberately loose: the family's refit is the real acceptance test. */
const FAMILY_CLUSTER_REL = 0.06
/**
 * Total angular sweep (radians) a family must cover before it is snapped to one circle.
 * Asserting that several arcs form one ring needs them to cover enough of it; a ring cut
 * by crossings keeps most of its 2π, while short arc pairs of unrelated curves do not.
 */
const FAMILY_MIN_SPAN = Math.PI
/** Grow rounds for a family; the loop exits early once membership settles. */
const FAMILY_GROW_ROUNDS = 3
/** Sweep (radians) a candidate needs before lying on the family circle counts as evidence
 *  without also agreeing on radius. Short fragments are excluded because two crossing
 *  circles stay within budget of each other for a few degrees around the crossing. */
const FAMILY_JOIN_MIN_SPAN = 0.6
/** A member is dropped if the family circle leaves it more than `FAMILY_WORSEN_K` times
 *  worse than its own fit, with `FAMILY_WORSEN_FLOOR` px as the floor so an unusually
 *  clean arc does not set an impossible bar. */
const FAMILY_WORSEN_K = 2
const FAMILY_WORSEN_FLOOR = 0.6
/** Max distance (px) a junction may travel to the intersection of the two circles that
 *  claim it. It already lies within ~1px of both, so a longer move means the pairing is
 *  wrong and the radial snap is the safer answer. */
const JUNCTION_XING_MAX_MOVE = 3

// --- Through-chains: arc membership decided by topology, not by the fit ---
//
// A short arc's own circle fit is poorly conditioned (it can land at a fraction or a
// multiple of the true radius), so it cannot decide which ring an arc belongs to. Which
// incident arcs continue one another at a crossing is a topological question, though, and
// chaining them first hands the family pass whole rings instead of fragments.

/** Arc length (px) of each arm sampled to read its direction at a junction. */
const CHAIN_ARM_SPAN = 12
/** Shortest arm (px) that earns a verdict; below this a chord direction is dominated by
 *  the pixel staircase. */
const CHAIN_MIN_ARM = 6
/**
 * Max turn across a junction for two arms to count as one arc. A continuing arc turns by
 * about what the pixel staircase can hide; a real corner turns by tens of degrees.
 */
const CHAIN_TURN_MAX = (30 * Math.PI) / 180
/**
 * Minimum margin by which the straightest rejected pairing must trail the chosen matching.
 * This is the decisive gate: the absolute turn of a true continuation drifts with raster
 * resolution, but its rank against the alternatives does not. A pairing that wins by a
 * hair is ambiguous and is refused.
 */
const CHAIN_MIN_MARGIN = (30 * Math.PI) / 180

/**
 * Snap-gate tuning passed down from the planar fit options.
 *  • `arcSnap`      — run the co-circular open-arc snap (step 1d).
 *  • `localScaleK`  — scale-relative fidelity coefficient. 0 ⇒ off (absolute px).
 *    > 0 ⇒ each circle/ellipse/ring snap is accepted only within
 *    `min(fidelity, localScaleK · r)`, r being the fitted primitive's radius.
 *    See PlanarFitOptions.localScaleK.
 *  • `cornerVeto`   — never round a loop that turns sharper than CORNER_TURN. Default on.
 *  • `reseat`       — re-seat slid degree-3 junctions on the intersection of their
 *    incident fitted primitives (planarReseat.ts). Default on.
 *  • `width`/`height` — raster size (px), used only by the re-seat border guard
 *    (a junction on the canvas frame must stay on the frame). Omitted ⇒ no guard.
 *  • `onReseat`     — receives the ids of the vertices the re-seat moved. The
 *    converged-pair weld keys on them and must run in the caller, because contracting
 *    a micro-edge rewrites the region loops, which this function treats as read-only.
 *  • `onChord`      — diagnostic sink: one record per occluder-chord candidate, with
 *    the value each gate saw. Output is identical with or without it.
 *  • `onArcLoop`    — diagnostic sink: one record per loop, chain or family the
 *    co-circular snap weighed, naming the gate that declined it.
 */
export interface SnapOptions {
  arcSnap?: boolean
  /** Join open arcs into through-chains across their junctions before the co-circular
   *  family pass clusters them. Default on. */
  chainArcs?: boolean
  localScaleK?: number
  cornerVeto?: boolean
  reseat?: boolean
  width?: number
  height?: number
  onReseat?: (movedVertexIds: ReadonlySet<number>) => void
  onChord?: ChordObserver
  /** Diagnostic sink: one record per degree-3 junction the re-seat weighed (arm verdicts,
   *  winning pair, move). */
  onReseatVerdict?: ReseatObserver
  /** Diagnostic override for the re-seat's certification constants. */
  reseatTune?: ReseatTune
  onArcLoop?: ArcLoopObserver
}

/**
 * One co-circular candidate (loop, chain or family) and its outcome. `verdict` names the
 * first gate that declined it, in evaluation order.
 */
export interface ArcLoopRecord {
  label: number
  edges: number
  openEdges: number
  /** Fitted circle radius (px), when a circle could be fitted at all. */
  r: number
  /** Fitted circle centre, when there is one (distinguishes rings of equal radius). */
  cx?: number
  cy?: number
  /** Member edge ids, for the two document-wide verdicts. */
  ids?: number[]
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
    /** A co-circular family of open edges, clustered across the whole topology and
     *  snapped to its own refit. Reported with `label` -1 (document-wide), `edges` =
     *  member arcs and `turnDeg` = the family's angular sweep. */
    | 'family-snapped'
    /** A through-chain: open edges joined across shared junctions by tangent continuity.
     *  Reported with `label` -1, `edges` = member arcs, `turnDeg` = the chain's sweep and
     *  `r`/`radialDev` from the chain's own circle fit. Single-edge chains are not reported. */
    | 'through-chain'
}
export type ArcLoopObserver = (r: ArcLoopRecord) => void

/**
 * Effective snap tolerance at a given local feature scale. With `localScaleK`
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
 * a region loop. Pass false for a single open edge: wrapping there would read the arc's
 * whole sweep as one corner.
 */
function maxTurnRad(poly: Vec[], closed = true): number {
  const dirs: Vec[] = []
  const n = poly.length
  // Open chains skip the closing chord (last point back to first), which on an arc runs
  // against the curve and would register as a sharp corner.
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
 * tight enough, returning a new topology; the input is never mutated.
 * `loopsByLabel` gives each region's boundary loops (used by the co-circular snap).
 *
 *   0.  Junction re-seat (planarReseat.ts), so every snap works from corrected anchors.
 *   1d. Co-circular open arcs (a ring split by junctions) → one circle, junctions on it.
 *   1a. Disc edges (closed) → circle / ellipse, oriented to the edge's existing
 *       winding so both the disc region and its surrounding field inherit it.
 *   1b. Open edges whose arc is near-straight → two corner nodes at the unchanged
 *       junction endpoints, so the planar graph stays welded.
 *   1c. Concentric-centre / equal-radius relation solver across the disc circles
 *       (each adjustment re-gated against that circle's flattened arc).
 *
 * `fidelity ≤ 0` ⇒ the input topology is returned unchanged.
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

  // Junction re-seat first: a junction that slid along a near-tangent crossing moves
  // back to the intersection of its incident fitted primitives, so every snap below
  // works from corrected anchors. Edges it straightened as occluder chords are a
  // straight cut through a disc (a "D"), and 1d must not absorb them into a circle.
  let chordEdges: ReadonlySet<number> = new Set<number>()
  if (snap.reseat ?? true) {
    const r = reseatJunctions(
      edges,
      vertices,
      snap.width,
      snap.height,
      snap.onChord,
      snap.onReseatVerdict,
      snap.reseatTune,
    )
    chordEdges = r.chords
    snap.onReseat?.(r.moved)
  }

  // 1d — co-circular open arcs (a ring split into arcs by junctions) → fit them to one
  // circle, snap the junctions onto it and re-emit each arc as a circular slice, so the
  // arcs share the circle's tangent at every junction instead of meeting at a kink.
  // Edges it snaps skip the per-edge 1a/1b passes below.
  const arcSnapped = arcSnap
    ? snapCoCircularLoops(
        edges,
        vertices,
        loopsByLabel,
        fid,
        localScaleK,
        cornerVeto,
        chordEdges,
        snap.onArcLoop,
        snap.chainArcs ?? true,
        snap.width,
        snap.height,
      )
    : new Set<number>()

  const discCircles: DiscCircle[] = []

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    if (e.nodes.length < 2 || arcSnapped.has(e.id)) continue

    if (e.closed) {
      // --- 1a. Disc edge → circle / ellipse --------------------------------
      const raw = flatten({ nodes: e.nodes, closed: true })
      const positive = anchorSignedArea(e.nodes) > 0
      // A sharp-cornered loop is a polygon, not a disc. See CORNER_TURN.
      const cornered = cornerVeto && maxTurnRad(raw) >= CORNER_TURN

      const circle = fitCircle(raw)
      if (
        !cornered &&
        circle &&
        circle.r > 2 * fid &&
        maxRadialDev(raw, circle) <= effFidelity(fid, circle.r, localScaleK)
      ) {
        e.nodes = makeCircleSubPath(circle.cx, circle.cy, circle.r, positive).nodes
        discCircles.push({ edgeIdx: i, positive, cx: circle.cx, cy: circle.cy, r: circle.r, raw })
        continue
      }

      const ell = fitEllipse(raw)
      // Both directions must hold: maxEllipseDev (polygon→ellipse) is blind to the
      // ellipse bulging into space the polygon never visits (see maxEllipseToPolyDev).
      const ellFid = ell ? effFidelity(fid, Math.min(ell.rx, ell.ry), localScaleK) : fid
      if (
        !cornered &&
        ell &&
        Math.min(ell.rx, ell.ry) > 2 * fid &&
        maxEllipseDev(raw, ell) <= ellFid &&
        maxEllipseToPolyDev(raw, ell) <= ellFid
      ) {
        e.nodes = makeEllipseSubPath(ell.cx, ell.cy, ell.rx, ell.ry, positive).nodes
      }
      continue
    }

    // --- 1b. Open edge → straight line ------------------------------------
    // Replace the fitted arc with the chord between its pinned junction endpoints
    // when every sample lies within fidelity of it. The endpoints are kept exact so
    // every other edge meeting at those junctions stays welded.
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

  // `vertices` carries any moves from the re-seat and 1d; the rest are independent
  // copies, so a later mutation of the input cannot leak into the output.
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
  if (n.hIn) {
    n.hIn.x += dx
    n.hIn.y += dy
  }
  if (n.hOut) {
    n.hOut.x += dx
    n.hOut.y += dy
  }
}

/** One family candidate: a run of one or more open edges fitted as one arc. */
interface ArcCand {
  /** Member edges, in walk order. One entry ⇒ a single, unchained edge. */
  es: SharedEdge[]
  pts: Vec[]
  c: Circle
  span: number
}

/** Points of one arm, junction first, out to `span` px of arc length. */
function armWindow(pts: Vec[], atEnd: boolean, span: number): Vec[] {
  const out: Vec[] = []
  let acc = 0
  const n = pts.length
  for (let k = 0; k < n; k++) {
    const p = atEnd ? pts[n - 1 - k] : pts[k]
    if (k > 0) acc += Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y)
    out.push(p)
    if (acc >= span) break
  }
  return out
}

/** Unit direction from a window's junction end to its far end, and the arc it covers. */
function armChord(w: Vec[]): { dir: Vec; len: number } | null {
  let len = 0
  for (let i = 1; i < w.length; i++) len += Math.hypot(w[i].x - w[i - 1].x, w[i].y - w[i - 1].y)
  const a = w[0]
  const b = w[w.length - 1]
  const d = Math.hypot(b.x - a.x, b.y - a.y)
  return d < 1e-9 ? null : { dir: { x: (b.x - a.x) / d, y: (b.y - a.y) / d }, len }
}

/**
 * Join candidate arcs across their shared junctions into through-chains.
 *
 * At each junction of degree ≥ 3, every pairing of the incident arms is ranked by how
 * straight the boundary runs across it, and a matching is taken greedily — straightest
 * first, each arm used once. A matching rather than a single pair, because at a degree-4
 * crossing of two circles both pairings are true continuations. The matching is accepted
 * only if it beats the best rejected pairing by CHAIN_MIN_MARGIN, and each chosen pair
 * must turn less than CHAIN_TURN_MAX.
 *
 * Skipped junctions:
 *   • On the canvas frame: a boundary clipped by the raster edge continues along it and
 *     reads as a perfect 0° continuation that says nothing about the art.
 *   • With any arm shorter than CHAIN_MIN_ARM.
 *
 * Arms are read from every incident open edge, not only the candidates, since the arm
 * that decides a pairing may be one the family pass never touches; only candidate pairs
 * are then linked. Each chain must still fit one circle within budget, or it falls back
 * to its unchained members.
 *
 * Deterministic: iteration by vertex id then edge id, ties broken by id. With no junction
 * admitted the input list is returned unchanged.
 */
function throughChains(
  cands: ArcCand[],
  edges: SharedEdge[],
  vertices: Vertex[],
  fid: number,
  localScaleK: number,
  width?: number,
  height?: number,
  onArcLoop?: ArcLoopObserver,
): ArcCand[] {
  const candOf = new Map<number, number>()
  for (let i = 0; i < cands.length; i++) candOf.set(cands[i].es[0].id, i)
  const vById = new Map<number, Vertex>()
  for (const v of vertices) vById.set(v.id, v)

  // Every incident open edge-end, by vertex.
  const inc = new Map<number, { edge: SharedEdge; atEnd: boolean }[]>()
  const add = (vid: number | null, end: { edge: SharedEdge; atEnd: boolean }): void => {
    if (vid == null || vid < 0) return
    const a = inc.get(vid)
    if (a) a.push(end)
    else inc.set(vid, [end])
  }
  for (const e of edges) {
    if (e.closed || e.nodes.length < 2) continue
    add(e.startVertex, { edge: e, atEnd: false })
    add(e.endVertex, { edge: e, atEnd: true })
  }

  // link[edgeId * 2 + (atEnd ? 1 : 0)] = the edge-end it continues into.
  const key = (edgeId: number, atEnd: boolean): number => edgeId * 2 + (atEnd ? 1 : 0)
  const link = new Map<number, number>()
  for (const vid of [...inc.keys()].sort((a, b) => a - b)) {
    const v = vById.get(vid)
    if (!v) continue
    // A junction on the canvas frame is a clip, not a crossing (see above).
    if (width != null && height != null && (v.x <= 1 || v.y <= 1 || v.x >= width - 1 || v.y >= height - 1)) continue
    const ends = (inc.get(vid) ?? []).slice().sort((a, b) => a.edge.id - b.edge.id || Number(a.atEnd) - Number(b.atEnd))
    if (ends.length < 3) continue
    const arms = ends.map((e) => {
      const cand = candOf.get(e.edge.id)
      const pts = cand != null ? cands[cand].pts : flatten({ nodes: e.edge.nodes, closed: false })
      // `pts` runs start→end; the junction is at the end when `atEnd`.
      return { ...e, cand, chord: armChord(armWindow(pts, e.atEnd, CHAIN_ARM_SPAN)) }
    })
    if (arms.some((a) => !a.chord || a.chord.len < CHAIN_MIN_ARM)) continue

    const pairs: { i: number; j: number; turn: number }[] = []
    for (let a = 0; a < arms.length; a++) {
      for (let b = a + 1; b < arms.length; b++) {
        const da = arms[a].chord!.dir
        const db = arms[b].chord!.dir
        const dot = Math.max(-1, Math.min(1, da.x * db.x + da.y * db.y))
        // Both chords point away from the junction, so a boundary running straight through
        // has them opposed: turn 0 = straight on, π = doubling back.
        pairs.push({ i: a, j: b, turn: Math.PI - Math.acos(dot) })
      }
    }
    pairs.sort((p, q) => p.turn - q.turn || p.i - q.i || p.j - q.j)
    const used = new Set<number>()
    const chosen: typeof pairs = []
    for (const p of pairs) {
      if (used.has(p.i) || used.has(p.j)) continue
      used.add(p.i)
      used.add(p.j)
      chosen.push(p)
    }
    if (!chosen.length) continue
    const rejected = pairs.find((p) => !chosen.includes(p))
    const margin = rejected ? rejected.turn - chosen[chosen.length - 1].turn : Infinity
    if (margin < CHAIN_MIN_MARGIN) continue
    for (const p of chosen) {
      if (p.turn > CHAIN_TURN_MAX) continue
      const a = arms[p.i]
      const b = arms[p.j]
      if (a.cand == null || b.cand == null) continue
      link.set(key(a.edge.id, a.atEnd), key(b.edge.id, b.atEnd))
      link.set(key(b.edge.id, b.atEnd), key(a.edge.id, a.atEnd))
    }
  }
  if (!link.size) return cands

  // Walk the links into chains: back to a free end (or once round a cycle), then forward.
  const seen = new Set<number>()
  const out: ArcCand[] = []
  for (let i = 0; i < cands.length; i++) {
    const e0 = cands[i].es[0]
    if (seen.has(e0.id)) continue
    let cur = key(e0.id, false)
    const guard = new Set<number>()
    while (link.has(cur) && !guard.has(cur)) {
      guard.add(cur)
      const nxt = link.get(cur)!
      const nid = nxt >> 1
      if (nid === e0.id && guard.size > 1) break
      cur = key(nid, (nxt & 1) === 0) // enter at one end, leave by the other
    }
    const es: SharedEdge[] = []
    const pts: Vec[] = []
    for (let n = 0; n <= cands.length; n++) {
      const eid = cur >> 1
      if (seen.has(eid)) break
      seen.add(eid)
      const ci = candOf.get(eid)!
      es.push(cands[ci].es[0])
      // `pts` runs start→end; entering at the END means walking it backwards.
      for (const p of (cur & 1) === 1 ? [...cands[ci].pts].reverse() : cands[ci].pts) pts.push(p)
      const nxt = link.get(key(eid, (cur & 1) === 0))
      if (nxt === undefined) break
      cur = nxt
    }
    if (es.length < 2) {
      out.push(cands[candOf.get(es[0].id)!])
      continue
    }
    // A chain must still fit one circle; this is where a wrong pairing is caught, since
    // two crossing circles stay within budget of each other only near the crossing.
    // A failing chain falls back to its members, unchained.
    const c = fitCircle(pts)
    const okDev = c && c.r > 2 * fid && maxRadialDev(pts, c) <= effFidelity(fid, c.r, localScaleK)
    if (!c || !okDev) {
      for (const e of es) out.push(cands[candOf.get(e.id)!])
      continue
    }
    out.push({ es, pts, c, span: arcSweep(pts, c) })
    onArcLoop?.({
      label: -1,
      edges: es.length,
      openEdges: es.length,
      r: c.r,
      cx: c.cx,
      cy: c.cy,
      ids: es.map((e) => e.id),
      radialDev: maxRadialDev(pts, c),
      budget: effFidelity(fid, c.r, localScaleK),
      turnDeg: (arcSweep(pts, c) * 180) / Math.PI,
      verdict: 'through-chain',
    })
  }
  return out
}

/**
 * Snap ring boundaries split into open arcs to one fitted circle each. Two sources of
 * rings: region loops that are a full circle (a ring split by T-junctions), and families
 * of open edges clustered across the whole topology (a ring cut by crossings, whose arcs
 * are spread over several faces). Junction vertices are moved onto their circle — or onto
 * the crossing of two claiming circles — carrying every incident edge endpoint so the
 * graph stays welded, then each claimed edge is re-emitted as a circular slice. Returns
 * the ids of the re-emitted edges. Mutates `edges` / `vertices` in place.
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
  chainArcs = true,
  width?: number,
  height?: number,
): Set<number> {
  const snapped = new Set<number>()
  const byId = new Map<number, SharedEdge>()
  for (const e of edges) byId.set(e.id, e)
  const vById = new Map<number, Vertex>()
  for (const v of vertices) vById.set(v.id, v)

  // Each open ring edge is assigned to the first circle that claims it.
  const edgeCircle = new Map<number, Circle>()
  /**
   * Every circle that claims a vertex, not just the first. A crossing junction lies on
   * two rings; snapping it radially onto one leaves it off the other, and since a short
   * `arcSlice` is pinned by its endpoints, the arc would be displaced off its own circle.
   * Such a vertex goes to the circles' intersection instead (see below).
   */
  const vertCircle = new Map<number, Circle[]>()
  const claimVertex = (vid: number | null | undefined, c: Circle): void => {
    if (vid == null || vid < 0) return
    const list = vertCircle.get(vid)
    if (!list) {
      vertCircle.set(vid, [c])
      return
    }
    // Same circle twice (two arcs of one ring meeting) adds nothing.
    if (list.some((o) => o === c || (Math.abs(o.r - c.r) < 1e-6 && Math.hypot(o.cx - c.cx, o.cy - c.cy) < 1e-6))) return
    list.push(c)
  }

  for (const [label, loops] of loopsByLabel) {
    for (const loop of loops) {
      // `say` reports the declining gate to the diagnostic sink; a no-op without one.
      const openEdges = loop.filter((ref) => byId.get(ref.edge)?.closed === false).length
      const say = (verdict: ArcLoopRecord['verdict'], r = NaN, radialDev = NaN, budget = NaN, turnDeg = NaN): void =>
        onArcLoop?.({ label, edges: loop.length, openEdges, r, radialDev, budget, turnDeg, verdict })
      if (loop.length < 2) {
        say('single-edge-loop')
        continue
      } // a single closed-loop edge is a disc — 1a's job
      // A loop carrying a re-seated occluder chord is a disc cut by a line (a "D");
      // snapping it to one circle would absorb the chord into the arc.
      if (loop.some((ref) => chordEdges.has(ref.edge))) {
        say('carries-chord')
        continue
      }
      let ok = true
      let hasOpen = false
      const raw: Vec[] = []
      for (const ref of loop) {
        const e = byId.get(ref.edge)
        if (!e || e.nodes.length < 2) {
          ok = false
          break
        }
        if (!e.closed) hasOpen = true
        const arc = ref.reversed ? reverseEdgeNodes(e.nodes) : e.nodes
        for (const p of flatten({ nodes: arc, closed: e.closed })) raw.push(p)
      }
      if (!ok || !hasOpen || raw.length < 8) {
        say(ok && !hasOpen ? 'no-open-edge' : 'too-few-points')
        continue
      }
      // A loop that turns a sharp corner is a polygon, not a ring. See CORNER_TURN.
      const turn = maxTurnRad(raw)
      const turnDeg = (turn * 180) / Math.PI
      if (cornerVeto && turn >= CORNER_TURN) {
        say('corner-veto', NaN, NaN, NaN, turnDeg)
        continue
      }
      const c = fitCircle(raw)
      if (!c) {
        say('circle-fit-failed', NaN, NaN, NaN, turnDeg)
        continue
      }
      const dev = maxRadialDev(raw, c)
      const budget = effFidelity(fid, c.r, localScaleK)
      if (c.r <= 2 * fid) {
        say('radius-too-small', c.r, dev, budget, turnDeg)
        continue
      }
      if (dev > budget) {
        say('dev-exceeds-budget', c.r, dev, budget, turnDeg)
        continue
      }
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

  // Co-circular family pass, over the open edges the loop pass did not claim. A ring cut
  // by a crossing is not one loop: the covered ring becomes "C"-shaped faces whose single
  // boundary mixes its outer and inner circles, and its arcs are spread over several
  // faces. So each open edge is fitted on its own, the fits are clustered across the whole
  // document, and each cluster is snapped to its own refit — a ring's outer arcs become
  // one family and its inner arcs another.
  //
  // The corner veto is applied per edge here rather than per loop: a checker cell's side
  // is a straight chain that turns 0° and fits no useful circle, while a ring arc turns
  // smoothly. Together with the per-edge fit budget and FAMILY_MIN_SPAN (a false circle
  // through near-straight edges has a huge radius and almost no sweep), this keeps small
  // polygons from being rounded.
  const perEdge: ArcCand[] = []
  for (const e of edges) {
    if (e.closed || e.nodes.length < 2 || edgeCircle.has(e.id) || chordEdges.has(e.id)) continue
    const pts = flatten({ nodes: e.nodes, closed: false })
    if (pts.length < FAMILY_MIN_PTS) continue
    if (cornerVeto && maxTurnRad(pts, false) >= CORNER_TURN) continue
    const c = fitCircle(pts)
    if (!c || c.r <= 2 * fid) continue
    if (maxRadialDev(pts, c) > effFidelity(fid, c.r, localScaleK)) continue
    perEdge.push({ es: [e], pts, c, span: arcSweep(pts, c) })
  }
  // Join arcs that continue one another first, so clustering sees chain fits rather than
  // poorly conditioned fragment fits.
  const cands = chainArcs
    ? throughChains(perEdge, edges, vertices, fid, localScaleK, width, height, onArcLoop)
    : perEdge
  // Seed and grow, widest arc first, against the family's own refit rather than pairwise
  // (cx, cy, r) comparisons: a short arc's fit is poorly conditioned, while a refit over
  // several arcs is conditioned by their combined sweep and improves each round.
  cands.sort((a, b) => b.span - a.span || a.es[0].id - b.es[0].id)
  const taken = new Array<boolean>(cands.length).fill(false)
  for (let i = 0; i < cands.length; i++) {
    if (taken[i]) continue
    let cf: Circle = cands[i].c
    let group = [i]
    let credible = new Set<number>([i])
    for (let round = 0; round < FAMILY_GROW_ROUNDS; round++) {
      const budget = effFidelity(fid, cf.r, localScaleK)
      const tol = FAMILY_CLUSTER_REL * cf.r
      const grown = [i]
      const viaRadius = new Set<number>([i])
      for (let j = 0; j < cands.length; j++) {
        if (j === i || taken[j]) continue
        // Round 0 has only the seed's own circle, so it groups on a loose (centre, radius)
        // proxy. From round 1 the family circle is the refit and the test is whether the
        // candidate's polyline lies within budget of it. Members can leave as well as join.
        const byRadius =
          round === 0
            ? Math.abs(cands[j].c.r - cf.r) <= tol && Math.hypot(cands[j].c.cx - cf.cx, cands[j].c.cy - cf.cy) <= tol
            : Math.abs(cands[j].c.r - cf.r) <= tol + budget && maxRadialDev(cands[j].pts, cf) <= budget
        // Alternatively the candidate lies on the family circle and sweeps far enough for
        // that to be evidence, since its own radius estimate is the least reliable input.
        // The sweep condition is required: two crossing circles stay within budget of each
        // other for a few degrees around the crossing, so short arcs would be bent onto
        // the wrong circle.
        const joins = byRadius || (cands[j].span >= FAMILY_JOIN_MIN_SPAN && maxRadialDev(cands[j].pts, cf) <= budget)
        if (!joins) continue
        grown.push(j)
        if (byRadius) viaRadius.add(j)
        else viaRadius.delete(j)
      }
      const settled = grown.length === group.length && grown.every((v, n) => v === group[n])
      group = grown
      credible = viaRadius
      if (group.length < 2) break
      if (settled && round > 0) break
      const all: Vec[] = []
      for (const k of group) for (const p of cands[k].pts) all.push(p)
      const refit = fitCircle(all)
      if (!refit) break
      cf = refit
    }
    // A family may not make a member substantially worse than its own fit ("within budget"
    // is not "an improvement"). Offending members are dropped and the circle refitted
    // without them; what remains must still clear the sweep and budget tests below.
    for (let pass = 0; pass < 2 && group.length; pass++) {
      const keep = group.filter((k) => {
        // Only members that joined by agreeing on radius are checked: for a member admitted
        // geometrically, its own circle is the worse estimate and not a fair baseline.
        if (!credible.has(k)) return true
        return (
          maxRadialDev(cands[k].pts, cf) <=
          Math.max(FAMILY_WORSEN_K * maxRadialDev(cands[k].pts, cands[k].c), FAMILY_WORSEN_FLOOR)
        )
      })
      if (keep.length === group.length) break
      group = keep
      if (!group.length) break
      const kept: Vec[] = []
      for (const k of group) for (const p of cands[k].pts) kept.push(p)
      const refit = fitCircle(kept)
      if (!refit) break
      cf = refit
    }
    if (!group.length) continue

    // Evidence is measured by total sweep, not member count: a single long arc (a ring cut
    // only once) constrains its circle better than two short ones, and neither 1a nor 1b
    // would otherwise snap it.
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
    let members = 0
    for (const k of group) {
      taken[k] = true
      for (const e of cands[k].es) {
        members++
        edgeCircle.set(e.id, cf)
        claimVertex(e.startVertex, cf)
        claimVertex(e.endVertex, cf)
      }
    }
    onArcLoop?.({
      label: -1,
      edges: members,
      openEdges: members,
      r: cf.r,
      cx: cf.cx,
      cy: cf.cy,
      ids: group.flatMap((k) => cands[k].es.map((e) => e.id)),
      radialDev: fdev,
      budget: fbudget,
      turnDeg: (sweep * 180) / Math.PI,
      verdict: 'family-snapped',
    })
  }

  if (edgeCircle.size === 0) return snapped

  // Place each claimed vertex on its circle, moving every incident edge endpoint with it
  // (ring arcs are re-emitted below; spokes keep the moved endpoint, so no seam). One
  // circle ⇒ radial snap. Two or more ⇒ the intersection, over all circle pairs, nearest
  // the raw junction. Nearest rather than first-claimed: several crossings can lie within
  // a couple of pixels, and claim order is arbitrary (it would break mirror symmetry).
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
        if (d < bestD) {
          bestD = d
          best = x
        }
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
