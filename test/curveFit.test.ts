// Unit tests for the evidence-based curve fitter (plan §4.2 / Stage A): key-vertex
// selection, per-vertex tangents, soft-corner score, junction costs, and the
// min-cost DP that selects lines vs cubics and places C⁰ corners by evidence.
//
//   node --test test/curveFit.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fitClosedLoop,
  fitSingleCubic,
  keyVertexIndices,
  tangentAtIndex,
  cornerScoreAtIndex,
  junctionCosts,
  lineFit,
  DEFAULT_CURVE_FIT,
} from '../src/lib/trace/curveFit.ts'
import type { PathNode, Vec } from '../src/lib/path/types.ts'

const EPS = 1.0
const OPTS = { ...DEFAULT_CURVE_FIT, epsilon: EPS }

/** Dense points (≈1 px spacing) along the edges of a closed polygon. */
function samplePolygon(corners: [number, number][]): Vec[] {
  const pts: Vec[] = []
  for (let i = 0; i < corners.length; i++) {
    const [ax, ay] = corners[i]
    const [bx, by] = corners[(i + 1) % corners.length]
    const len = Math.hypot(bx - ax, by - ay)
    const steps = Math.max(1, Math.round(len))
    for (let k = 0; k < steps; k++) {
      const t = k / steps
      pts.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t })
    }
  }
  return pts
}

/** Dense points (≈1 px spacing) around a circle. */
function sampleCircle(cx: number, cy: number, r: number): Vec[] {
  const n = Math.max(12, Math.round(2 * Math.PI * r))
  const pts: Vec[] = []
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

const isLineNode = (n: PathNode) => !n.hIn && !n.hOut
const countCorners = (nodes: PathNode[]) => nodes.filter((n) => n.kind === 'corner').length

// ---------------------------------------------------------------------------
// Key vertices
// ---------------------------------------------------------------------------

test('keyVertexIndices keeps a square\'s four corners (and nothing on its edges)', () => {
  const sq = samplePolygon([
    [10, 10],
    [90, 10],
    [90, 90],
    [10, 90],
  ])
  const kv = keyVertexIndices(sq, EPS)
  assert.equal(kv.length, 4, `want 4 key vertices, got ${kv.length}`)
  // Each kept index is at (≈) a corner.
  const corners = [
    [10, 10],
    [90, 10],
    [90, 90],
    [10, 90],
  ]
  for (const i of kv) {
    const p = sq[i]
    const nearCorner = corners.some(([x, y]) => Math.hypot(p.x - x, p.y - y) < 1.5)
    assert.ok(nearCorner, `key vertex (${p.x},${p.y}) should sit on a corner`)
  }
})

// ---------------------------------------------------------------------------
// Soft-corner score
// ---------------------------------------------------------------------------

test('cornerScore is positive at a sharp corner, negative on a straight edge', () => {
  const sq = samplePolygon([
    [10, 10],
    [90, 10],
    [90, 90],
    [10, 90],
  ])
  // Index of the top-right corner (90,10): it is at the end of the first edge.
  const cornerIdx = sq.findIndex((p) => Math.abs(p.x - 90) < 0.5 && Math.abs(p.y - 10) < 0.5)
  assert.ok(cornerIdx > 0)
  const cCorner = cornerScoreAtIndex(sq, cornerIdx, EPS)
  assert.ok(cCorner > 0.25, `sharp corner score ${cCorner.toFixed(2)} should be > 0.25 (corner)`)

  // A midpoint of the top edge (straight).
  const midIdx = sq.findIndex((p) => Math.abs(p.y - 10) < 0.5 && Math.abs(p.x - 50) < 1)
  assert.ok(midIdx > 0)
  const cMid = cornerScoreAtIndex(sq, midIdx, EPS)
  assert.ok(cMid < 0, `straight-edge score ${cMid.toFixed(2)} should be < 0 (smooth)`)
})

test('cornerScore is negative everywhere on a circle (no corners)', () => {
  const circ = sampleCircle(60, 60, 40)
  const kv = keyVertexIndices(circ, EPS)
  for (const i of kv) {
    const c = cornerScoreAtIndex(circ, i, EPS)
    assert.ok(c < 0.25, `circle vertex score ${c.toFixed(2)} should not read as a corner`)
  }
})

// ---------------------------------------------------------------------------
// Tangents
// ---------------------------------------------------------------------------

test('tangentAtIndex follows a straight edge direction', () => {
  const sq = samplePolygon([
    [10, 10],
    [90, 10],
    [90, 90],
    [10, 90],
  ])
  const midIdx = sq.findIndex((p) => Math.abs(p.y - 10) < 0.5 && Math.abs(p.x - 50) < 1)
  const t = tangentAtIndex(sq, midIdx, EPS)
  // Top edge runs +x; tangent should be ≈ (±1, 0).
  assert.ok(Math.abs(Math.abs(t.x) - 1) < 0.05 && Math.abs(t.y) < 0.05, `tangent ${t.x.toFixed(2)},${t.y.toFixed(2)}`)
})

// ---------------------------------------------------------------------------
// Junction costs
// ---------------------------------------------------------------------------

test('junctionCosts: a corner makes C⁰ cheap, a smooth vertex makes G¹ free', () => {
  const corner = junctionCosts(1) // strong corner
  assert.ok(corner.c0 < corner.g1, 'at a corner, C⁰ should be cheaper than G¹')
  assert.ok(corner.c0 < 1, `corner C⁰ cost ${corner.c0.toFixed(2)} should be small`)

  const smooth = junctionCosts(-1) // strong smooth
  assert.equal(smooth.g1, 0, 'at a smooth vertex, G¹ is free')
  assert.ok(smooth.c0 > 10, `smooth C⁰ cost ${smooth.c0.toFixed(1)} should be large`)

  const ambiguous = junctionCosts(0.1)
  assert.equal(ambiguous.g1, 0, 'ambiguous biases toward G¹ (free)')
  assert.equal(ambiguous.c0, 10)
})

// ---------------------------------------------------------------------------
// Line fit
// ---------------------------------------------------------------------------

test('lineFit recovers a diagonal direction with ~zero deviation', () => {
  const pts: Vec[] = []
  for (let i = 0; i <= 20; i++) pts.push({ x: i, y: i })
  const fit = lineFit(pts)!
  assert.ok(fit.maxDev < 1e-6, `collinear points should have ~0 deviation, got ${fit.maxDev}`)
  assert.ok(Math.abs(Math.abs(fit.dir.x) - Math.SQRT1_2) < 1e-3)
})

// ---------------------------------------------------------------------------
// Single-cubic Schneider fit
// ---------------------------------------------------------------------------

test('fitSingleCubic approximates a quarter circle within a small tolerance', () => {
  const cx = 0
  const cy = 0
  const r = 50
  const arc: Vec[] = []
  const N = 60
  for (let i = 0; i <= N; i++) {
    const a = (Math.PI / 2) * (i / N)
    arc.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  // Tangent at start (r,0) points +y (into arc); at end (0,r) points +x (into arc).
  const fit = fitSingleCubic(arc, { x: 0, y: 1 }, { x: 1, y: 0 })
  assert.ok(fit.maxDev < 0.1, `quarter-circle single cubic maxDev ${fit.maxDev.toFixed(3)} should be tiny`)
})

// ---------------------------------------------------------------------------
// Whole-loop fitting
// ---------------------------------------------------------------------------

test('fitClosedLoop: a square → 4 corner nodes with straight edges', () => {
  const sq = samplePolygon([
    [10, 10],
    [90, 10],
    [90, 90],
    [10, 90],
  ])
  const nodes = fitClosedLoop(sq, OPTS)!
  assert.ok(nodes, 'square should fit')
  assert.equal(nodes.length, 4, `square wants 4 nodes, got ${nodes.length}`)
  assert.equal(countCorners(nodes), 4, 'all four joins are corners')
  assert.ok(nodes.every(isLineNode), 'square edges are straight lines (null handles)')
})

test('fitClosedLoop: a circle → no corners, few smooth nodes, anchors on the circle', () => {
  const cx = 60
  const cy = 60
  const r = 40
  const circ = sampleCircle(cx, cy, r)
  const nodes = fitClosedLoop(circ, OPTS)!
  assert.ok(nodes, 'circle should fit')
  assert.equal(countCorners(nodes), 0, 'a circle has no hard corners')
  assert.ok(nodes.length <= 8, `circle node count ${nodes.length} should be small`)
  for (const n of nodes) {
    const d = Math.abs(Math.hypot(n.x - cx, n.y - cy) - r)
    assert.ok(d < 1.5, `anchor should sit on the circle, off by ${d.toFixed(2)}px`)
  }
})

test('fitClosedLoop: a sharp mountain polygon keeps its corners (summit geometry)', () => {
  const corners: [number, number][] = [
    [84, 400],
    [212, 176],
    [300, 320],
    [356, 236],
    [428, 400],
  ]
  const mtn = samplePolygon(corners)
  const nodes = fitClosedLoop(mtn, OPTS)!
  assert.ok(nodes, 'mountain should fit')
  // Every true corner is reproduced by a corner node within ~1.5 px.
  for (const [x, y] of corners) {
    const hit = nodes.some((n) => n.kind === 'corner' && Math.hypot(n.x - x, n.y - y) < 1.5)
    assert.ok(hit, `corner (${x},${y}) must be preserved as a sharp node`)
  }
  // Clean polygon → exactly its corner count, all straight edges.
  assert.equal(nodes.length, corners.length, `want ${corners.length} nodes, got ${nodes.length}`)
  assert.ok(nodes.every(isLineNode), 'straight mountain edges are lines')
})

test('fitClosedLoop is deterministic (byte-identical re-run)', () => {
  const mtn = samplePolygon([
    [84, 400],
    [212, 176],
    [300, 320],
    [356, 236],
    [428, 400],
  ])
  const a = JSON.stringify(fitClosedLoop(mtn, OPTS))
  const b = JSON.stringify(fitClosedLoop(mtn, OPTS))
  assert.equal(a, b, 'same loop + options must yield identical nodes')
})
