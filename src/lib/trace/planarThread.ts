// Junction placement by contrast rank: a weak colour boundary must not aim a strong one.
//
// On ramp art traced flat, posterization band seams plant junctions on the logo's real
// edges. A junction is an integer lattice corner, so pinning a long edge to it costs
// ~1px at that end against the edge's own staircase evidence: the edge rotates, and an
// arc caught between two seam junctions kinks into its straight neighbours.
//
// The correction has to happen before the fit — a post-fit re-seat cannot move the
// vertex, because the primitive is fitted from the already-pinned edge and passes
// through it by construction. Here the two strong arms' raw lattice chains are joined
// into one window across the junction and fitted as one line, or one circle when the
// boundary curves through, and the junction is moved onto that curve. Every incident
// edge (including the seam) is then fitted pinned to the same point, so the shared-edge
// invariant holds.
//
// The correction is purely normal to the strong boundary: the lattice quantizes the
// junction across the edge, which tilts it; where it sits along the edge is the weak
// boundary's business and an error there is invisible.
//
// Where the strong boundary corners at the junction instead of continuing, no through
// fit exists (it would round the corner off). A corner is still a sub-pixel place — where
// the two arms' own lines meet, the evidence the in-chain corner snap uses but cannot
// reach at a junction because the chain ends there. Both arms must be straight enough
// for their lines to be tangents (ARM_BOW), else the junction keeps its lattice corner.
//
// Between the two: the turn gate reads a chord over a fixed px window, and at a coarse
// raster that window covers more of an arc, so an arc can read as a corner. A junction
// the turn gate refuses is first offered a circle window extended while the arms still
// fit one circle (THROUGH_EXTEND): an arc survives that at any raster, a corner at none.
//
// The rank is not the only way to tell which boundary continues. Where all three are
// real edges (a mouth's outline running past the point where a cheek meets it), the
// junction is a T too, and the lattice corner pulls the outline into it the same way.
// With `geometric`, a junction the rank refuses is still threaded when exactly ONE pair
// of its arms passes the through test (turn, one line or circle, the move bound): a Y
// where no pair continues, or an X where two do, keeps its corner. Only the through
// branch: the corner and extended-circle branches stay behind the rank.
//
// A threaded junction also hands both through arms the primitive's TANGENT there
// (`ThreadPlacement.tangents`), and the edge fit leaves the junction along it. Moving the
// vertex onto the curve is not enough: the fit's first segment otherwise leaves along
// the chord to the next lattice sample, and the outline dips into a cusp at the vertex
// (benchmarks §42.7).
//
// Every gate can only drop a junction: with no palette (or `fitThrough: false`) nothing
// moves. Pure and deterministic.
// Design notes and measurements: docs/vectorization-benchmarks.md.

import type { Vec } from '../path/types'
import { EXT, type PlanarNetwork } from './planarNetwork.ts'
import { armLine, circleMaxDev, fitCircle } from './planarFit.ts'
import { lineFit } from './curveFit.ts'
import { srgbToLab, deltaE76, type Lab } from './lab.ts'

/** Region colour by label — `quantize`'s palette (only r/g/b are read). */
export interface ThreadColor {
  r: number
  g: number
  b: number
}

// --- gates -------------------------------------------------------------------
/** ΔE76 at or above which a boundary is a real edge (the mark's own outline). */
const STRONG_DE = 25
/** ΔE76 at or below which a boundary is a posterization band seam. */
const WEAK_DE = 12
/** Raw-lattice arc (px) sampled on each arm for the through fit — the base window. It is
 *  a fixed px count on purpose: staircase phase noise is ±0.5px per endpoint at every
 *  raster, so a chord direction needs the same px of evidence at every raster. Don't
 *  scale it with the raster: at small sizes it would refuse straight continuations on
 *  noise. Arcs at coarse rasters are handled by THROUGH_EXTEND instead. */
const THROUGH_SPAN = 12
/** Multiples of THROUGH_SPAN the circle window may grow to, in order; the extension stops
 *  at the first that does not fit (or that an arm cannot fill) and keeps the last that did.
 *  A junction the turn gate refused becomes a threaded arc only if the 2× window fits: a
 *  corner's straight arms leave any circle at a rate set by the corner angle alone, so a
 *  corner sharper than ~20° fails at 24px at every raster. The upper multiple bounds work,
 *  not fidelity. */
const THROUGH_EXTEND = [2, 3, 4]
/** Shortest arm (px) that earns a verdict at all; below this a chord direction is
 *  staircase-phase noise. */
const MIN_ARM = 6
/** Max deviation (px) of the two arms' joined window from one line or one circle. The
 *  circle covers a boundary that curves through (a radius-50 rounded corner bows 1.5px off
 *  its chord over ±12px and would fail a line-only test). */
const THROUGH_DEV = 1.2
/** Max chord turn (deg) the boundary may take across the junction to count as
 *  continuing. The residual alone is not enough: a 40° corner fits a circle to ~1.1px over
 *  the base window (a 40° bend over 24px is an arc of radius ~35) and would be moved off
 *  the corner the lattice had right. Continuations and large-radius rounds read well under
 *  20°, real corners well over. A junction this gate refuses is still offered the extended
 *  circle window (THROUGH_EXTEND); the turn remains the gate for the line branch. */
const THROUGH_TURN_DEG = 20
/** How far the re-placed junction may travel off its lattice corner (px). This is a
 *  sub-pixel placement, not a re-seat; past this the fit disagrees with the label map and
 *  the junction is dropped. The corner branch shares it: an acute apex could justify a
 *  larger move, but a wider bound for that branch changes almost nothing. */
const MAX_MOVE = 2.0
/**
 * Max |perp deviation| (px) of one arm's samples from its own fitted line for that line
 * to be usable as the boundary's tangent at the junction (corner branch).
 *
 * A one-sided veto: a high bow proves the line is a chord across something that turns
 * (authored-straight arms stay below 0.8), but a low bow proves nothing — many bent arms
 * read low too. So it only ever drops an arm, never certifies one.
 */
const ARM_BOW = 0.8
/**
 * Least angle (deg) every other arm must leave a GEOMETRIC through pair's line at — a floor
 * under the rules that decide (strong arms, `cutAt`, no outline running through). It was
 * 45° for a while, to stop four hooks at 30–42° in the A/B review; each had its own cause,
 * fixed where it lives, and 45° refused real T's: `cl-ties`' string meets the kite's edge at
 * 33°. A real T measures 30–90° (the smiling face's mouth 55–73°, the Olympic rings 60–90°).
 */
const STEM_MIN_DEG = 25

/** Radius (px) of the neighbourhood `cutAt` reads: two arm windows, so a crossing band a
 *  few px wide is inside it at any raster the lanes trace. */
const CUT_RADIUS = 2 * THROUGH_SPAN
/** Pieces of the front shape under this many px are anti-aliasing specks, not a cut. */
const CUT_MIN_PIECE = 4

/**
 * Is region `x` CUT into more than one piece around this junction? The shape in front of a
 * crossing stays whole and the one behind it is split. A geometric pair claims its shared
 * region is in front, its outline running through; if that region is in pieces right here,
 * something lies across it and the claim is wrong. `hairlines`: a red bar over a black one
 * at 22° — on the lattice the black side runs straight past the red for six rows, every
 * angle and residual reads like `cl-ties`' string past a kite, and only this tells them
 * apart: the black is in two pieces, the string is one. LOCAL on purpose: a ring that is
 * over its neighbour at one crossing and under it at the other is cut somewhere, just not
 * where it is in front.
 */
export function cutAt(labels: Int32Array, w: number, h: number, cx: number, cy: number, x: number): boolean {
  const r = CUT_RADIUS
  const x0 = Math.max(0, Math.floor(cx - r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const x1 = Math.min(w - 1, Math.ceil(cx + r))
  const y1 = Math.min(h - 1, Math.ceil(cy + r))
  const bw = x1 - x0 + 1
  const seen = new Uint8Array(bw * (y1 - y0 + 1))
  const inside = (px: number, py: number): boolean =>
    labels[py * w + px] === x && (px + 0.5 - cx) ** 2 + (py + 0.5 - cy) ** 2 <= r * r
  let pieces = 0
  const stack: number[] = []
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const i = (py - y0) * bw + (px - x0)
      if (seen[i] || !inside(px, py)) continue
      seen[i] = 1
      stack.push(px, py)
      let size = 0
      while (stack.length) {
        const qy = stack.pop()!
        const qx = stack.pop()!
        size++
        for (const [nx, ny] of [
          [qx + 1, qy],
          [qx - 1, qy],
          [qx, qy + 1],
          [qx, qy - 1],
        ]) {
          if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue
          const j = (ny - y0) * bw + (nx - x0)
          if (seen[j] || !inside(nx, ny)) continue
          seen[j] = 1
          stack.push(nx, ny)
        }
      }
      if (size >= CUT_MIN_PIECE && ++pieces > 1) return true
    }
  }
  return false
}

/**
 * The label behind everything: the one with the most boundary on the canvas edge. A
 * geometric pair whose shared region is the ground (or transparency) is the SILHOUETTE
 * of two shapes meeting, not one shape's outline running past another: an aerial
 * tramway's disc meeting its cable housing is a shallow corner the artist drew, and
 * forcing it smooth bends both neighbours. A T's through boundary belongs to the shape
 * in FRONT, which is on both arms (the mouth runs past the blush; the brown is on both
 * sides of the point).
 */
function groundLabel(net: PlanarNetwork): number {
  const run = new Map<number, number>()
  for (const e of net.edges) {
    const l = e.left === EXT ? e.right : e.right === EXT ? e.left : null
    if (l == null || l === EXT) continue
    run.set(l, (run.get(l) ?? 0) + e.pts.length)
  }
  let best = EXT
  let most = 0
  for (const [l, n] of run) {
    if (n > most) {
      most = n
      best = l
    }
  }
  return best
}

const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y)

/** ΔE76 across every edge: the colour contrast between the two regions that own it.
 *  EXT (transparent / out of bounds) is always a real edge; an unknown label yields
 *  NaN, which is neither strong nor weak and therefore never moves anything. */
export function edgeContrast(net: PlanarNetwork, palette: readonly ThreadColor[]): Float64Array {
  const labs: Lab[] = palette.map((c) => srgbToLab(c.r, c.g, c.b))
  const labOf = (l: number): Lab | null => (l >= 0 && l < labs.length ? labs[l] : null)
  const out = new Float64Array(net.edges.length)
  for (let i = 0; i < net.edges.length; i++) {
    const e = net.edges[i]
    if (e.left === EXT || e.right === EXT) {
      out[i] = Infinity // the canvas / transparency border is a real edge
      continue
    }
    const a = labOf(e.left)
    const b = labOf(e.right)
    out[i] = a && b ? deltaE76(a, b) : NaN
  }
  return out
}

// --- junction survey ---------------------------------------------------------

/** One incident edge-end at a junction. */
export interface JunctionEnd {
  edge: number
  /** True when the junction is the edge's end (pts[n-1]), false at its start. */
  atEnd: boolean
  de: number
  /** Raw lattice arc available on this arm (px, capped at THROUGH_SPAN). */
  arm: number
}

export interface JunctionVerdict {
  corner: number
  x: number
  y: number
  ends: JunctionEnd[]
  /** Deviation of the two strong arms' joined window from one line / one circle. */
  lineDev: number | null
  circleDev: number | null
  /** Turn (deg) between the two strong arms — 0 = straight through. */
  turnDeg: number | null
  /** Each strong arm's own line residual (`bow`), in the order the ends were surveyed. */
  armBow: [number, number] | null
  /** Which rule placed it: a through fit, or a corner apex (the two arms' own lines
   *  intersected). */
  kind: 'thread' | 'apex' | null
  /** Threaded by geometry alone: the contrast rank refused it and one arm pair passed. */
  geometric?: boolean
  /** A geometric pair was dropped because its shared region is in pieces here (`cutAt`). */
  cut?: boolean
  /** For a junction with a geometric through pair: the least angle (deg) another arm
   *  leaves that pair's line at (STEM_MIN_DEG). */
  stemDeg?: number
  /** For a threaded junction: the through primitive's unit tangent at `moveTo`, pointing
   *  into each through arm, keyed by edge index * 2 + (atEnd ? 1 : 0). */
  tangents?: [number, Vec][]
  /** For a through-circle placement: the THROUGH_SPAN multiple the window grew to while
   *  still one circle (1 = the base window only; ≥ 2 = extended). Null otherwise. */
  extK: number | null
  /** Where the placement puts this junction (null when it is not moved). */
  moveTo: Vec | null
  /** How far that is from the lattice corner. */
  move: number | null
  linked: boolean
  reason: string
  /** Diagnostic only (`tune.alt`): where each estimator would put the junction, gates
   *  ignored — the through-line projection, the through-circle projection (with the fitted
   *  radius), and the two arms' line intersection. */
  alt?: { line: Vec | null; circle: Vec | null; r: number; apex: Vec | null }
}

function incidentEnds(net: PlanarNetwork): Map<number, JunctionEnd[]> {
  const out = new Map<number, JunctionEnd[]>()
  const add = (c: number, end: JunctionEnd): void => {
    if (c < 0) return
    let a = out.get(c)
    if (!a) out.set(c, (a = []))
    a.push(end)
  }
  for (let i = 0; i < net.edges.length; i++) {
    const e = net.edges[i]
    if (e.closed) continue
    add(e.startV, { edge: i, atEnd: false, de: 0, arm: 0 })
    add(e.endV, { edge: i, atEnd: true, de: 0, arm: 0 })
  }
  return out
}

/** Raw lattice points on one arm, junction first, out to `span` px of arc. */
function armWindow(pts: Vec[], atEnd: boolean, span: number): Vec[] {
  const out: Vec[] = []
  let acc = 0
  const n = pts.length
  for (let k = 0; k < n; k++) {
    const p = atEnd ? pts[n - 1 - k] : pts[k]
    if (k > 0) acc += dist(out[out.length - 1], p)
    out.push({ x: p.x, y: p.y })
    if (acc >= span) break
  }
  return out
}

/** Arc length (px) of an arm's window. */
function armLen(w: Vec[]): number {
  let acc = 0
  for (let i = 1; i < w.length; i++) acc += dist(w[i - 1], w[i])
  return acc
}

/** Unit direction from a window's junction end to its far end. */
function chordDir(w: Vec[]): Vec | null {
  const a = w[0]
  const b = w[w.length - 1]
  const l = dist(a, b)
  return l < 1e-9 ? null : { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
}

/** An arm's own least-squares line plus `bow` — the max |perp deviation| of the samples
 *  that produced it. A straight arm's samples sit on the line (bow ≈ the raster's own
 *  staircase); a curved arm's line is a chord and its bow is the sagitta over the window,
 *  which is what ARM_BOW vetoes. Shares `armLine` with the in-chain corner snap. */
function armFit(w: Vec[]): { line: { c: Vec; d: Vec }; bow: number } {
  const line = armLine(w)
  let bow = 0
  for (const p of w) {
    const dev = Math.abs((p.x - line.c.x) * line.d.y - (p.y - line.c.y) * line.d.x)
    if (dev > bow) bow = dev
  }
  return { line, bow }
}

/** Intersection of two lines, or null when they are too near-parallel to define a point. */
function crossLines(a: { c: Vec; d: Vec }, b: { c: Vec; d: Vec }): Vec | null {
  const det = a.d.x * -b.d.y - a.d.y * -b.d.x
  if (Math.abs(det) < 1e-6) return null
  const t = ((b.c.x - a.c.x) * -b.d.y - (b.c.y - a.c.y) * -b.d.x) / det
  const p = { x: a.c.x + t * a.d.x, y: a.c.y + t * a.d.y }
  return Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null
}

/**
 * The circle window, grown while the evidence stays one circle.
 *
 * Both arms are re-read at each multiple of the base span; the extension stops at the
 * first window an arm cannot fill (the edge ends) or whose joined samples no longer fit
 * one circle within `dev`, and returns the circle of the widest window that did, with its
 * multiple. Null when not even the 2× window fits.
 *
 * The wider window also gives a better radius: 12px of a radius-40 arc has ~0.45px of
 * sagitta against ±0.5px of staircase, so its fitted radius is unreliable, while 24px
 * has ~1.8px.
 */
function extendCircle(
  net: PlanarNetwork,
  a: JunctionEnd,
  b: JunctionEnd,
  span: number,
  dev: number,
): { c: { cx: number; cy: number; r: number }; k: number } | null {
  let best: { c: { cx: number; cy: number; r: number }; k: number } | null = null
  for (const k of THROUGH_EXTEND) {
    const s = span * k
    const wa = armWindow(net.edges[a.edge].pts, a.atEnd, s)
    const wb = armWindow(net.edges[b.edge].pts, b.atEnd, s)
    if (armLen(wa) < s || armLen(wb) < s) break
    const win = [...wa].reverse().concat(wb.slice(1))
    const md = circleMaxDev(win)
    if (md == null || md > dev) break
    const c = fitCircle(win)
    if (!c) break
    best = { c, k }
  }
  return best
}

/** Centroid of a point set (the point every least-squares line passes through). */
function centroid(pts: Vec[]): Vec {
  let mx = 0
  let my = 0
  for (const p of pts) {
    mx += p.x
    my += p.y
  }
  return { x: mx / pts.length, y: my / pts.length }
}

/**
 * Survey every junction: which incident boundaries are real edges, which are band
 * seams, whether the real ones continue through, and where the fit puts the junction.
 * The tracer moves exactly the junctions this marks `linked`; `bench/threadDiag.ts`
 * prints these same rows.
 */
export function surveyJunctions(
  net: PlanarNetwork,
  contrast: Float64Array,
  cornerJunctions = true,
  /** Diagnostic only: override the window / residual gates. Production never passes it. */
  tune?: { span?: number; dev?: number; alt?: boolean },
  /** Thread a junction the rank refuses when exactly one arm pair continues through it. */
  geometric = false,
  /** Sub-pixel chains by edge id (planarSubpixel), read by the GEOMETRIC pairs only. */
  subpix?: ReadonlyMap<number, Vec[]>,
  /** The label map, for the front-shape test (`cutAt`). Absent ⇒ not asked. */
  labels?: Int32Array,
): JunctionVerdict[] {
  const span = tune?.span ?? THROUGH_SPAN
  const throughDev = tune?.dev ?? THROUGH_DEV
  const cw = net.width + 1
  const inc = incidentEnds(net)
  const out: JunctionVerdict[] = []
  /** Read once, and only when a geometric pair needs it (groundLabel). */
  let ground: number | undefined
  for (const corner of net.junctions) {
    const windows = new Map<number, Vec[]>()
    // The geometric pairs read the SUB-PIXEL chains, the ones the fit reads. On the lattice a
    // red bar lying across a black one meets it along a vertical boundary (the black column
    // keeps its full width in the label map); only the anti-aliasing says the red's edge is
    // the diagonal, and a pair chosen on the lattice bent the black side into the red
    // (`hairlines`). The rank keeps its lattice windows: its gates were measured on them.
    const fine = new Map<number, Vec[]>()
    /** Each arm's direction over TWICE the window (or to its end): the crossing test's. */
    const far = new Map<number, Vec | null>()
    const ends = (inc.get(corner) ?? []).map((e) => {
      const w = armWindow(net.edges[e.edge].pts, e.atEnd, span)
      const key = e.edge * 2 + (e.atEnd ? 1 : 0)
      windows.set(key, w)
      const sp = subpix?.get(net.edges[e.edge].id)
      fine.set(key, sp ? armWindow(sp, e.atEnd, span) : w)
      far.set(key, chordDir(armWindow(sp ?? net.edges[e.edge].pts, e.atEnd, 2 * span)))
      return { ...e, de: contrast[e.edge], arm: armLen(w) }
    })
    let W = windows
    const v: JunctionVerdict = {
      corner,
      x: corner % cw,
      y: (corner / cw) | 0,
      ends,
      lineDev: null,
      circleDev: null,
      turnDeg: null,
      armBow: null,
      kind: null,
      extK: null,
      moveTo: null,
      move: null,
      linked: false,
      reason: '',
    }
    out.push(v)
    if (ends.length < 3) {
      v.reason = 'degree<3'
      continue
    }
    const strong = ends.filter((e) => e.de >= STRONG_DE)
    const weak = ends.filter((e) => e.de <= WEAK_DE)
    let pair: [JunctionEnd, JunctionEnd] | null = null
    if (strong.length === 2 && weak.length === ends.length - 2) pair = [strong[0], strong[1]]
    else if (geometric) {
      ground ??= groundLabel(net)
      const g = ground
      const through = throughPairs(ends, fine, far, throughDev).filter(({ pair: [x, y] }) => {
        const ex = net.edges[x.edge]
        const ey = net.edges[y.edge]
        const shared = ex.left === ey.left || ex.left === ey.right ? ex.left : ex.right
        if (shared === g || shared === EXT) return false
        if (labels && cutAt(labels, net.width, net.height, v.x, v.y, shared)) {
          v.cut = true
          return false
        }
        return true
      })
      if (through.length === 1 && through[0].stem >= STEM_MIN_DEG) {
        pair = through[0].pair
        v.geometric = true
        W = fine
        v.stemDeg = through[0].stem
      } else if (through.length) v.stemDeg = Math.min(...through.map((t) => t.stem))
    }
    if (!pair) {
      // Either the contrast is not cleanly split (something sits in the 12–25 gap) or
      // this is not a weak-into-strong T at all.
      v.reason = `rank ${strong.length}s/${weak.length}w of ${ends.length}`
      if (v.stemDeg != null) v.reason += `, through pair with stem ${v.stemDeg.toFixed(0)}°`
      if (v.cut) v.reason += ', front shape cut here'
      continue
    }
    const [a, b] = pair
    if (a.edge === b.edge) {
      v.reason = 'strong arms are one edge'
      continue
    }
    if (Math.min(a.arm, b.arm) < MIN_ARM) {
      v.reason = `arm ${Math.min(a.arm, b.arm).toFixed(0)}px < ${MIN_ARM}`
      continue
    }
    const wa = W.get(a.edge * 2 + (a.atEnd ? 1 : 0))!
    const wb = W.get(b.edge * 2 + (b.atEnd ? 1 : 0))!
    if (v.geometric) v.armBow = [armFit(wa).bow, armFit(wb).bow]
    // One ordered polyline through the junction: arm A reversed, then arm B.
    const win = [...wa].reverse().concat(wb.slice(1))
    if (win.length < 5) {
      v.reason = 'window too short'
      continue
    }
    const lf = lineFit(win)
    v.lineDev = lf ? lf.maxDev : null
    v.circleDev = circleMaxDev(win)
    const ta = chordDir(wa)
    const tb = chordDir(wb)
    if (ta && tb) {
      const d = Math.max(-1, Math.min(1, ta.x * tb.x + ta.y * tb.y))
      v.turnDeg = 180 - (Math.acos(d) * 180) / Math.PI
    }
    const q = wa[0]
    let p: Vec | null = null
    if (tune?.alt) {
      const c = fitCircle(win)
      const l = c ? Math.hypot(q.x - c.cx, q.y - c.cy) : 0
      const m = centroid(win)
      const t = lf ? (q.x - m.x) * lf.dir.x + (q.y - m.y) * lf.dir.y : 0
      v.alt = {
        line: lf ? { x: m.x + t * lf.dir.x, y: m.y + t * lf.dir.y } : null,
        circle: c && l > 1e-9 ? { x: c.cx + ((q.x - c.cx) / l) * c.r, y: c.cy + ((q.y - c.cy) / l) * c.r } : null,
        r: c ? c.r : NaN,
        apex: crossLines(armFit(wa).line, armFit(wb).line),
      }
    }
    /** Project the junction radially onto a circle. Projection only: normal to the
     *  boundary, never along it. */
    const ontoCircle = (c: { cx: number; cy: number; r: number }): Vec | null => {
      const l = Math.hypot(q.x - c.cx, q.y - c.cy)
      return l > 1e-9 ? { x: c.cx + ((q.x - c.cx) / l) * c.r, y: c.cy + ((q.y - c.cy) / l) * c.r } : null
    }
    // A junction the turn gate refuses may still be an arc read at a coarse raster; the
    // extended circle window decides (see THROUGH_EXTEND). Only worth asking where the
    // base window already fits a circle; a sharp corner's residual only grows from there.
    const refusedByTurn = v.turnDeg == null || v.turnDeg > THROUGH_TURN_DEG
    const ext = (v.circleDev ?? Infinity) <= throughDev ? extendCircle(net, a, b, span, throughDev) : null
    /** The primitive the junction is projected onto, for its tangent. */
    let along: { line: Vec } | { cx: number; cy: number } | null = null
    if (!refusedByTurn) {
      // The boundary continues through: fit it as one window and project.
      const dev = Math.min(v.lineDev ?? Infinity, v.circleDev ?? Infinity)
      if (!(dev <= throughDev)) {
        v.reason = `break (dev ${Number.isFinite(dev) ? dev.toFixed(2) : '—'})`
        continue
      }
      // Project onto whichever primitive the joined window is made of. A circle comes
      // from the widest window that still fits it.
      if ((v.circleDev ?? Infinity) < (v.lineDev ?? Infinity)) {
        const c = ext?.c ?? fitCircle(win)
        if (c) {
          p = ontoCircle(c)
          along = c
        }
        v.extK = ext?.k ?? 1
      } else if (lf) {
        const m = centroid(win)
        const t = (q.x - m.x) * lf.dir.x + (q.y - m.y) * lf.dir.y
        p = { x: m.x + t * lf.dir.x, y: m.y + t * lf.dir.y }
        along = { line: lf.dir }
      }
      v.kind = 'thread'
    } else if (v.geometric) {
      // Unreachable while throughPairs applies the same turn gate; kept so a pair the
      // rank never vouched for can never reach the corner branches below.
      v.reason = 'geometric, refused by turn'
      v.geometric = undefined
      continue
    } else if (ext) {
      // The chord turn said corner, the wider window says arc: thread onto that circle
      // rather than intersecting the arms inside the curve.
      p = ontoCircle(ext.c)
      along = ext.c
      v.extK = ext.k
      v.kind = 'thread'
    } else {
      // The boundary corners here: place the junction where the two arms' own lines meet.
      // Both arms must be usable (ARM_BOW) — intersecting against a bowed arm's chord
      // throws the apex pixels along the other arm, and one arm alone does not define a
      // corner. Don't correct along a single usable arm's normal instead: the move has a
      // component across the other arm, whose chain is still on the lattice, and tilts it.
      if (!cornerJunctions) {
        v.reason = `corner (turn ${v.turnDeg == null ? '—' : v.turnDeg.toFixed(1)}°)`
        continue
      }
      const fa = armFit(wa)
      const fb = armFit(wb)
      v.armBow = [fa.bow, fb.bow]
      if (fa.bow > ARM_BOW || fb.bow > ARM_BOW) {
        v.reason = `corner, arm is a chord (bow ${fa.bow.toFixed(2)}/${fb.bow.toFixed(2)})`
        continue
      }
      p = crossLines(fa.line, fb.line)
      v.kind = 'apex'
    }
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      v.kind = null
      v.extK = null
      v.reason = 'fit degenerate'
      continue
    }
    v.moveTo = p
    v.move = dist(p, q)
    if (!(v.move <= MAX_MOVE)) {
      v.reason = `move ${v.move.toFixed(2)}px > ${MAX_MOVE}`
      v.kind = null
      v.extK = null
      continue
    }
    v.linked = true
    v.reason = v.geometric ? `thread (geometric, stem ${v.stemDeg!.toFixed(0)}°)` : v.kind!
    if (along && p) {
      // The tangent is each arm's OWN direction, averaged — not the joined window's line.
      // Two arms of one outline that border different colours sit up to a pixel apart
      // (anti-aliasing against white is not anti-aliasing against blue), and a line fitted
      // across that jog tilts by atan(jog / window): on the Olympic rings 5°, which flattened
      // the yellow ring's arc between two crossings. Averaged, a jog cancels, and so do the
      // two one-sided windows' opposite errors on an arc.
      const fwd = (e: JunctionEnd): Vec => {
        const w = W.get(e.edge * 2 + (e.atEnd ? 1 : 0))!
        const d = armLine(w).d
        const c = chordDir(w)
        return c && d.x * c.x + d.y * c.y < 0 ? { x: -d.x, y: -d.y } : d
      }
      const da = fwd(a)
      const db = fwd(b)
      const t = { x: db.x - da.x, y: db.y - da.y }
      const l = Math.hypot(t.x, t.y)
      if (l > 1e-9) {
        const u = { x: t.x / l, y: t.y / l }
        const into = (e: JunctionEnd): [number, Vec] => {
          const d = chordDir(W.get(e.edge * 2 + (e.atEnd ? 1 : 0))!)
          const sg = d && d.x * u.x + d.y * u.y < 0 ? -1 : 1
          return [e.edge * 2 + (e.atEnd ? 1 : 0), { x: sg * u.x, y: sg * u.y }]
        }
        v.tangents = [into(a), into(b)]
      }
    }
  }
  return out
}

/** Every pair of a junction's arms that runs through it: distinct edges, both arms at
 *  least MIN_ARM, a chord turn under THROUGH_TURN_DEG, and one line or one circle across.
 *  `stem` is the least angle (deg) any OTHER arm's chord makes with the pair's line. */
function throughPairs(
  ends: JunctionEnd[],
  windows: Map<number, Vec[]>,
  far: Map<number, Vec | null>,
  dev: number,
): { pair: [JunctionEnd, JunctionEnd]; stem: number }[] {
  const out: { pair: [JunctionEnd, JunctionEnd]; stem: number }[] = []
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const a = ends[i]
      const b = ends[j]
      if (a.edge === b.edge || Math.min(a.arm, b.arm) < MIN_ARM) continue
      // A shape's outline is a real edge on both sides of the point. A pair with a seam in
      // it (seam-corner: a navy wedge's side and the ΔE 19 seam between two blues leaving
      // its corner) is two different boundaries that happen to line up.
      if (!(a.de >= STRONG_DE && b.de >= STRONG_DE)) continue
      const wa = windows.get(a.edge * 2 + (a.atEnd ? 1 : 0))!
      const wb = windows.get(b.edge * 2 + (b.atEnd ? 1 : 0))!
      const ta = chordDir(wa)
      const tb = chordDir(wb)
      if (!ta || !tb) continue
      const turn = 180 - (Math.acos(Math.max(-1, Math.min(1, ta.x * tb.x + ta.y * tb.y))) * 180) / Math.PI
      if (turn > THROUGH_TURN_DEG) continue
      const win = [...wa].reverse().concat(wb.slice(1))
      if (win.length < 5) continue
      const lf = lineFit(win)
      if (!(Math.min(lf ? lf.maxDev : Infinity, circleMaxDev(win) ?? Infinity) <= dev)) continue
      // The pair's direction through the junction: the mean of A reversed and B.
      const ux = tb.x - ta.x
      const uy = tb.y - ta.y
      const ul = Math.hypot(ux, uy)
      let stem = 90
      let crossing = false
      for (const e of ends) {
        if (e === a || e === b) continue
        const d = chordDir(windows.get(e.edge * 2 + (e.atEnd ? 1 : 0))!)
        if (!d || ul < 1e-9) continue
        const sin = Math.abs(d.x * uy - d.y * ux) / ul
        stem = Math.min(stem, (Math.asin(Math.min(1, sin)) * 180) / Math.PI)
        // A stem that carries straight on into one of the pair's arms is the OTHER outline
        // through this point: two shapes cross here, and the one in front is the one whose
        // edge continues — not this pair. Read over TWICE the window: on `hairlines` a red
        // bar lies over the end of a black one, and its edge runs within a pixel of the
        // black side for the first six rows — over 12 px the black|red arm reads vertical,
        // over its whole 16 px it is the red edge's 22°, in line with the stem.
        const fd = far.get(e.edge * 2 + (e.atEnd ? 1 : 0))
        for (const k of [a, b]) {
          const t = far.get(k.edge * 2 + (k.atEnd ? 1 : 0))
          if (!fd || !t) continue
          const c = -(fd.x * t.x + fd.y * t.y)
          if (c >= Math.cos((THROUGH_TURN_DEG * Math.PI) / 180)) crossing = true
        }
      }
      if (!crossing) out.push({ pair: [a, b], stem })
    }
  }
  return out
}

/** Where `threadJunctions` puts junctions, and the tangents their through arms leave on. */
export interface ThreadPlacement {
  /** Lattice corner → sub-pixel position. */
  pos: Map<number, Vec>
  /** Edge index * 2 + (junction is its end ? 1 : 0) → unit tangent into the edge. Empty
   *  unless `throughPairs`. */
  tangents: Map<number, Vec>
  /** The two `tangents` keys of each threaded junction's through pair. */
  pairs: [number, number][]
  /** Lattice corners of the GEOMETRIC through junctions — the ones the rank never placed —
   *  with their through direction: the re-seat may slide one ALONG it, never across it (a
   *  rank thread it may still correct either way). */
  corners: [number, Vec][]
}

/**
 * Sub-pixel position for every junction a weak boundary planted on a strong one, keyed
 * by lattice corner — whether the strong boundary continues through it or corners at it.
 * Junctions not in the map keep their integer corner, so an empty map is a no-op. With
 * `throughPairs`, also the junctions one arm pair runs straight through (geometric), and
 * the through tangent for every threaded junction.
 */
export function threadJunctions(
  net: PlanarNetwork,
  palette: readonly ThreadColor[],
  cornerJunctions = true,
  throughPairs = false,
  /** Diagnostic sink for every verdict (PlanarFitOptions.threadDiag). */
  diag?: (v: JunctionVerdict) => void,
  /** Sub-pixel chains by edge id, for the geometric pairs. */
  subpix?: ReadonlyMap<number, Vec[]>,
  /** The label map, for the front-shape test. */
  labels?: Int32Array,
): ThreadPlacement {
  const pos = new Map<number, Vec>()
  const tangents = new Map<number, Vec>()
  const pairs: [number, number][] = []
  const corners: [number, Vec][] = []
  for (const v of surveyJunctions(
    net,
    edgeContrast(net, palette),
    cornerJunctions,
    undefined,
    throughPairs,
    subpix,
    labels,
  )) {
    diag?.(v)
    if (!v.linked || !v.moveTo) continue
    pos.set(v.corner, v.moveTo)
    if (!throughPairs || !v.tangents) continue
    for (const [k, t] of v.tangents) tangents.set(k, t)
    pairs.push([v.tangents[0][0], v.tangents[1][0]])
    if (v.geometric) corners.push([v.corner, v.tangents[1][1]])
  }
  return { pos, tangents, pairs, corners }
}
