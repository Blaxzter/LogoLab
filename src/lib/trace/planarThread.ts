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
): JunctionVerdict[] {
  const span = tune?.span ?? THROUGH_SPAN
  const throughDev = tune?.dev ?? THROUGH_DEV
  const cw = net.width + 1
  const inc = incidentEnds(net)
  const out: JunctionVerdict[] = []
  for (const corner of net.junctions) {
    const windows = new Map<number, Vec[]>()
    const ends = (inc.get(corner) ?? []).map((e) => {
      const w = armWindow(net.edges[e.edge].pts, e.atEnd, span)
      windows.set(e.edge * 2 + (e.atEnd ? 1 : 0), w)
      return { ...e, de: contrast[e.edge], arm: armLen(w) }
    })
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
    if (strong.length !== 2 || weak.length !== ends.length - 2) {
      // Either the contrast is not cleanly split (something sits in the 12–25 gap) or
      // this is not a weak-into-strong T at all.
      v.reason = `rank ${strong.length}s/${weak.length}w of ${ends.length}`
      continue
    }
    const [a, b] = strong
    if (a.edge === b.edge) {
      v.reason = 'strong arms are one edge'
      continue
    }
    if (Math.min(a.arm, b.arm) < MIN_ARM) {
      v.reason = `arm ${Math.min(a.arm, b.arm).toFixed(0)}px < ${MIN_ARM}`
      continue
    }
    const wa = windows.get(a.edge * 2 + (a.atEnd ? 1 : 0))!
    const wb = windows.get(b.edge * 2 + (b.atEnd ? 1 : 0))!
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
        if (c) p = ontoCircle(c)
        v.extK = ext?.k ?? 1
      } else if (lf) {
        const m = centroid(win)
        const t = (q.x - m.x) * lf.dir.x + (q.y - m.y) * lf.dir.y
        p = { x: m.x + t * lf.dir.x, y: m.y + t * lf.dir.y }
      }
      v.kind = 'thread'
    } else if (ext) {
      // The chord turn said corner, the wider window says arc: thread onto that circle
      // rather than intersecting the arms inside the curve.
      p = ontoCircle(ext.c)
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
    v.reason = v.kind!
  }
  return out
}

/**
 * Sub-pixel position for every junction a weak boundary planted on a strong one, keyed
 * by lattice corner — whether the strong boundary continues through it or corners at it.
 * Junctions not in the map keep their integer corner, so an empty map is a no-op.
 */
export function threadJunctions(net: PlanarNetwork, palette: readonly ThreadColor[], cornerJunctions = true): Map<number, Vec> {
  const out = new Map<number, Vec>()
  for (const v of surveyJunctions(net, edgeContrast(net, palette), cornerJunctions)) {
    if (v.linked && v.moveTo) out.set(v.corner, v.moveTo)
  }
  return out
}
