// Mono is a two-label segmentation now (src/lib/trace/mono.ts), handed to the
// planar tracer like any colour segmentation. What this gates is the map itself:
// the cut, the despeckle contract, and the composited source the planar passes
// read on art over transparency.
//
//   node --test test/mono-labels.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { monoLabels, MONO_INK, MONO_PAPER } from '../src/lib/trace/mono.ts'
import type { ImageDataLike } from '../src/lib/traceInput/ink.ts'

type RGBA = [number, number, number, number]

function canvas(w: number, h: number, bg: RGBA): ImageDataLike {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set(bg, i * 4)
  return { width: w, height: h, data }
}
function rect(img: ImageDataLike, x0: number, y0: number, w: number, h: number, c: RGBA): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) img.data.set(c, (y * img.width + x) * 4)
}
const count = (labels: Int32Array, l: number) => labels.reduce((n, v) => n + (v === l ? 1 : 0), 0)

test('ink and paper, and the means of each', () => {
  const img = canvas(40, 40, [255, 255, 255, 255])
  rect(img, 10, 10, 20, 20, [20, 30, 40, 255])
  const seg = monoLabels(img, 128, false, 1)
  assert.equal(count(seg.labels, MONO_INK), 400)
  assert.equal(seg.inkPixels, 400)
  assert.deepEqual(seg.palette[MONO_INK], { r: 20, g: 30, b: 40 })
  assert.deepEqual(seg.palette[MONO_PAPER], { r: 255, g: 255, b: 255 })
  assert.equal(seg.image.data[3], 255, 'the composited source is opaque')
})

test('despeckle flips ink specks to paper and pinholes to ink, but never a component on the border', () => {
  const img = canvas(60, 60, [255, 255, 255, 255])
  rect(img, 10, 10, 30, 30, [0, 0, 0, 255]) // the shape
  rect(img, 20, 20, 2, 2, [255, 255, 255, 255]) // a 4px pinhole in it
  rect(img, 50, 50, 2, 2, [0, 0, 0, 255]) // a 4px speck beside it
  rect(img, 0, 0, 2, 2, [0, 0, 0, 255]) // a 4px speck ON the border
  const loose = monoLabels(img, 128, false, 1)
  assert.equal(count(loose.labels, MONO_INK), 900 - 4 + 4 + 4, 'floor 1: everything stays')
  const tidy = monoLabels(img, 128, false, 8)
  assert.equal(
    count(tidy.labels, MONO_INK),
    900 + 4,
    'floor 8: the pinhole fills, the speck goes, the border speck stays',
  )
  assert.equal(tidy.labels[0], MONO_INK)
  assert.equal(tidy.labels[50 * 60 + 50], MONO_PAPER)
  assert.equal(tidy.labels[20 * 60 + 20], MONO_INK)
})

test('art over transparency: a coverage cut, and a source composited over the paper', () => {
  const img = canvas(40, 40, [0, 0, 0, 0]) // transparent BLACK, as decoders emit it
  rect(img, 10, 10, 20, 20, [0, 0, 0, 255])
  rect(img, 9, 10, 1, 20, [0, 0, 0, 100]) // a 39% edge column: paper by coverage
  rect(img, 30, 10, 1, 20, [0, 0, 0, 200]) // a 78% edge column: ink by coverage
  const seg = monoLabels(img, 128, false, 1)
  assert.equal(seg.labels[15 * 40 + 9], MONO_PAPER)
  assert.equal(seg.labels[15 * 40 + 30], MONO_INK)
  assert.equal(seg.inkPixels, 420)
  // The planar passes read this; on raw RGB the paper would be black like the ink.
  const o = (15 * 40 + 5) * 4
  assert.deepEqual([...seg.image.data.slice(o, o + 4)], [255, 255, 255, 255], 'transparent paper reads white')
  const e = (15 * 40 + 9) * 4
  assert.ok(seg.image.data[e] > 150 && seg.image.data[e] < 160, 'a 39% pixel reads as the real ramp value')
  // The paper mean includes the anti-aliased column the cut left on the paper side.
  assert.ok(seg.palette[MONO_PAPER].r > 250 && seg.palette[MONO_PAPER].r < 255)
})

test('inverted: light ink on a dark ground, composited over black', () => {
  const img = canvas(40, 40, [0, 0, 0, 0])
  rect(img, 10, 10, 20, 20, [255, 255, 255, 255])
  rect(img, 9, 10, 1, 20, [255, 255, 255, 100])
  const seg = monoLabels(img, 128, true, 1)
  assert.equal(seg.inkPixels, 400, 'the 39% column is paper by coverage')
  assert.ok(
    seg.palette[MONO_PAPER].r > 0 && seg.palette[MONO_PAPER].r < 5,
    'paper is black plus its anti-aliased column',
  )
  assert.deepEqual([...seg.image.data.slice(0, 4)], [0, 0, 0, 255], 'transparent paper reads black')
})
