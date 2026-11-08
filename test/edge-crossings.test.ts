// Crossing shared edges (src/lib/trace/edgeCrossings.ts), and the boundary solve's promise that it
// adds none (planarSolve.ts): on aurora's posterized ramp it once pressed a 1 px band between two
// purples until its two sides crossed, and the page showed through a white hairline.
//
//   node --test test/edge-crossings.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PathNode, SharedEdge } from '../src/lib/path/types.ts'
import { crossingKey, edgeCrossings } from '../src/lib/trace/edgeCrossings.ts'
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
