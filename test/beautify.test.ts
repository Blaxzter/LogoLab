// Unit tests for the V3 shape-beautification pass (src/lib/trace/beautify.ts).
//
//   node --test test/beautify.test.ts
//
// Covers the pure math behind every snap: circle/ellipse fitting + fidelity
// gating, line straightening / collinear merge, the concentric + equal-radius
// relation solver, winding preservation, and determinism.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { beautify, DEFAULT_BEAUTIFY_OPTIONS, type BeautifyOptions } from '../src/lib/trace/beautify.ts'
import type { PathNode, SubPath } from '../src/lib/path/types.ts'

const OPTS: BeautifyOptions = { ...DEFAULT_BEAUTIFY_OPTIONS }

// --- builders ---------------------------------------------------------------

const corner = (x: number, y: number): PathNode => ({ x, y, hIn: null, hOut: null, kind: 'corner' })

/** A closed polygon (corner nodes) sampling a circle; `cw` flips winding. */
function circlePoly(cx: number, cy: number, r: number, n = 48, cw = false): SubPath {
  const nodes: PathNode[] = []
  for (let i = 0; i < n; i++) {
    const t = (cw ? -1 : 1) * (i / n) * 2 * Math.PI
    nodes.push(corner(cx + r * Math.cos(t), cy + r * Math.sin(t)))
  }
  return { nodes, closed: true }
}

/** A closed polygon sampling an axis-aligned ellipse. */
function ellipsePoly(cx: number, cy: number, rx: number, ry: number, n = 64): SubPath {
  const nodes: PathNode[] = []
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI
    nodes.push(corner(cx + rx * Math.cos(t), cy + ry * Math.sin(t)))
  }
  return { nodes, closed: true }
}

// --- helpers ----------------------------------------------------------------

const isCircleSubPath = (sp: SubPath): boolean =>
  sp.closed && sp.nodes.length === 4 && sp.nodes.every((n) => n.kind === 'smooth' && !!n.hIn && !!n.hOut)

/** Recover (cx, cy, r) from a 4-node kappa-Bézier circle/ellipse (anchors are the
 *  axis extremes, so their mean is the centre). */
function circleOf(sp: SubPath): { cx: number; cy: number; rx: number; ry: number } {
  const cx = sp.nodes.reduce((s, n) => s + n.x, 0) / 4
  const cy = sp.nodes.reduce((s, n) => s + n.y, 0) / 4
  const rx = Math.max(...sp.nodes.map((n) => Math.abs(n.x - cx)))
  const ry = Math.max(...sp.nodes.map((n) => Math.abs(n.y - cy)))
  return { cx, cy, rx, ry }
}

function signedArea(sp: SubPath): number {
  let a = 0
  const n = sp.nodes.length
  for (let i = 0; i < n; i++) {
    const p = sp.nodes[i]
    const q = sp.nodes[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

const one = (sp: SubPath, opts = OPTS): SubPath => beautify([[sp]], opts)[0][0]

// --- circle snapping --------------------------------------------------------

test('a circular contour snaps to a 4-node Bézier circle at the right centre/radius', () => {
  const out = one(circlePoly(120, 90, 50))
  assert.ok(isCircleSubPath(out), 'should become a 4-node smooth circle')
  const c = circleOf(out)
  assert.ok(Math.abs(c.cx - 120) < 1 && Math.abs(c.cy - 90) < 1, `centre [${c.cx},${c.cy}]`)
  assert.ok(Math.abs(c.rx - 50) < 1 && Math.abs(c.ry - 50) < 1, `radius ${c.rx},${c.ry}`)
})

test('a square is NOT snapped to a circle (deviation far exceeds fidelity)', () => {
  const sq: SubPath = { nodes: [corner(10, 10), corner(90, 10), corner(90, 90), corner(10, 90)], closed: true }
  const out = one(sq)
  assert.ok(!isCircleSubPath(out), 'a square must not become a circle')
  assert.equal(out.nodes.length, 4)
})

test('fidelity = 0 disables beautification (contour returned untouched)', () => {
  const poly = circlePoly(120, 90, 50)
  const out = one(poly, { ...OPTS, fidelity: 0 })
  assert.equal(out, poly, 'same reference back')
  assert.equal(out.nodes.length, poly.nodes.length)
})

test('a tiny loop (r < 2·fidelity) is not snapped to a circle', () => {
  const out = one(circlePoly(50, 50, 2), { ...OPTS, fidelity: 1.5 })
  assert.ok(!isCircleSubPath(out), 'a 2px-radius loop is below the snap floor')
})

test('an open subpath is left untouched', () => {
  const open: SubPath = { nodes: [corner(0, 0), corner(10, 0), corner(10, 10)], closed: false }
  const out = one(open)
  assert.equal(out.closed, false)
  assert.equal(out.nodes.length, 3)
})

// --- winding preservation ---------------------------------------------------

test('snapped circle preserves the original loop winding (hole stays a hole)', () => {
  for (const cw of [false, true]) {
    const poly = circlePoly(100, 100, 40, 48, cw)
    const out = one(poly)
    assert.ok(isCircleSubPath(out))
    assert.equal(
      Math.sign(signedArea(out)),
      Math.sign(signedArea(poly)),
      `winding sign must match (cw=${cw})`,
    )
  }
})

// --- ellipse snapping -------------------------------------------------------

test('an axis-aligned ellipse snaps to a 4-node ellipse with the right radii', () => {
  const out = one(ellipsePoly(200, 150, 60, 40))
  assert.ok(isCircleSubPath(out), 'ellipse also materialises as a 4-node smooth loop')
  const c = circleOf(out)
  assert.ok(Math.abs(c.rx - 60) < 1.5 && Math.abs(c.ry - 40) < 1.5, `radii ${c.rx},${c.ry}`)
})

// --- line / collinear -------------------------------------------------------

test('a redundant collinear vertex on a straight edge is merged away', () => {
  // A rectangle whose top edge carries an extra (collinear) midpoint.
  const rect: SubPath = {
    nodes: [corner(10, 10), corner(50, 10), corner(90, 10), corner(90, 90), corner(10, 90)],
    closed: true,
  }
  const out = one(rect)
  assert.equal(out.nodes.length, 4, 'the collinear midpoint should be dropped')
})

test('a near-axis edge snaps to exact horizontal within the line-polish budget', () => {
  // A top edge barely tilted (< 10°) and within the sub-fidelity line cap of
  // horizontal: each endpoint moves only ~0.2px to the shared midpoint.
  const rect: SubPath = {
    nodes: [corner(10, 10.2), corner(30, 9.8), corner(30, 60), corner(10, 60)],
    closed: true,
  }
  const out = one(rect, { ...OPTS, fidelity: 1.5 })
  assert.ok(Math.abs(out.nodes[0].y - out.nodes[1].y) < 1e-6, 'top edge endpoints share a y')
})

// --- relation solver --------------------------------------------------------

test('concentric circles are aligned to a common centre (gated by fidelity)', () => {
  const a = circlePoly(100, 100, 40)
  const b = circlePoly(101, 101, 25)
  const [[outA, outB]] = beautify([[a, b]], { ...OPTS, fidelity: 2 })
  assert.ok(isCircleSubPath(outA) && isCircleSubPath(outB))
  const ca = circleOf(outA)
  const cb = circleOf(outB)
  assert.ok(Math.abs(ca.cx - cb.cx) < 1e-6 && Math.abs(ca.cy - cb.cy) < 1e-6, 'centres coincide')
})

test('far-apart circles whose alignment would exceed fidelity are NOT moved', () => {
  // Centres 1px apart but fidelity is tiny — the alignment move would break it.
  const a = circlePoly(100, 100, 40)
  const b = circlePoly(101, 100, 40)
  const [[outA, outB]] = beautify([[a, b]], { ...OPTS, fidelity: 0.5 })
  // Each still snaps individually but keeps its own centre.
  const ca = circleOf(outA)
  const cb = circleOf(outB)
  assert.ok(Math.abs(ca.cx - cb.cx) > 0.5, 'centres stay distinct when alignment exceeds the knob')
})

test('equal-radius circles are reconciled to a shared radius', () => {
  // Two same-ish circles, far apart (so NOT concentric), radii 40 and 41.
  const a = circlePoly(100, 100, 40)
  const b = circlePoly(400, 100, 41)
  const [[outA, outB]] = beautify([[a, b]], { ...OPTS, fidelity: 1.5 })
  const ra = circleOf(outA).rx
  const rb = circleOf(outB).rx
  assert.ok(Math.abs(ra - rb) < 1e-6, `radii reconciled, got ${ra} vs ${rb}`)
  assert.ok(Math.abs(ra - 40.5) < 0.5, `to their mean ~40.5, got ${ra}`)
})

test('relation solver also works across items (different groups)', () => {
  const a = circlePoly(100, 100, 40)
  const b = circlePoly(100.5, 100.5, 25)
  const out = beautify([[a], [b]], { ...OPTS, fidelity: 2 })
  const ca = circleOf(out[0][0])
  const cb = circleOf(out[1][0])
  assert.ok(Math.abs(ca.cx - cb.cx) < 1e-6 && Math.abs(ca.cy - cb.cy) < 1e-6, 'cross-item concentric')
})

// --- determinism ------------------------------------------------------------

test('beautify is deterministic (byte-identical on a re-run)', () => {
  const build = () => [[circlePoly(100, 100, 40), circlePoly(101, 101, 25)], [ellipsePoly(300, 300, 50, 30)]]
  const r1 = beautify(build(), OPTS)
  const r2 = beautify(build(), OPTS)
  assert.deepEqual(r1, r2)
})

test('input subpaths are not mutated', () => {
  const poly = circlePoly(120, 90, 50)
  const before = JSON.stringify(poly)
  beautify([[poly]], OPTS)
  assert.equal(JSON.stringify(poly), before, 'the source contour must be left intact')
})
