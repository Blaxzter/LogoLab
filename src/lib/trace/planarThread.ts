// §14 — contrast rank: a WEAK colour boundary must not aim a STRONG one.
//
// On ramp art traced FLAT the posterization band seams (ΔE 2.7–10.2 on the Affinity
// mark) plant junctions on the logo's REAL edges (ΔE 47–79). A junction is an INTEGER
// lattice corner, so pinning a 116px edge to it costs ~1px at that end against 100+px
// of the edge's own staircase evidence: the flank does not step, it ROTATES (0.98px
// end to end), and an arc caught between two seam junctions kinks 11° into its
// straight neighbours. The weak boundary aims the strong edge.
//
// The fix has to live BEFORE the fit. A post-fit re-seat provably moves the vertex
// 0.000px — the primitive is fitted from the ALREADY-PINNED edge, so its line passes
// through the vertex by construction (§14.1, built, measured, reverted). Here the two
// STRONG arms' raw lattice chains are joined into one window ACROSS the junction and
// fitted — as one line, or as one circle when the boundary curves through — and the
// junction is moved onto that curve. Every incident edge (including the band seam,
// whose endpoint follows) is then fitted pinned to the same point, so both regions
// still reference one shared edge and the planar byte-coincidence invariant holds.
//
// The correction is purely NORMAL to the strong boundary. That is the whole point: the
// lattice quantizes the junction ACROSS the edge, which tilts it; where the junction
// sits ALONG the edge is the weak boundary's business, and an error there is invisible.
//
// §17 (§0 #15) is the OTHER branch of the same rank. Where the strong boundary CORNERS at
// the junction instead of continuing, no through fit exists — one line or circle across
// the bend would round the corner off, which is exactly what the chord-turn gate refuses —
// and until now such a junction simply kept its integer lattice corner, so an edge with
// one threaded end and one corner-pinned end traded a constant offset for a TILT. A corner
// is still a sub-pixel place: it is where the two arms' OWN lines meet, the evidence
// §10.6's corner snap uses inside a chain and cannot reach at a junction (the chain ends
// there, so `snapCornerToArms` has nothing to intersect against). Both arms must be
// straight enough for their lines to be tangents (ARM_BOW) or the junction is left alone.
//
// §28 (issue #14) sits between the two. The turn gate reads a chord over a FIXED px window,
// and 12px is a fraction of the art that halves with every doubling of the raster — so an
// authored ARC that threads at 512 reads as a corner at 256 and was intersected inside its
// own curve. A refused junction is now first offered the circle window EXTENDED while the
// arms still fit one circle (THROUGH_EXTEND): an arc survives that at any raster, a corner
// at none, and the circle from the widest surviving window is also the one every circle
// placement now projects onto — its radius is read from enough sweep to mean something.
//
// Everything is evidence-gated and every gate can only DROP a junction: with no palette
// (or `fitThrough: false`) nothing moves and the fit is byte-identical to the pre-§14
// tracer. Pure & deterministic.

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

// --- gates (calibrated in docs/vectorization-benchmarks.md §14.3) -------------
/** ΔE76 at or above which a boundary is a REAL edge (the mark's own outline). */
const STRONG_DE = 25
/** ΔE76 at or below which a boundary is a posterization band seam. */
const WEAK_DE = 12
/** Raw-lattice arc (px) sampled on each arm for the through fit — the BASE window. It is
 *  a fixed px count, and deliberately so for the LINE question (does the boundary run
 *  straight through?): staircase phase noise is ±0.5px per endpoint at every raster, so a
 *  chord direction needs the same px of evidence at every raster (the §10.6 short-arm
 *  lesson, and why MIN_ARM does not scale either).
 *
 *  For the CIRCLE question it is NOT enough on its own, and that is issue #14's measured
 *  defect: 12px of an arc is a fraction of the art that halves with every doubling of the
 *  raster, so the same authored arc reads a chord turn of 21.4° @256 and 7.1° @2048, the
 *  coarse end trips THROUGH_TURN_DEG and is routed to the §17 apex branch (0.73 artwork-px
 *  off the arc, worse than its own lattice corner), and the circle 12px CAN fit is
 *  ill-conditioned (radius 47–56 for an authored 79–81, too little sweep against the
 *  staircase). Scaling this window with the raster was built and MEASURED worse at every
 *  raster (§28: at 256 it shrinks to 6px and refuses four straight continuations on
 *  noise). What is scale-free is the circle's own evidence: the window is EXTENDED
 *  (THROUGH_EXTEND) while the joined arms still fit ONE circle within THROUGH_DEV, and the
 *  junction threads onto the circle the widest surviving window affords. An arc survives
 *  the extension at any raster; a corner's straight arms leave any circle at a rate set by
 *  the corner angle alone, so it fails the first step. */
const THROUGH_SPAN = 12
/** Multiples of THROUGH_SPAN the circle window may grow to, in order; the extension stops
 *  at the first that does not fit (or that an arm cannot fill) and keeps the last that did.
 *  A junction the turn gate refused becomes a threaded arc only if the 2× window fits —
 *  that is the evidence a corner cannot produce (§28 measured: a 40° corner's circle
 *  residual is 1.11px at 12px and ~2.2px at 24px, a 20° corner's ~1.1px at 24px; the
 *  turn gate's own 20° boundary, reached from the residual instead of the chord turn, and
 *  identical at every raster). The upper multiple bounds work, not fidelity: more arc is
 *  only more evidence, and the residual gate stops the window at any real feature. */
const THROUGH_EXTEND = [2, 3, 4]
/** …and the shortest arm that earns a verdict at all (below this a chord direction is
 *  staircase-phase noise — the §10.6 short-arm lesson). */
const MIN_ARM = 6
/** Max deviation (px) of the two arms' JOINED window from one line or one circle. A
 *  line covers "runs straight through", a circle "curves smoothly through" (a
 *  radius-50 rounded corner bows 1.5px off its own chord over ±12px and would fail a
 *  line-only test — the user's second complaint is exactly such a corner). */
const THROUGH_DEV = 1.2
/** …and the chord turn (deg) the boundary may take across the junction. The residual
 *  ALONE is not enough, and this is measured, not assumed: on the Affinity mark a
 *  genuine 40° corner of the navy plate fits a circle to 1.11px over the ±12px window
 *  (a 40° bend over 24px IS an arc of radius ~35), so it passes THROUGH_DEV and would
 *  be moved — off the corner the lattice had right. The turn splits the same junctions
 *  cleanly where the residual cannot: continuations and the plate's radius-50 corners
 *  read 0–13.2°, real corners 39.8–105.3°. 20° sits in that gap, 1.5× from both.
 *
 *  That calibration is a 512 statement (issue #14): the same arc reads 21.4° @256. So a
 *  junction this gate refuses is no longer sent straight to the corner branch — it is
 *  first offered the EXTENDED circle window (THROUGH_EXTEND), which a corner cannot
 *  pass and an arc can at any raster. The turn stays the gate for the LINE branch. */
const THROUGH_TURN_DEG = 20
/** How far the re-placed junction may travel off its lattice corner. It is a sub-pixel
 *  placement, not a re-seat (§10.4's MIN_MOVE 1.5px is the other end of this scale);
 *  past this the through fit disagrees with the label map and the junction is dropped.
 *
 *  §17 SHARES it, and a separate wider bound for the corner branch was measured and NOT
 *  taken. An ACUTE apex is the one place a bigger move is legitimate — the raster erodes
 *  a narrow tip, so its true corner sits px past the lattice — and `seam-corner`'s 17°
 *  wedge is refused here at 2.16px. But the sweep saturates immediately: every value from
 *  3 to 12px does exactly the same thing (that one junction, nothing else) for @512
 *  chamfer 0.214 → 0.209 and @256 0.196 → 0.200. A knob that trades one lane against
 *  another for 0.005px does not earn its place; the refusal is named residue instead. */
const MAX_MOVE = 2.0
/**
 * §17 (§0 #15) — max |perp deviation| of ONE arm's samples from its OWN fitted line for
 * that line to be usable as the boundary's tangent at the junction.
 *
 * This is a ONE-SIDED veto and the measurement is why. Scoring all 202 arms of the 101
 * corner-verdict junctions across the 128 GT-scorable marks against the AUTHORED outline
 * (does the art run straight over that same 12px window?):
 *
 *     bow ≤ 0.79   51 authored-STRAIGHT   100 authored-bent
 *     bow > 0.79    0 authored-STRAIGHT    51 authored-bent
 *
 * So a HIGH bow proves the line is a chord across something that turns — no straight arm
 * in the corpus reaches 0.8 — while a LOW bow proves nothing at all (two thirds of the
 * arms under it are bent). The gate is therefore only ever used to DROP an arm, never to
 * certify one, and a junction whose two arms are both dropped keeps its lattice corner.
 * (The §15.8 residue predicted this: `bow` on a lattice staircase is not separable. It
 * was re-measured here rather than assumed, and it is not separable in this population
 * either — only bounded on one side.)
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
  /** True when the junction is the edge's END (pts[n-1]), false at its START. */
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
  /** Which rule placed it: a §14 through fit, or a §17 corner APEX (the two arms' own
   *  lines intersected). */
  kind: 'thread' | 'apex' | null
  /** For a through-CIRCLE placement: the THROUGH_SPAN multiple the window grew to while
   *  still one circle (1 = the base window only; ≥ 2 = the §28 extension). Null otherwise. */
  extK: number | null
  /** Where the placement puts this junction (null when it is not moved). */
  moveTo: Vec | null
  /** How far that is from the lattice corner. */
  move: number | null
  linked: boolean
  reason: string
  /** DIAGNOSTIC ONLY (`tune.alt`): where EACH estimator would put the junction, gates
   *  ignored — the through-line projection, the through-circle projection (with the fitted
   *  radius), and the two arms' line intersection. Lets a census score the estimators
   *  against the authored boundary independently of the rule that picks between them. */
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

/** Raw lattice points on one arm, JUNCTION FIRST, out to `span` px of arc. */
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
 *  staircase); a CURVED arm's line is a chord and its bow is the sagitta over the window,
 *  which is what ARM_BOW vetoes. Shares `armLine` with the §10.6 corner snap — one
 *  estimator, two callers. */
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
 * §28 (issue #14) — the circle window, grown while the evidence stays ONE circle.
 *
 * Both arms are re-read at each multiple of the base span; the extension stops at the
 * first window an arm cannot fill (the edge ends — another junction, another feature) or
 * whose joined samples no longer fit one circle within `dev`, and returns the circle of the
 * widest window that did, with its multiple. Null when not even the 2× window fits — the
 * caller then has no more evidence than the base window gave it.
 *
 * Why the radius comes out right here and not from the base window: a circle fitted to
 * 12px of a radius-40 arc has ~0.45px of sagitta to read against ±0.5px of staircase, and
 * its radius is a coin flip (measured 47–56 for an authored 79–81 on band-cross); at 24px
 * the sagitta is 1.8px and the radius reads 73–80. The projection error at the junction is
 * the radius error's sagitta, so it falls the same way (0.63 → 0.38, 0.73 → 0.15 artwork
 * px, `threadScaleDiag`).
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
 * seams, whether the real ones CONTINUE through, and where the through fit puts the
 * junction. The tracer moves exactly the junctions this marks `linked`;
 * `src/devtest/threadDiag.ts` prints these same rows, so the calibration is
 * inspectable rather than asserted.
 */
export function surveyJunctions(
  net: PlanarNetwork,
  contrast: Float64Array,
  cornerJunctions = true,
  /** DIAGNOSTIC ONLY (issue #14's paired census): override the window / residual gates so
   *  a counterfactual can be measured without editing the constants. Production never
   *  passes it; omitted ⇒ the shipped constants, byte-identical. */
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
    // §28: a junction the turn gate refuses is an ARC read at a coarse raster until proven
    // a corner — the extended circle window is that proof either way (see THROUGH_EXTEND).
    // Only worth asking where the base window already fits a circle; a sharp corner's
    // residual only grows from there.
    const refusedByTurn = v.turnDeg == null || v.turnDeg > THROUGH_TURN_DEG
    const ext = (v.circleDev ?? Infinity) <= throughDev ? extendCircle(net, a, b, span, throughDev) : null
    if (!refusedByTurn) {
      // --- §14: the boundary CONTINUES through. Fit it as one window and project. ---
      const dev = Math.min(v.lineDev ?? Infinity, v.circleDev ?? Infinity)
      if (!(dev <= throughDev)) {
        v.reason = `break (dev ${Number.isFinite(dev) ? dev.toFixed(2) : '—'})`
        continue
      }
      // Move the junction onto the through fit — whichever primitive the joined window
      // is actually made of. A circle is taken from the widest window that still fits it
      // (§28) — the base window's own circle only when nothing wider does.
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
      // --- §28 (issue #14): the chord turn said "corner", the wider evidence says ARC.
      // 24px of an authored arc fits one circle at every raster; 24px of a real corner's
      // straight arms fit none (a 40° corner reads ~2.2px against THROUGH_DEV 1.2). The
      // junction threads onto that circle — the through fit the base window was too short
      // to earn, not the apex the corner branch would have intersected inside the curve.
      p = ontoCircle(ext.c)
      v.extK = ext.k
      v.kind = 'thread'
    } else {
      // --- §17 (§0 #15): the boundary CORNERS here. A through fit is not defined — one
      // line or circle across the bend would round the corner off, which is exactly what
      // the turn gate above exists to refuse. But a corner is still a SUB-PIXEL place:
      // it is where the two arms' own lines meet, the same evidence §10.6's corner snap
      // uses INSIDE a chain and the one thing a junction cannot reach there (the chain
      // ends at the junction, so `snapCornerToArms` has nothing to intersect).
      //
      // BOTH arms have to be usable evidence (ARM_BOW). A bowed arm's "line" is a chord of
      // something turning, and intersecting against a chord throws the apex px ALONG the
      // other arm (measured, with the veto removed: moves reach 10.4px). One arm alone does
      // not define a corner, so such a junction keeps its lattice corner.
      //
      // MEASURED AND REJECTED, recorded so it is not rebuilt: with ONE usable arm the
      // junction can still be corrected in that arm's NORMAL direction (§14's own rule —
      // the along-edge position is the weak boundary's business). That is geometrically
      // right and it does improve the junction itself: on the Affinity mark it moves all
      // five corner junctions from 0.50px to 0.27px off the authored outline. But the
      // correction has a component ACROSS the OTHER arm, whose chain is still on the
      // lattice, so it tilts that one instead. Over the 110 GT-scorable marks it measured
      // 8 better / 6 worse on chamfer (against 6/3 for the apex branch alone), cost
      // `affinity-designer` a recovered corner (5/7 → 4/7), and left that mark's
      // authored-straight-run swing a wash (Σ 7.39 → 7.57px). §17.3 has the numbers.
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
 * by lattice corner — whether the strong boundary continues through it (§14) or corners
 * at it (§17). Junctions not in the map keep their integer corner, so an empty map is a
 * byte-identical no-op.
 */
export function threadJunctions(net: PlanarNetwork, palette: readonly ThreadColor[], cornerJunctions = true): Map<number, Vec> {
  const out = new Map<number, Vec>()
  for (const v of surveyJunctions(net, edgeContrast(net, palette), cornerJunctions)) {
    if (v.linked && v.moveTo) out.set(v.corner, v.moveTo)
  }
  return out
}
