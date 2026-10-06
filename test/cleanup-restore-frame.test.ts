// The Restore brush / Keep marker after Auto-trim read pristine through the
// working buffer's ORIGIN (src/components/cleanup/restoreFrame.ts):
//
//   node --test test/cleanup-restore-frame.test.ts
//
// Before, the brush indexed the full-size pristine with the TRIMMED buffer's
// stride, so restoring working (2,2) after a 10×10 crop at (5,5) wrote pristine
// (2,1) instead of (7,7) — a sheared restore.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../bench/nodeHarness.ts'
import { brushStamp, cropPad, floodRestore } from '../src/lib/cleanup/bgRemove.ts'
import { alignedSource, NO_ORIGIN, pristineFrame, trimmedOrigin } from '../src/components/cleanup/restoreFrame.ts'

ensureImageData()

/** A w×h image whose pixel (x,y) is [x, y, 0, 255]: every pixel names its place. */
function coords(w: number, h: number): ImageData {
  const out = new ImageData(w, h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.data.set([x, y, 0, 255], (y * w + x) * 4)
  return out
}

const px = (img: ImageData, x: number, y: number) =>
  Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4))

test('restore after a trim reads the pixel that was really there', () => {
  const pristine = coords(20, 20)
  const bounds = { x: 5, y: 5, w: 10, h: 10 }
  const working = cropPad(pristine, bounds, 0)
  const origin = trimmedOrigin(NO_ORIGIN, bounds, 0)
  working.data.fill(0) // erased
  const src = alignedSource(pristine, origin, working.width, working.height)
  assert.ok(brushStamp(working, 2, 2, 0.5, 1, 'restore', src) > 0)
  assert.deepEqual(px(working, 2, 2), [7, 7, 0, 255])
})

test('a padded trim aligns too, and the pad reads as transparent', () => {
  const pristine = coords(20, 20)
  const bounds = { x: 0, y: 3, w: 20, h: 10 }
  const pad = 4
  const working = cropPad(pristine, bounds, pad) // 28×18, wider than pristine
  const origin = trimmedOrigin(NO_ORIGIN, bounds, pad)
  assert.deepEqual(origin, { ox: -4, oy: -1 })
  const src = alignedSource(pristine, origin, working.width, working.height)
  assert.equal(src.width, 28)
  assert.deepEqual(px(src, 4 + 9, 4 + 2), [9, 5, 0, 255])
  assert.deepEqual(px(src, 1, 6), [0, 0, 0, 0])
  // Inside the crop, the source is exactly what cropPad put there.
  for (let y = pad; y < pad + bounds.h; y++)
    for (let x = pad; x < pad + bounds.w; x++) assert.deepEqual(px(src, x, y), px(working, x, y))
})

test('trims compose: a second trim offsets from the first', () => {
  const pristine = coords(30, 30)
  const a = { x: 4, y: 6, w: 20, h: 20 }
  const w1 = cropPad(pristine, a, 2)
  const o1 = trimmedOrigin(NO_ORIGIN, a, 2)
  const b = { x: 3, y: 1, w: 10, h: 10 }
  const w2 = cropPad(w1, b, 0)
  const o2 = trimmedOrigin(o1, b, 0)
  assert.deepEqual(o2, { ox: 5, oy: 5 })
  const src = alignedSource(pristine, o2, w2.width, w2.height)
  // The source is pristine at the composed offset — including where the working
  // buffer holds the first trim's transparent pad (that pad sat over real pixels).
  for (let y = 0; y < w2.height; y++)
    for (let x = 0; x < w2.width; x++) assert.deepEqual(px(src, x, y), [x + 5, y + 5, 0, 255])
  assert.deepEqual(px(w2, 4, 4), px(src, 4, 4))
})

test('the Keep marker works after a trim instead of silently doing nothing', () => {
  const pristine = coords(20, 20)
  const bounds = { x: 5, y: 5, w: 10, h: 10 }
  const working = cropPad(pristine, bounds, 0)
  working.data.fill(0)
  const src = alignedSource(pristine, trimmedOrigin(NO_ORIGIN, bounds, 0), 10, 10)
  assert.ok(floodRestore(working, src, 3, 3, { tolerance: 1, softness: 0 }) > 0)
  assert.deepEqual(px(working, 3, 3), [8, 8, 0, 255])
})

test('untrimmed: pristine itself is the source (no copy)', () => {
  const pristine = coords(8, 8)
  assert.equal(alignedSource(pristine, NO_ORIGIN, 8, 8), pristine)
})

test('the overlay ghost covers the pristine frame, offset by the origin', () => {
  assert.deepEqual(pristineFrame({ ox: 5, oy: 10 }, { w: 20, h: 40 }, { w: 10, h: 20 }), {
    left: '-50%',
    top: '-50%',
    width: '200%',
    height: '200%',
  })
  assert.deepEqual(pristineFrame(NO_ORIGIN, { w: 10, h: 10 }, { w: 10, h: 10 }), {
    left: '0%',
    top: '0%',
    width: '100%',
    height: '100%',
  })
})
