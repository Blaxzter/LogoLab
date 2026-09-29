// A centreline polyline → PathNodes, with the planar fitter's own pieces: the open-arc
// DP (`fitOpenArc`) between corners, the closed-loop fitter for a ring, and a circle
// snap for a ring that is one — the same "sharp is 60°" and the same ε the outline
// lanes use, so Smoothing means the same thing to a stroke as to a fill.
//
// One thing is this file's own: the APEX. Thinning rounds every sharp corner — the
// skeleton's turn sits about half a width inside the point where the two centrelines
// meet, and is rounded over about as much on either side. So a corner the turn
// detector finds is REBUILT: the two arms are read outside that rounded zone (a line
// where they are straight, a circle's tangent where they curve) and the apex is where
// the arm lines meet. The raster then has the last word: at a real corner the
// ink still reaches the apex (a round join is an arc centred on it, a miter goes past
// it), so the distance transform there reads a full half-width; at a smooth bend tight
// enough to trip the detector the apex sits between the centreline and the outer
// edge, and the transform reads less. A candidate that fails that check keeps its
// smooth polyline. A bevel join fails it too and stays rounded, which is the ink.

import type { PathNode, SubPath, Vec } from '../../path/types'
import { fitClosedLoop, lineFit } from '../curveFit.ts'
import { CORNER_MERGE, CORNER_WINDOW, detectLoopCorners, detectOpenCorners } from '../planarFit/corners.ts'
import { circleMaxDev, dedup, fitCircle } from '../planarFit/geom.ts'
import { fitOpenArc } from '../planarFit/openFit.ts'
import type { PlanarFitOptions } from '../planarFit/options.ts'
import { ellipseSubPaths } from '../../path/model.ts'

/** What the apex reconstruction needs to know about the raster. */
export interface FitContext {
  /** Stroke width of the path (px). */
  width: number
  /** Distance transform of the ink (px), row-major. */
  dt: Float32Array
  rasterWidth: number
  rasterHeight: number
  /** σ of the smoothing the polyline had (points ≈ px); the apex zone clears 3σ of it. */
  sigma?: number
  /** Diagnostic sink, called once per corner candidate with what was decided and why. */
  onCorner?: (r: CornerDiag) => void
}

/** One corner candidate's record (bench/centerlineDiag.ts prints these). */
export interface CornerDiag {
  /** The candidate on the polyline, and the coarse turn read there (deg). */
  at: Vec
  turnDeg: number
  zone: number
  /** Arm lines as read (null = unreadable). */
  armA: { at: Vec; dir: Vec } | null
  armB: { at: Vec; dir: Vec } | null
  apex: Vec | null
  /** Distance transform at the apex vs the half-width the check wants. */
  dtAtApex: number | null
  needDt: number
  outcome: 'rebuilt' | 'kept-turn' | 'smooth'
}

/** Share of the half-width the distance transform must read at an apex for it to be a corner. */
export const APEX_MIN_RADIUS = 0.85
// Not smoothed further before fitting. Smoothing each piece at σ = 0.2 W was tried
// for the rect-corner kink (lucide-mail, 4.7 px off where a side meets a corner arc of
// radius W) and measured: every curve shrinks by σ²/2R, and the corpus went from
// 17/20 to 13/20 passing (house 0.35 → 0.65 px, settings 0.30 → 0.69). The kink is a
// fitter question (the DP reads the skeleton's wobble as a wedge), not a smoothing one.
/** The straight-arm bar: max deviation from a line, in px, as a share of W and a floor.
 *  A chord of length L on a circle of radius R deviates L²/(8R) and its direction is off
 *  by L/(2R): at 0.02 W over a 0.75 W chord the direction error stays under ~4°. */
export const STRAIGHT_TOL_W = 0.02
export const STRAIGHT_TOL_MIN = 0.35

const corner = (p: Vec): PathNode => ({ x: p.x, y: p.y, hIn: null, hOut: null, kind: 'corner' })
const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y)

/** Bilinear read of the distance transform at a point (pixel centres at +0.5). */
function dtAt(ctx: FitContext, p: Vec): number {
  const fx = p.x - 0.5
  const fy = p.y - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= ctx.rasterWidth || y >= ctx.rasterHeight ? 0 : ctx.dt[y * ctx.rasterWidth + x]
  return (
    (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) +
    (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
  )
}

/** A line through `at` with unit direction `dir`. */
interface Line {
  at: Vec
  dir: Vec
}

/**
 * The line an arm follows as it approaches a corner or a junction, read from the points
 * beyond the rounded zone: a total-least-squares line over the longest straight stretch
 * (grown outward while it stays within `tol`), or — when the arm curves — the tangent
 * of the circle through its first ~2 W at the point nearest the zone. `seq[0]` is the
 * point nearest the corner. Null when the arm is too short to read.
 *
 * `tol` is the fit tolerance for the CIRCLE and the fallback; the straight test uses a
 * tighter bar of its own (`STRAIGHT_TOL`), because a chord of a small ring passes a
 * loose one — a 24 px chord of a 48 px circle deviates 1.5 px — and its direction is
 * then 20° off the tangent, which is the difference between a ring's two ends pairing
 * through their stem and the ring opening into a V.
 */
export function armLineOf(seq: Vec[], W: number, tol: number, toward?: Vec): Line | null {
  if (seq.length < 2) return null
  const maxSpan = 4 * W
  const straightTol = Math.min(tol, Math.max(STRAIGHT_TOL_MIN, STRAIGHT_TOL_W * W))
  // Grow a straight window.
  let acc = 0
  let best: Vec[] | null = null
  const win: Vec[] = [seq[0]]
  for (let k = 1; k < seq.length; k++) {
    acc += dist(seq[k], seq[k - 1])
    win.push(seq[k])
    if (win.length >= 3) {
      const lf = lineFit(win)
      if (!lf || lf.maxDev > straightTol) break
      best = win.slice()
    }
    if (acc >= maxSpan) break
  }
  const straightLen = best ? dist(best[0], best[best.length - 1]) : 0
  if (best && straightLen >= Math.max(3, 0.75 * W)) {
    const lf = lineFit(best)!
    // Orient toward seq[0] (into the corner).
    const d =
      lf.dir.x * (best[0].x - best[best.length - 1].x) + lf.dir.y * (best[0].y - best[best.length - 1].y) < 0
        ? { x: -lf.dir.x, y: -lf.dir.y }
        : lf.dir
    let mx = 0
    let my = 0
    for (const q of best) {
      mx += q.x
      my += q.y
    }
    return { at: { x: mx / best.length, y: my / best.length }, dir: d }
  }
  // Curved arm: circle over ~2 W of arc, tangent at the point nearest the corner.
  const arc: Vec[] = []
  acc = 0
  for (let k = 0; k < seq.length; k++) {
    arc.push(seq[k])
    if (k > 0) acc += dist(seq[k], seq[k - 1])
    if (acc >= 2 * W) break
  }
  if (arc.length >= 4) {
    const c = fitCircle(arc)
    const dev = circleMaxDev(arc)
    if (c && dev !== null && dev <= tol) {
      // The tangent where the circle passes nearest the point the arm heads for (the
      // junction, or the corner candidate) — not at the arm's first point, which sits
      // a zone's length back around the circle: on a 48 px ring that is 23° of arc, and
      // a tangent read there says a ring's two ends turn 46° through their stem. Only
      // when that point IS on the circle, though: a rounded rect's side reaches its
      // junction below the corner arc, where the stroke has straightened, and the
      // circle's tangent at the junction's projection would be the arc's, tilted.
      const onCircle =
        toward !== undefined && Math.abs(Math.hypot(toward.x - c.cx, toward.y - c.cy) - c.r) <= Math.max(2, 0.1 * c.r)
      const p = onCircle ? toward! : arc[0]
      const rx = p.x - c.cx
      const ry = p.y - c.cy
      const rl = Math.hypot(rx, ry) || 1
      // Tangent, oriented toward the corner (away from the arc's far end).
      let tx = -ry / rl
      let ty = rx / rl
      const far = arc[arc.length - 1]
      if (tx * (arc[0].x - far.x) + ty * (arc[0].y - far.y) < 0) {
        tx = -tx
        ty = -ty
      }
      return { at: { x: c.cx + (rx / rl) * c.r, y: c.cy + (ry / rl) * c.r }, dir: { x: tx, y: ty } }
    }
  }
  // Short or irregular: the chord of what there is.
  const far = seq[Math.min(seq.length - 1, Math.max(2, Math.round(W)))]
  const dx = seq[0].x - far.x
  const dy = seq[0].y - far.y
  const l = Math.hypot(dx, dy)
  if (l < 1e-6) return null
  return { at: seq[0], dir: { x: dx / l, y: dy / l } }
}

/** Intersection of two lines, or null when near-parallel. */
export function lineMeet(a: Line, b: Line): Vec | null {
  const den = a.dir.x * b.dir.y - a.dir.y * b.dir.x
  if (Math.abs(den) < 1e-6) return null
  const dx = b.at.x - a.at.x
  const dy = b.at.y - a.at.y
  const t = (dx * b.dir.y - dy * b.dir.x) / den
  return { x: a.at.x + t * a.dir.x, y: a.at.y + t * a.dir.y }
}

export interface Rebuilt {
  pts: Vec[]
  /** Indices into `pts` of the rebuilt apexes (forced corners). */
  corners: number[]
}

/**
 * Find the corners of an open polyline and rebuild each apex. The detector's window
 * scales with the stroke (±max(4, W) points) so a thick stroke's rounded turn still
 * reads as one; the circle-or-wedge evidence is then the raster's, via `ctx.dt`.
 */
export function rebuildCorners(raw: Vec[], W: number, opts: PlanarFitOptions, ctx: FitContext | null): Rebuilt {
  let pts = raw.slice()
  const n0 = pts.length
  if (n0 < 5) return { pts, corners: [] }
  // The window must reach past the skeleton's rounding (~0.6 r a side, see below), or
  // the turn it reads is the rounded arc's, not the corner's: ±W points does. A tight
  // smooth bend trips it too; the raster check below is what tells those apart.
  const win = Math.max(opts.cornerWindow ?? CORNER_WINDOW, Math.round(W))
  const merge = Math.max(opts.cornerMerge ?? CORNER_MERGE, W)
  // Descending: a rebuild replaces the zone around its corner with one point, so the
  // indices BEFORE it are untouched — and the ones already recorded after it move by the
  // same amount, which `shift` carries onto them below.
  const C = detectOpenCorners(pts, opts.cornerTurnDeg, win, merge)
    .filter((i) => i > 0 && i < n0 - 1)
    .sort((a, b) => b - a)
  const r = W / 2
  const tol = Math.max(0.5, 0.06 * W)
  const needDt = APEX_MIN_RADIUS * r - 0.5
  const corners: number[] = []
  for (const c of C) {
    const n = pts.length
    // Coarse turn over the window (diagnostic).
    const b = pts[Math.max(0, c - win)]
    const a = pts[Math.min(n - 1, c + win)]
    const d1 = { x: pts[c].x - b.x, y: pts[c].y - b.y }
    const d2 = { x: a.x - pts[c].x, y: a.y - pts[c].y }
    const cosTurn = (d1.x * d2.x + d1.y * d2.y) / ((Math.hypot(d1.x, d1.y) || 1) * (Math.hypot(d2.x, d2.y) || 1))
    const turnDeg = (Math.acos(Math.max(-1, Math.min(1, cosTurn))) * 180) / Math.PI
    // Measured on the thinned skeleton of a 36° tip at W=32: the turn is rounded over
    // ~0.6 r on each side of its tip, and the tip sits ~0.5 r inside the true apex.
    // (The exact medial axis would turn AT the apex; thinning rounds it.) A zone of
    // 0.8 r + 1 clears the rounding and leaves the arms as long as they can be; on a
    // thin stroke the polyline's own smoothing rounds the corner further, so the zone
    // also clears 3σ of that.
    const zone = Math.min(2 * W, Math.max(0.8 * r + 1, 3 * (ctx?.sigma ?? 0)))
    const diag = (rec: Omit<CornerDiag, 'at' | 'turnDeg' | 'zone' | 'needDt'>): void =>
      ctx?.onCorner?.({ at: pts[c], turnDeg, zone, needDt, ...rec })
    // Arms outside the zone, nearest point first.
    let ia = c
    while (ia > 0 && dist(pts[ia], pts[c]) < zone) ia--
    let ib = c
    while (ib < n - 1 && dist(pts[ib], pts[c]) < zone) ib++
    if (ia <= 0 || ib >= n - 1) {
      // Not enough arm on one side to read: keep the polyline's own turn as a corner.
      corners.push(c)
      diag({ armA: null, armB: null, apex: null, dtAtApex: null, outcome: 'kept-turn' })
      continue
    }
    const armA = pts.slice(0, ia + 1).reverse()
    const armB = pts.slice(ib)
    const la = armLineOf(armA, W, tol, pts[c])
    const lb = armLineOf(armB, W, tol, pts[c])
    const apex = la && lb ? lineMeet(la, lb) : null
    if (!apex || dist(apex, pts[c]) > zone + W) {
      corners.push(c)
      diag({ armA: la, armB: lb, apex, dtAtApex: null, outcome: 'kept-turn' })
      continue
    }
    // The raster's verdict: a corner's apex is on the centreline (full radius there).
    const have = ctx ? dtAt(ctx, apex) : null
    if (have !== null && have < needDt) {
      diag({ armA: la, armB: lb, apex, dtAtApex: have, outcome: 'smooth' })
      continue // a smooth bend (or a bevel): leave it
    }
    diag({ armA: la, armB: lb, apex, dtAtApex: have, outcome: 'rebuilt' })
    pts = [...pts.slice(0, ia + 1), apex, ...pts.slice(ib)]
    // The zone's ib − ia − 1 points became one: every corner recorded so far sits past
    // ib and moves back by that much. (Left uncorrected, each earlier corner's node
    // landed 6–14 px down its arm — a "corner" in the middle of a straight step.)
    const shift = 1 - (ib - ia - 1)
    for (let k = 0; k < corners.length; k++) corners[k] += shift
    corners.push(ia + 1)
  }
  return { pts, corners: corners.sort((a, b) => a - b) }
}

/** Concatenate piecewise fits: the seam node keeps the incoming handle of one piece and
 *  the outgoing handle of the next, as a corner. */
function joinPieces(pieces: PathNode[][], closed: boolean): PathNode[] {
  const out: PathNode[] = []
  for (const piece of pieces) {
    if (piece.length === 0) continue
    if (out.length === 0) {
      out.push(...piece.map((n) => ({ ...n })))
      continue
    }
    const seam = out[out.length - 1]
    seam.hOut = piece[0].hOut
    seam.kind = 'corner'
    for (let k = 1; k < piece.length; k++) out.push({ ...piece[k] })
  }
  if (closed && out.length > 1) {
    // The last node is the first: fold its incoming handle onto node 0.
    const last = out.pop()!
    out[0].hIn = last.hIn
    out[0].kind = 'corner'
  }
  return out
}

/** Fit an open polyline. */
export function fitOpenCentreline(raw: Vec[], W: number, opts: PlanarFitOptions, ctx: FitContext | null): PathNode[] {
  const pts0 = dedup(raw)
  if (pts0.length < 2) return []
  if (pts0.length === 2) return [corner(pts0[0]), corner(pts0[1])]
  // A straight run is two nodes, whatever the detector would say.
  const lf = lineFit(pts0)
  if (lf && lf.maxDev <= opts.epsilon) return [corner(pts0[0]), corner(pts0[pts0.length - 1])]
  const { pts, corners } = rebuildCorners(pts0, W, opts, ctx)
  const bounds = [0, ...corners, pts.length - 1]
  const pieces: PathNode[][] = []
  for (let i = 0; i + 1 < bounds.length; i++) {
    const piece = pts.slice(bounds[i], bounds[i + 1] + 1)
    if (piece.length < 2) continue
    pieces.push(fitOpenArc(piece, opts))
  }
  return joinPieces(pieces, false)
}

/**
 * Fit a ring. A ring that reads as a circle within `fidelity` px becomes a true circle;
 * otherwise its corners (rebuilt as above) split it into open pieces, or the
 * closed-loop fitter takes it whole.
 */
export function fitClosedCentreline(
  raw: Vec[],
  W: number,
  opts: PlanarFitOptions,
  ctx: FitContext | null,
  fidelity: number,
): SubPath | null {
  const pts0 = dedup(raw)
  if (pts0.length < 3) return null
  const circ = fitCircle(pts0)
  const dev = circleMaxDev(pts0)
  if (circ && dev !== null && fidelity > 0 && dev <= Math.min(fidelity, Math.max(0.5, 0.06 * circ.r))) {
    const sp = ellipseSubPaths(circ.cx, circ.cy, circ.r, circ.r)
    if (sp && sp.length) return sp[0]
  }
  const win = Math.max(opts.cornerWindow ?? CORNER_WINDOW, Math.round(W))
  const merge = Math.max(opts.cornerMerge ?? CORNER_MERGE, W)
  const C = detectLoopCorners(pts0, opts.cornerTurnDeg, win, merge)
  if (C.length === 0) {
    const nodes = fitClosedLoop(pts0, { epsilon: opts.epsilon, lineCost: opts.lineCost, cubicCost: opts.cubicCost })
    if (nodes && nodes.length >= 2) return { nodes, closed: true }
    return { nodes: pts0.map(corner), closed: true }
  }
  // Rotate so the seam sits midway between two corners, then treat as open: the
  // rebuild sees every corner with both arms intact, and the seam is on a smooth run.
  const n = pts0.length
  const sorted = C.slice().sort((a, b) => a - b)
  const c0 = sorted[0]
  const cPrev = sorted[sorted.length - 1]
  const gap = (c0 - cPrev + n) % n
  const seam = (cPrev + Math.floor(gap / 2)) % n
  const rot: Vec[] = []
  for (let k = 0; k <= n; k++) rot.push(pts0[(seam + k) % n]) // closes on itself
  const { pts, corners } = rebuildCorners(rot, W, opts, ctx)
  if (corners.length === 0) {
    const nodes = fitClosedLoop(pts0, { epsilon: opts.epsilon, lineCost: opts.lineCost, cubicCost: opts.cubicCost })
    if (nodes && nodes.length >= 2) return { nodes, closed: true }
  }
  const bounds = [0, ...corners, pts.length - 1]
  const pieces: PathNode[][] = []
  for (let i = 0; i + 1 < bounds.length; i++) {
    const piece = pts.slice(bounds[i], bounds[i + 1] + 1)
    if (piece.length >= 2) pieces.push(fitOpenArc(piece, opts))
  }
  const nodes = joinPieces(pieces, true)
  // The seam node (pts[0] = pts[last]) is on a smooth run: make it smooth, not a corner.
  if (nodes.length >= 2 && corners.length > 0 && corners[0] !== 0) nodes[0].kind = 'smooth'
  return nodes.length >= 2 ? { nodes, closed: true } : null
}
