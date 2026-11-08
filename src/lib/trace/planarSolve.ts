// Boundary solve: after the fit, move every node and handle of the planar graph AT ONCE so the
// exact area coverage the curves would paint matches the source raster.
//
// Every stage upstream decides a point on its own, along its own normal. A pixel's value is
// the coverage of every region touching it, so those local readings leave a line of small
// errors along every edge, and the curve fit then spends its whole ε on top. Measured on the
// emoji corpus, fills are exact and nearly all of the mean ΔE sits within 1 px of an edge.
//
// It mostly moves what the fit already chose. Between rounds a node goes in where a curve still
// misses the raster, at most `addRatio` of the fit's count.
//
// Nothing in the energy keeps two edges apart, and a sliver a pixel wide is cheaper to the sum
// with its two sides crossed. So after each round the graph is checked for crossings the fit did
// not have (edgeCrossings.ts): the edges involved are held where the round found them and the
// round runs again; if it still crosses, the round is undone, nodes it added included.
//
// The maths is damped Gauss-Newton on
//   E = Σ_band ‖ T_p − Σ_label cov_label(p)·c_label(p) ‖²
// with the fills held fixed. Three things make that cheap:
//   * A planar map means a pixel's colour is linear in the coverages, so one accumulation
//     buffer (font-rs, libart) per channel renders it: an edge deposits its signed area times
//     (left colour − right colour). O(perimeter + pixels), an exact box filter. A gradient has no
//     one colour to deposit, so each gradient region keeps a coverage buffer of its own over its
//     bounding box, multiplied by its paint at the pixel.
//   * Moving a boundary piece by δ changes the coverage of the pixel it lies in by exactly
//     the area swept, δ × (piece vector). So the Jacobian is analytic and sparse: one row
//     entry per piece, filed under its pixel, routed to the control points by the Bézier basis.
//   * The normal equations are solved matrix-free with Jacobi-preconditioned CG.
//
// Pure (no DOM or Node APIs). Runs in the trace worker and ships in the npm package.

import type { EdgeRef, GradientFill, PathNode, SharedEdge, Vec, Vertex } from '../path/types'
import { edgeCrossings } from './edgeCrossings.ts'
import { gradientLut, gradientParamT } from './gradient.ts'
import { EXT } from './planarNetwork.ts'

export interface SolveColor {
  r: number
  g: number
  b: number
}

export interface SolveImage {
  data: Uint8ClampedArray | Uint8Array
  width: number
  height: number
}

export interface BoundarySolveInput {
  vertices: Vertex[]
  edges: SharedEdge[]
  loopsByLabel: ReadonlyMap<number, EdgeRef[][]>
  /** Label → the colour its fill paints. */
  palette: readonly SolveColor[]
  /** A region whose paint is neither one opaque colour nor a `gradientOf` gradient (a glow stack,
   *  a translucent fill) has no place in the model: its edges stay where they are and the pixels
   *  around them are left out of the sum. */
  isFlat: (label: number) => boolean
  /** An opaque gradient's paint: its edges solve too, against that gradient at each pixel. */
  gradientOf?: (label: number) => GradientFill | null
  image: SolveImage
  /** The label map the graph was traced from: settles which region lies on which side of an
   *  edge where the loops cannot. */
  labels?: Int32Array
  /** Through junctions (planarThread): the vertex may slide along this direction only, and the
   *  arms keep their end handles, or the G¹ join they were fitted to becomes a kink. */
  through?: ReadonlyMap<number, Vec>
  tune?: Partial<SolveTune>
}

export interface SolveTune {
  /** Outer Gauss-Newton iterations. */
  iters: number
  /** CG iterations per outer iteration. */
  cgIters: number
  /** Flattening step along a curve (px). */
  step: number
  /** How far an anchor or a handle may move in one step (px). */
  maxStepAnchor: number
  maxStepHandle: number
  /** How far an anchor or a handle may end up from where the fit put it (px). The band only
   *  reaches this far, and the fit's ε is about this size, so it cannot rebuild a shape. */
  maxTotalAnchor: number
  maxTotalHandle: number
  /** A corner node with a smaller tangent break than this is held to it: free handles would
   *  grow it into a kink the art does not have. */
  keepBreakDeg: number
  /** Stop once an accepted step gains less than this share of the energy. */
  minGain: number
  /** A straight side at least this long (px) may bend during the solve. */
  bendMinLen: number
  /** A bent side whose sagitta stays under this (px) was straight and goes back to a line. */
  bendKeep: number
  /** Iterations after the sides that were straight went back. */
  bendFinish: number
  /** How far a handle may turn from the fit's direction (deg). A short handle turns a long way
   *  for a tiny move of its tip: unchecked, that is a kink the art does not have. */
  maxHandleTurnDeg: number
  /** Solves in all; between two of them, nodes go in where a curve still misses the raster. */
  rounds: number
  /** How many nodes may be added, as a share of what the fit chose. */
  addRatio: number
  /** A curve under this residual (squared, summed along it) is good enough to keep whole. */
  splitMinScore: number
  /** A curve shorter than this (px) is not split. */
  splitMinLen: number
}

export const DEFAULT_SOLVE_TUNE: SolveTune = {
  iters: 8,
  cgIters: 30,
  step: 0.5,
  maxStepAnchor: 0.6,
  maxStepHandle: 1.5,
  maxTotalAnchor: 1,
  maxTotalHandle: 3,
  keepBreakDeg: 5,
  minGain: 0.003,
  bendMinLen: 8,
  bendKeep: 0.1,
  bendFinish: 3,
  maxHandleTurnDeg: 30,
  rounds: 3,
  addRatio: 0.1,
  splitMinScore: 0.15,
  splitMinLen: 6,
}

export interface SolveReport {
  /** Sum of squared residuals over the band, channels 0..1. */
  before: number
  after: number
  iters: number
  /** Free coordinates in the solve. */
  unknowns: number
  /** Pixels in the band. */
  band: number
}

/** A cubic (or line) of the graph, as indices into the unknowns. -1 = no handle. */
interface Seg {
  a: number
  h1: number
  h2: number
  b: number
  edge: number
  /** The segment's first node in its edge. */
  node: number
}

/** How far the scored band reaches past a boundary (px). It must cover everywhere a curve can
 *  go in one solve: a pixel outside it costs nothing, so a boundary that gets there is free to
 *  keep growing. An anchor moves at most maxTotalAnchor and a handle maxTotalHandle, which moves
 *  the curve by at most 0.25 × the one + 0.75 × the other. */
const REACH = 4

/** Entries in a gradient's colour table. A stop list is walked once, not per pixel. */
const LUT_SIZE = 1024
/** All gradient regions' coverage buffers together, in rasters' worth of cells. Past it a region
 *  stays as drawn: the 2048 px raster's coverage alone is 33 MB a raster. */
const MAX_GRADIENT_RASTERS = 3

/** One gradient region in the model: its paint and its coverage over its bounding box. */
interface GradientSlot {
  gradient: GradientFill
  lut: Float32Array
  x0: number
  y0: number
  w: number
  h: number
  acc: Float64Array
}

/** Where each point started, so the limits hold over all the rounds of a solve and not per round. */
interface Origins {
  vertices: Map<number, Vec>
  nodes: Map<PathNode, { x: number; y: number; hIn: Vec | null; hOut: Vec | null }>
}

/**
 * Deposit one directed line into the accumulation buffer (stride = width + 2 cells, 4 channels
 * a cell). `c` is the four-channel colour step across the line. Running sums along each row then
 * give the exact box-filtered picture.
 */
export function depositLine(
  acc: Float64Array,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  c: ArrayLike<number>,
): void {
  const stride = (w + 2) * 4
  scanLine(w, h, x0, y0, x1, y1, (row, cell, v) => {
    const o = row * stride + cell * 4
    acc[o] += v * c[0]
    acc[o + 1] += v * c[1]
    acc[o + 2] += v * c[2]
    acc[o + 3] += v * c[3]
  })
}

/** The signed area one directed line adds to each cell, row by row. */
function scanLine(
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  add: (row: number, cell: number, v: number) => void,
): void {
  if (y0 === y1) return
  const dir = y0 < y1 ? 1 : -1
  const topX = dir > 0 ? x0 : x1
  const topY = dir > 0 ? y0 : y1
  const botX = dir > 0 ? x1 : x0
  const botY = dir > 0 ? y1 : y0
  const dxdy = (botX - topX) / (botY - topY)
  let x = topX
  if (topY < 0) x -= topY * dxdy
  const yFrom = Math.max(0, Math.floor(topY))
  const yTo = Math.min(h, Math.ceil(botY))
  for (let y = yFrom; y < yTo; y++) {
    const row = y
    const dy = Math.min(y + 1, botY) - Math.max(y, topY)
    const xNext = x + dxdy * dy
    const d = dy * dir
    // Outside the raster a piece still carries its height to everything right of it.
    const xa = Math.max(0, Math.min(w, x))
    const xb = Math.max(0, Math.min(w, xNext))
    const lo = Math.min(xa, xb)
    const hi = Math.max(xa, xb)
    const loFloor = Math.floor(lo)
    const hiCeil = Math.ceil(hi)
    if (hiCeil <= loFloor + 1) {
      const xmf = 0.5 * (xa + xb) - loFloor
      add(row, loFloor, d - d * xmf)
      add(row, loFloor + 1, d * xmf)
    } else {
      const s = 1 / (hi - lo)
      const f0 = lo - loFloor
      const a0 = 0.5 * s * (1 - f0) * (1 - f0)
      const f1 = hi - hiCeil + 1
      const am = 0.5 * s * f1 * f1
      add(row, loFloor, d * a0)
      if (hiCeil === loFloor + 2) {
        add(row, loFloor + 1, d * (1 - a0 - am))
      } else {
        const a1 = s * (1.5 - f0)
        add(row, loFloor + 1, d * (a1 - a0))
        for (let xi = loFloor + 2; xi < hiCeil - 1; xi++) add(row, xi, d * s)
        const a2 = a1 + (hiCeil - loFloor - 3) * s
        add(row, hiCeil - 1, d * (1 - a2 - am))
      }
      add(row, hiCeil, d * am)
    }
    x = xNext
  }
}

/**
 * Which label lies on each side of an edge. A loop's direction usually says, but assembly flips a
 * loop to orient it for nonzero fill, so two labels can reference an edge the same way round. The
 * label map decides those: the edges that agree show which geometric side "left" is.
 */
function sidesOf(
  edges: readonly SharedEdge[],
  loopsByLabel: ReadonlyMap<number, EdgeRef[][]>,
  labels: Int32Array | undefined,
  w: number,
  h: number,
): Map<number, { left: number; right: number }> {
  const refs = new Map<number, { label: number; reversed: boolean }[]>()
  for (const [label, loops] of loopsByLabel) {
    for (const loop of loops) {
      for (const ref of loop) {
        const r = refs.get(ref.edge)
        if (r) r.push({ label, reversed: ref.reversed })
        else refs.set(ref.edge, [{ label, reversed: ref.reversed }])
      }
    }
  }
  const sides = new Map<number, { left: number; right: number }>()
  const open: { edge: SharedEdge; a: number; b: number }[] = []
  for (const [id, r] of refs) {
    const s = { left: EXT, right: EXT }
    const fwd = r.find((x) => !x.reversed)
    const rev = r.find((x) => x.reversed)
    if (fwd) s.left = fwd.label
    if (rev) s.right = rev.label
    sides.set(id, s)
  }
  if (!labels) return sides
  const byId = new Map(edges.map((e) => [e.id, e]))
  for (const [id, r] of refs) {
    if (r.length !== 2 || r[0].reversed !== r[1].reversed || r[0].label === r[1].label) continue
    const e = byId.get(id)
    if (e) open.push({ edge: e, a: r[0].label, b: r[1].label })
  }
  if (open.length === 0) return sides
  const labelAt = (x: number, y: number): number => {
    const cx = Math.floor(x)
    const cy = Math.floor(y)
    return cx < 0 || cy < 0 || cx >= w || cy >= h ? EXT : labels[cy * w + cx]
  }
  // Read the labels 1.5 px either side of a few points of a segment.
  const readSides = (e: SharedEdge, visit: (plus: number, minus: number) => void): void => {
    const n = e.nodes.length
    const segs = e.closed ? n : n - 1
    for (let i = 0; i < segs; i++) {
      const p = e.nodes[i]
      const q = e.nodes[(i + 1) % n]
      const c1 = p.hOut ?? p
      const c2 = q.hIn ?? q
      for (const t of [0.25, 0.5, 0.75]) {
        const u = 1 - t
        const x = u * u * u * p.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * q.x
        const y = u * u * u * p.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * q.y
        const tx = 3 * u * u * (c1.x - p.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (q.x - c2.x)
        const ty = 3 * u * u * (c1.y - p.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (q.y - c2.y)
        const l = Math.hypot(tx, ty)
        if (l < 1e-9) continue
        visit(labelAt(x - (ty / l) * 1.5, y + (tx / l) * 1.5), labelAt(x + (ty / l) * 1.5, y - (tx / l) * 1.5))
      }
    }
  }
  // Which side is "left" for the edges whose two references agree.
  let plusIsLeft = 0
  for (const e of edges) {
    const s = sides.get(e.id)
    const r = refs.get(e.id)
    if (!s || !r || r.length !== 2 || s.left === s.right || r[0].reversed === r[1].reversed) continue
    readSides(e, (plus, minus) => {
      if (plus === s.left && minus === s.right) plusIsLeft++
      if (plus === s.right && minus === s.left) plusIsLeft--
    })
  }
  for (const { edge, a, b } of open) {
    let aOnPlus = 0
    readSides(edge, (plus, minus) => {
      if (plus === a || minus === b) aOnPlus++
      if (plus === b || minus === a) aOnPlus--
    })
    const aIsLeft = aOnPlus > 0 === plusIsLeft >= 0
    sides.set(edge.id, aIsLeft ? { left: a, right: b } : { left: b, right: a })
  }
  return sides
}

const breakDeg = (ax: number, ay: number, bx: number, by: number): number => {
  const la = Math.hypot(ax, ay)
  const lb = Math.hypot(bx, by)
  if (la < 1e-9 || lb < 1e-9) return 0
  const c = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))
  return (Math.acos(c) * 180) / Math.PI
}

/** Where a curve still misses the raster: split segment `node` of edge `edge` at `t`. */
interface SplitCandidate {
  edge: number
  node: number
  t: number
  score: number
}

/** Insert a node into one segment by de Casteljau: the curve itself does not change. */
function splitSegment(e: SharedEdge, node: number, t: number, origins: Origins): void {
  const n = e.nodes.length
  const a = e.nodes[node]
  const b = e.nodes[(node + 1) % n]
  const lerp = (p: Vec, q: Vec, u: number): Vec => ({ x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u })
  const p0: Vec = { x: a.x, y: a.y }
  const p3: Vec = { x: b.x, y: b.y }
  const c1 = a.hOut ?? p0
  const c2 = b.hIn ?? p3
  const q0 = lerp(p0, c1, t)
  const q1 = lerp(c1, c2, t)
  const q2 = lerp(c2, p3, t)
  const r0 = lerp(q0, q1, t)
  const r1 = lerp(q1, q2, t)
  const s = lerp(r0, r1, t)
  a.hOut = q0
  b.hIn = q2
  // These two handles now mean something else, so they start over from here.
  const oa = origins.nodes.get(a)
  if (oa) oa.hOut = q0
  const ob = origins.nodes.get(b)
  if (ob) ob.hIn = q2
  e.nodes.splice(node + 1, 0, { x: s.x, y: s.y, hIn: r0, hOut: r1, kind: 'smooth' })
}

/**
 * Solve the graph in place: nodes, handles and vertices move, and shared anchors stay exactly
 * shared. A node is added only where a curve still misses the raster after the solve, up to
 * `addRatio` of the nodes the fit chose, and the graph is solved again around it. Returns null
 * when there is nothing to solve.
 */
export function solveBoundaries(input: BoundarySolveInput): SolveReport | null {
  const tune = { ...DEFAULT_SOLVE_TUNE, ...input.tune }
  let budget = 0
  for (const e of input.edges) budget += e.nodes.length
  budget = Math.floor(budget * tune.addRatio)
  const origins: Origins = { vertices: new Map(), nodes: new Map() }
  for (const v of input.vertices) origins.vertices.set(v.id, { x: v.x, y: v.y })
  for (const e of input.edges) {
    for (const n of e.nodes) {
      origins.nodes.set(n, { x: n.x, y: n.y, hIn: n.hIn && { ...n.hIn }, hOut: n.hOut && { ...n.hOut } })
    }
  }
  // Crossings the fit already drew are not the solve's to answer for.
  const fitCrossings = edgeCrossings(input.edges)
  const held = new Set<number>()
  let first: SolveReport | null = null
  let last: SolveReport | null = null
  /** The graph before the last round's nodes went in, to take them out again. */
  let beforeSplit: Snapshot | null = null
  for (let round = 0; ; round++) {
    const lastRound = round + 1 >= tune.rounds || budget <= 0
    const start = snapshot(input, origins)
    const fresh = (): string[] => [...edgeCrossings(input.edges)].filter((k) => !fitCrossings.has(k))
    let out = solveOnce(input, tune, !lastRound, origins, held)
    let crossed = false
    for (let attempt = 0; out && attempt < CROSS_RETRIES; attempt++) {
      const pairs = fresh()
      if (pairs.length === 0) break
      restore(input, origins, start)
      crossed = true
      for (const k of pairs) for (const id of k.split(':')) held.add(Number(id))
      out = solveOnce(input, tune, !lastRound, origins, held)
    }
    if (!out) {
      // A round that gained nothing once its crossings were held takes its new nodes along.
      if (crossed && beforeSplit) restore(input, origins, beforeSplit)
      break
    }
    // Still crossing after the retries (on a photo every retry finds the next sliver): the edges
    // that cross go back to where the round found them, the rest keep what they gained.
    putBack(input, start, fresh, held)
    first ??= out.report
    last = out.report
    if (lastRound) break
    // Worst first, one per segment. A later node of an edge goes in first, or the earlier
    // insertion would shift its index. A held edge cannot use one.
    const take = out.splits
      .filter((c) => !held.has(input.edges[c.edge].id))
      .sort((p, q) => q.score - p.score)
      .slice(0, Math.max(1, Math.ceil(budget / (tune.rounds - round - 1))))
      .sort((p, q) => q.node - p.node)
    if (take.length === 0) break
    beforeSplit = snapshot(input, origins)
    for (const c of take) splitSegment(input.edges[c.edge], c.node, c.t, origins)
    budget -= take.length
  }
  return first && last ? { ...last, before: first.before } : null
}

/** How often a round that crossed edges runs again, holding them, before the edges still
 *  crossing are put back instead. */
const CROSS_RETRIES = 3

/**
 * Put every edge in a fresh crossing back where `start` had it, until none is left, and hold it.
 * A vertex goes back with its edge; another edge ending there follows it with its end anchor and
 * that anchor's handle. Converges: with every edge back, the graph is `start`, which had none.
 */
function putBack(input: BoundarySolveInput, start: Snapshot, fresh: () => string[], held: Set<number>): void {
  const { edges, vertices } = input
  const edgeAt = new Map(edges.map((e, i) => [e.id, i]))
  const vertexAt = new Map(vertices.map((v, i) => [v.id, i]))
  const back = new Set<number>()
  for (let pairs = fresh(); pairs.length > 0; pairs = fresh()) {
    const moved = new Set<number>()
    for (const k of pairs) {
      for (const id of k.split(':')) {
        const i = edgeAt.get(Number(id))
        if (i == null || back.has(i)) continue
        back.add(i)
        held.add(Number(id))
        const e = edges[i]
        e.nodes.splice(0, e.nodes.length, ...start.nodes[i])
        e.nodes.forEach((n, j) => {
          const f = start.fields[i][j]
          n.x = f.x
          n.y = f.y
          n.hIn = f.hIn
          n.hOut = f.hOut
          n.kind = f.kind
        })
        for (const vid of [e.startVertex, e.endVertex]) if (vid != null) moved.add(vid)
      }
    }
    if (moved.size === 0) break
    for (const vid of moved) {
      const vi = vertexAt.get(vid)
      if (vi == null) continue
      vertices[vi].x = start.vertices[vi].x
      vertices[vi].y = start.vertices[vi].y
    }
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]
      if (back.has(i) || e.closed) continue
      const ends: [number | null, PathNode, 'hOut' | 'hIn'][] = [
        [e.startVertex, e.nodes[0], 'hOut'],
        [e.endVertex, e.nodes[e.nodes.length - 1], 'hIn'],
      ]
      for (const [vid, n, side] of ends) {
        if (vid == null || !moved.has(vid)) continue
        const v = vertices[vertexAt.get(vid)!]
        const dx = v.x - n.x
        const dy = v.y - n.y
        n.x = v.x
        n.y = v.y
        const h = n[side]
        if (h) n[side] = { x: h.x + dx, y: h.y + dy }
      }
    }
  }
}

/** The graph's geometry, to undo a round with. Insertion splices the node arrays and rewrites
 *  the origins of the split segment's handles, so those are kept too. */
interface Snapshot {
  vertices: Vec[]
  nodes: PathNode[][]
  fields: PathNode[][]
  origins: Map<PathNode, NonNullable<ReturnType<Origins['nodes']['get']>>>
}

function snapshot(input: BoundarySolveInput, origins: Origins): Snapshot {
  const snap: Snapshot = { vertices: [], nodes: [], fields: [], origins: new Map() }
  for (const v of input.vertices) snap.vertices.push({ x: v.x, y: v.y })
  for (const e of input.edges) {
    snap.nodes.push(e.nodes.slice())
    snap.fields.push(e.nodes.map((n) => ({ ...n })))
    for (const n of e.nodes) {
      const o = origins.nodes.get(n)
      if (o) snap.origins.set(n, { ...o })
    }
  }
  return snap
}

function restore(input: BoundarySolveInput, origins: Origins, snap: Snapshot): void {
  input.vertices.forEach((v, i) => {
    v.x = snap.vertices[i].x
    v.y = snap.vertices[i].y
  })
  input.edges.forEach((e, i) => {
    e.nodes.splice(0, e.nodes.length, ...snap.nodes[i])
    e.nodes.forEach((n, j) => {
      const f = snap.fields[i][j]
      n.x = f.x
      n.y = f.y
      n.hIn = f.hIn
      n.hOut = f.hOut
      n.kind = f.kind
    })
  })
  for (const [n, o] of snap.origins) origins.nodes.set(n, { ...o })
}

/** The colour-table entry of a gradient at a pixel's centre, as an index into `lut`. */
const lutIndex = (sl: GradientSlot, x: number, y: number): number =>
  Math.round(gradientParamT(sl.gradient, x + 0.5, y + 0.5) * (LUT_SIZE - 1)) * 3

/** A slot for each gradient region, largest first, while the coverage buffers fit the limit. */
function gradientSlots(input: BoundarySolveInput, w: number, h: number): Map<number, GradientSlot> {
  const out = new Map<number, GradientSlot>()
  const { gradientOf, edges, loopsByLabel } = input
  if (!gradientOf) return out
  const byId = new Map(edges.map((e) => [e.id, e]))
  const wanted: { label: number; gradient: GradientFill; x0: number; y0: number; w: number; h: number }[] = []
  for (const [label, loops] of loopsByLabel) {
    if (label === EXT) continue
    const gradient = gradientOf(label)
    if (!gradient) continue
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const loop of loops) {
      for (const ref of loop) {
        for (const n of byId.get(ref.edge)?.nodes ?? []) {
          for (const p of [n, n.hIn, n.hOut]) {
            if (!p) continue
            x0 = Math.min(x0, p.x)
            y0 = Math.min(y0, p.y)
            x1 = Math.max(x1, p.x)
            y1 = Math.max(y1, p.y)
          }
        }
      }
    }
    if (!(x1 >= x0)) continue
    // Past the box by as far as a curve can go, and never past the raster.
    const bx0 = Math.max(0, Math.floor(x0) - REACH - 1)
    const by0 = Math.max(0, Math.floor(y0) - REACH - 1)
    const bx1 = Math.min(w, Math.ceil(x1) + REACH + 1)
    const by1 = Math.min(h, Math.ceil(y1) + REACH + 1)
    wanted.push({ label, gradient, x0: bx0, y0: by0, w: bx1 - bx0, h: by1 - by0 })
  }
  wanted.sort((a, b) => b.w * b.h - a.w * a.h)
  let room = MAX_GRADIENT_RASTERS * w * h
  for (const s of wanted) {
    const cells = (s.w + 2) * s.h
    if (cells > room) continue
    room -= cells
    out.set(s.label, {
      gradient: s.gradient,
      lut: gradientLut(s.gradient, LUT_SIZE),
      x0: s.x0,
      y0: s.y0,
      w: s.w,
      h: s.h,
      acc: new Float64Array(cells),
    })
  }
  return out
}

function solveOnce(
  input: BoundarySolveInput,
  tune: SolveTune,
  wantSplits: boolean,
  origins: Origins,
  /** Edges (by id) held where they are: they crossed another edge in an earlier try. */
  held: ReadonlySet<number>,
): { report: SolveReport; splits: SplitCandidate[] } | null {
  const { vertices, edges, loopsByLabel, palette, isFlat, image, through } = input
  const { width: w, height: h, data } = image
  if (edges.length === 0 || w < 2 || h < 2) return null
  const sides = sidesOf(edges, loopsByLabel, input.labels, w, h)
  const slots = gradientSlots(input, w, h)
  const flat = (l: number): boolean => l === EXT || isFlat(l) || slots.has(l)
  const colour = (l: number): [number, number, number, number] => {
    if (l === EXT) return [0, 0, 0, 0]
    // A gradient's colour comes from its slot; here it only counts as opaque.
    if (slots.has(l)) return [0, 0, 0, 1]
    const c = palette[l]
    return c ? [c.r / 255, c.g / 255, c.b / 255, 1] : [0, 0, 0, 0]
  }

  // --- the unknowns: one point per vertex, per interior anchor, per handle ---
  const px: number[] = []
  const py: number[] = []
  const newPoint = (x: number, y: number): number => {
    px.push(x)
    py.push(y)
    return px.length - 1
  }
  const isHandle: boolean[] = []
  const vertexPoint = new Map<number, number>()
  for (const v of vertices) {
    vertexPoint.set(v.id, newPoint(v.x, v.y))
    isHandle.push(false)
  }
  const segs: Seg[] = []
  const edgeColour: Float64Array[] = []
  const edgeSlots: { left: GradientSlot | null; right: GradientSlot | null }[] = []
  const edgeMovable: boolean[] = []
  interface NodeRefs {
    anchor: number
    hIn: number
    hOut: number
  }
  const nodeRefs: NodeRefs[][] = []
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei]
    const s = sides.get(e.id) ?? { left: EXT, right: EXT }
    const cl = colour(s.left)
    const cr = colour(s.right)
    edgeColour.push(Float64Array.of(cl[0] - cr[0], cl[1] - cr[1], cl[2] - cr[2], cl[3] - cr[3]))
    edgeSlots.push({ left: slots.get(s.left) ?? null, right: slots.get(s.right) ?? null })
    edgeMovable.push(flat(s.left) && flat(s.right))
    const refs: NodeRefs[] = []
    const n = e.nodes.length
    for (let i = 0; i < n; i++) {
      const nd = e.nodes[i]
      let anchor = -1
      if (!e.closed && i === 0 && e.startVertex != null) anchor = vertexPoint.get(e.startVertex) ?? -1
      if (!e.closed && i === n - 1 && e.endVertex != null) anchor = vertexPoint.get(e.endVertex) ?? -1
      if (anchor < 0) {
        anchor = newPoint(nd.x, nd.y)
        isHandle.push(false)
      }
      const hIn = nd.hIn ? newPoint(nd.hIn.x, nd.hIn.y) : -1
      if (nd.hIn) isHandle.push(true)
      const hOut = nd.hOut ? newPoint(nd.hOut.x, nd.hOut.y) : -1
      if (nd.hOut) isHandle.push(true)
      refs.push({ anchor, hIn, hOut })
    }
    nodeRefs.push(refs)
    const count = e.closed ? n : n - 1
    for (let i = 0; i < count; i++) {
      const p = refs[i]
      const q = refs[(i + 1) % n]
      segs.push({ a: p.anchor, h1: p.hOut, h2: q.hIn, b: q.anchor, edge: ei, node: i })
    }
  }

  const FRAME = 1e-3
  const onFrameX = (v: number): boolean => Math.abs(v) < FRAME || Math.abs(v - w) < FRAME
  const onFrameY = (v: number): boolean => Math.abs(v) < FRAME || Math.abs(v - h) < FRAME
  const alongFrame = (ax: number, ay: number, bx: number, by: number): boolean =>
    (onFrameX(ax) && onFrameX(bx) && Math.abs(ax - bx) < FRAME) ||
    (onFrameY(ay) && onFrameY(by) && Math.abs(ay - by) < FRAME)

  // --- a straight side may bend ---
  // The fit draws a line wherever a shallow arc stays inside ε, and a line can only move its two
  // ends, so a long one keeps its whole sagitta as error. Each gets handles for the solve; the
  // ones the raster leaves straight go back to lines afterwards, so a straight side stays one.
  const bent: number[] = []
  for (let si = 0; si < segs.length; si++) {
    const s = segs[si]
    if (s.h1 >= 0 || s.h2 >= 0 || !edgeMovable[s.edge] || held.has(edges[s.edge].id)) continue
    const ax = px[s.a]
    const ay = py[s.a]
    const bx = px[s.b]
    const by = py[s.b]
    if (alongFrame(ax, ay, bx, by) || Math.hypot(bx - ax, by - ay) < tune.bendMinLen) continue
    s.h1 = newPoint(ax + (bx - ax) / 3, ay + (by - ay) / 3)
    isHandle.push(true)
    s.h2 = newPoint(ax + ((bx - ax) * 2) / 3, ay + ((by - ay) * 2) / 3)
    isHandle.push(true)
    const refs = nodeRefs[s.edge]
    refs[s.node].hOut = s.h1
    refs[(s.node + 1) % refs.length].hIn = s.h2
    bent.push(si)
  }
  const np = px.length
  const x = new Float64Array(np * 2)
  for (let i = 0; i < np; i++) {
    x[i * 2] = px[i]
    x[i * 2 + 1] = py[i]
  }
  // The limits are measured from where the fit put a point, however many rounds ago.
  const x0 = x.slice()
  const startAt = (p: number, at: Vec | null | undefined): void => {
    if (p < 0 || !at) return
    x0[p * 2] = at.x
    x0[p * 2 + 1] = at.y
  }
  for (const v of vertices) startAt(vertexPoint.get(v.id) ?? -1, origins.vertices.get(v.id))
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei]
    const refs = nodeRefs[ei]
    for (let i = 0; i < e.nodes.length; i++) {
      const o = origins.nodes.get(e.nodes[i])
      if (!o) continue
      const isEnd = !e.closed && (i === 0 || i === e.nodes.length - 1)
      if (!isEnd) startAt(refs[i].anchor, o)
      startAt(refs[i].hIn, o.hIn)
      startAt(refs[i].hOut, o.hOut)
    }
  }

  // --- what may move ---
  const free = new Uint8Array(np * 2).fill(1)
  for (let i = 0; i < np; i++) {
    if (isHandle[i]) continue
    // An anchor on the raster's frame slides along it only.
    if (onFrameX(x[i * 2])) free[i * 2] = 0
    if (onFrameY(x[i * 2 + 1])) free[i * 2 + 1] = 0
  }
  // A held edge stays where this round found it (not where the fit put it: the projection below
  // pins a point that may not move to x0) and still counts: the picture around it is painted as
  // it lies, and its neighbours settle against it. An edge that never moves has x0 = x already.
  for (const sg of segs) {
    if (edgeMovable[sg.edge] && !held.has(edges[sg.edge].id)) continue
    for (const p of [sg.a, sg.h1, sg.h2, sg.b]) {
      if (p < 0) continue
      free[p * 2] = 0
      free[p * 2 + 1] = 0
      x0[p * 2] = x[p * 2]
      x0[p * 2 + 1] = x[p * 2 + 1]
    }
  }
  // An edge lying along the frame is the frame: it never moves and no pixel is scored for it.
  const segOnFrame = new Uint8Array(segs.length)
  for (let si = 0; si < segs.length; si++) {
    const sg = segs[si]
    if (!alongFrame(x[sg.a * 2], x[sg.a * 2 + 1], x[sg.b * 2], x[sg.b * 2 + 1])) continue
    segOnFrame[si] = 1
    for (const p of [sg.h1, sg.h2]) {
      if (p < 0) continue
      free[p * 2] = 0
      free[p * 2 + 1] = 0
    }
  }
  // A through junction keeps its arms' handles rigid.
  const followsAnchor = new Uint8Array(np)
  const rigid: { handle: number; anchor: number; dx: number; dy: number }[] = []
  const throughDir = new Map<number, Vec>()
  if (through) {
    for (const [vid, dir] of through) {
      const p = vertexPoint.get(vid)
      if (p == null) continue
      throughDir.set(p, dir)
    }
    for (let ei = 0; ei < edges.length; ei++) {
      const refs = nodeRefs[ei]
      const ends = [refs[0], refs[refs.length - 1]]
      for (const r of ends) {
        if (!throughDir.has(r.anchor)) continue
        for (const hp of [r.hIn, r.hOut]) {
          if (hp < 0) continue
          free[hp * 2] = 0
          free[hp * 2 + 1] = 0
          followsAnchor[hp] = 1
          rigid.push({
            handle: hp,
            anchor: r.anchor,
            dx: x[hp * 2] - x[r.anchor * 2],
            dy: x[hp * 2 + 1] - x[r.anchor * 2 + 1],
          })
        }
      }
    }
  }

  // --- nodes whose two sides must stay on one tangent ---
  interface Tangent {
    anchor: number
    hIn: number
    hOut: number
    /** The neighbouring anchor across a straight side, when one side has no handle. */
    lineFrom: number
  }
  const tangents: Tangent[] = []
  // Read off the current points, so a side that went back to a line is seen as one.
  const buildTangents = (): void => {
    tangents.length = 0
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei]
      const refs = nodeRefs[ei]
      const n = e.nodes.length
      for (let i = 0; i < n; i++) {
        if (!e.closed && (i === 0 || i === n - 1)) continue
        const r = refs[i]
        const rp = refs[(i - 1 + n) % n]
        const rn = refs[(i + 1) % n]
        const ax = x[r.anchor * 2]
        const ay = x[r.anchor * 2 + 1]
        const smooth = e.nodes[i].kind === 'smooth'
        const small = (fx: number, fy: number, tx: number, ty: number): boolean =>
          breakDeg(ax - fx, ay - fy, tx - ax, ty - ay) < tune.keepBreakDeg
        if (r.hIn >= 0 && r.hOut >= 0) {
          if (smooth || small(x[r.hIn * 2], x[r.hIn * 2 + 1], x[r.hOut * 2], x[r.hOut * 2 + 1]))
            tangents.push({ anchor: r.anchor, hIn: r.hIn, hOut: r.hOut, lineFrom: -1 })
        } else if (r.hOut >= 0 && rp.hOut < 0) {
          if (smooth || small(x[rp.anchor * 2], x[rp.anchor * 2 + 1], x[r.hOut * 2], x[r.hOut * 2 + 1]))
            tangents.push({ anchor: r.anchor, hIn: -1, hOut: r.hOut, lineFrom: rp.anchor })
        } else if (r.hIn >= 0 && rn.hIn < 0) {
          if (smooth || small(x[r.hIn * 2], x[r.hIn * 2 + 1], x[rn.anchor * 2], x[rn.anchor * 2 + 1]))
            tangents.push({ anchor: r.anchor, hIn: r.hIn, hOut: -1, lineFrom: rn.anchor })
        }
      }
    }
  }
  buildTangents()

  const handleOf: { handle: number; anchor: number }[] = []
  for (const refs of nodeRefs) {
    for (const r of refs) {
      if (r.hIn >= 0 && !followsAnchor[r.hIn]) handleOf.push({ handle: r.hIn, anchor: r.anchor })
      if (r.hOut >= 0 && !followsAnchor[r.hOut]) handleOf.push({ handle: r.hOut, anchor: r.anchor })
    }
  }
  const cosMaxTurn = Math.cos((tune.maxHandleTurnDeg * Math.PI) / 180)
  const sinMaxTurn = Math.sin((tune.maxHandleTurnDeg * Math.PI) / 180)

  const project = (v: Float64Array): void => {
    // Limits first, so the tangent is taken from where the points may really be.
    for (let i = 0; i < np; i++) {
      const lim = isHandle[i] ? tune.maxTotalHandle : tune.maxTotalAnchor
      const dx = v[i * 2] - x0[i * 2]
      const dy = v[i * 2 + 1] - x0[i * 2 + 1]
      const d = Math.hypot(dx, dy)
      if (d > lim) {
        v[i * 2] = x0[i * 2] + (dx / d) * lim
        v[i * 2 + 1] = x0[i * 2 + 1] + (dy / d) * lim
      }
    }
    // A handle keeps roughly the direction and at least a quarter of the length the fit gave it.
    for (const { handle, anchor } of handleOf) {
      const dx0 = x0[handle * 2] - x0[anchor * 2]
      const dy0 = x0[handle * 2 + 1] - x0[anchor * 2 + 1]
      const l0 = Math.hypot(dx0, dy0)
      if (l0 < 1e-6) continue
      const dx = v[handle * 2] - v[anchor * 2]
      const dy = v[handle * 2 + 1] - v[anchor * 2 + 1]
      const l = Math.hypot(dx, dy)
      const cos = l < 1e-9 ? 1 : (dx * dx0 + dy * dy0) / (l * l0)
      const cross = l < 1e-9 ? 0 : (dx0 * dy - dy0 * dx) / (l * l0)
      const within = cos >= cosMaxTurn
      if (within && l >= l0 / 4) continue
      const len = Math.max(l, l0 / 4)
      // Rotate the fit's direction by the turn allowed, toward where the handle went.
      const c = within ? cos : cosMaxTurn
      const s = within ? cross : Math.sign(cross || 1) * sinMaxTurn
      v[handle * 2] = v[anchor * 2] + ((dx0 * c - dy0 * s) / l0) * len
      v[handle * 2 + 1] = v[anchor * 2 + 1] + ((dx0 * s + dy0 * c) / l0) * len
    }
    for (const [p, dir] of throughDir) {
      const l = Math.hypot(dir.x, dir.y) || 1
      const ux = dir.x / l
      const uy = dir.y / l
      const t = (v[p * 2] - x0[p * 2]) * ux + (v[p * 2 + 1] - x0[p * 2 + 1]) * uy
      v[p * 2] = x0[p * 2] + t * ux
      v[p * 2 + 1] = x0[p * 2 + 1] + t * uy
    }
    for (const r of rigid) {
      v[r.handle * 2] = v[r.anchor * 2] + r.dx
      v[r.handle * 2 + 1] = v[r.anchor * 2 + 1] + r.dy
    }
    for (const t of tangents) {
      const ax = v[t.anchor * 2]
      const ay = v[t.anchor * 2 + 1]
      if (t.lineFrom >= 0) {
        const fx = v[t.lineFrom * 2]
        const fy = v[t.lineFrom * 2 + 1]
        const h = t.hOut >= 0 ? t.hOut : t.hIn
        const sign = 1
        const lineLen = Math.hypot(ax - fx, ay - fy)
        if (lineLen < 1e-6) continue
        const ux = ((ax - fx) / lineLen) * sign
        const uy = ((ay - fy) / lineLen) * sign
        const len = Math.hypot(v[h * 2] - ax, v[h * 2 + 1] - ay)
        v[h * 2] = ax + ux * len
        v[h * 2 + 1] = ay + uy * len
      } else {
        const inx = v[t.hIn * 2]
        const iny = v[t.hIn * 2 + 1]
        const outx = v[t.hOut * 2]
        const outy = v[t.hOut * 2 + 1]
        const dl = Math.hypot(outx - inx, outy - iny)
        if (dl < 1e-6) continue
        const ux = (outx - inx) / dl
        const uy = (outy - iny) / dl
        const lIn = Math.hypot(inx - ax, iny - ay)
        const lOut = Math.hypot(outx - ax, outy - ay)
        v[t.hIn * 2] = ax - ux * lIn
        v[t.hIn * 2 + 1] = ay - uy * lIn
        v[t.hOut * 2] = ax + ux * lOut
        v[t.hOut * 2 + 1] = ay + uy * lOut
      }
    }
    // A fixed coordinate stays put whatever the tangent asked of it. A rigid handle is fixed
    // to its junction, not to the page, so it has already moved with it.
    for (let i = 0; i < np * 2; i++) {
      if (!free[i] && !followsAnchor[i >> 1]) v[i] = x0[i]
    }
  }

  // --- flatten: the same polyline renders the picture and files the Jacobian ---
  const walk = (
    v: Float64Array,
    emit: (x0: number, y0: number, x1: number, y1: number, seg: number, t0: number, t1: number) => void,
  ): void => {
    for (let si = 0; si < segs.length; si++) {
      const s = segs[si]
      const ax = v[s.a * 2]
      const ay = v[s.a * 2 + 1]
      const bx = v[s.b * 2]
      const by = v[s.b * 2 + 1]
      if (s.h1 < 0 && s.h2 < 0) {
        emit(ax, ay, bx, by, si, 0, 1)
        continue
      }
      const c1x = s.h1 >= 0 ? v[s.h1 * 2] : ax
      const c1y = s.h1 >= 0 ? v[s.h1 * 2 + 1] : ay
      const c2x = s.h2 >= 0 ? v[s.h2 * 2] : bx
      const c2y = s.h2 >= 0 ? v[s.h2 * 2 + 1] : by
      const len = Math.hypot(c1x - ax, c1y - ay) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(bx - c2x, by - c2y)
      const n = Math.max(1, Math.min(256, Math.ceil(len / tune.step)))
      let qx = ax
      let qy = ay
      for (let k = 1; k <= n; k++) {
        const t = k / n
        const u = 1 - t
        const b0 = u * u * u
        const b1 = 3 * u * u * t
        const b2 = 3 * u * t * t
        const b3 = t * t * t
        const rx = b0 * ax + b1 * c1x + b2 * c2x + b3 * bx
        const ry = b0 * ay + b1 * c1y + b2 * c2y + b3 * by
        emit(qx, qy, rx, ry, si, (k - 1) / n, t)
        qx = rx
        qy = ry
      }
    }
  }

  // --- the band: fixed for the whole solve, so the energy is continuous ---
  const blocked = new Uint8Array(w * h)
  const seeds = new Uint8Array(w * h)
  const markLine = (mask: Uint8Array, ax: number, ay: number, bx: number, by: number): void => {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)))
    for (let k = 0; k <= steps; k++) {
      const px0 = Math.floor(ax + ((bx - ax) * k) / steps)
      const py0 = Math.floor(ay + ((by - ay) * k) / steps)
      if (px0 >= 0 && py0 >= 0 && px0 < w && py0 < h) mask[py0 * w + px0] = 1
    }
  }
  walk(x, (ax, ay, bx, by, si) => {
    if (segOnFrame[si]) return
    markLine(edgeMovable[segs[si].edge] ? seeds : blocked, ax, ay, bx, by)
  })
  const dilate = (mask: Uint8Array, reach: number): Uint8Array => {
    const out = new Uint8Array(w * h)
    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        if (!mask[cy * w + cx]) continue
        const y1 = Math.min(h - 1, cy + reach)
        const x1 = Math.min(w - 1, cx + reach)
        for (let qy = Math.max(0, cy - reach); qy <= y1; qy++) {
          for (let qx = Math.max(0, cx - reach); qx <= x1; qx++) out[qy * w + qx] = 1
        }
      }
    }
    return out
  }
  const reached = dilate(seeds, REACH)
  const excluded = dilate(blocked, 1)
  const bandIndex = new Int32Array(w * h).fill(-1)
  let nb = 0
  for (let i = 0; i < w * h; i++) if (reached[i] && !excluded[i]) bandIndex[i] = nb++
  if (nb === 0) return null
  const target = new Float64Array(nb * 4)
  const render = new Float64Array(nb * 4)
  for (let i = 0; i < w * h; i++) {
    const b = bandIndex[i]
    if (b < 0) continue
    const a = data[i * 4 + 3] / 255
    target[b * 4] = (data[i * 4] / 255) * a
    target[b * 4 + 1] = (data[i * 4 + 1] / 255) * a
    target[b * 4 + 2] = (data[i * 4 + 2] / 255) * a
    target[b * 4 + 3] = a
  }

  // --- render the band; the sign comes from the picture, not from an orientation convention ---
  const acc = new Float64Array((w + 2) * h * 4)
  let sign = 1
  const cover = (sl: GradientSlot, ax: number, ay: number, bx: number, by: number, s: number): void => {
    const stride = sl.w + 2
    scanLine(sl.w, sl.h, ax - sl.x0, ay - sl.y0, bx - sl.x0, by - sl.y0, (row, cell, c) => {
      sl.acc[row * stride + cell] += c * s
    })
  }
  const slotList = [...slots.values()]
  const paint = (v: Float64Array): void => {
    acc.fill(0)
    for (const sl of slotList) sl.acc.fill(0)
    walk(v, (ax, ay, bx, by, si) => {
      const ei = segs[si].edge
      depositLine(acc, w, h, ax, ay, bx, by, edgeColour[ei])
      const es = edgeSlots[ei]
      if (es.left) cover(es.left, ax, ay, bx, by, 1)
      if (es.right) cover(es.right, ax, ay, bx, by, -1)
    })
    const stride = (w + 2) * 4
    for (let cy = 0; cy < h; cy++) {
      let r = 0
      let g = 0
      let bl = 0
      let al = 0
      const row = cy * stride
      for (let cx = 0; cx < w; cx++) {
        const o = row + cx * 4
        r += acc[o]
        g += acc[o + 1]
        bl += acc[o + 2]
        al += acc[o + 3]
        const b = bandIndex[cy * w + cx]
        if (b < 0) continue
        render[b * 4] = r * sign
        render[b * 4 + 1] = g * sign
        render[b * 4 + 2] = bl * sign
        render[b * 4 + 3] = al * sign
      }
    }
    for (const sl of slotList) {
      const slStride = sl.w + 2
      for (let cy = 0; cy < sl.h; cy++) {
        let run = 0
        const row = cy * slStride
        const iy = sl.y0 + cy
        for (let cx = 0; cx < sl.w; cx++) {
          run += sl.acc[row + cx]
          const ix = sl.x0 + cx
          const b = bandIndex[iy * w + ix]
          if (b < 0 || Math.abs(run) < 1e-9) continue
          const k = lutIndex(sl, ix, iy)
          const cov = run * sign
          render[b * 4] += cov * sl.lut[k]
          render[b * 4 + 1] += cov * sl.lut[k + 1]
          render[b * 4 + 2] += cov * sl.lut[k + 2]
        }
      }
    }
  }
  paint(x)
  let alphaSum = 0
  for (let i = 3; i < render.length; i += 4) alphaSum += render[i]
  if (alphaSum < 0) sign = -1
  // A partition's picture stays inside the colours it mixes. Out of range means the model of this
  // graph is wrong: optimising it would move boundaries toward nonsense, so the fit stands.
  let outOfRange = 0
  for (let i = 0; i < render.length; i++) {
    const v = render[i] * sign
    if (v < -0.1 || v > 1.1) outOfRange++
  }
  if (outOfRange > render.length * 0.01) return null
  const energy = (v: Float64Array): number => {
    paint(v)
    let e = 0
    for (let i = 0; i < render.length; i++) {
      const d = target[i] - render[i]
      e += d * d
    }
    return e
  }

  // --- the Jacobian, rebuilt at each accepted point ---
  const pieceBand: number[] = []
  const pieceAx: number[] = []
  const pieceAy: number[] = []
  const pieceSeg: number[] = []
  const pieceT: number[] = []
  // left colour − right colour at the piece's pixel, four channels a piece.
  const pieceC: number[] = []
  const buildPieces = (v: Float64Array): void => {
    pieceC.length = 0
    pieceBand.length = 0
    pieceAx.length = 0
    pieceAy.length = 0
    pieceSeg.length = 0
    pieceT.length = 0
    const file = (ax: number, ay: number, bx: number, by: number, si: number, t: number): void => {
      const cx = Math.floor((ax + bx) / 2)
      const cy = Math.floor((ay + by) / 2)
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) return
      const b = bandIndex[cy * w + cx]
      if (b < 0) return
      pieceBand.push(b)
      // Coverage of the pixel changes by the area swept: δ × (piece vector).
      pieceAx.push(-(by - ay) * sign)
      pieceAy.push((bx - ax) * sign)
      pieceSeg.push(si)
      pieceT.push(t)
      const ei = segs[si].edge
      const c = edgeColour[ei]
      let cr = c[0]
      let cg = c[1]
      let cb = c[2]
      const { left, right } = edgeSlots[ei]
      if (left) {
        const k = lutIndex(left, cx, cy)
        cr += left.lut[k]
        cg += left.lut[k + 1]
        cb += left.lut[k + 2]
      }
      if (right) {
        const k = lutIndex(right, cx, cy)
        cr -= right.lut[k]
        cg -= right.lut[k + 1]
        cb -= right.lut[k + 2]
      }
      pieceC.push(cr, cg, cb, c[3])
    }
    walk(v, (ax, ay, bx, by, si, t0, t1) => {
      if (!edgeMovable[segs[si].edge] || segOnFrame[si]) return
      // Cut the piece where it crosses a pixel gridline.
      const cuts = [0, 1]
      const dx = bx - ax
      const dy = by - ay
      if (Math.floor(ax) !== Math.floor(bx)) {
        for (let g = Math.ceil(Math.min(ax, bx)); g <= Math.floor(Math.max(ax, bx)); g++) cuts.push((g - ax) / dx)
      }
      if (Math.floor(ay) !== Math.floor(by)) {
        for (let g = Math.ceil(Math.min(ay, by)); g <= Math.floor(Math.max(ay, by)); g++) cuts.push((g - ay) / dy)
      }
      if (cuts.length > 2) cuts.sort((p, q) => p - q)
      for (let k = 0; k + 1 < cuts.length; k++) {
        const u0 = Math.max(0, cuts[k])
        const u1 = Math.min(1, cuts[k + 1])
        if (u1 - u0 < 1e-9) continue
        file(ax + dx * u0, ay + dy * u0, ax + dx * u1, ay + dy * u1, si, t0 + (t1 - t0) * ((u0 + u1) / 2))
      }
    })
  }
  // Bézier weights of a piece on its four control points. A missing handle's weight goes to
  // its anchor: "a null handle collapses onto its anchor".
  const weights = (s: Seg, t: number, out: Float64Array): void => {
    const u = 1 - t
    let b0 = u * u * u
    let b1 = 3 * u * u * t
    let b2 = 3 * u * t * t
    let b3 = t * t * t
    if (s.h1 < 0 && s.h2 < 0) {
      b0 = u
      b1 = 0
      b2 = 0
      b3 = t
    } else {
      if (s.h1 < 0) {
        b0 += b1
        b1 = 0
      }
      if (s.h2 < 0) {
        b3 += b2
        b2 = 0
      }
    }
    out[0] = b0
    out[1] = b1
    out[2] = b2
    out[3] = b3
  }
  const w4 = new Float64Array(4)
  const applyJ = (dv: Float64Array, out: Float64Array): void => {
    out.fill(0)
    for (let i = 0; i < pieceBand.length; i++) {
      const s = segs[pieceSeg[i]]
      weights(s, pieceT[i], w4)
      let d = 0
      if (w4[0]) d += w4[0] * (dv[s.a * 2] * pieceAx[i] + dv[s.a * 2 + 1] * pieceAy[i])
      if (w4[1]) d += w4[1] * (dv[s.h1 * 2] * pieceAx[i] + dv[s.h1 * 2 + 1] * pieceAy[i])
      if (w4[2]) d += w4[2] * (dv[s.h2 * 2] * pieceAx[i] + dv[s.h2 * 2 + 1] * pieceAy[i])
      if (w4[3]) d += w4[3] * (dv[s.b * 2] * pieceAx[i] + dv[s.b * 2 + 1] * pieceAy[i])
      const o = pieceBand[i] * 4
      const c = i * 4
      out[o] += d * pieceC[c]
      out[o + 1] += d * pieceC[c + 1]
      out[o + 2] += d * pieceC[c + 2]
      out[o + 3] += d * pieceC[c + 3]
    }
  }
  const applyJT = (u: Float64Array, out: Float64Array): void => {
    out.fill(0)
    for (let i = 0; i < pieceBand.length; i++) {
      const s = segs[pieceSeg[i]]
      const o = pieceBand[i] * 4
      const c = i * 4
      const sv = pieceC[c] * u[o] + pieceC[c + 1] * u[o + 1] + pieceC[c + 2] * u[o + 2] + pieceC[c + 3] * u[o + 3]
      if (sv === 0) continue
      weights(s, pieceT[i], w4)
      const gx = sv * pieceAx[i]
      const gy = sv * pieceAy[i]
      if (w4[0]) {
        out[s.a * 2] += w4[0] * gx
        out[s.a * 2 + 1] += w4[0] * gy
      }
      if (w4[1]) {
        out[s.h1 * 2] += w4[1] * gx
        out[s.h1 * 2 + 1] += w4[1] * gy
      }
      if (w4[2]) {
        out[s.h2 * 2] += w4[2] * gx
        out[s.h2 * 2 + 1] += w4[2] * gy
      }
      if (w4[3]) {
        out[s.b * 2] += w4[3] * gx
        out[s.b * 2 + 1] += w4[3] * gy
      }
    }
    for (let i = 0; i < out.length; i++) if (!free[i]) out[i] = 0
  }
  const diagonal = (out: Float64Array): void => {
    out.fill(0)
    for (let i = 0; i < pieceBand.length; i++) {
      const s = segs[pieceSeg[i]]
      const c = i * 4
      const cc =
        pieceC[c] * pieceC[c] +
        pieceC[c + 1] * pieceC[c + 1] +
        pieceC[c + 2] * pieceC[c + 2] +
        pieceC[c + 3] * pieceC[c + 3]
      weights(s, pieceT[i], w4)
      const ax2 = pieceAx[i] * pieceAx[i] * cc
      const ay2 = pieceAy[i] * pieceAy[i] * cc
      const pts = [s.a, s.h1, s.h2, s.b]
      for (let k = 0; k < 4; k++) {
        if (!w4[k]) continue
        out[pts[k] * 2] += w4[k] * w4[k] * ax2
        out[pts[k] * 2 + 1] += w4[k] * w4[k] * ay2
      }
    }
  }

  // --- damped Gauss-Newton ---
  const before = energy(x)
  let eCur = before
  let lambda = 0.02
  const g = new Float64Array(np * 2)
  const diag = new Float64Array(np * 2)
  const step = new Float64Array(np * 2)
  const res = new Float64Array(np * 2)
  const zv = new Float64Array(np * 2)
  const pv = new Float64Array(np * 2)
  const Ap = new Float64Array(np * 2)
  const jp = new Float64Array(nb * 4)
  const resid = new Float64Array(nb * 4)
  const trial = new Float64Array(np * 2)
  let iters = 0
  const run = (count: number): void => {
    for (let it = 0; it < count; it++) {
      iters++
      buildPieces(x)
      paint(x)
      for (let i = 0; i < resid.length; i++) resid[i] = target[i] - render[i]
      applyJT(resid, g)
      diagonal(diag)
      let meanDiag = 0
      let nDiag = 0
      for (let i = 0; i < diag.length; i++) {
        if (!free[i] || diag[i] <= 0) continue
        meanDiag += diag[i]
        nDiag++
      }
      if (nDiag === 0) break
      meanDiag /= nDiag
      const floor = meanDiag * 1e-3
      let accepted = false
      for (let attempt = 0; attempt < 4 && !accepted; attempt++) {
        // CG on (JᵀJ + λ·D) step = Jᵀr, Jacobi-preconditioned.
        const damp = (i: number): number => lambda * (diag[i] + floor)
        const M = (i: number): number => diag[i] + damp(i) || 1
        step.fill(0)
        res.set(g)
        let rz = 0
        for (let i = 0; i < res.length; i++) {
          zv[i] = free[i] ? res[i] / M(i) : 0
          pv[i] = zv[i]
          rz += res[i] * zv[i]
        }
        const rz0 = rz
        for (let k = 0; k < tune.cgIters && rz > rz0 * 1e-4; k++) {
          applyJ(pv, jp)
          applyJT(jp, Ap)
          let pAp = 0
          for (let i = 0; i < Ap.length; i++) {
            if (!free[i]) {
              Ap[i] = 0
              continue
            }
            Ap[i] += damp(i) * pv[i]
            pAp += pv[i] * Ap[i]
          }
          if (pAp <= 0) break
          const alpha = rz / pAp
          let rzNext = 0
          for (let i = 0; i < res.length; i++) {
            step[i] += alpha * pv[i]
            res[i] -= alpha * Ap[i]
            zv[i] = free[i] ? res[i] / M(i) : 0
            rzNext += res[i] * zv[i]
          }
          const beta = rzNext / rz
          rz = rzNext
          for (let i = 0; i < pv.length; i++) pv[i] = zv[i] + beta * pv[i]
        }
        for (let i = 0; i < np; i++) {
          const lim = isHandle[i] ? tune.maxStepHandle : tune.maxStepAnchor
          const sx = step[i * 2]
          const sy = step[i * 2 + 1]
          const d = Math.hypot(sx, sy)
          const f = d > lim ? lim / d : 1
          trial[i * 2] = x[i * 2] + sx * f
          trial[i * 2 + 1] = x[i * 2 + 1] + sy * f
        }
        project(trial)
        const eTrial = energy(trial)
        if (eTrial < eCur) {
          const gain = (eCur - eTrial) / (eCur || 1)
          x.set(trial)
          eCur = eTrial
          lambda = Math.max(1e-4, lambda / 2)
          accepted = true
          if (gain < tune.minGain) it = count
        } else {
          lambda *= 4
        }
      }
      if (!accepted) break
    }
  }
  run(tune.iters)

  // A side the raster left straight goes back to being a line, and the rest settle around it.
  let straightened = 0
  for (const si of bent) {
    const s = segs[si]
    const ax = x[s.a * 2]
    const ay = x[s.a * 2 + 1]
    const dx = x[s.b * 2] - ax
    const dy = x[s.b * 2 + 1] - ay
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) continue
    const off = (p: number): number => Math.abs((x[p * 2] - ax) * dy - (x[p * 2 + 1] - ay) * dx) / len
    // A cubic's sagitta is at most 3/4 of its handles' distance from the chord.
    if (0.75 * Math.max(off(s.h1), off(s.h2)) >= tune.bendKeep) continue
    const refs = nodeRefs[s.edge]
    refs[s.node].hOut = -1
    refs[(s.node + 1) % refs.length].hIn = -1
    free[s.h1 * 2] = 0
    free[s.h1 * 2 + 1] = 0
    free[s.h2 * 2] = 0
    free[s.h2 * 2 + 1] = 0
    s.h1 = -1
    s.h2 = -1
    straightened++
  }
  if (straightened > 0) {
    buildTangents()
    eCur = energy(x)
    lambda = Math.max(lambda, 0.02)
    run(tune.bendFinish)
  }
  if (eCur >= before) return null

  // --- write back ---
  const pt = (p: number): Vec => ({ x: x[p * 2], y: x[p * 2 + 1] })
  for (const v of vertices) {
    const p = vertexPoint.get(v.id)
    if (p == null) continue
    v.x = x[p * 2]
    v.y = x[p * 2 + 1]
  }
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei]
    const refs = nodeRefs[ei]
    for (let i = 0; i < e.nodes.length; i++) {
      const nd = e.nodes[i]
      const r = refs[i]
      nd.x = x[r.anchor * 2]
      nd.y = x[r.anchor * 2 + 1]
      if (r.hIn >= 0) nd.hIn = pt(r.hIn)
      if (r.hOut >= 0) nd.hOut = pt(r.hOut)
    }
  }
  let unknowns = 0
  for (let i = 0; i < free.length; i++) if (free[i]) unknowns++
  const report = { before, after: eCur, iters, unknowns, band: nb }
  const splits: SplitCandidate[] = []
  if (wantSplits) {
    // What each curve still misses, and where along it.
    buildPieces(x)
    paint(x)
    const BINS = 16
    const score = new Float64Array(segs.length)
    const bins = new Float64Array(segs.length * BINS)
    for (let i = 0; i < pieceBand.length; i++) {
      const o = pieceBand[i] * 4
      let rr = 0
      for (let k = 0; k < 4; k++) {
        const d = target[o + k] - render[o + k]
        rr += d * d
      }
      const v = rr * Math.hypot(pieceAx[i], pieceAy[i])
      score[pieceSeg[i]] += v
      bins[pieceSeg[i] * BINS + Math.min(BINS - 1, Math.floor(pieceT[i] * BINS))] += v
    }
    for (let si = 0; si < segs.length; si++) {
      const s = segs[si]
      if (score[si] < tune.splitMinScore || (s.h1 < 0 && s.h2 < 0)) continue
      if (Math.hypot(x[s.b * 2] - x[s.a * 2], x[s.b * 2 + 1] - x[s.a * 2 + 1]) < tune.splitMinLen) continue
      let bestT = 0.5
      let best = -1
      for (let b = 2; b < BINS - 2; b++) {
        const k = si * BINS + b
        const v = bins[k - 1] + bins[k] + bins[k + 1]
        if (v > best) {
          best = v
          bestT = (b + 0.5) / BINS
        }
      }
      splits.push({ edge: s.edge, node: s.node, t: bestT, score: score[si] })
    }
  }
  return { report, splits }
}
