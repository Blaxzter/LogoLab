// The node-edit overlay is a few batched paths and a geometric grab test.
//
//   node --test test/node-overlay.test.ts
//
// It used to be ~9 SVG elements per node. A re-traced page of sheet music is one
// path with 3002 nodes, and selecting it put 27 811 elements on the stage: every
// pan re-rendered all of them (~130 ms a frame) and every zoom rewrote their
// radii. Now the overlay is one <path> per style, and there are no per-node hit
// targets, so what a click grabs is decided by `nearestGrab` alone. These tests
// pin the two things the DOM version got for free: the batched strings draw
// every node exactly once, and a click grabs the thing it is on.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  anchorMarksD,
  handleDotsD,
  nearestGrab,
  spokesD,
} from '../src/components/vectorize/nodeOverlay.ts'
import type { PathItem, PathNode } from '../src/lib/path/types.ts'

const node = (x: number, y: number, kind: PathNode['kind'], hIn: PathNode['hIn'] = null, hOut: PathNode['hOut'] = null): PathNode =>
  ({ x, y, kind, hIn, hOut })

const item = (nodes: PathNode[][]): PathItem => ({
  kind: 'path',
  id: 'p',
  fill: '#000000',
  fillRule: 'nonzero',
  visible: true,
  subPaths: nodes.map((n) => ({ nodes: n, closed: true })),
} as PathItem)

const count = (d: string, ch: string) => d.split(ch).length - 1

test('every anchor is drawn once, smooth as a circle and corner as a square', () => {
  const it = item([
    [node(0, 0, 'corner'), node(10, 0, 'smooth', { x: 8, y: -2 }, { x: 12, y: 2 }), node(10, 10, 'corner')],
    [node(20, 20, 'smooth')],
  ])
  const { smooth, corner } = anchorMarksD(it, 1, 1)
  assert.equal(count(corner, 'M'), 2)
  assert.equal(count(corner, 'z'), 2)
  assert.equal(count(smooth, 'M'), 2)
  assert.equal(count(smooth, 'a'), 4, 'a circle is two arcs')
  // A 1-unit half-side square around (0,0).
  assert.ok(corner.startsWith('M-1 -1h2v2h-2z'), corner)
})

test('the filter draws only the named nodes (selected / hovered layers)', () => {
  const it = item([[node(0, 0, 'corner'), node(5, 0, 'corner'), node(9, 0, 'smooth')]])
  const { smooth, corner } = anchorMarksD(it, 1, 1, new Set(['0:1']))
  assert.equal(count(corner, 'M'), 1)
  assert.equal(smooth, '')
  assert.ok(corner.startsWith('M4 -1'), corner)
})

test('spokes and dots exist only for handles that exist', () => {
  const it = item([[node(0, 0, 'smooth', { x: -1, y: 0 }, null), node(5, 0, 'corner')]])
  assert.equal(spokesD(it), 'M0 0L-1 0')
  assert.equal(count(handleDotsD(it, 0.5), 'M'), 1)
})

test('a click grabs the nearest anchor or handle within reach, and nothing beyond it', () => {
  const it = item([[node(0, 0, 'smooth', { x: -4, y: 0 }, { x: 4, y: 0 }), node(20, 0, 'corner')]])
  assert.equal(nearestGrab(it, { x: 0.5, y: 0.5 }, 2), '0:0')
  assert.equal(nearestGrab(it, { x: 3.8, y: 0.2 }, 2), '0:0:out')
  assert.equal(nearestGrab(it, { x: -3.5, y: 0 }, 2), '0:0:in')
  assert.equal(nearestGrab(it, { x: 19, y: 1 }, 2), '0:1')
  assert.equal(nearestGrab(it, { x: 10, y: 0 }, 2), null)
})

test('an anchor wins a tie with a handle sitting on top of it', () => {
  // A collapsed handle lies exactly on its anchor; the anchor is what people reach for.
  const it = item([[node(0, 0, 'smooth', { x: 0, y: 0 }, { x: 0, y: 0 })]])
  assert.equal(nearestGrab(it, { x: 0.3, y: 0 }, 2), '0:0')
})

test('3000 nodes stay cheap', () => {
  const nodes: PathNode[] = []
  for (let i = 0; i < 3000; i++) nodes.push(node(i, (i * 7) % 50, i % 2 ? 'smooth' : 'corner', { x: i - 0.3, y: 0 }, { x: i + 0.3, y: 0 }))
  const it = item([nodes])
  const t0 = performance.now()
  for (let k = 0; k < 10; k++) {
    anchorMarksD(it, 0.1, 0.1)
    handleDotsD(it, 0.1)
    nearestGrab(it, { x: 1500, y: 3 }, 1)
  }
  // A generous ceiling: this is ~2 ms a round on a laptop; the old overlay was 130 ms a frame.
  assert.ok((performance.now() - t0) / 10 < 40)
})
