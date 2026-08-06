// §15 guard 2 — the TANGENT PIN may not fit a curve its own evidence does not support
// (src/lib/trace/planarFit.ts; issue #11, benchmarks §15.8).
//
// The pin rotates an apex handle onto the LINE fitted through that arm's samples, because
// on a sub-pixel displaced chain the arc fit's end tangent is free within ε and drifts
// toward the bisector (§15.7). The line is the right evidence only while the arm is
// STRAIGHT across the window it is measured on — [SNAP_GAP .. SNAP_SPAN] px from the apex.
// Where the boundary has already turned inside that window, the "arm line" is a CHORD: its
// direction is not the boundary's direction at the apex, and rotating a LONG handle onto it
// swings the fitted curve px away from the samples it was fitted to.
//
// The witness (a script 'a' whose counter wedge pinches out at the top): 29.3° of rotation
// on a 26.0px handle moved the control point 13.1px, the bowl's crown sagged ~2px, and the
// white gap at the top of the counter closed. The corpus-wide histogram (src/devtest/
// pinDiag.ts) put that one pin 3.6× beyond every other applied pin in tier 0 + the gallery
// witnesses, which is what makes a bound on the handle-tip movement the right guard.
//
// The anatomy below is that witness's, built from two analytic strokes and quantized onto
// the crack lattice: a curved crown, a 2px "pinch" step where the sub-pixel white wedge is
// fused away, a shoulder, a long straight stem. No raster is involved — the pin's inputs
// are the chain and the corner set, and §15's displacement pass reverts this neighbourhood
// to the lattice anyway (its corner self-guard), so the lattice chain IS what the fitter
// sees there.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cubicAt } from '../src/lib/path/geometry.ts'
import { DEFAULT_PLANAR_FIT, detectLoopCorners, fitCorneredLoop, type PinDiagRecord } from '../src/lib/trace/planarFit.ts'
import type { PathNode, Vec } from '../src/lib/path/types.ts'

// --- the anatomy ------------------------------------------------------------------------
/** Bowl: y = Y0 + (x − XA)²/R — a crown of curvature radius R/2 px, apex at XA. */
const R = 90
const XA = 48
const Y0 = 18
/** The pinch column: right of it the boundary is the OTHER stroke's edge, JUMP px higher,
 *  because the white wedge between the two banks still had width when the lattice fused
 *  it. This step is the counter wedge's quantized tip, and the corner the pin fires on. */
const XP = 62
const JUMP = 2
/** The shoulder: flat for FLAT px past the pinch, then falling to the stem. */
const FLAT = 8
const SLOPE = 0.25
const XS = 72 // the stem's right edge
const X0 = 2 // where the bowl's flank runs out of canvas

const bowl = (x: number): number => Y0 + ((x - XA) * (x - XA)) / R
const shoulder = (x: number): number => bowl(XP) - JUMP + Math.max(0, x - XP - FLAT) * SLOPE
const top = (x: number): number => Math.round(x <= XP ? bowl(x) : shoulder(x))

/** The closed 4-connected staircase of that outline — the only kind of chain
 *  planarNetwork ever hands the fitter. */
function counterLoop(): Vec[] {
  const pts: Vec[] = []
  const push = (x: number, y: number): void => {
    const last = pts[pts.length - 1]
    if (!last || last.x !== x || last.y !== y) pts.push({ x, y })
  }
  let y = top(XS)
  for (let yy = 60; yy >= y; yy--) push(XS, yy) // up the stem's right edge
  for (let x = XS - 1; x >= X0; x--) {
    const ty = top(x)
    while (y < ty) push(x + 1, ++y)
    while (y > ty) push(x + 1, --y)
    push(x, y)
  }
  for (let yy = y; yy <= 110; yy++) push(X0, yy) // and a plain box back around
  for (let x = X0 + 1; x <= XS; x++) push(x, 110)
  for (let yy = 109; yy > 60; yy--) push(XS, yy)
  return pts
}

// --- measurement ------------------------------------------------------------------------
/** Sample a fitted node list densely into a polyline. */
function flatten(nodes: PathNode[]): Vec[] {
  const out: Vec[] = []
  const n = nodes.length
  for (let i = 0; i < n; i++) {
    const a = nodes[i]
    const b = nodes[(i + 1) % n]
    const c1 = a.hOut ?? { x: a.x, y: a.y }
    const c2 = b.hIn ?? { x: b.x, y: b.y }
    for (let s = 0; s < 32; s++) out.push(cubicAt({ x: a.x, y: a.y }, c1, c2, { x: b.x, y: b.y }, s / 32))
  }
  return out
}

const distTo = (p: Vec, poly: Vec[]): number => {
  let best = Infinity
  for (const q of poly) {
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d < best) best = d
  }
  return best
}

/**
 * Worst distance from the CROWN's own lattice samples to the curve fitted through them —
 * "does the fit still explain its evidence there". Measured clear of the pinch step itself
 * (its 2px wall is not representable by any smooth curve and is not what is under test).
 */
function crownSag(pin: boolean): { sag: number; pins: PinDiagRecord[] } {
  const pts = counterLoop()
  const corners = detectLoopCorners(pts, DEFAULT_PLANAR_FIT.cornerTurnDeg)
  const pins: PinDiagRecord[] = []
  const nodes = fitCorneredLoop(pts, corners, { ...DEFAULT_PLANAR_FIT, pinCornerTangents: pin, pinDiag: (r) => pins.push(r) })
  const poly = flatten(nodes)
  let sag = 0
  for (const p of pts) {
    if (p.x > XP - 4 || p.y > top(X0) + 4) continue
    sag = Math.max(sag, distTo(p, poly))
  }
  return { sag, pins }
}

/**
 * The bar. The fit's own tolerance is ε = 1.0px and the chain is a ±0.5px staircase, so a
 * healthy fit lands near — but under — 1.6. Measured on this fixture: unpinned 1.24px;
 * pinned, before the shift cap, 2.77px (an 11.0° rotation of a 23.2px handle = 4.4px of
 * control-point movement); pinned, with the cap, 1.24px again.
 */
const SAG_MAX = 1.6

test('pin: the fitted curve still explains the crown it was fitted to', () => {
  const { sag, pins } = crownSag(true)
  const worst = pins
    .filter((p) => p.applied)
    .map((p) => ({ p, shift: 2 * p.handle * Math.sin((p.rotDeg * Math.PI) / 360) }))
    .sort((a, b) => b.shift - a.shift)[0]
  assert.ok(
    sag <= SAG_MAX,
    `the pinned fit leaves its own crown samples by ${sag.toFixed(2)}px (limit ${SAG_MAX}). Worst applied pin: ` +
      (worst
        ? `${worst.p.rotDeg.toFixed(1)}° on a ${worst.p.handle.toFixed(1)}px handle = ${worst.shift.toFixed(2)}px of control-point movement`
        : 'none') +
      `. The arm line was measured where the boundary had already turned — benchmarks §15.8.`,
  )
})

test('pin: the unpinned fit is inside the same bar — the pin is what moves it', () => {
  const { sag } = crownSag(false)
  assert.ok(sag <= SAG_MAX, `the unpinned fit already leaves its evidence by ${sag.toFixed(2)}px — the fixture is not isolating the pin`)
})

test('pin: a gently-curved arm is still pinned (§15.7 stays on)', () => {
  // The CONTROL, and it is the configuration guard 2 was built for: a lens whose two tips
  // are sharp corners between long, nearly-straight arms fitted as cubics — chupa-chups'
  // letterform corners in miniature. There the arm line IS the boundary's direction at the
  // apex, the correction is small, and the curve-displacement bound must leave it alone.
  // (An axis-aligned square would not test anything: its arcs fit as straight LINES, which
  // carry no handles to pin.)
  const RR = 160 // arc radius — gentle enough that the chord is the tangent
  const HALF = 40
  const CY = 60
  const rim = (x: number): number => Math.round(CY - (Math.sqrt(RR * RR - x * x) - Math.sqrt(RR * RR - HALF * HALF)))
  const pts: Vec[] = []
  const push = (x: number, y: number): void => {
    const last = pts[pts.length - 1]
    if (!last || last.x !== x || last.y !== y) pts.push({ x, y })
  }
  let y = rim(-HALF)
  for (let x = -HALF; x <= HALF; x++) {
    const ty = rim(x)
    while (y > ty) push(x + 60, --y)
    while (y < ty) push(x + 60, ++y)
    push(x + 60, y)
  }
  for (let x = HALF; x >= -HALF; x--) {
    const ty = 2 * CY - rim(x)
    while (y < ty) push(x + 60, ++y)
    while (y > ty) push(x + 60, --y)
    push(x + 60, y)
  }
  const corners = detectLoopCorners(pts, DEFAULT_PLANAR_FIT.cornerTurnDeg)
  assert.equal(corners.length, 2, 'the lens should present its two tips as sharp corners')
  const pins: PinDiagRecord[] = []
  fitCorneredLoop(pts, corners, { ...DEFAULT_PLANAR_FIT, pinCornerTangents: true, pinDiag: (r) => pins.push(r) })
  assert.equal(pins.length, 4, 'both tips should offer both handles to the pin')
  const refused = pins.filter((p) => !p.applied)
  assert.equal(
    refused.length,
    0,
    `the curve-displacement bound refused ${refused.length} healthy pin(s): ` +
      refused.map((p) => `${p.rotDeg.toFixed(1)}° on ${p.handle.toFixed(1)}px`).join(', '),
  )
})
