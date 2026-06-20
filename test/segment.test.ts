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

test('a thin all-discontinuity mark on transparency is never dropped (labelled -1)', () => {
  // A filled blob (provides smooth seeds, S>0) PLUS a 1px stroke + 1px dot far
  // away on transparency. Every pixel of the thin features is a discontinuity
  // (borders transparency), so they get no smooth seed and the flood can't reach
  // them — they must instead be seeded as their own macro-region, not emitted as
  // the transparent sentinel −1 (which the tracer would silently drop).
  const W = 64
  const H = 64
  const seg = segmentImage(img(W, H, (x, y) => {
    const inBlob = x >= 6 && x < 26 && y >= 6 && y < 26 // 20×20 filled blob
    const inStroke = x === 50 && y >= 8 && y < 56 // 1px vertical stroke
    const inDot = x >= 44 && x < 46 && y >= 44 && y < 46 // tiny 2×2 mark
    if (inBlob) return [200, 40, 40, 255]
    if (inStroke) return [20, 20, 200, 255]
    if (inDot) return [20, 160, 60, 255]
    return [0, 0, 0, 0] // transparent
  }))
  let lostOpaque = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inBlob = x >= 6 && x < 26 && y >= 6 && y < 26
      const inStroke = x === 50 && y >= 8 && y < 56
      const inDot = x >= 44 && x < 46 && y >= 44 && y < 46
      const opaque = inBlob || inStroke || inDot
      if (opaque && seg.labels[y * W + x] < 0) lostOpaque++
    }
  }
  assert.equal(lostOpaque, 0, `no opaque pixel may be dropped as -1, lost ${lostOpaque}`)
  // The stroke must survive as a distinct (blue) region somewhere in the palette.
  const hasBlue = seg.palette.some((p) => p.b > 140 && p.r < 90)
  assert.ok(hasBlue, 'the isolated blue stroke survives as its own macro-region')
})

test('respects custom options object (smoke)', () => {
  const seg = segmentImage(img(40, 40, () => [100, 150, 200]), { ...DEFAULT_SEGMENT_OPTIONS })
  assert.ok(seg.palette.length >= 1)
})

// --- small-region merge (Despeckle → minRegionArea), the sliver fix -----------

// Three vertical bands — big blue | mid green sliver | big red — with gradients OFF
// so the bands posterize instead of fusing. Areas: blue/red ≈ 2400px², green ≈
// 1200px². This is the "miniature region at a colour transition" the merge targets.
const slivers = (minRegionArea: number) =>
  segmentImage(
    img(100, 60, (x) => (x < 40 ? [0, 0, 255] : x < 60 ? [0, 220, 0] : [255, 0, 0])),
    { ...DEFAULT_SEGMENT_OPTIONS, mergeGradients: false, minRegionArea },
  )

test('minRegionArea absorbs a sub-threshold sliver into its nearest-colour neighbour', () => {
  // A 1800px² threshold absorbs the green sliver (≈1200) but not blue/red (≈2400).
  const merged = slivers(1800)
  assert.equal(macroCount(merged), 2, 'the green sliver is absorbed; blue + red remain')

  // Exact tiling preserved: every pixel keeps a valid label, exactly 2 distinct ids.
  const ids = new Set<number>()
  for (const l of merged.labels) {
    assert.ok(l >= 0, 'no pixel may be dropped by the merge')
    ids.add(l)
  }
  assert.equal(ids.size, 2)

  // The sliver colour no longer owns a region (its pixels were recoloured).
  const hasGreen = merged.palette.some((p) => p.g > 150 && p.r < 90 && p.b < 90)
  assert.ok(!hasGreen, 'the green sliver colour no longer has its own region')
})

test('minRegionArea below every region is a no-op (sliver survives, labels unchanged)', () => {
  const off = slivers(0)
  const sub = slivers(600) // below the green sliver's ≈1200px²
  assert.equal(macroCount(off), 3, 'all three bands survive with no merge')
  assert.equal(macroCount(sub), 3, 'a sub-everything threshold merges nothing')
  for (let i = 0; i < off.labels.length; i++) assert.equal(sub.labels[i], off.labels[i])
})

test('minRegionArea merge is deterministic', () => {
  const a = slivers(1800)
  const b = slivers(1800)
  assert.equal(a.palette.length, b.palette.length)
  for (let i = 0; i < a.labels.length; i++) assert.equal(a.labels[i], b.labels[i])
})
