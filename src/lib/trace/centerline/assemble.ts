// From stroke runs to stroked paths: what happens at a junction, and where a path ends.
//
// A junction is where the output matters most: an X should be two lines that cross,
// not four that meet. So each run's approach to a node is read as an ARM — its
// direction just outside the junction zone, a line where the arm is straight and a
// circle's tangent where it curves (fit.ts's `armLineOf`) — and the arms are paired by
// how straight the stroke would run through: a rank, like planarThread's through-
// chains, where the straightest continuations win and nothing past a 35° turn is one.
// A paired run continues through the node, keeping its own points (the skeleton is
// right along a symmetric crossing, and on a curve a chord across a cut would kink
// it); an unpaired one is cut back to the junction zone — the medial axis bends
// toward the bisector where an arm STOPS — and ends at the least-squares meet of the
// arm lines (a T's stem, a Y's arms). Exactly two leftover arms are a corner and join
// at that meet; a third arm that is only thinning's branch toward a corner's tip is
// dropped first. Where two split-crossing nodes were welded into one the skeleton in
// between is not the stroke, so every arm there is cut back and re-joined at the meet.
//
// Three readings go past one node's arms (§39.8). Two arms that lie along the ring a
// round HOLE implies are one stroke, bridged along that circle, and what else meets there
// ends on it (a windmill's sails on its hub). A through pair at a junction where other
// arms end is cut back and re-joined along its own tangents, not along the skeleton,
// which bends toward the stem. And junctions joined by runs that never leave their zones
// are read as ONE junction, its outer arms paired into lines through it (a putter's
// double-line shaft crossing a cup), where the bridges cover every link they replace.
//
// Free ends are read by ends.ts (cap and true end); the paths are then fitted (fit.ts)
// and given their width: the median of the run's readable point widths, snapped to the
// picture's stroke width when within 15% of it — a monoline icon comes out as one
// width, not eleven that differ in the second decimal.

import type { PathItem, SubPath, Vec } from '../../path/types'
import type { PlanarFitOptions } from '../planarFit/options.ts'
import type { StrokeRun } from './blobs.ts'
import { applyEnd, dropEndHook, outwardTangent, readEnd, type CapKind, type EndRead } from './ends.ts'
import { armLineOf, fitClosedCentreline, fitOpenCentreline, type FitContext } from './fit.ts'
import type { SkeletonGraph } from './graph.ts'
import type { Hole } from './holes.ts'
import { gaussSmooth, type CoverageField } from './profile.ts'

/** A run end continues into another when the stroke turns no more than this through the node. */
export const THROUGH_DEG = 35
/** Widths within this fraction of the picture's stroke width snap to it. */
export const WIDTH_SNAP = 0.15
/** A free-ending third arm within this angle of a corner's bisector is the corner's tip spur. */
export const TIP_SPUR_DEG = 25
/** A free-ending arm no wider than this share of the strokes it hangs off… */
export const STUB_WIDTH_K = 0.4
/** …and no longer than this many of their widths is a stub of texture, not a stroke. */
export const STUB_LEN_K = 3

export interface StrokePath {
  subPath: SubPath
  width: number
  cap: CapKind
  /** Points the path was fitted from (for diagnostics). */
  polyline: Vec[]
}

interface End {
  run: number
  side: 'a' | 'b'
  node: number
  /** Unit direction INTO the node along the arm. */
  dir: Vec
  /** A point on the arm's line. */
  at: Vec
  /** Index of the first point outside the junction zone (from the run's far end) — the trim point. */
  keep: number
  ok: boolean
  /** The arm's own points between the two junction zones (at most 3 W of them), nearest
   *  the node first — what `ringPair` holds against a ring's circle. */
  ringPts: Vec[]
  /** The run's arc length, and whether its OTHER end is free (a candidate tip spur). */
  len: number
  freeOther: boolean
}

const nodePos = (g: SkeletonGraph, id: number): Vec => ({ x: g.nodes[id].x + 0.5, y: g.nodes[id].y + 0.5 })
const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y)
/** Distance of `p` from the line through `at` along unit `dir`. */
const lineDist = (p: Vec, at: Vec, dir: Vec): number => Math.abs((p.x - at.x) * dir.y - (p.y - at.y) * dir.x)

/** The arm of run `r` at `side`. */
function readArm(g: SkeletonGraph, runs: StrokeRun[], r: number, side: 'a' | 'b', W: number): End {
  const run = runs[r]
  const nodeId = side === 'a' ? run.a : run.b
  const J = nodePos(g, nodeId)
  const zone = Math.max(g.nodes[nodeId].r + 1, 0.6 * W)
  const seq = side === 'a' ? run.pts : run.pts.slice().reverse() // seq[0] nearest the node
  let start = 0
  while (start < seq.length - 1 && dist(seq[start], J) < zone) start++
  let len = 0
  for (let i = 1; i < run.pts.length; i++) len += dist(run.pts[i], run.pts[i - 1])
  const otherNode = side === 'a' ? run.b : run.a
  const otherFill = side === 'a' ? run.blobAtB : run.blobAtA
  const keep = side === 'a' ? start : run.pts.length - 1 - start
  // The arm short of the FAR junction's zone too: there the skeleton bends toward the
  // strokes meeting that node, off any circle the arm is on.
  const ringPts: Vec[] = []
  const farJ = otherNode >= 0 ? nodePos(g, otherNode) : null
  const farZone = otherNode >= 0 ? Math.max(g.nodes[otherNode].r + 1, 0.6 * W) : 0
  for (let k = start, arc = 0; k < seq.length && arc <= 3 * W; k++) {
    if (farJ && dist(seq[k], farJ) < farZone) break
    if (k > start) arc += dist(seq[k], seq[k - 1])
    ringPts.push(seq[k])
  }
  // A ring with four strokes ending on it can leave no point between two junction zones
  // (the windmill's hub: 23 px arcs between welded nodes); then the arm is read up to the
  // far node itself, its bend within the ring test's tolerance.
  if (ringPts.length < 3) {
    ringPts.length = 0
    for (let k = start, arc = 0; k < seq.length && arc <= 3 * W; k++) {
      if (k > start) arc += dist(seq[k], seq[k - 1])
      ringPts.push(seq[k])
    }
  }
  const base = { run: r, side, node: nodeId, keep, len, freeOther: otherNode < 0 && !otherFill, ringPts }
  const line = armLineOf(seq.slice(start), W, Math.max(0.5, 0.06 * W), J)
  if (line) return { ...base, dir: line.dir, at: line.at, ok: true }
  const far = seq[seq.length - 1]
  const dx = J.x - far.x
  const dy = J.y - far.y
  const l = Math.hypot(dx, dy) || 1
  return { ...base, dir: { x: dx / l, y: dy / l }, at: seq[start], ok: false }
}

/** Reach of another stroke's line, in widths, within which an arm's skeleton is bent. */
export const WELD_REACH_W = 1
/** At most this many widths of an arm are cut back at a welded crossing. */
export const WELD_CUT_MAX_W = 4

/** Cut a welded crossing's arm back past every point within `WELD_REACH_W` widths of
 *  another through stroke's line (never more than `WELD_CUT_MAX_W` widths, never past
 *  the run's middle) and re-read its line from there. Mutates `e`. */
function recutWelded(e: End, others: End[], runs: StrokeRun[], W: number): void {
  const pts = runs[e.run].pts
  const n = pts.length
  const step = e.side === 'a' ? 1 : -1
  const reach = WELD_REACH_W * W
  const near = (p: Vec): boolean => others.some((o) => lineDist(p, o.at, o.dir) < reach)
  const mid = n >> 1
  let k = e.keep
  let arc = 0
  while (near(pts[k]) && arc < WELD_CUT_MAX_W * W) {
    const nk = k + step
    if (step > 0 ? nk > mid : nk < mid) break
    arc += dist(pts[nk], pts[k])
    k = nk
  }
  if (k === e.keep) return
  const seq: Vec[] = []
  for (let q = k; q >= 0 && q < n; q += step) seq.push(pts[q])
  const line = armLineOf(seq, W, Math.max(0.5, 0.06 * W))
  e.keep = k
  if (line) {
    e.at = line.at
    e.dir = line.dir
  }
}

/** Least-squares point nearest all the given lines (exact intersection for two). */
function meetLines(lines: { at: Vec; dir: Vec }[], fallback: Vec): Vec {
  let a = 0
  let b = 0
  let d = 0
  let rx = 0
  let ry = 0
  for (const l of lines) {
    const nxx = 1 - l.dir.x * l.dir.x
    const nxy = -l.dir.x * l.dir.y
    const nyy = 1 - l.dir.y * l.dir.y
    a += nxx
    b += nxy
    d += nyy
    rx += nxx * l.at.x + nxy * l.at.y
    ry += nxy * l.at.x + nyy * l.at.y
  }
  const det = a * d - b * b
  if (Math.abs(det) < 1e-9) return fallback
  return { x: (d * rx - b * ry) / det, y: (a * ry - b * rx) / det }
}

interface Circle {
  cx: number
  cy: number
  r: number
}

/** Every point of both arms within this share of the stroke width (or 1.5 px) of the
 *  ring's centreline circle. The skeleton of a ring that strokes end on runs as chords
 *  between the junctions; the two windmills' sit up to 0.11 W and 0.155 W off it. */
export const RING_ARM_TOL_W = 0.2

/**
 * Two arms of ONE ring meeting at a junction from either side: a ring with strokes ending
 * on it. The arms cannot say so themselves. Read a zone's length back around a ring of
 * 1.4 W (a windmill's hub) the two halves' tangents turn 60° through the junction and
 * never pair, and each pairs with a stroke ending there instead; and where the strokes'
 * ink merges with the ring's, the skeleton between junctions is a chord, so no circle can
 * be read from it either (two chords at a junction ARE a corner, to the skeleton). The
 * round HOLE the ring encloses says it (holes.ts): its centreline is the hole's edge
 * grown by half the width. Two arms that lie along that circle, coming at the junction
 * from opposite sides, are one stroke. Returns the centreline circle, or null.
 */
function ringPair(A: End, B: End, J: Vec, W: number, holes: Hole[]): (Circle & { fit: number }) | null {
  if (!A.ok || !B.ok || A.ringPts.length < 3 || B.ringPts.length < 3) return null
  const pts = [...A.ringPts, ...B.ringPts]
  const tol = Math.max(1.5, RING_ARM_TOL_W * W)
  for (const h of holes) {
    // The centreline radius, read from the arms themselves (the ring's own width), and
    // checked against the hole's edge plus half the picture's width.
    const ds = pts.map((p) => Math.hypot(p.x - h.cx, p.y - h.cy)).sort((p, q) => p - q)
    const r = ds[ds.length >> 1]
    if (Math.abs(r - (h.r + W / 2)) > 0.25 * W + 1) continue
    if (ds[0] < r - tol || ds[ds.length - 1] > r + tol) continue
    // How well, as a share of the tolerance: the best-fitting pair at a node wins.
    const c = { cx: h.cx, cy: h.cy, r, fit: Math.max(r - ds[0], ds[ds.length - 1] - r) / tol }
    // The junction sits on the circle, and the arms come at it from OPPOSITE sides.
    if (Math.abs(Math.hypot(J.x - c.cx, J.y - c.cy) - r) > Math.max(2, 0.5 * W)) continue
    const ang = (p: Vec): number => Math.atan2(p.y - c.cy, p.x - c.cx)
    const wrap = (t: number): number => Math.atan2(Math.sin(t), Math.cos(t))
    const tJ = ang(J)
    const dA = wrap(tJ - ang(A.ringPts[0]))
    const dB = wrap(tJ - ang(B.ringPts[0]))
    if (dA * dB >= 0 || Math.abs(dA) > Math.PI / 2 || Math.abs(dB) > Math.PI / 2) continue
    return c
  }
  return null
}

/** Points along `c` strictly between `p` and `q` (the short way), every `step` px of arc;
 *  the radius runs from p's to q's so the bridge meets both ends exactly. */
function arcBridge(c: Circle, p: Vec, q: Vec, step: number): Vec[] {
  const tp = Math.atan2(p.y - c.cy, p.x - c.cx)
  let dt = Math.atan2(q.y - c.cy, q.x - c.cx) - tp
  dt = Math.atan2(Math.sin(dt), Math.cos(dt))
  const rp = Math.hypot(p.x - c.cx, p.y - c.cy)
  const rq = Math.hypot(q.x - c.cx, q.y - c.cy)
  const n = Math.max(1, Math.ceil((Math.abs(dt) * c.r) / step))
  const out: Vec[] = []
  for (let k = 1; k < n; k++) {
    const t = k / n
    const rr = rp + (rq - rp) * t
    out.push({ x: c.cx + rr * Math.cos(tp + dt * t), y: c.cy + rr * Math.sin(tp + dt * t) })
  }
  return out
}

/** Points strictly between `p` (heading `t0`) and `q` (arriving heading `t1`) on the
 *  cubic Hermite curve between them, every `step` px of chord: a straight line when the
 *  two tangents lie along the chord, a smooth bend when they turn. */
function hermiteBridge(p: Vec, t0: Vec, q: Vec, t1: Vec, step: number): Vec[] {
  const m = dist(p, q)
  const n = Math.max(1, Math.ceil(m / step))
  const out: Vec[] = []
  for (let k = 1; k < n; k++) {
    const s = k / n
    const s2 = s * s
    const s3 = s2 * s
    const h00 = 2 * s3 - 3 * s2 + 1
    const h10 = s3 - 2 * s2 + s
    const h01 = -2 * s3 + 3 * s2
    const h11 = s3 - s2
    out.push({
      x: h00 * p.x + h10 * m * t0.x + h01 * q.x + h11 * m * t1.x,
      y: h00 * p.y + h10 * m * t0.y + h01 * q.y + h11 * m * t1.y,
    })
  }
  return out
}

/** Points strictly between `p` and `q` on the segment, about one pixel apart. */
function lineBridge(p: Vec, q: Vec): Vec[] {
  const n = Math.ceil(dist(p, q))
  const out: Vec[] = []
  for (let k = 1; k < n; k++) out.push({ x: p.x + ((q.x - p.x) * k) / n, y: p.y + ((q.y - p.y) * k) / n })
  return out
}

/** Where a line meets a circle, the crossing nearest `near`; null when it misses. */
function ringMeet(c: Circle, l: { at: Vec; dir: Vec }, near: Vec): Vec | null {
  const fx = l.at.x - c.cx
  const fy = l.at.y - c.cy
  const b = fx * l.dir.x + fy * l.dir.y
  const disc = b * b - (fx * fx + fy * fy - c.r * c.r)
  if (disc < 0) return null
  const sq = Math.sqrt(disc)
  const p1 = { x: l.at.x + (-b - sq) * l.dir.x, y: l.at.y + (-b - sq) * l.dir.y }
  const p2 = { x: l.at.x + (-b + sq) * l.dir.x, y: l.at.y + (-b + sq) * l.dir.y }
  return dist(p1, near) <= dist(p2, near) ? p1 : p2
}

/** Junctions read as one at most: a crossing of two double lines is four. */
export const CLUSTER_MAX_NODES = 6
/** Cluster readings tried per picture, splits included. */
export const CLUSTER_TRIES = 256
/** A run between two junctions no longer than this many of its own widths can be a link. */
export const CLUSTER_LINK_W = 3
/** A link's points must lie within this share of its width of some pair's bridge. */
export const CLUSTER_COVER_W = 0.5

/** Every point near the ring a hole's edge implies: within the ring pairing's tolerance
 *  and a quarter width more, since a link is read through its junctions' zones. */
function onRing(pts: Vec[], h: Hole, W: number): boolean {
  if (pts.length === 0) return false
  const r = h.r + W / 2
  const tol = Math.max(1.5, RING_ARM_TOL_W * W) + 0.25 * W
  return pts.every((p) => Math.abs(Math.hypot(p.x - h.cx, p.y - h.cy) - r) <= tol)
}

/** A run with readable widths along at least half a width of its points, their median
 *  at least 0.75 of the given arms' — a stroke, however short. */
function readsAsStroke(run: StrokeRun, armWidths: number[]): boolean {
  const ws = Array.from(run.w).filter((w) => Number.isFinite(w) && w > 0)
  const wArm = Math.min(...armWidths)
  if (ws.length < Math.max(3, 0.5 * wArm)) return false
  ws.sort((a, b) => a - b)
  return ws[ws.length >> 1] >= 0.75 * wArm
}

/** Median readable width of a run, or `W`. */
function widthOfRun(run: StrokeRun, W: number): number {
  const ws = Array.from(run.w)
    .filter((w) => Number.isFinite(w) && w > 0)
    .sort((a, b) => a - b)
  return ws.length ? ws[ws.length >> 1] : W
}

/**
 * Groups of two or more junctions joined by LINKS — runs between two different nodes that
 * never leave the junctions' own zones, or are no longer than three of their own widths
 * (a shallow crossing's split) — and not an arc of a ring.
 */
function junctionClusters(
  g: SkeletonGraph,
  runs: StrokeRun[],
  endsAt: Map<number, End[]>,
  W: number,
  holes: Hole[],
): { nodes: number[]; links: Set<number> }[] {
  const zone = (id: number): number => Math.max(g.nodes[id].r + 1, 0.6 * W)
  const parent = new Map<number, number>()
  const find = (i: number): number => {
    let r = i
    while (parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  for (const id of endsAt.keys()) parent.set(id, id)
  const linkRuns: number[] = []
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r]
    if (run.closed || run.a < 0 || run.b < 0 || run.a === run.b) continue
    if (run.blobAtA || run.blobAtB || !parent.has(run.a) || !parent.has(run.b)) continue
    let len = 0
    for (let k = 1; k < run.pts.length; k++) len += dist(run.pts[k], run.pts[k - 1])
    // Inside both zones — or within three of its OWN widths: a crossing at a shallow
    // angle splits into junctions w / sin θ apart (84 px for 32 px strokes at 36°), and
    // the zones are sized by the picture's width, which on mixed widths is another's.
    if (len > Math.max(zone(run.a) + zone(run.b) + 0.5 * W, CLUSTER_LINK_W * widthOfRun(run, W))) continue
    // An arc of a ring around a round hole is the ring, however short (holes.ts).
    if (holes.some((h) => onRing(run.pts, h, W))) continue
    linkRuns.push(r)
    parent.set(find(run.a), find(run.b))
  }
  const groups = new Map<number, { nodes: number[]; links: Set<number> }>()
  for (const id of endsAt.keys()) {
    const root = find(id)
    const gr = groups.get(root) ?? { nodes: [], links: new Set<number>() }
    gr.nodes.push(id)
    groups.set(root, gr)
  }
  for (const r of linkRuns) groups.get(find(runs[r].a))!.links.add(r)
  return [...groups.values()].filter((gr) => gr.nodes.length >= 2)
}

/** The connected parts of a set of nodes under the given links. */
function splitCluster(
  nodes: number[],
  links: Set<number>,
  runs: StrokeRun[],
): { nodes: number[]; links: Set<number> }[] {
  const parent = new Map<number, number>(nodes.map((id) => [id, id]))
  const find = (i: number): number => {
    let r = i
    while (parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  for (const r of links) parent.set(find(runs[r].a), find(runs[r].b))
  const parts = new Map<number, { nodes: number[]; links: Set<number> }>()
  for (const id of nodes) {
    const root = find(id)
    const part = parts.get(root) ?? { nodes: [], links: new Set<number>() }
    part.nodes.push(id)
    parts.set(root, part)
  }
  for (const r of links) parts.get(find(runs[r].a))!.links.add(r)
  return [...parts.values()]
}

/**
 * Pair a cluster's outer arms into lines through it: a pair turns no more than the
 * through bar AND lies on one line — each arm's point within half its width (plus a
 * tenth of the way across) of the other's line, and each ahead of the other, as the
 * pairing across a fill reads it. Ranked by that line fit. Null unless at least two lines
 * go through and at most one arm is left to end inside.
 */
function clusterPairs(
  outer: End[],
  runs: StrokeRun[],
  W: number,
  cosThrough: number,
): { pairs: [number, number][]; unpaired: number[] } | null {
  if (outer.length < 4) return null
  const lateral = (p: Vec, at: Vec, dir: Vec): number => Math.abs((p.x - at.x) * dir.y - (p.y - at.y) * dir.x)
  const cands: { i: number; j: number; off: number }[] = []
  for (let i = 0; i < outer.length; i++) {
    const A = outer[i]
    if (!A.ok) continue
    for (let j = i + 1; j < outer.length; j++) {
      const B = outer[j]
      if (!B.ok || A.run === B.run) continue
      const cos = -(A.dir.x * B.dir.x + A.dir.y * B.dir.y)
      if (cos < cosThrough) continue
      const ab = { x: B.at.x - A.at.x, y: B.at.y - A.at.y }
      if (ab.x * A.dir.x + ab.y * A.dir.y <= 0 || -(ab.x * B.dir.x + ab.y * B.dir.y) <= 0) continue
      const tol =
        Math.max(1.5, 0.25 * (widthOfRun(runs[A.run], W) + widthOfRun(runs[B.run], W))) + 0.1 * Math.hypot(ab.x, ab.y)
      const off = Math.max(lateral(B.at, A.at, A.dir), lateral(A.at, B.at, B.dir)) / tol
      if (off > 1) continue
      cands.push({ i, j, off })
    }
  }
  // Best on ONE line first: two parallel strokes a gap apart are equally straight with
  // their own continuation and with the other's, and only the line tells them apart.
  cands.sort((p, q) => p.off - q.off)
  const used = new Set<number>()
  const pairs: [number, number][] = []
  for (const c of cands) {
    if (used.has(c.i) || used.has(c.j)) continue
    used.add(c.i)
    used.add(c.j)
    pairs.push([c.i, c.j])
  }
  const unpaired = outer.map((_, i) => i).filter((i) => !used.has(i))
  if (pairs.length < 2 || unpaired.length > 1) return null
  return { pairs, unpaired }
}

export interface AssembleResult {
  paths: StrokePath[]
  junctions: number
}

/** One junction's record (bench/centerlineDiag.ts prints these). */
export interface JunctionDiag {
  /** Skeleton centroid, and where the arms' lines meet. */
  at: Vec
  meet: Vec
  welded: boolean
  arms: { run: number; side: 'a' | 'b'; dir: Vec; at: Vec; ok: boolean; len: number }[]
  /** Indices into `arms` paired as continuations, and the corner pair if any. */
  through: [number, number][]
  corner: [number, number] | null
  /** Runs dropped as a corner's tip spur. */
  dropped: number[]
}

export function assembleStrokes(
  g: SkeletonGraph,
  runs: StrokeRun[],
  W: number,
  f: CoverageField,
  blobMask: Uint8Array | null,
  dt: Float32Array,
  holes: Hole[],
  opts: PlanarFitOptions,
  fidelity: number,
  onCorner?: FitContext['onCorner'],
  onJunction?: (r: JunctionDiag) => void,
): AssembleResult {
  const cosThrough = Math.cos((THROUGH_DEG * Math.PI) / 180)
  const cosTip = Math.cos((TIP_SPUR_DEG * Math.PI) / 180)
  // Two arms are a corner when the stroke turns by at least the fitter's sharp bar
  // between them: the angle between the arms' INTO-node directions is then at most
  // 180° − cornerTurnDeg, so their dot product is at least cos of that.
  const cosCorner = Math.cos(((180 - opts.cornerTurnDeg) * Math.PI) / 180)
  // Every run end at a node.
  const endsAt = new Map<number, End[]>()
  const endOf = new Map<string, End>()
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r]
    if (run.closed) continue
    for (const side of ['a', 'b'] as const) {
      const nodeId = side === 'a' ? run.a : run.b
      if (nodeId < 0 || !g.nodes[nodeId].alive) continue
      const e = readArm(g, runs, r, side, W)
      endOf.set(`${r}${side}`, e)
      const list = endsAt.get(nodeId) ?? []
      list.push(e)
      endsAt.set(nodeId, list)
    }
  }

  // Pair arms per node; place the junction.
  const partner = new Map<string, string>()
  const junctionAt = new Map<number, Vec>()
  const clustered = new Set<number>()
  /** Run ends paired as two arcs of one circle, and that circle. */
  const ringOf = new Map<string, Circle>()
  /** Run ends paired THROUGH a junction where other arms end: re-joined by a bridge along
   *  the two arms' own tangents, not by the skeleton between them. */
  const bridged = new Set<string>()
  /** Run ends paired as a CORNER (not a through continuation). */
  const cornerJoin = new Set<string>()
  /** Run ends paired across a fill, bridged by a straight chord under it. */
  const acrossFill = new Set<string>()
  const dead = new Set<number>()
  let junctions = 0

  // Micro-stubs (§39.8). Faint texture touching a stroke — the dimples of a golf ball
  // drawn against its outline — thins into a branch off the stroke that pruning keeps
  // (it reaches past the junction's radius), and the profile reads its partial coverage
  // as a stroke a quarter as wide: a 6 px path at 2.66 beside 8.5 px strokes. Measured
  // on the field report's sheets those run 0.22–0.31 of the width of the strokes they
  // hang off and 1.8–2.4 of those widths long; the thinner strokes an icon really draws
  // read 0.53–0.6 and run many widths, a dash or a dot touches nothing, and "shorter than
  // the neighbour's width" (the first guess) catches none of the stubs. Dropped before
  // any pairing, so the stroke they hung off pairs through as if they were never there.
  for (const [, ends] of endsAt) {
    if (ends.length < 2) continue
    for (const S of ends) {
      if (!S.freeOther) continue
      const others = ends.filter((e) => e !== S && e.run !== S.run).map((e) => widthOfRun(runs[e.run], W))
      if (others.length === 0) continue
      others.sort((a, b) => a - b)
      const wN = others[others.length >> 1]
      if (widthOfRun(runs[S.run], W) > STUB_WIDTH_K * wN || S.len > STUB_LEN_K * wN) continue
      dead.add(S.run)
    }
  }
  for (const [id, ends] of endsAt)
    endsAt.set(
      id,
      ends.filter((e) => !dead.has(e.run)),
    )

  // Junction CLUSTERS first: several junctions joined by runs too short to leave their
  // zones (a stroke crossing two others a gap apart — a putter's double-line shaft — or
  // a split crossing beside a third arm). Read node by node, those links are taken for
  // arms and the strokes swap lines through them; read as ONE junction, only its outer
  // arms count, and lines through it pair by direction AND by lying on one line, so
  // two parallel strokes a gap apart cannot swap (`clusterPairs`). Accepted only where
  // the bridges of the pairs cover every link — the junction then loses no ink — else
  // its nodes pair one by one as before. A ring's arcs between the strokes ending on it
  // are never links (`onRing`): straight strokes ending on a small ring pass within half
  // a width of its quarter arcs, and would take the ring for their own crossing.
  const queue = junctionClusters(g, runs, endsAt, W, holes)
  // A cluster that does not read as lines through it is split — each of its links
  // dropped in turn, each part tried again: a shallow crossing's two junctions may sit
  // one link from an unrelated one (a club head's foot below the crossing). Clusters are
  // a handful of nodes, so the splits are few.
  const tried = new Set<string>()
  // Bounded: a pathological skeleton (a QR block's lattice of junctions) has as many
  // connected node subsets as it likes; clusters are only ever worth a few nodes.
  let budget = CLUSTER_TRIES
  const reject = (cl: { nodes: number[]; links: Set<number> }): void => {
    if (cl.nodes.length > CLUSTER_MAX_NODES) return
    for (const drop of cl.links) {
      const links = new Set([...cl.links].filter((r) => r !== drop))
      for (const part of splitCluster(cl.nodes, links, runs)) {
        if (part.nodes.length < 2) continue
        const key = part.nodes
          .slice()
          .sort((a, b) => a - b)
          .join(',')
        if (tried.has(key)) continue
        tried.add(key)
        queue.push(part)
      }
    }
  }
  for (const cl of queue)
    tried.add(
      cl.nodes
        .slice()
        .sort((a, b) => a - b)
        .join(','),
    )
  while (queue.length && budget-- > 0) {
    const cl = queue.shift()!
    if (cl.nodes.length > CLUSTER_MAX_NODES) {
      reject(cl)
      continue
    }
    if (cl.nodes.some((id) => clustered.has(id))) continue
    const outer: End[] = []
    for (const id of cl.nodes) for (const e of endsAt.get(id)!) if (!cl.links.has(e.run)) outer.push(e)
    const res = clusterPairs(outer, runs, W, cosThrough)
    if (!res) {
      reject(cl)
      continue
    }
    // Each outer arm is cut back out of EVERY junction zone in the cluster, not only its
    // own: a neighbouring junction bends its last points as much as its own does.
    const zones = cl.nodes.map((id) => ({ at: nodePos(g, id), r: Math.max(g.nodes[id].r + 1, 0.6 * W) }))
    const cutKeep = new Map<End, number>()
    for (const e of outer) {
      const pts = runs[e.run].pts
      const n = pts.length
      let k = e.keep
      const step = e.side === 'a' ? 1 : -1
      while (k + step >= 0 && k + step < n && zones.some((z) => dist(pts[k], z.at) < z.r)) k += step
      cutKeep.set(e, k)
    }
    // Coverage: every point of every link within reach of some pair's bridge.
    const bridges: Vec[] = []
    for (const [i, j] of res.pairs) {
      const A = outer[i]
      const B = outer[j]
      const pA = runs[A.run].pts[cutKeep.get(A)!]
      const pB = runs[B.run].pts[cutKeep.get(B)!]
      bridges.push(pA, ...hermiteBridge(pA, A.dir, pB, { x: -B.dir.x, y: -B.dir.y }, 1), pB)
    }
    let covered = true
    for (const r of cl.links) {
      // A bridge that replaces a link runs along it, within half the link's width.
      const reach = Math.max(1.5, CLUSTER_COVER_W * widthOfRun(runs[r], W))
      for (const p of runs[r].pts)
        if (!bridges.some((q) => dist(p, q) <= reach)) {
          covered = false
          break
        }
      if (!covered) break
    }
    if (!covered) {
      reject(cl)
      continue
    }
    for (const [e, k] of cutKeep) e.keep = k
    for (const r of cl.links) dead.add(r)
    for (const [i, j] of res.pairs) {
      const ka = `${outer[i].run}${outer[i].side}`
      const kb = `${outer[j].run}${outer[j].side}`
      partner.set(ka, kb)
      partner.set(kb, ka)
      bridged.add(ka)
      bridged.add(kb)
    }
    // A stroke ending in the cluster ends where its line meets the nearest pair's chord.
    for (const id of cl.nodes) {
      clustered.add(id)
      junctionAt.set(id, nodePos(g, id))
    }
    for (const u of res.unpaired) {
      const e = outer[u]
      let best: Vec | null = null
      let bd = Infinity
      for (const [i, j] of res.pairs) {
        const pA = runs[outer[i].run].pts[outer[i].keep]
        const pB = runs[outer[j].run].pts[outer[j].keep]
        const l = dist(pA, pB)
        if (l < 1e-6) continue
        const m = meetLines(
          [
            { at: e.at, dir: e.dir },
            { at: pA, dir: { x: (pB.x - pA.x) / l, y: (pB.y - pA.y) / l } },
          ],
          e.at,
        )
        const d = dist(m, nodePos(g, e.node))
        if (d < bd) {
          bd = d
          best = m
        }
      }
      if (best && bd <= Math.max(2, 1.5 * g.nodes[e.node].r + 1)) junctionAt.set(e.node, best)
    }
    junctions++
    onJunction?.({
      at: nodePos(g, cl.nodes[0]),
      meet: nodePos(g, cl.nodes[0]),
      welded: true,
      arms: outer.map((e) => ({ run: e.run, side: e.side, dir: e.dir, at: e.at, ok: e.ok, len: e.len })),
      through: res.pairs,
      corner: null,
      dropped: [...cl.links],
    })
  }

  for (const [nodeId, endsAll] of endsAt) {
    if (clustered.has(nodeId)) continue
    junctions++
    const node = g.nodes[nodeId]
    const centroid = nodePos(g, nodeId)
    let ends = endsAll
    // Tip spur: three arms, one a free-ending run lying along the bisector of the
    // other two (outward, toward a miter tip; or inward, toward the concave corner —
    // the medial axis has a branch to every reflex vertex), no longer than the way
    // to that corner.
    if (ends.length === 3) {
      for (let si = 0; si < 3; si++) {
        const S = ends[si]
        if (!S.freeOther) continue
        const [A, B] = ends.filter((_, i) => i !== si)
        if (!A.ok || !B.ok) continue
        // Two arcs of one circle are no corner, so the third arm is no corner's tip.
        if (ringPair(A, B, centroid, W, holes)) continue
        // Only a CORNER has a tip: the two arms must turn by at least the sharp bar
        // (an arc's two halves meeting at its top read as a 150° pair, and the nub on
        // an umbrella is a real stroke, not that pair's spur).
        const cosI = A.dir.x * B.dir.x + A.dir.y * B.dir.y
        if (cosI < cosCorner) continue
        // Shorter than a stroke is wide: thinning's branch toward the join, whatever
        // direction its two pixels happen to read (a run that short is unreadable) —
        // unless it READS as a stroke, its own width measured along it as wide as the
        // corner's arms: where an arrowhead's arms meet its stem at one tip, an arm two
        // widths long sits under this bar and was dropped as the tip of the corner the
        // other arm and the stem make (§39.8).
        const stub =
          S.len <= 2 * node.r + 2 &&
          !readsAsStroke(
            runs[S.run],
            [A, B].map((e) => widthOfRun(runs[e.run], W)),
          )
        if (!stub) {
          if (!S.ok) continue
          const bx = A.dir.x + B.dir.x
          const by = A.dir.y + B.dir.y
          const bl = Math.hypot(bx, by)
          if (bl < 1e-6) continue
          if (Math.abs((S.dir.x * bx + S.dir.y * by) / bl) < cosTip) continue
          const apex = meetLines([A, B], centroid)
          const half = Math.max(0.05, Math.acos(Math.max(-1, Math.min(1, cosI))) / 2)
          const bound = node.r / Math.sin(half) + dist(apex, centroid) + 2 * node.r + 2
          if (S.len > bound) continue
        }
        dead.add(S.run)
        ends = [A, B]
        break
      }
    }
    // Through pairs by rank — a ring's two ends may pair with each other (that is how a
    // stroked circle with a stem stays one circle).
    // An arm too short to read (`ok` false — a two-pixel stub) has a guessed direction and
    // never pairs: it ends at the meet on its own. Paired, a stub at a zigzag's tip took
    // one arm as its continuation and left the other to end there, splitting the stroke.
    // Two arcs of one ring rank above any tangent (2 less their misfit, a share of the
    // tolerance), so they take their pair before any straight continuation is weighed.
    const cands: { i: number; j: number; cos: number; ring?: Circle }[] = []
    for (let i = 0; i < ends.length; i++) {
      if (!ends[i].ok) continue
      for (let j = i + 1; j < ends.length; j++) {
        if (!ends[j].ok) continue
        const ring = ringPair(ends[i], ends[j], centroid, W, holes)
        if (ring) {
          cands.push({ i, j, cos: 2 - ring.fit, ring })
          continue
        }
        const cos = -(ends[i].dir.x * ends[j].dir.x + ends[i].dir.y * ends[j].dir.y)
        if (cos >= cosThrough) cands.push({ i, j, cos })
      }
    }
    cands.sort((p, q) => q.cos - p.cos)
    const used = new Set<number>()
    const pairUp = (i: number, j: number): void => {
      used.add(i)
      used.add(j)
      partner.set(`${ends[i].run}${ends[i].side}`, `${ends[j].run}${ends[j].side}`)
      partner.set(`${ends[j].run}${ends[j].side}`, `${ends[i].run}${ends[i].side}`)
    }
    const through: [number, number][] = []
    let ring: Circle | null = null
    const inRing = new Set<number>()
    for (const c of cands) {
      if (used.has(c.i) || used.has(c.j)) continue
      pairUp(c.i, c.j)
      through.push([c.i, c.j])
      if (c.ring) {
        ringOf.set(`${ends[c.i].run}${ends[c.i].side}`, c.ring)
        ringOf.set(`${ends[c.j].run}${ends[c.j].side}`, c.ring)
        if (!ring) {
          ring = c.ring
          inRing.add(c.i)
          inRing.add(c.j)
        }
      }
    }
    // A corner: exactly two arms left over (a K's two strokes off one point, a V) —
    // unless the node sits on a fill, where two leftover arms are two strokes that
    // each END in the fill (a stem and a staff line meeting inside a note head), not
    // a corner of one another.
    const left = ends.map((_, i) => i).filter((i) => !used.has(i))
    let cornerPair: [number, number] | null = null
    const onFill =
      blobMask !== null &&
      node.pixels.some(
        (px) => blobMask[px] === 1 || blobMask[Math.floor(centroid.y) * f.width + Math.floor(centroid.x)] === 1,
      )
    // An arrowhead or a Y: three arms left, ONE on the bisector of the other two, which
    // turn by at least the sharp bar. The two are a V and the third ends at its apex —
    // the reading the tip-spur rule above makes before it drops a short bisector arm,
    // here for one long enough to keep (an arrow's stem). Read as three ends, an
    // arrowhead came back as three strokes meeting at a point. A symmetric Y, where
    // every arm qualifies, stays three.
    let corner2 = left.length === 2 ? left : null
    if (left.length === 3) {
      const vs: number[][] = []
      for (let si = 0; si < 3; si++) {
        const S = ends[left[si]]
        const [ia, ib] = left.filter((_, k) => k !== si)
        const A = ends[ia]
        const B = ends[ib]
        if (!S.ok || !A.ok || !B.ok) continue
        if (A.dir.x * B.dir.x + A.dir.y * B.dir.y < cosCorner) continue
        const bx = A.dir.x + B.dir.x
        const by = A.dir.y + B.dir.y
        const bl = Math.hypot(bx, by)
        if (bl < 1e-6 || Math.abs((S.dir.x * bx + S.dir.y * by) / bl) < cosTip) continue
        vs.push([ia, ib])
      }
      if (vs.length === 1) corner2 = vs[0]
    }
    if (corner2 && !onFill) {
      pairUp(corner2[0], corner2[1])
      cornerJoin.add(`${ends[corner2[0]].run}${ends[corner2[0]].side}`)
      cornerJoin.add(`${ends[corner2[1]].run}${ends[corner2[1]].side}`)
      cornerPair = [corner2[0], corner2[1]]
    }
    // A through pair where other arms END (a T's bar, a sail edge passing the top of a
    // wall) is not a symmetric crossing: the medial axis of the bar bends toward the stem
    // across the zone, and kept, that bend is drawn — a notch in a straight edge. Its
    // ends are cut back and joined along their own tangents instead.
    if (left.length > 0 && !node.welded)
      for (const [i, j] of through) {
        if (inRing.has(i)) continue
        bridged.add(`${ends[i].run}${ends[i].side}`)
        bridged.add(`${ends[j].run}${ends[j].side}`)
      }
    // A welded crossing: each through pair is one stroke passing under the others, and
    // its skeleton bends toward theirs as long as their ink is within reach — at a 33° X
    // that is nearly two widths out, far past the node's zone. Cut each arm back to where no
    // other pair's line comes within a width of it, re-read its line there, and join the
    // pair along those lines. Through the meet instead, the bent arms were kept and
    // chorded to the junction point: two strokes kinking toward each other (§39.8).
    if (node.welded && through.length >= 2)
      for (const [i, j] of through) {
        if (inRing.has(i)) continue
        const others = through
          .filter(([a]) => a !== i)
          .flatMap(([a, b]) => [ends[a], ends[b]])
          .filter((e) => e.ok)
        if (others.length === 0) continue
        for (const k of [i, j]) recutWelded(ends[k], others, runs, W)
        bridged.add(`${ends[i].run}${ends[i].side}`)
        bridged.add(`${ends[j].run}${ends[j].side}`)
      }
    // Junction point: the least-squares meet of every arm's own line. On a ring, the
    // ring's tangents (read a zone back round the circle) would drag that meet into the
    // hole: the other arms' meet is placed ON the ring instead, where they end.
    const lines = ends.filter((e, i) => e.ok && !inRing.has(i)).map((e) => ({ at: e.at, dir: e.dir }))
    let J = ring
      ? lines.length >= 2
        ? meetLines(lines, centroid)
        : lines.length === 1
          ? (ringMeet(ring, lines[0], centroid) ?? centroid)
          : centroid
      : lines.length >= 2
        ? meetLines(lines, centroid)
        : centroid
    // A meet far outside the junction's own zone is an ill-conditioned set of near-
    // parallel lines; the centroid is the honest answer then.
    if (dist(J, centroid) > Math.max(2, 1.5 * node.r + 1)) J = centroid
    if (ring) {
      const d = Math.hypot(J.x - ring.cx, J.y - ring.cy) || 1
      J = { x: ring.cx + ((J.x - ring.cx) / d) * ring.r, y: ring.cy + ((J.y - ring.cy) / d) * ring.r }
    }
    junctionAt.set(nodeId, J)
    onJunction?.({
      at: centroid,
      meet: J,
      welded: node.welded === true,
      arms: ends.map((e) => ({ run: e.run, side: e.side, dir: e.dir, at: e.at, ok: e.ok, len: e.len })),
      through,
      corner: cornerPair,
      dropped: endsAll.filter((e) => dead.has(e.run)).map((e) => e.run),
    })
  }
  for (const r of dead) {
    partner.delete(`${r}a`)
    partner.delete(`${r}b`)
  }

  // Through a FILL: a stroke that runs into a fill and one that leaves it on the far
  // side, collinear, are one stroke drawn under the fill — a staff line through a note
  // head. Inside the fill the skeleton is the fill's own (a thicket with junctions), so
  // the chain-level bridging in `strokeRuns` cannot see across it; this pairs the cut
  // ends instead, by the same through bar as a junction, plus a lateral bar: the two
  // ends must lie on one line, or a stem coming down into the head at 27° would take
  // the staff line as its continuation (it did, through the junction inside the head,
  // before the head's mask reached its rim).
  if (blobMask) {
    const comp = fillComponents(blobMask, f.width, f.height)
    type FillEnd = { key: string; at: Vec; dir: Vec; comp: number }
    const fillEnds: FillEnd[] = []
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r]
      if (run.closed || dead.has(r) || run.pts.length < 2) continue
      for (const side of ['a', 'b'] as const) {
        const key = `${r}${side}`
        if (partner.has(key)) continue
        const at = side === 'a' ? run.pts[0] : run.pts[run.pts.length - 1]
        // Read over three widths: the last two points before a cut are the skeleton
        // bending into the fill's own axis, and over 2 W that read 8° off on a 2 px
        // staff line — enough to fail the lateral bar below at 14 px.
        const dir = outwardTangent(run.pts, side, Math.max(6, 3 * W))
        if (!dir) continue
        // The fill this end runs into: the first fill pixel along its outward direction
        // within a stroke width (the run was cut at the fill's edge, or ends at a
        // junction just inside it).
        let c = 0
        for (let step = 0; step <= W + 1 && c === 0; step += 0.5) {
          const px = Math.floor(at.x + dir.x * step)
          const py = Math.floor(at.y + dir.y * step)
          if (px < 0 || py < 0 || px >= f.width || py >= f.height) break
          c = comp[py * f.width + px]
        }
        if (c === 0) continue
        fillEnds.push({ key, at, dir, comp: c })
      }
    }
    const lateral = (p: Vec, at: Vec, dir: Vec): number => Math.abs((p.x - at.x) * dir.y - (p.y - at.y) * dir.x)
    // Half a width, plus a tenth of the way across the fill (a 6° read of the end's
    // direction): a stem coming into a head at 27° is 5 px off the staff line's line
    // over 20 px and stays out; the staff line's other half is 0.4 px off and pairs.
    const tolAt = (across: number): number => Math.max(1.5, 0.5 * W) + 0.1 * across
    const cands: { i: number; j: number; cos: number }[] = []
    for (let i = 0; i < fillEnds.length; i++) {
      for (let j = i + 1; j < fillEnds.length; j++) {
        const A = fillEnds[i]
        const B = fillEnds[j]
        if (A.comp !== B.comp) continue
        const cos = -(A.dir.x * B.dir.x + A.dir.y * B.dir.y)
        if (cos < cosThrough) continue
        // Each end must lie AHEAD of the other, across the fill, and on its line.
        const ab = { x: B.at.x - A.at.x, y: B.at.y - A.at.y }
        if (ab.x * A.dir.x + ab.y * A.dir.y <= 0 || -(ab.x * B.dir.x + ab.y * B.dir.y) <= 0) continue
        const tol = tolAt(Math.hypot(ab.x, ab.y))
        if (lateral(B.at, A.at, A.dir) > tol || lateral(A.at, B.at, B.dir) > tol) continue
        cands.push({ i, j, cos })
      }
    }
    cands.sort((p, q) => q.cos - p.cos)
    const usedFill = new Set<number>()
    for (const c of cands) {
      if (usedFill.has(c.i) || usedFill.has(c.j)) continue
      usedFill.add(c.i)
      usedFill.add(c.j)
      partner.set(fillEnds[c.i].key, fillEnds[c.j].key)
      partner.set(fillEnds[c.j].key, fillEnds[c.i].key)
      acrossFill.add(fillEnds[c.i].key)
      acrossFill.add(fillEnds[c.j].key)
    }
  }

  // A run's points as they enter a path. An end that CONTINUES straight through a
  // plain junction keeps every point — along a symmetric crossing the skeleton is the
  // stroke, and on a curve (a ring, the gear) cutting it back and bridging the gap
  // with a chord would kink it. Every other end is cut back to its zone and re-joined
  // at the junction point: an arm that STOPS at a node bends toward the bisector over
  // its last half-width (the medial axis of an acute T), a corner's two arms both do,
  // and at a welded node the skeleton in between runs along the overlap.
  const cutBack = (key: string): boolean => {
    const e = endOf.get(key)
    if (!e) return false
    if (g.nodes[e.node].welded) return true
    if (!partner.has(key)) return true
    // Inside the zone a ring's skeleton bends toward the strokes ending on it, and a
    // bar's toward the stem.
    if (ringOf.has(key) || bridged.has(key)) return true
    return cornerJoin.has(key)
  }
  const trimmed = (r: number): { pts: Vec[]; w: number[] } => {
    const run = runs[r]
    const ea = endOf.get(`${r}a`)
    const eb = endOf.get(`${r}b`)
    let lo = ea && cutBack(`${r}a`) ? ea.keep : 0
    let hi = eb && cutBack(`${r}b`) ? eb.keep : run.pts.length - 1
    if (hi - lo < 1) {
      lo = Math.min(lo, Math.max(0, (run.pts.length >> 1) - 1))
      hi = Math.max(hi, Math.min(run.pts.length - 1, (run.pts.length >> 1) + 1))
    }
    const pts: Vec[] = []
    const w: number[] = []
    // A run paired along the SAME ring at both ends is an arc of that ring: between the
    // junctions on it the skeleton runs as a chord (the strokes' ink merged with the
    // ring's), and the points go onto the circle, as the arc bridges at its ends do.
    const ra = ringOf.get(`${r}a`)
    const rb = ringOf.get(`${r}b`)
    const arc = ra && rb && ra.cx === rb.cx && ra.cy === rb.cy ? { ...ra, r: (ra.r + rb.r) / 2 } : null
    for (let k = lo; k <= hi; k++) {
      const p = run.pts[k]
      if (arc) {
        const d = Math.hypot(p.x - arc.cx, p.y - arc.cy) || 1
        pts.push({ x: arc.cx + ((p.x - arc.cx) / d) * arc.r, y: arc.cy + ((p.y - arc.cy) / d) * arc.r })
      } else pts.push(p)
      w.push(run.w[k])
    }
    return { pts, w }
  }

  const visited = new Set<number>()
  const paths: StrokePath[] = []
  const widthOf = (ws: number[]): number => {
    const fin = ws.filter((w) => Number.isFinite(w) && w > 0).sort((p, q) => p - q)
    if (fin.length === 0) return W
    const med = fin[fin.length >> 1]
    return Math.abs(med - W) <= WIDTH_SNAP * W ? W : med
  }

  const emit = (pts: Vec[], ws: number[], closed: boolean, capA: CapKind, capB: CapKind): void => {
    if (pts.length < 2) return
    const width = Math.round(widthOf(ws) * 100) / 100
    if (!(width > 0)) return
    // Smooth the staircase residue (±0.5 px) at a scale well below the stroke width;
    // corners survive because the detector reads turns over ±max(4, W) points, past σ,
    // and the apex rebuild's zone clears 3σ (fit.ts).
    const sigma = Math.max(0.6, Math.min(2, 0.15 * width))
    const sm = gaussSmooth(pts, sigma, closed)
    const cap: CapKind = capA === capB ? capA : 'round'
    const ctx: FitContext = { width, dt, rasterWidth: f.width, rasterHeight: f.height, sigma, onCorner }
    if (closed) {
      const sp = fitClosedCentreline(sm, width, opts, ctx, fidelity)
      if (sp) paths.push({ subPath: sp, width, cap, polyline: sm })
      return
    }
    const nodes = fitOpenCentreline(sm, width, opts, ctx)
    if (nodes.length >= 2) paths.push({ subPath: { nodes, closed: false }, width, cap, polyline: sm })
  }

  // Closed runs (rings with no node) go straight through.
  for (let r = 0; r < runs.length; r++) {
    if (!runs[r].closed) continue
    visited.add(r)
    emit(runs[r].pts, Array.from(runs[r].w), true, 'round', 'round')
  }

  const pushPoints = (pts: Vec[], ws: number[], seqP: Vec[], seqW: number[]): void => {
    let k = 0
    // Drop a duplicate of the last point.
    if (pts.length && seqP.length && dist(pts[pts.length - 1], seqP[0]) < 1e-6) k = 1
    for (; k < seqP.length; k++) {
      pts.push(seqP[k])
      ws.push(seqW[k])
    }
  }

  // Nodes some paired stroke passes THROUGH (both of the pair's ends on that node).
  const crossed = new Set<number>()
  for (const [key, other] of partner) {
    const node = endNode(key)
    if (node >= 0 && node === endNode(other)) crossed.add(node)
  }
  function endNode(key: string): number {
    const run = runs[Number(key.slice(0, -1))]
    return key.endsWith('a') ? run.a : run.b
  }
  const crossedAt = (node: number): boolean => crossed.has(node)

  const follow = (startRun: number, startSide: 'a' | 'b'): void => {
    // Walk from an end: enter the run at `startSide`, leave at the other side, hop to
    // the partner run, until an unpaired end (or the start again, for a loop).
    const pts: Vec[] = []
    const ws: number[] = []
    const run0 = runs[startRun]
    const enterNode0 = startSide === 'a' ? run0.a : run0.b
    const startAtJunction = enterNode0 >= 0 && junctionAt.has(enterNode0)
    if (startAtJunction) {
      pts.push(junctionAt.get(enterNode0)!)
      ws.push(NaN)
    }
    let r = startRun
    let side = startSide
    let closed = false
    let endRun = r
    let endSide: 'a' | 'b' = side
    let endAtJunction = false
    for (;;) {
      visited.add(r)
      const run = runs[r]
      const t = trimmed(r)
      const seqP = side === 'a' ? t.pts : t.pts.slice().reverse()
      const seqW = side === 'a' ? t.w : t.w.slice().reverse()
      pushPoints(pts, ws, seqP, seqW)
      const leaveSide: 'a' | 'b' = side === 'a' ? 'b' : 'a'
      const leaveNode = leaveSide === 'a' ? run.a : run.b
      const next = partner.get(`${r}${leaveSide}`)
      if (next) {
        // Through a junction: where the arms were cut back (a welded node, a corner
        // join) the junction point bridges them; a through pair's own points already
        // touch.
        const nr = Number.parseInt(next.slice(0, -1), 10)
        const ns = next.slice(-1) as 'a' | 'b'
        const ringC = ringOf.get(`${r}${leaveSide}`)
        if (ringC && pts.length) {
          // Two arcs of one circle: bridged along it, end to end.
          const t = trimmed(nr)
          const q = ns === 'a' ? t.pts[0] : t.pts[t.pts.length - 1]
          for (const p of arcBridge(ringC, pts[pts.length - 1], q, Math.max(1, W / 4))) {
            pts.push(p)
            ws.push(NaN)
          }
        } else if (bridged.has(`${r}${leaveSide}`) && pts.length) {
          const t = trimmed(nr)
          const q = ns === 'a' ? t.pts[0] : t.pts[t.pts.length - 1]
          const eA = endOf.get(`${r}${leaveSide}`)!
          const eB = endOf.get(next)!
          for (const p of hermiteBridge(
            pts[pts.length - 1],
            eA.dir,
            q,
            { x: -eB.dir.x, y: -eB.dir.y },
            Math.max(1, W / 4),
          )) {
            pts.push(p)
            ws.push(NaN)
          }
        } else if (acrossFill.has(`${r}${leaveSide}`) && pts.length) {
          // Across a fill: a straight chord under it, never through a junction inside the
          // fill (the head's own thicket), whose meet is off the stroke's line.
          const t = trimmed(nr)
          const q = ns === 'a' ? t.pts[0] : t.pts[t.pts.length - 1]
          for (const p of lineBridge(pts[pts.length - 1], q)) {
            pts.push(p)
            ws.push(NaN)
          }
        } else if (leaveNode >= 0 && cutBack(`${r}${leaveSide}`)) {
          // Through the meet, sampled every pixel on both chords: the smoothing before the
          // fit counts its σ in POINTS, and a lone meet between two arms cut back a zone
          // apart was averaged into the chord — an arrowhead's V came back a smile.
          const J = junctionAt.get(leaveNode)!
          const t = trimmed(nr)
          const q = ns === 'a' ? t.pts[0] : t.pts[t.pts.length - 1]
          for (const p of [...lineBridge(pts[pts.length - 1], J), J, ...lineBridge(J, q)]) {
            pts.push(p)
            ws.push(NaN)
          }
        }
        if (nr === startRun && ns === startSide) {
          closed = true
          break
        }
        if (visited.has(nr)) break // defensive: never loop forever
        r = nr
        side = ns
        continue
      }
      endRun = r
      endSide = leaveSide
      if (leaveNode >= 0 && junctionAt.has(leaveNode)) {
        pts.push(junctionAt.get(leaveNode)!)
        ws.push(NaN)
        endAtJunction = true
      }
      break
    }
    if (closed) {
      if (pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-6) {
        pts.pop()
        ws.pop()
      }
      emit(pts, ws, true, 'round', 'round')
      return
    }
    let capA: CapKind = 'butt'
    let capB: CapKind = 'butt'
    // A free end's hook (its corner pixels kept by thinning) goes before the end is read.
    // Only a FLAT end has corners to curl into, so the hook is cut only when the end it
    // leaves reads flat; a round end, or a curve's end, keeps every point.
    let body = pts
    const unhook = (side: 'a' | 'b', r: number): void => {
      const cut = dropEndHook(body, side, r)
      if (cut !== body && readEnd(cut, side, r, f, blobMask, false).cap === 'butt') body = cut
    }
    if (!startAtJunction && !(startSide === 'a' ? run0.blobAtA : run0.blobAtB)) unhook('a', halfWidthNear(ws, W))
    if (!endAtJunction && !(endSide === 'a' ? runs[endRun].blobAtA : runs[endRun].blobAtB))
      unhook('b', halfWidthNear(ws.slice().reverse(), W))
    let P = body
    // A free flat end, kept so it can be re-placed if the path goes out round (below).
    type FlatEnd = { read: EndRead; t: Vec; r: number }
    let readA: EndRead | null = null
    let readB: EndRead | null = null
    let flatA: FlatEnd | null = null
    let flatB: FlatEnd | null = null
    const flatEnd = (src: Vec[], side: 'a' | 'b', read: EndRead, r: number, intoFill: boolean): FlatEnd | null => {
      if (intoFill || read.cap !== 'butt') return null
      const t = outwardTangent(src, side, Math.max(3, 3 * r))
      return t ? { read, t, r } : null
    }
    if (!startAtJunction) {
      const intoFill = startSide === 'a' ? run0.blobAtA : run0.blobAtB
      const r = halfWidthNear(ws, W)
      const read = readEnd(P, 'a', r, f, blobMask, intoFill)
      flatA = flatEnd(P, 'a', read, r, intoFill)
      P = applyEnd(P, 'a', read)
      capA = read.cap
      readA = read
    }
    if (!endAtJunction) {
      const runE = runs[endRun]
      const intoFill = endSide === 'a' ? runE.blobAtA : runE.blobAtB
      const r = halfWidthNear(ws.slice().reverse(), W)
      const read = readEnd(P, 'b', r, f, blobMask, intoFill)
      flatB = flatEnd(P, 'b', read, r, intoFill)
      P = applyEnd(P, 'b', read)
      capB = read.cap
      readB = read
    }
    // A path carries ONE linecap and mixed ends go out round (emit). readEnd placed a free
    // flat end AT the ink's end, so drawn round it would paint a half-width of ink past the
    // source: pull it back by r, where readEnd puts a round end. (An into-fill end is butt
    // by construction and overlaps its fill on purpose, so it stays.)
    if (capA !== capB && (flatA || flatB)) {
      const pulled = (e: FlatEnd): EndRead => ({
        end: { x: e.read.end.x - e.r * e.t.x, y: e.read.end.y - e.r * e.t.y },
        cap: 'round',
        advance: e.read.advance - e.r,
      })
      P = body
      if (readA) P = applyEnd(P, 'a', flatA ? pulled(flatA) : readA)
      if (readB) P = applyEnd(P, 'b', flatB ? pulled(flatB) : readB)
    }
    // Both ends on junctions and neither is crossed by a stroke running through it (a Y:
    // a V meeting a rect ON its rounded corner, no two arms in line). Nothing there
    // covers a butt end, so the arms leave wedges between them; round fills the meet.
    // Where a pair DOES run through, it buries the butt end, and a round one would bulge
    // past it wherever the node sits off the through-stroke's centre.
    if (startAtJunction && endAtJunction && !crossedAt(enterNode0) && !crossedAt(runs[endRun][endSide])) {
      capA = capB = 'round'
    }
    emit(P, ws, false, capA, capB)
  }

  // Unpaired ends first (open paths), then anything left is a loop through junctions.
  for (const r of dead) visited.add(r)
  for (let r = 0; r < runs.length; r++) {
    if (visited.has(r) || runs[r].closed) continue
    const aFree = !partner.has(`${r}a`)
    const bFree = !partner.has(`${r}b`)
    if (aFree) follow(r, 'a')
    else if (bFree) follow(r, 'b')
  }
  for (let r = 0; r < runs.length; r++) {
    if (visited.has(r) || runs[r].closed) continue
    follow(r, 'a')
  }
  return { paths, junctions }
}

/** 4-connected components of the fill mask, labelled from 1; 0 where there is no fill. */
function fillComponents(mask: Uint8Array, width: number, height: number): Int32Array {
  const comp = new Int32Array(width * height)
  const stack: number[] = []
  let next = 0
  for (let s = 0; s < comp.length; s++) {
    if (!mask[s] || comp[s]) continue
    next++
    comp[s] = next
    stack.length = 0
    stack.push(s)
    while (stack.length) {
      const p = stack.pop()!
      const x = p % width
      const y = (p / width) | 0
      const nb = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ]
      for (const q of nb) {
        if (q < 0 || !mask[q] || comp[q]) continue
        comp[q] = next
        stack.push(q)
      }
    }
  }
  return comp
}

/** Half-width near the head of a width sequence (first finite entries), else W/2. */
function halfWidthNear(ws: number[], W: number): number {
  const take: number[] = []
  for (let k = 0; k < ws.length && take.length < 6; k++) if (Number.isFinite(ws[k])) take.push(ws[k])
  if (take.length === 0) return W / 2
  take.sort((a, b) => a - b)
  return take[take.length >> 1] / 2
}

/** The stroked PathItems of an assembly, in order. */
export function strokeItems(paths: StrokePath[], color: string): PathItem[] {
  return paths.map((p, i) => ({
    kind: 'path',
    id: `stroke-${i}`,
    fill: 'none',
    fillRule: 'nonzero',
    subPaths: [p.subPath],
    stroke: { color, width: p.width, cap: p.cap, join: 'round' },
    visible: true,
  }))
}
