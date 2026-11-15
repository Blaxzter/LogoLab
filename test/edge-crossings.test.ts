// Crossing shared edges (src/lib/trace/edgeCrossings.ts), and the boundary solve's promise that it
// adds none (planarSolve.ts): on aurora's posterized ramp it once pressed a 1 px band between two
// purples until its two sides crossed, and the page showed through a white hairline.
//
//   node --test test/edge-crossings.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PathNode, SharedEdge } from '../src/lib/path/types.ts'
import { crossingKey, crossingSites, edgeCrossings, edgeEars } from '../src/lib/trace/edgeCrossings.ts'
import { trimEars } from '../src/lib/trace/planarSolve.ts'
import { DEFAULT_VECTORIZE_OPTIONS, traceImage } from '../src/lib/trace/index.ts'
import { ensureImageData, loadPng } from '../bench/nodeHarness.ts'

ensureImageData()

const corner = (x: number, y: number): PathNode => ({ x, y, hIn: null, hOut: null, kind: 'corner' })
const open = (
  id: number,
  nodes: PathNode[],
  startVertex: number | null = null,
  endVertex: number | null = null,
): SharedEdge => ({
  id,
  nodes,
  closed: false,
  startVertex,
  endVertex,
})
/** One cubic from a to b with handles h1, h2. */
const cubic = (
  id: number,
  a: [number, number],
  h1: [number, number],
  h2: [number, number],
  b: [number, number],
): SharedEdge =>
  open(id, [
    { x: a[0], y: a[1], hIn: null, hOut: { x: h1[0], y: h1[1] }, kind: 'smooth' },
    { x: b[0], y: b[1], hIn: { x: h2[0], y: h2[1] }, hOut: null, kind: 'smooth' },
  ])

test('two lines crossing are found; two meeting at a shared end are a junction', () => {
  const x = [open(3, [corner(0, 0), corner(10, 10)]), open(7, [corner(0, 10), corner(10, 0)])]
  assert.deepEqual([...edgeCrossings(x)], [crossingKey(3, 7)])
  assert.equal(crossingKey(7, 3), '3:7')
  const v = [open(1, [corner(0, 0), corner(5, 5)], null, 9), open(2, [corner(5, 5), corner(10, 0)], 9, null)]
  assert.equal(edgeCrossings(v).size, 0)
})

test('an edge that crosses itself is found once, under its own id twice', () => {
  // A figure eight as one closed edge.
  const eight: SharedEdge = {
    id: 4,
    closed: true,
    startVertex: null,
    endVertex: null,
    nodes: [corner(0, 0), corner(10, 10), corner(10, 0), corner(0, 10)],
  }
  assert.deepEqual([...edgeCrossings([eight])], ['4:4'])
  // A plain square does not.
  const square: SharedEdge = { ...eight, nodes: [corner(0, 0), corner(10, 0), corner(10, 10), corner(0, 10)] }
  assert.equal(edgeCrossings([square]).size, 0)
})

test('a fishtail at a corner is not a crossing; a loop the size of a pixel is', () => {
  // A square whose right side runs `over` px past the bottom before turning back onto it: the
  // ear between them is over²/2 px². The solve leaves ones like it where it moves a corner past
  // its own handle; counted, they held whole letter outlines on the pixel grid.
  const square = (over: number): SharedEdge => ({
    id: 7,
    nodes: [corner(0, 0), corner(10, 0), corner(10, 10 + over), corner(10 + over, 10), corner(0, 10)],
    closed: true,
    startVertex: null,
    endVertex: null,
  })
  assert.equal(edgeCrossings([square(0.4)]).size, 0, 'an ear of 0.08 px²')
  assert.deepEqual([...edgeCrossings([square(2)])], ['7:7'], 'an ear of 2 px²')
  // A sliver 40 px long pressed until its sides cross in the middle: two loops of 0.4 px² each,
  // but neither is an ear at a corner (Instagram's white gap, twisted shut by the solve).
  const twisted: SharedEdge = {
    ...square(0),
    nodes: [corner(0, 0.02), corner(40, -0.02), corner(40, 0.02), corner(0, -0.02)],
  }
  assert.deepEqual([...edgeCrossings([twisted])], ['7:7'], 'a sliver twisted shut')
})

test('a curve bowing across a line crosses it; one bowing a fifth of a pixel short does not', () => {
  const line = open(1, [corner(0, 5), corner(40, 5)])
  /** A cubic over the chord y = `from` whose top reaches y = `peak` (its sagitta is 3/4 of the
   *  handles' offset when both sit at one height). */
  const bow = (from: number, peak: number): SharedEdge => {
    const hy = from + (peak - from) / 0.75
    return cubic(2, [0, from], [13, hy], [27, hy], [40, from])
  }
  assert.equal(edgeCrossings([line, bow(4, 5.4)]).size, 1, '0.4 px across')
  assert.equal(edgeCrossings([line, bow(4, 5.05)]).size, 1, 'a twentieth of a pixel across')
  assert.equal(edgeCrossings([line, bow(3, 4.8)]).size, 0, '0.2 px short of it all along')
})

test('a crossing names the curve it lies on, once per pair of curves', () => {
  // A three-curve polyline crossed by a vertical line through its middle curve, twice over (the
  // line runs down, then back up a little further on): the solve holds those curves, not edge 5.
  const zig = open(5, [corner(0, 0), corner(10, 0), corner(20, 0), corner(30, 0)])
  const cut = open(6, [corner(15, -5), corner(15, 5), corner(17, 5), corner(17, -5)])
  const sites = crossingSites([zig, cut])
  assert.deepEqual(
    sites.map((s) => [s.key, s.a, s.b]).sort((p, q) => p[2].seg - q[2].seg),
    [
      ['5:6', { edge: 0, seg: 1 }, { edge: 1, seg: 0 }],
      ['5:6', { edge: 0, seg: 1 }, { edge: 1, seg: 2 }],
    ],
  )
  assert.deepEqual([...edgeCrossings([zig, cut])], ['5:6'], 'the edge pairs are what they were')
})

test('a fishtail is cut off at the crossing, and nothing else on the edge moves', () => {
  // A triangle whose top corner overshoots: the outline runs up y = x to (10, 10), steps back
  // to (9.4, 10) and crosses its own way up 0.4 px short of the corner. An ear of 0.09 px²,
  // which edgeCrossings lets through, and which an outline view shows as a bow tie.
  const at = 0.6 / 20.6
  const tip = 9.4 + 10.6 * at
  const ring = [corner(0, 0), corner(10, 10), corner(9.4, 10), corner(20, 0)]
  // Rotated so the ear holds the closed edge's first node: the ear wraps round its end.
  for (const start of [0, 1]) {
    const nodes = [...ring.slice(start), ...ring.slice(0, start)].map((n) => ({ ...n }))
    const e: SharedEdge = { id: 3, nodes, closed: true, startVertex: null, endVertex: null }
    assert.equal(edgeCrossings([e]).size, 0, 'a fishtail is no crossing')
    const ears = edgeEars([e])
    assert.equal(ears.length, 1)
    assert.equal(ears[0].wraps, start === 1)
    assert.ok(Math.hypot(ears[0].at.x - tip, ears[0].at.y - tip) < 1e-9)
    assert.equal(trimEars([e]), 1)
    const want =
      start === 0
        ? [
            [0, 0],
            [tip, tip],
            [20, 0],
          ]
        : [
            [20, 0],
            [0, 0],
            [tip, tip],
          ]
    assert.equal(e.nodes.length, 3)
    e.nodes.forEach((n, i) => assert.ok(Math.hypot(n.x - want[i][0], n.y - want[i][1]) < 1e-9, `node ${i}`))
    assert.ok(
      e.nodes.every((n) => n.hIn === null && n.hOut === null),
      'its sides stay lines',
    )
    assert.equal(edgeEars([e]).length, 0)
  }
})

test('a fishtail inside one curve is cut there, with a node where it crossed', () => {
  // One cubic whose handles cross over: it loops on itself in its middle (a cusp pulled past).
  const e = cubic(4, [0, 0], [22, 0.6], [-2, 0.6], [20, 0])
  const before = edgeEars([e])
  assert.equal(before.length, 1, 'a loop of a fraction of a pixel inside one curve')
  assert.equal(before[0].into.seg, 0)
  assert.equal(before[0].outOf.seg, 0)
  assert.equal(trimEars([e]), 1)
  assert.equal(e.nodes.length, 3)
  assert.equal(e.nodes[1].kind, 'corner')
  assert.deepEqual([e.nodes[0].x, e.nodes[0].y, e.nodes[2].x, e.nodes[2].y], [0, 0, 20, 0], 'its ends stay')
  assert.equal(edgeEars([e]).length, 0)
  assert.equal(edgeCrossings([e]).size, 0)
})

test('`only` limits the search to pairs touching the edges named', () => {
  const edges = [
    open(1, [corner(0, 0), corner(10, 10)]),
    open(2, [corner(0, 10), corner(10, 0)]),
    open(3, [corner(20, 0), corner(30, 10)]),
    open(4, [corner(20, 10), corner(30, 0)]),
  ]
  assert.equal(edgeCrossings(edges).size, 2)
  assert.deepEqual([...edgeCrossings(edges, new Set([4]))], ['3:4'])
})

test('the boundary solve adds no crossing (aurora: a 1 px band between two purples)', async () => {
  const img = loadPng('test/fixtures/aurora-512.png') as unknown as ImageData
  const opts = { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar' as const, gradients: false }
  const off = await traceImage(img, { ...opts, planarFit: { boundarySolve: false } })
  const on = await traceImage(img, opts)
  const before = edgeCrossings(off.topology!.edges)
  const fresh = [...edgeCrossings(on.topology!.edges)].filter((k) => !before.has(k))
  assert.deepEqual(fresh, [], 'crossings the solve made')
})
