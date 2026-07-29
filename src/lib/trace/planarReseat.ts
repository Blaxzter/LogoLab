// Junction RE-SEAT for the planar tracer — a planarBeautify pre-pass that moves a
// degree-3 junction vertex to the intersection of the two strongest fitted
// primitives (line / circle) arriving at it, when the vertex sits close to BOTH
// primitives yet their intersection lies measurably away ALONG them.
//
// The failure it corrects (docs/vectorization-benchmarks.md §10.4): where an
// occluding straight edge crosses a disc near-tangentially (gradient-flat's
// triangle over the white circle — 12° incidence), the three-colour meeting point
// in the LABEL MAP slides several px along the shared tangent: the colour needle
// between the two boundaries is sub-pixel thin near the true crossing, so AA +
// quantization hand its pixels to a neighbour class and the lattice junction
// lands where the needle first becomes wide enough to survive — measured 8.4px
// past the authored intersection at 512px. Every downstream fit honours the
// pinned vertex, so the straight edge's LAST segment bends off its own line to
// reach it ("the line gets pulled into the circle") and the chord between the
// junctions fits neither the line nor the arc. No lattice-local scheme can find
// the true point (the evidence is destroyed in the raster); the fitted primitives
// of the long incident boundaries still hold it — their intersection restores the
// junction to sub-pixel accuracy, and the mangled terminal caps are re-emitted
// from the primitives themselves.
//
// This is NOT planarJunction.subpixelJunctions (refineJunctions): that pass
// least-squares the RAW lattice arms within ±10px of the corner — exactly the
// mangled evidence — and caps its move at 2px, so it cannot see this defect. It
// re-seats EVERY junction (measured a corpus-wide tradeoff, off by default);
// this pass fires only where a slid junction is positively identified: the
// vertex within NEAR_TOL of both primitives, the correction ≥ MIN_MOVE (generic
// sub-pixel lattice noise stays untouched), transversal incidence at the target.
//
// Pure & deterministic: fixed vertex/edge order, no PRNG. Mutates `edges` /
// `vertices` in place (planarBeautify hands it the already-cloned copies).

import type { EdgeRef, PathNode, SharedEdge, Vec, Vertex } from '../path/types'
import { armLine } from './planarFit.ts'
import { arcSlice, type Circle, fitCircle, maxRadialDev } from './circleFit.ts'
import { weldJunctionClusters } from './planarWeld.ts'

/** Vertex must lie within this of BOTH primitives (a slid junction stays near
 *  both boundaries; one that is genuinely far from a primitive is not this
 *  failure mode and must not be "corrected" onto it). */
const NEAR_TOL = 3.0
/** Hard cap on the correction distance. */
const MAX_SLIDE = 12
/** Corrections below this are generic sub-pixel lattice noise, not a slide —
 *  skipped so ordinary (correct) junctions stay byte-stable. refineJunctions
 *  already measured corpus-wide sub-pixel re-seating as a tradeoff; this pass
 *  only claims the unambiguous failures. */
const MIN_MOVE = 1.5
/** Primitives must cross this transversally at the target (near-tangent
 *  intersections are numerically unstable along the shared tangent). */
const MIN_ANGLE_SIN = Math.sin((5 * Math.PI) / 180)
/** Arm evidence budget (px along the fitted boundary, from the vertex inward). */
const ARM_MAX = 110
/** A terminal segment no longer than this may be a mangled cap: the fit chasing
 *  the needle-annexed pixels into the junction. Its arm may exclude it. (24, not
 *  18: overlap's bottom lens tip put the cap breakpoint 20px out — the slid
 *  vertex then had ONE primitive and could not be corrected.) */
const CAP_MAX = 24
/** Max perp deviation for a line arm / radial deviation for a circle arm. */
const LINE_TOL = 0.8
const CIRC_TOL = 0.9
/** Minimum arm length to claim a line / a circle (a circle needs enough sweep
 *  to pin its centre). */
const MIN_LINE_ARM = 8
const MIN_ARC_ARM = 24
/** Circle-radius sanity range for an arm primitive. */
const R_MIN = 6
const R_MAX = 2500
/** Stop collecting arm segments at a fitted corner turning sharper than this —
 *  the boundary beyond a corner is a DIFFERENT primitive (gradient-flat: the
 *  triangle's top edge must not pollute its hypotenuse's line). */
const CORNER_STOP_COS = Math.cos((30 * Math.PI) / 180)
/** …EXCEPT at the first interior node when the terminal segment is this short:
 *  a ≤8px cap turning ≥30° into a long run IS the mangle (overlap's bottom lens
 *  tip: a 3px cap kinked off the arc — the corner stop starved the arm, so the
 *  cap-skip never had a candidate). A real short terminal (gradient-flat's 24px
 *  hypotenuse piece meeting the top edge at 42°) stays protected by the bound;
 *  and when the bypass does cross a REAL corner, candidate A fails its fit and
 *  candidate B must still pass the NEAR_TOL gate at the vertex. */
const CAP_STOP_BYPASS = 8
/** Samples per cubic segment when flattening an arm. */
const ARM_SAMPLES = 12
/** Chord straightening: the two junction line-primitives must be THIS collinear
 *  (angle / mutual offset) to count as one continuing occluder line… */
const CHORD_COLLINEAR_SIN = Math.sin((3 * Math.PI) / 180)
const CHORD_COLLINEAR_OFF = 1.0
/** …the edge between them must stay within this of that line (it crosses the
 *  needle-mangled zone, so it is looser than the arm tolerance but bounded), */
const CHORD_TOL = 2.5
/** …and no longer than this (the mangled zone is junction-local). */
const CHORD_MAX_LEN = 80

const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y)

/** A terminal primitive at one edge end. Line: point `a` + unit dir `d`.
 *  Circle: `c`. `conf` = arm length (px); `skipCap` = the terminal segment was
 *  excluded as a suspected mangled cap. */
interface Prim {
  kind: 'line' | 'circle'
  a?: Vec
  d?: Vec
  c?: Circle
  conf: number
  skipCap: boolean
}

interface End {
  e: SharedEdge
  atEnd: boolean
}

/** Sample the cubic (p, h1, h2, q) at `n` interior steps, including both ends. */
function sampleCubic(p: Vec, h1: Vec | null, h2: Vec | null, q: Vec, n: number, out: Vec[]): void {
  const c1 = h1 ?? p
  const c2 = h2 ?? q
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    out.push({
      x: u * u * u * p.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * q.x,
      y: u * u * u * p.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * q.y,
    })
  }
}

/** Polyline length. */
function polyLen(pts: Vec[]): number {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i])
  return l
}

interface Arm {
  /** Per fitted segment, flattened points ordered FROM the vertex INWARD
   *  (segPts[0][0] is the vertex-side anchor). */
  segPts: Vec[][]
  segLen: number[]
}

/**
 * Flatten the fitted segments of `e` from the `atEnd` endpoint inward, stopping
 * at ARM_MAX px or at an interior corner turning ≥ 30° (the boundary beyond a
 * corner belongs to a different primitive).
 */
function collectArm(e: SharedEdge, atEnd: boolean): Arm {
  const nodes = e.nodes
  const m = nodes.length
  const segPts: Vec[][] = []
  const segLen: number[] = []
  let cum = 0
  let prevDir: Vec | null = null
  const count = m - 1
  for (let s = 0; s < count && cum < ARM_MAX; s++) {
    // Node closer to the vertex (`p`) and its inner neighbour (`q`), with the
    // handles facing each other in that orientation.
    const p = atEnd ? nodes[m - 1 - s] : nodes[s]
    const q = atEnd ? nodes[m - 2 - s] : nodes[s + 1]
    const h1 = atEnd ? p.hIn : p.hOut
    const h2 = atEnd ? q.hOut : q.hIn
    const pts: Vec[] = []
    sampleCubic(p, h1, h2, q, ARM_SAMPLES, pts)
    // Corner stop: direction entering `p` (from the previous segment) vs leaving.
    // Bypassed at the first interior node behind a very short cap — see CAP_STOP_BYPASS.
    if (prevDir && !(s === 1 && segLen[0] <= CAP_STOP_BYPASS)) {
      const d0 = pts[1] ?? pts[0]
      const dx = d0.x - p.x
      const dy = d0.y - p.y
      const l = Math.hypot(dx, dy)
      if (l > 1e-9) {
        const cos = (prevDir.x * dx + prevDir.y * dy) / l
        if (cos < CORNER_STOP_COS) break
      }
    }
    const last = pts[pts.length - 1]
    const penult = pts[pts.length - 2] ?? pts[0]
    const ex = last.x - penult.x
    const ey = last.y - penult.y
    const el = Math.hypot(ex, ey)
    prevDir = el > 1e-9 ? { x: ex / el, y: ey / el } : prevDir
    segPts.push(pts)
    const l = polyLen(pts)
    segLen.push(l)
    cum += l
  }
  return { segPts, segLen }
}

/** Max perp deviation of `pts` from the line (a, d). */
function lineMaxDev(pts: Vec[], a: Vec, d: Vec): number {
  let maxD = 0
  for (const p of pts) {
    const dev = Math.abs((p.x - a.x) * d.y - (p.y - a.y) * d.x)
    if (dev > maxD) maxD = dev
  }
  return maxD
}

/** Fit `pts` (total length `len`) to a line, else a circle. */
function evalArm(pts: Vec[], len: number): Prim | null {
  if (pts.length < 2) return null
  if (len >= MIN_LINE_ARM) {
    const l = armLine(pts)
    if (lineMaxDev(pts, l.c, l.d) <= LINE_TOL) return { kind: 'line', a: l.c, d: l.d, conf: len, skipCap: false }
  }
  if (len >= MIN_ARC_ARM) {
    const c = fitCircle(pts)
    if (c && c.r >= R_MIN && c.r <= R_MAX && maxRadialDev(pts, c) <= CIRC_TOL)
      return { kind: 'circle', c, conf: len, skipCap: false }
  }
  return null
}

/**
 * Terminal primitive at one edge end. Preference order: the arm INCLUDING the
 * terminal segment (the boundary is already primitive-clean up to the vertex);
 * else, when the terminal segment is short enough to be a mangled cap, the arm
 * EXCLUDING it (the neighbouring run carries the true primitive).
 */
function endPrimitive(e: SharedEdge, atEnd: boolean): Prim | null {
  const arm = collectArm(e, atEnd)
  if (arm.segPts.length === 0) return null
  const all: Vec[] = []
  for (const seg of arm.segPts) for (const p of seg) all.push(p)
  const total = arm.segLen.reduce((a, b) => a + b, 0)
  const pa = evalArm(all, total)
  if (pa) return pa
  if (arm.segPts.length >= 2 && arm.segLen[0] <= CAP_MAX) {
    const rest: Vec[] = []
    for (let s = 1; s < arm.segPts.length; s++) for (const p of arm.segPts[s]) rest.push(p)
    const pb = evalArm(rest, total - arm.segLen[0])
    if (pb) return { ...pb, skipCap: true }
  }
  return null
}

/** Distance from `p` to a primitive. */
function primDist(p: Vec, pr: Prim): number {
  if (pr.kind === 'line') return Math.abs((p.x - pr.a!.x) * pr.d!.y - (p.y - pr.a!.y) * pr.d!.x)
  const c = pr.c!
  return Math.abs(Math.hypot(p.x - c.cx, p.y - c.cy) - c.r)
}

/** Unit tangent of a primitive at a point on (or near) it. */
function primTangent(p: Vec, pr: Prim): Vec {
  if (pr.kind === 'line') return pr.d!
  const c = pr.c!
  const dx = p.x - c.cx
  const dy = p.y - c.cy
  const l = Math.hypot(dx, dy) || 1
  return { x: -dy / l, y: dx / l }
}

/** Intersection points of two primitives (0, 1 or 2). */
function intersect(p1: Prim, p2: Prim): Vec[] {
  if (p1.kind === 'line' && p2.kind === 'line') {
    const det = p1.d!.x * p2.d!.y - p1.d!.y * p2.d!.x
    if (Math.abs(det) < MIN_ANGLE_SIN) return []
    const rx = p2.a!.x - p1.a!.x
    const ry = p2.a!.y - p1.a!.y
    const t = (rx * p2.d!.y - ry * p2.d!.x) / det
    return [{ x: p1.a!.x + t * p1.d!.x, y: p1.a!.y + t * p1.d!.y }]
  }
  if (p1.kind === 'circle' && p2.kind === 'circle') {
    const c1 = p1.c!
    const c2 = p2.c!
    const dx = c2.cx - c1.cx
    const dy = c2.cy - c1.cy
    const d = Math.hypot(dx, dy)
    if (d < 1e-9 || d > c1.r + c2.r || d < Math.abs(c1.r - c2.r)) return []
    const a = (d * d + c1.r * c1.r - c2.r * c2.r) / (2 * d)
    const h2 = c1.r * c1.r - a * a
    if (h2 < 0) return []
    const h = Math.sqrt(h2)
    const mx = c1.cx + (a * dx) / d
    const my = c1.cy + (a * dy) / d
    const ox = (-dy * h) / d
    const oy = (dx * h) / d
    return [
      { x: mx + ox, y: my + oy },
      { x: mx - ox, y: my - oy },
    ]
  }
  const line = p1.kind === 'line' ? p1 : p2
  const circ = p1.kind === 'circle' ? p1 : p2
  const c = circ.c!
  const t0 = (c.cx - line.a!.x) * line.d!.x + (c.cy - line.a!.y) * line.d!.y
  const fx = line.a!.x + t0 * line.d!.x
  const fy = line.a!.y + t0 * line.d!.y
  const h2 = c.r * c.r - ((c.cx - fx) ** 2 + (c.cy - fy) ** 2)
  if (h2 < 0) return []
  const h = Math.sqrt(h2)
  return [
    { x: fx + h * line.d!.x, y: fy + h * line.d!.y },
    { x: fx - h * line.d!.x, y: fy - h * line.d!.y },
  ]
}

/**
 * Re-map a CURVED terminal segment onto a moved endpoint, keeping its own
 * curvature (§13). The un-paired third edge at a re-seated junction is
 * anchor-shifted, and a rigid shift keeps handles sized for the OLD span: when
 * the correction shortens the segment, the cubic balloons outward by the
 * leftover handle length (bg-ramp-twin: a 41° rim cap whose two ends were
 * re-seated 7.5px and 5.2px inward bulged 3.26px past its own circle — the
 * "beak" on a disc that should be round).
 *
 * The control polygon is carried by the similarity that maps the old endpoint
 * onto `H` about the inner anchor, EXCEPT that the component perpendicular to
 * the chord scales by k² rather than k: a circular arc's sagitta goes as
 * chord²/radius, so a pure similarity would inflate the radius as the chord
 * shrinks — it preserves the shape when what must be preserved is the CURVE the
 * boundary is a piece of. Exact for a straight segment (perp component 0) and
 * for a circular arc.
 *
 * ONLY the SHRINKING case is corrected (k < 1). That is the defect: leftover
 * handle length the shortened span no longer supports, bulging outward, visible
 * and gate-poisoning. A LENGTHENED span leaves the handles too short instead —
 * the segment flattens toward its chord, the conservative direction, and the
 * near-straight fits depend on it: `hairlines`' diagonal crosses a bar in a 9.9px
 * edge whose fit carries a sub-pixel wobble, and scaling that by k² put a visible
 * S-kink in a straight bar (it also stopped 1b from straightening the edge at all,
 * so the kink survived to the output). Growth keeps the plain shift, unchanged.
 *
 * `k` is floored for the perpendicular term so a near-collapsed span does not
 * quite flatten the segment to its chord.
 */
const RESHAPE_K_MIN = 0.25

function reshapeTerminalTo(T: PathNode, inner: PathNode, atEnd: boolean, H: Vec): boolean {
  const hT = atEnd ? T.hIn : T.hOut
  const hI = atEnd ? inner.hOut : inner.hIn
  // A straight terminal segment is already exact under a plain shift — leave it
  // (and every edge made of straight runs) byte-identical.
  if (!hT && !hI) return false
  const ux = T.x - inner.x
  const uy = T.y - inner.y
  const L0 = Math.hypot(ux, uy)
  const vx = H.x - inner.x
  const vy = H.y - inner.y
  const L1 = Math.hypot(vx, vy)
  if (L0 < 1e-6 || L1 < 1e-6) return false
  const k = L1 / L0
  if (k >= 1) return false // growth: the plain shift's under-bulge is the safe error
  const kPerp = k * Math.max(RESHAPE_K_MIN, k)
  // Orthonormal frames on the old and new chords (both rooted at `inner`).
  const oax = ux / L0
  const oay = uy / L0
  const nax = vx / L1
  const nay = vy / L1
  const remap = (h: Vec): void => {
    const dx = h.x - inner.x
    const dy = h.y - inner.y
    const along = (dx * oax + dy * oay) * k
    const perp = (dx * -oay + dy * oax) * kPerp
    h.x = inner.x + along * nax + perp * -nay
    h.y = inner.y + along * nay + perp * nax
  }
  if (hT) remap(hT)
  if (hI) remap(hI)
  T.x = H.x
  T.y = H.y
  return true
}

/** Move a node's anchor, carrying its handles by the same delta. */
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

/**
 * Sweep-side hint for a TERMINAL arc re-emit. The terminal segment is junction-
 * local — it can never lap the fitted circle — but on a mangled cap the sampled
 * midpoint can land on the wrong angular side of a tiny from→to span (the cap
 * points AWAY from the corrected vertex), and arcSlice would honour that as a
 * near-full-circle sweep: a ghost disc ballooning out of a sliver edge (a 5.9px
 * cap on an r≈81 arm re-emitted as a 356° arc — soft-alpha logo art, §10.4b).
 * When the hinted sweep exceeds π the hint IS the mangle — replace it with the
 * minor arc's own midpoint (the chord midpoint projected radially onto the
 * circle). from/to antipodal never reaches the projection: both sweeps are π.
 */
function junctionLocalMid(c: Circle, from: Vec, to: Vec, mid: Vec): Vec {
  const TWO_PI = Math.PI * 2
  const norm = (a: number): number => ((a % TWO_PI) + TWO_PI) % TWO_PI
  const af = Math.atan2(from.y - c.cy, from.x - c.cx)
  const ccwSpan = norm(Math.atan2(to.y - c.cy, to.x - c.cx) - af) || TWO_PI
  const ccw = norm(Math.atan2(mid.y - c.cy, mid.x - c.cx) - af) <= ccwSpan
  const sweep = ccw ? ccwSpan : TWO_PI - ccwSpan
  if (sweep <= Math.PI) return mid
  const mx = (from.x + to.x) / 2 - c.cx
  const my = (from.y + to.y) / 2 - c.cy
  const d = Math.hypot(mx, my)
  if (d < 1e-9) return mid
  return { x: c.cx + (c.r * mx) / d, y: c.cy + (c.r * my) / d }
}

/** Midpoint of the terminal segment (sweep-side hint for arcSlice). */
function terminalMid(e: SharedEdge, atEnd: boolean): Vec {
  const nodes = e.nodes
  const m = nodes.length
  const p = atEnd ? nodes[m - 1] : nodes[0]
  const q = atEnd ? nodes[m - 2] : nodes[1]
  const h1 = atEnd ? p.hIn : p.hOut
  const h2 = atEnd ? q.hOut : q.hIn
  const pts: Vec[] = []
  sampleCubic(p, h1, h2, q, 2, pts)
  return pts[1]
}

/**
 * Re-anchor one edge end on the corrected vertex position `H`.
 *  • pair member, line arm: the terminal anchor moves along its own line; a
 *    mangled cap (skipCap) is removed entirely — its breakpoint node is dropped
 *    and the straight run extends to `H` (the bend was the defect).
 *  • pair member, circle arm: the terminal segment re-emits as an arc slice of
 *    the fitted circle into `H`, so the boundary keeps the circle's tangent.
 *  • third edge (no primitive used): the anchor moves to `H`; a curved terminal
 *    segment is re-mapped onto it curvature-preserving (reshapeTerminalTo), a
 *    straight one takes the plain shift.
 */
function applyEnd(end: End, H: Vec, prim: Prim | null): void {
  const { e, atEnd } = end
  let nodes = e.nodes
  let m = nodes.length
  if (m < 2) return
  if (!prim) {
    // No primitive of its own in the winning pair: the anchor moves, and a CURVED
    // terminal segment is re-mapped onto it (a rigid shift would leave it holding
    // handles sized for the old span — the bulging rim cap of §13). A straight
    // one takes the plain shift, byte-identically.
    const T = atEnd ? nodes[m - 1] : nodes[0]
    if (!reshapeTerminalTo(T, atEnd ? nodes[m - 2] : nodes[1], atEnd, H)) shiftNodeTo(T, H.x, H.y)
    return
  }
  if (prim.kind === 'line') {
    if (prim.skipCap && m >= 3) {
      // Drop the cap breakpoint; the straight run extends to H.
      nodes.splice(atEnd ? m - 2 : 1, 1)
      m = nodes.length
    }
    const T = atEnd ? nodes[m - 1] : nodes[0]
    const inner = atEnd ? nodes[m - 2] : nodes[1]
    T.x = H.x
    T.y = H.y
    T.kind = 'corner'
    // The terminal segment IS (part of) the line — keep it exactly straight.
    if (atEnd) {
      T.hIn = null
      inner.hOut = null
    } else {
      T.hOut = null
      inner.hIn = null
    }
    return
  }
  // Circle arm: re-emit the terminal segment as an arc slice into H.
  const c = prim.c!
  const mid = terminalMid(e, atEnd)
  const T = atEnd ? nodes[m - 1] : nodes[0]
  const inner = atEnd ? nodes[m - 2] : nodes[1]
  const from = atEnd ? { x: inner.x, y: inner.y } : { x: H.x, y: H.y }
  const to = atEnd ? { x: H.x, y: H.y } : { x: inner.x, y: inner.y }
  const arc = arcSlice(c.cx, c.cy, c.r, from, to, junctionLocalMid(c, from, to, mid))
  if (arc.length < 2) {
    shiftNodeTo(T, H.x, H.y)
    return
  }
  T.x = H.x
  T.y = H.y
  T.kind = 'corner'
  const interior = arc.slice(1, arc.length - 1)
  if (atEnd) {
    inner.hOut = arc[0].hOut
    T.hIn = arc[arc.length - 1].hIn
    if (interior.length) nodes.splice(m - 1, 0, ...interior)
  } else {
    T.hOut = arc[0].hOut
    inner.hIn = arc[arc.length - 1].hIn
    if (interior.length) nodes.splice(1, 0, ...interior)
  }
}

/**
 * Re-seat slid degree-3 junctions onto the intersection of their two strongest
 * incident fitted primitives. Mutates `edges` / `vertices` in place. `width` /
 * `height` (raster px) guard the canvas border: a border junction must stay on
 * the frame. Deterministic: vertices ascending, pairs ranked by summed arm
 * length.
 *
 * Returns:
 *  • `chords` — ids of edges straightened as occluder CHORDS: an edge whose two
 *    endpoints were both re-seated against the SAME line primitive is that line
 *    continuing through the crossing (gradient-flat: the triangle hypotenuse
 *    occluding the disc — the white|dark boundary between the junctions IS the
 *    line, sagitta-close to the disc's arc but not on it). Its fit crossed the
 *    needle-mangled zone, so it is re-emitted as the straight chord. The caller
 *    must keep the co-circular loop snap (§1d) OFF any loop containing one: a
 *    disc cut by a chord is a "D", and absorbing the chord into the circle
 *    re-invents the occluded sliver the art paints on top.
 *  • `moved` — ids of the vertices the pass re-seated, the evidence key for the
 *    converged-pair weld (weldConvergedJunctions): a rasterized degree-4
 *    crossing splits into two degree-3 junctions + a micro-edge, and when the
 *    re-seat drives both (or one) onto the true crossing the pair should fuse
 *    into ONE vertex — which needs the region loops, so it runs in the caller.
 */
export function reseatJunctions(
  edges: SharedEdge[],
  vertices: Vertex[],
  width?: number,
  height?: number,
): { chords: Set<number>; moved: Set<number> } {
  const incident = new Map<number, End[]>()
  for (const e of edges) {
    if (e.closed || e.nodes.length < 2) continue
    if (e.startVertex != null && e.startVertex >= 0) {
      let a = incident.get(e.startVertex)
      if (!a) incident.set(e.startVertex, (a = []))
      a.push({ e, atEnd: false })
    }
    if (e.endVertex != null && e.endVertex >= 0) {
      let a = incident.get(e.endVertex)
      if (!a) incident.set(e.endVertex, (a = []))
      a.push({ e, atEnd: true })
    }
  }

  // Line primitives each re-seated vertex was corrected against (chord detection).
  const lineAt = new Map<number, Prim[]>()
  const moved = new Set<number>()

  for (const v of vertices) {
    const ends = incident.get(v.id)
    if (!ends || ends.length !== 3) continue
    if (width != null && height != null && (v.x <= 1 || v.y <= 1 || v.x >= width - 1 || v.y >= height - 1)) continue

    // Fresh primitives per vertex (an earlier re-seat may have touched an edge).
    const prims = ends.map((end) => endPrimitive(end.e, end.atEnd))

    // Best qualifying pair by summed arm confidence.
    let best: { i: number; j: number; H: Vec; conf: number } | null = null
    for (let i = 0; i < 3; i++) {
      const pi = prims[i]
      if (!pi) continue
      if (primDist(v, pi) > NEAR_TOL) continue
      for (let j = i + 1; j < 3; j++) {
        const pj = prims[j]
        if (!pj) continue
        if (primDist(v, pj) > NEAR_TOL) continue
        let H: Vec | null = null
        let hd = Infinity
        for (const cand of intersect(pi, pj)) {
          const d = dist(cand, v)
          if (d < hd) {
            hd = d
            H = cand
          }
        }
        if (!H || hd > MAX_SLIDE) continue
        // A circle arm must not slide the junction a large fraction of its own
        // radius (a near-full tiny circle offers no stable direction).
        if (pi.kind === 'circle' && hd > 0.5 * pi.c!.r) continue
        if (pj.kind === 'circle' && hd > 0.5 * pj.c!.r) continue
        // Transversality at the target.
        const t1 = primTangent(H, pi)
        const t2 = primTangent(H, pj)
        if (Math.abs(t1.x * t2.y - t1.y * t2.x) < MIN_ANGLE_SIN) continue
        const conf = pi.conf + pj.conf
        if (!best || conf > best.conf) best = { i, j, H, conf }
      }
    }
    if (!best) continue
    if (dist(best.H, v) < MIN_MOVE) continue

    v.x = best.H.x
    v.y = best.H.y
    moved.add(v.id)
    for (let k = 0; k < 3; k++) {
      applyEnd(ends[k], best.H, k === best.i || k === best.j ? prims[k] : null)
    }
    lineAt.set(
      v.id,
      [best.i, best.j].map((k) => prims[k]!).filter((p) => p.kind === 'line'),
    )
  }

  // --- occluder-chord straightening ----------------------------------------
  // An edge whose two endpoints were both re-seated against one and the same
  // line is that line's continuation through the crossing: re-emit it as the
  // straight chord between the corrected vertices.
  const straightened = new Set<number>()
  for (const e of edges) {
    if (e.closed || e.nodes.length < 2) continue
    if (e.startVertex == null || e.endVertex == null) continue
    const l1s = lineAt.get(e.startVertex)
    const l2s = lineAt.get(e.endVertex)
    if (!l1s?.length || !l2s?.length) continue
    const a = e.nodes[0]
    const b = e.nodes[e.nodes.length - 1]
    if (dist(a, b) > CHORD_MAX_LEN) continue
    const sameLine = l1s.some((l1) =>
      l2s.some(
        (l2) =>
          Math.abs(l1.d!.x * l2.d!.y - l1.d!.y * l2.d!.x) <= CHORD_COLLINEAR_SIN &&
          primDist(l2.a!, l1) <= CHORD_COLLINEAR_OFF,
      ),
    )
    if (!sameLine) continue
    // The edge's own fit must sit near the chord (it crossed the mangled zone —
    // a genuinely different boundary between the two junctions must survive).
    const line = l1s[0]
    let maxDev = 0
    for (let s = 0; s + 1 < e.nodes.length; s++) {
      const p = e.nodes[s]
      const q = e.nodes[s + 1]
      const pts: Vec[] = []
      sampleCubic(p, p.hOut, q.hIn, q, ARM_SAMPLES, pts)
      const d = lineMaxDev(pts, line.a!, line.d!)
      if (d > maxDev) maxDev = d
    }
    if (maxDev > CHORD_TOL) continue
    e.nodes = [
      { x: a.x, y: a.y, hIn: null, hOut: null, kind: 'corner' },
      { x: b.x, y: b.y, hIn: null, hOut: null, kind: 'corner' },
    ]
    straightened.add(e.id)
  }
  return { chords: straightened, moved }
}

/**
 * Fuse junction pairs the re-seat CONVERGED into one vertex. A rasterized
 * degree-4 crossing (two boundaries crossing at a point — overlap's lens tips)
 * splits into two degree-3 junctions joined by a 1–4px micro-edge; when the
 * re-seat drives them onto the true crossing (both, or one with the other
 * already sub-pixel-close) the pair is one authored point and the micro-edge is
 * pure rasterization. Contract it: `weldJunctionClusters` does the graph work
 * (fuse to centroid, re-anchor incident edges, excise the edge from every
 * loop) — but gated here on RE-SEAT EVIDENCE, not on bare shortness: candidates
 * are micro-edges (≤ RESEAT_WELD_LEN fitted px) with a re-seated endpoint. The
 * blanket ≤3px weld was measured a corpus regression (a micro-edge is sometimes
 * a REAL thin feature — beverage-box-flat, §9.3); an untouched micro-edge stays.
 * Mutates topology + loops in place (index.ts owns both at the call site).
 */
export function weldConvergedJunctions(
  vertices: Vertex[],
  edges: SharedEdge[],
  loopsByLabel: Map<number, EdgeRef[][]>,
  width: number,
  height: number,
  moved: ReadonlySet<number>,
): void {
  if (moved.size === 0) return
  weldJunctionClusters(vertices, edges, loopsByLabel, width, height, RESEAT_WELD_LEN, (e) =>
    (e.startVertex != null && moved.has(e.startVertex)) || (e.endVertex != null && moved.has(e.endVertex)),
  )
}

/** Max fitted length of a micro-edge the converged-pair weld may contract. Above
 *  the re-seat's own convergence radius (a one-sided pair: one endpoint moved
 *  onto the crossing, the other already within MIN_MOVE of it — up to ~2px
 *  apart), far below any real thin feature the blanket weld tripped on. */
const RESEAT_WELD_LEN = 2.0
