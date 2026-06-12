// Unit tests for structure-first segmentation (src/lib/trace/segment.ts).
//
//   node --test test/segment.test.ts
//
// Synthesizes images with known structure and asserts the segmenter (a) keeps
// regions across a true edge separate (𝒜 edge veto), (b) reunites a smooth
// gradient split into colour bands, (c) merges same-colour non-adjacent blobs,
// and (d) does NOT bridge two distinct flats into a fake gradient (profile veto).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { segmentImage, DEFAULT_SEGMENT_OPTIONS } from '../src/lib/trace/segment.ts'

type ColorFn = (x: number, y: number) => [number, number, number, number?]

function img(w: number, h: number, color: ColorFn): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = color(x, y)
      const o = (y * w + x) * 4
      data[o] = r
      data[o + 1] = g
      data[o + 2] = b
      data[o + 3] = a ?? 255
    }
  }
  return { width: w, height: h, data }
}

/** Macro-region count from a segment result. */
const macroCount = (r: { palette: unknown[] }): number => r.palette.length

test('two flat regions across a sharp edge stay separate (edge veto)', () => {
  const W = 64
  const seg = segmentImage(img(W, 48, (x) => (x < W / 2 ? [20, 40, 200] : [220, 60, 40])))
  assert.equal(macroCount(seg), 2, 'a real edge must not be bridged into one region')
  // Both colours are represented (order by count may vary; both halves equal).
  const hasBlue = seg.palette.some((p) => p.b > 150 && p.r < 80)
  const hasRed = seg.palette.some((p) => p.r > 150 && p.b < 80)
  assert.ok(hasBlue && hasRed, 'both flat colours survive as distinct regions')
})

test('a smooth gradient field collapses to ONE region', () => {
  const W = 80
  const seg = segmentImage(img(W, 48, (x) => {
    const v = Math.round((255 * x) / (W - 1))
    return [v, v, v]
  }))
  assert.equal(macroCount(seg), 1, 'a continuous ramp is one macro-region (bands reunited)')
})

test('same-colour non-adjacent blobs merge into one region', () => {
  // White field with two separate black squares far apart.
  const W = 80
  const H = 48
  const seg = segmentImage(img(W, H, (x, y) => {
    const inA = x >= 8 && x < 24 && y >= 8 && y < 40
    const inB = x >= 56 && x < 72 && y >= 8 && y < 40
    return inA || inB ? [10, 10, 10] : [245, 245, 245]
  }))
  assert.equal(macroCount(seg), 2, 'white bg + one merged black region')
})

test('distinct non-adjacent flats are NOT bridged into a fake gradient', () => {
  // White field with a blue square and a red square far apart: a blue→red linear
  // would fit the two clusters with low residual, but its profile is bimodal.
  const W = 80
  const H = 48
  const seg = segmentImage(img(W, H, (x, y) => {
    const inA = x >= 8 && x < 24 && y >= 8 && y < 40
    const inB = x >= 56 && x < 72 && y >= 8 && y < 40
    if (inA) return [30, 60, 220]
    if (inB) return [220, 50, 40]
    return [245, 245, 245]
  }))
  assert.equal(macroCount(seg), 3, 'white bg + blue + red kept distinct (profile veto)')
})

test('deterministic: identical input → identical labels', () => {
  const src = img(56, 56, (x, y) => {
    const v = Math.round((255 * (x + y)) / 110)
    return [v, 100, 255 - v]
  })
  const a = segmentImage(src)
  const b = segmentImage(src)
  assert.equal(a.palette.length, b.palette.length)
  for (let i = 0; i < a.labels.length; i++) assert.equal(a.labels[i], b.labels[i])
})

test('respects custom options object (smoke)', () => {
  const seg = segmentImage(img(40, 40, () => [100, 150, 200]), { ...DEFAULT_SEGMENT_OPTIONS })
  assert.ok(seg.palette.length >= 1)
})
