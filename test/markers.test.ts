// Unit tests for user-placed region markers ("seeds") in segmentation
// (src/lib/trace/segment.ts).
//
//   node --test test/markers.test.ts
//
// Marker semantics: a marker = "keep a distinct region here". After the normal
// segmentation, any macro-region that ends up containing ≥2 markers is split by
// SEEDED REGION GROWING — each marker grows a sub-region outward, the boundary
// settling on the colour ridge between them (Adams–Bischof). So markers separate
// regions even when their colours are within the merge threshold, with the
// boundary on the true edge (not a ragged scan-order sliver). With no markers the
// result is byte-identical to before. Markers are normalized [0,1].

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { segmentImage, DEFAULT_SEGMENT_OPTIONS, markerSnapRadius } from '../src/lib/trace/segment.ts'

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

const macroCount = (r: { palette: unknown[] }): number => r.palette.length
const withMarkers = (markers: { x: number; y: number }[]) => ({ ...DEFAULT_SEGMENT_OPTIONS, markers })

test('two markers split one adjacent same-colour region (seeded region growing)', () => {
  // A single solid rectangle is ONE region by default. Two markers inside it must
  // grow into two regions that meet at a watershed and never merge.
  const W = 64
  const H = 40
  const solid = img(W, H, () => [120, 130, 145])
  assert.equal(macroCount(segmentImage(solid)), 1, 'solid field is one region without markers')
  const seg = segmentImage(solid, withMarkers([
    { x: 0.25, y: 0.5 },
    { x: 0.75, y: 0.5 },
  ]))
  assert.equal(macroCount(seg), 2, 'two markers split the solid field into two regions')
})

test('a marker in each of two merging blobs keeps them separate (seeded split of a merged region)', () => {
  // White field with two separate same-colour black squares far apart: the global
  // union-fit merges them into ONE region by default. A marker in each blob makes
  // them distinct (the merge is vetoed) without touching the white background.
  const W = 80
  const H = 48
  const scene: ColorFn = (x, y) => {
    const inA = x >= 8 && x < 24 && y >= 8 && y < 40
    const inB = x >= 56 && x < 72 && y >= 8 && y < 40
    return inA || inB ? [10, 10, 10] : [245, 245, 245]
  }
  assert.equal(macroCount(segmentImage(img(W, H, scene))), 2, 'blobs merge into one region by default')
  const seg = segmentImage(img(W, H, scene), withMarkers([
    { x: 16 / W, y: 24 / H }, // centre of blob A
    { x: 64 / W, y: 24 / H }, // centre of blob B
  ]))
  assert.equal(macroCount(seg), 3, 'white bg + two distinct marked blobs')
})

test('seeded split puts the boundary on the colour edge (no ragged slivers)', () => {
  // Two flat halves whose colours are WITHIN the merge threshold, so they fuse into
  // ONE region by default. A marker in each must split them along the colour edge at
  // the middle — each half ≈ its true area (not a degenerate sliver, the old bug).
  const W = 64
  const H = 40
  const left: [number, number, number] = [120, 130, 145]
  const right: [number, number, number] = [126, 124, 150] // ΔE ≈ 7 < τ_s = 10
  const scene = img(W, H, (x) => (x < W / 2 ? left : right))
  assert.equal(macroCount(segmentImage(scene)), 1, 'the two close halves fuse into one region by default')
  const seg = segmentImage(scene, withMarkers([
    { x: 0.25, y: 0.5 },
    { x: 0.75, y: 0.5 },
  ]))
  assert.equal(seg.palette.length, 2, 'two markers split the fused region into two')
  // Both regions are substantial (a clean edge split is ~half each = 1280 px); the
  // old veto produced a tiny sliver here. Allow generous slack for the edge column.
  const sorted = [...seg.counts].sort((a, b) => a - b)
  assert.ok(sorted[0] > 1000, `smaller region is substantial, got ${sorted[0]} px (sliver would be ≪)`)
  // The boundary is at the colour edge (≈ x=32), not skewed: a left pixel and a
  // right pixel land in different regions.
  assert.notEqual(seg.labels[20 * W + 8], seg.labels[20 * W + 56], 'left and right halves are different regions')
})

test('no markers ⇒ byte-identical labels (additive: empty / undefined are no-ops)', () => {
  const src = img(56, 56, (x, y) => {
    const v = Math.round((255 * (x + y)) / 110)
    return [v, 100, 255 - v]
  })
  const base = segmentImage(src)
  const emptyArr = segmentImage(src, withMarkers([]))
  const explicitUndef = segmentImage(src, { ...DEFAULT_SEGMENT_OPTIONS, markers: undefined })
  assert.equal(emptyArr.palette.length, base.palette.length)
  assert.equal(explicitUndef.palette.length, base.palette.length)
  for (let i = 0; i < base.labels.length; i++) {
    assert.equal(emptyArr.labels[i], base.labels[i])
    assert.equal(explicitUndef.labels[i], base.labels[i])
  }
})

test('deterministic with markers: identical input + markers → identical labels', () => {
  const src = img(64, 48, (x, y) => {
    const inA = x >= 8 && x < 28 && y >= 8 && y < 40
    const inB = x >= 36 && x < 56 && y >= 8 && y < 40
    return inA || inB ? [30, 160, 90] : [240, 240, 240]
  })
  const markers = [{ x: 18 / 64, y: 0.5 }, { x: 46 / 64, y: 0.5 }]
  const a = segmentImage(src, withMarkers(markers))
  const b = segmentImage(src, withMarkers(markers))
  assert.equal(a.palette.length, b.palette.length)
  for (let i = 0; i < a.labels.length; i++) assert.equal(a.labels[i], b.labels[i])
})

test('a marker on a non-smooth pixel snaps to the nearest region (no-op when unreachable)', () => {
  // Marker placed exactly on the sharp edge between two flat halves still anchors
  // to a real segment (the nearest smooth pixel), so it never silently vanishes.
  const W = 64
  const seg = segmentImage(
    img(W, 48, (x) => (x < W / 2 ? [20, 40, 200] : [220, 60, 40])),
    withMarkers([{ x: 0.5, y: 0.5 }]),
  )
  // One marker can't split anything (it takes two different markers to veto a
  // merge); the natural two-flats result is unchanged.
  assert.equal(macroCount(seg), 2, 'a single marker on an edge leaves the two flats intact')
})

// --- issue #14: the snap radius is a fraction of the image, not 64px ------------------
// Markers arrive in NORMALIZED coordinates, so the same hand-placed marker must reach the
// same artwork at every raster. The old absolute 64px was 12.5% of the image at the lab's
// 512 and 3% at the app's 2048 — a marker that snapped in the lab silently no-op'd on
// export. 512 stays byte-identical; the floor is a sensor number.
test('marker snap radius scales with the image (byte-identical at 512)', () => {
  assert.equal(markerSnapRadius(512, 512), 64)
  assert.equal(markerSnapRadius(1024, 768), 128)
  assert.equal(markerSnapRadius(2048, 2048), 256)
  assert.equal(markerSnapRadius(256, 256), 32)
  assert.equal(markerSnapRadius(40, 40), 8, 'floor: a few px of discontinuity band at any raster')
  assert.equal(markerSnapRadius(4, 4), 4, 'never past the image itself')
})
