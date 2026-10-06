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
// Free ends are read by ends.ts (cap and true end); the paths are then fitted (fit.ts)
// and given their width: the median of the run's readable point widths, snapped to the
// picture's stroke width when within 15% of it — a monoline icon comes out as one
// width, not eleven that differ in the second decimal.

import type { PathItem, SubPath, Vec } from '../../path/types'
import type { PlanarFitOptions } from '../planarFit/options.ts'
import type { StrokeRun } from './blobs.ts'
import { applyEnd, outwardTangent, readEnd, type CapKind, type EndRead } from './ends.ts'
import { armLineOf, fitClosedCentreline, fitOpenCentreline, type FitContext } from './fit.ts'
import type { SkeletonGraph } from './graph.ts'
import { gaussSmooth, type CoverageField } from './profile.ts'

/** A run end continues into another when the stroke turns no more than this through the node. */
export const THROUGH_DEG = 35
/** Widths within this fraction of the picture's stroke width snap to it. */
export const WIDTH_SNAP = 0.15
/** A free-ending third arm within this angle of a corner's bisector is the corner's tip spur. */
export const TIP_SPUR_DEG = 25

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
  /** The run's arc length, and whether its OTHER end is free (a candidate tip spur). */
  len: number
  freeOther: boolean
}

const nodePos = (g: SkeletonGraph, id: number): Vec => ({ x: g.nodes[id].x + 0.5, y: g.nodes[id].y + 0.5 })
const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y)

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
  const base = { run: r, side, node: nodeId, keep, len, freeOther: otherNode < 0 && !otherFill }
  const line = armLineOf(seq.slice(start), W, Math.max(0.5, 0.06 * W), J)
  if (line) return { ...base, dir: line.dir, at: line.at, ok: true }
  const far = seq[seq.length - 1]
  const dx = J.x - far.x
  const dy = J.y - far.y
  const l = Math.hypot(dx, dy) || 1
  return { ...base, dir: { x: dx / l, y: dy / l }, at: seq[start], ok: false }
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
  /** Run ends paired as a CORNER (not a through continuation). */
  const cornerJoin = new Set<string>()
  const dead = new Set<number>()
  let junctions = 0
  for (const [nodeId, endsAll] of endsAt) {
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
        // Only a CORNER has a tip: the two arms must turn by at least the sharp bar
        // (an arc's two halves meeting at its top read as a 150° pair, and the nub on
        // an umbrella is a real stroke, not that pair's spur).
        const cosI = A.dir.x * B.dir.x + A.dir.y * B.dir.y
        if (cosI < cosCorner) continue
        // Shorter than a stroke is wide: thinning's branch toward the join, whatever
        // direction its two pixels happen to read (a run that short is unreadable).
        const stub = S.len <= 2 * node.r + 2
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
    const cands: { i: number; j: number; cos: number }[] = []
    for (let i = 0; i < ends.length; i++) {
      if (!ends[i].ok) continue
      for (let j = i + 1; j < ends.length; j++) {
        if (!ends[j].ok) continue
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
    for (const c of cands) {
      if (used.has(c.i) || used.has(c.j)) continue
      pairUp(c.i, c.j)
      through.push([c.i, c.j])
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
    if (left.length === 2 && !onFill) {
      pairUp(left[0], left[1])
      cornerJoin.add(`${ends[left[0]].run}${ends[left[0]].side}`)
      cornerJoin.add(`${ends[left[1]].run}${ends[left[1]].side}`)
      cornerPair = [left[0], left[1]]
    }
    // Junction point: the least-squares meet of every arm's own line.
    const lines = ends.filter((e) => e.ok).map((e) => ({ at: e.at, dir: e.dir }))
    let J = lines.length >= 2 ? meetLines(lines, centroid) : centroid
    // A meet far outside the junction's own zone is an ill-conditioned set of near-
    // parallel lines; the centroid is the honest answer then.
    if (dist(J, centroid) > Math.max(2, 1.5 * node.r + 1)) J = centroid
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
    for (let k = lo; k <= hi; k++) {
      pts.push(run.pts[k])
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
        if (leaveNode >= 0 && cutBack(`${r}${leaveSide}`)) {
          pts.push(junctionAt.get(leaveNode)!)
          ws.push(NaN)
        }
        const nr = Number.parseInt(next.slice(0, -1), 10)
        const ns = next.slice(-1) as 'a' | 'b'
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
    let P = pts
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
      P = pts
      if (readA) P = applyEnd(P, 'a', flatA ? pulled(flatA) : readA)
      if (readB) P = applyEnd(P, 'b', flatB ? pulled(flatB) : readB)
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
