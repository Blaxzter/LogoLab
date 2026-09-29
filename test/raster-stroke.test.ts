// The pure rasterizer paints STROKES now (src/lib/render/raster.ts), because the
// fidelity score and the Difference view render `derivedDoc`, and a centreline trace is
// stroked paths. What this pins: a stroke's coverage is its outline (width, caps, joins),
// a stroke-only path (`fill: 'none'`) paints no fill, and the union at a join never
// double-counts.
//
//   node --test test/raster-stroke.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rasterizeDoc } from '../src/lib/render/raster.ts'
import type { EditableDoc, PathItem, PathNode } from '../src/lib/path/types.ts'

const node = (x: number, y: number): PathNode => ({ x, y, hIn: null, hOut: null, kind: 'corner' })
const stroke = (
  id: string,
  nodes: PathNode[],
  width: number,
  cap: 'butt' | 'round' | 'square' = 'butt',
  join: 'miter' | 'round' | 'bevel' = 'miter',
  closed = false,
): PathItem => ({
  kind: 'path',
  id,
  fill: 'none',
  fillRule: 'nonzero',
  subPaths: [{ nodes, closed }],
  stroke: { color: '#000000', width, cap, join },
  visible: true,
})
const doc = (items: PathItem[]): EditableDoc => ({ viewBox: [0, 0, 64, 64], items })
const px = (buf: Uint8ClampedArray, x: number, y: number): number => buf[(y * 64 + x) * 4]
const inkCount = (buf: Uint8ClampedArray): number => {
  let n = 0
  for (let i = 0; i < 64 * 64; i++) if (buf[i * 4] < 128) n++
  return n
}

test('a horizontal butt stroke paints exactly its width, and nothing past its ends', () => {
  const buf = rasterizeDoc(doc([stroke('h', [node(10, 32), node(50, 32)], 8)]), 64, 64)
  // Rows 28..35 inside, 27 and 36 outside, at x=30.
  assert.equal(px(buf, 30, 28), 0)
  assert.equal(px(buf, 30, 35), 0)
  assert.equal(px(buf, 30, 27), 255)
  assert.equal(px(buf, 30, 36), 255)
  // Butt caps: x=9 and x=50 are paper.
  assert.equal(px(buf, 9, 32), 255)
  assert.equal(px(buf, 50, 32), 255)
  assert.equal(inkCount(buf), 40 * 8)
})

test('round and square caps extend the stroke by half its width', () => {
  const round = rasterizeDoc(doc([stroke('r', [node(10, 32), node(50, 32)], 8, 'round')]), 64, 64)
  const square = rasterizeDoc(doc([stroke('s', [node(10, 32), node(50, 32)], 8, 'square')]), 64, 64)
  // Square: 4 px past each end at full width.
  assert.equal(px(square, 52, 28), 0)
  assert.equal(px(square, 7, 35), 0)
  assert.equal(inkCount(square), 48 * 8)
  // Round: the tip is ink at the centre row, paper at the corners of the square cap.
  assert.equal(px(round, 52, 32), 0)
  assert.equal(px(round, 53, 28), 255)
  const disc = Math.PI * 16 // two half-discs of r=4
  assert.ok(Math.abs(inkCount(round) - (40 * 8 + disc)) <= 6, `round caps ${inkCount(round)} px`)
})

test('a stroke-only path paints no fill, and a joined L has no hole at the corner', () => {
  const buf = rasterizeDoc(doc([stroke('L', [node(10, 10), node(50, 10), node(50, 50)], 8, 'butt', 'round')]), 64, 64)
  // Inside the L's corner region (the overlap of the two quads + the round join): ink.
  assert.equal(px(buf, 48, 12), 0)
  assert.equal(px(buf, 52, 8), 0) // the round join reaches past the outer corner
  // The interior of the L is paper (no fill).
  assert.equal(px(buf, 30, 30), 255)
  // A bevel join does not reach the outer corner; a miter does.
  const bevel = rasterizeDoc(doc([stroke('b', [node(10, 10), node(50, 10), node(50, 50)], 8, 'butt', 'bevel')]), 64, 64)
  const miter = rasterizeDoc(doc([stroke('m', [node(10, 10), node(50, 10), node(50, 50)], 8, 'butt', 'miter')]), 64, 64)
  assert.equal(px(bevel, 53, 6), 255)
  assert.equal(px(miter, 53, 6), 0)
})

test('a closed stroked square is a hollow frame; a filled path with a stroke paints both', () => {
  const frame = rasterizeDoc(
    doc([stroke('f', [node(16, 16), node(48, 16), node(48, 48), node(16, 48)], 6, 'butt', 'miter', true)]),
    64,
    64,
  )
  assert.equal(px(frame, 32, 32), 255)
  assert.equal(px(frame, 16, 32), 0)
  assert.equal(px(frame, 47, 17), 0) // the closing segment's miter corner
  const both: PathItem = {
    kind: 'path',
    id: 'b',
    fill: '#ff0000',
    fillRule: 'nonzero',
    subPaths: [{ closed: true, nodes: [node(16, 16), node(48, 16), node(48, 48), node(16, 48)] }],
    stroke: { color: '#0000ff', width: 4, cap: 'butt', join: 'miter' },
    visible: true,
  }
  const buf = rasterizeDoc(doc([both]), 64, 64)
  // Interior red, edge blue.
  assert.deepEqual([buf[(32 * 64 + 32) * 4], buf[(32 * 64 + 32) * 4 + 2]], [255, 0])
  assert.deepEqual([buf[(32 * 64 + 16) * 4], buf[(32 * 64 + 16) * 4 + 2]], [0, 255])
})
