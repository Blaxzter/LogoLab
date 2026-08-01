// Unit tests for the flat-art palette path (paletteSegment.ts) + its two new
// contracts: (1) the AUTO palette snaps each entry to the DOMINANT EXACT source
// colour (mode), not the k-means mean; (2) a LOCKED palette is used verbatim —
// every pixel snaps to the nearest of the given colours, the count is the user's,
// and traceImage bypasses the automatic flat-vs-photo gates.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { segmentFlatPalette } from '../src/lib/trace/paletteSegment.ts'
import { traceImage } from '../src/lib/trace/index.ts'

ensureImageData()

type Img = { width: number; height: number; data: Uint8ClampedArray }

/** Build a flat image where `fill(x,y)` returns an opaque [r,g,b]. */
function makeImage(w: number, h: number, fill: (x: number, y: number) => [number, number, number]): Img {
  return makeImageA(w, h, (x, y) => [...fill(x, y), 255])
}

/** Build a flat RGBA image where `fill(x,y)` returns [r,g,b,a]. */
function makeImageA(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): Img {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const [r, g, b, a] = fill(x, y)
      data[o] = r
      data[o + 1] = g
      data[o + 2] = b
      data[o + 3] = a
    }
  }
  return { width: w, height: h, data }
}

test('auto palette snaps to the dominant EXACT source colour (mode, not mean)', () => {
  // One region: 60 px of the true design colour (200,50,10) and 40 px of a colour
  // skewed strictly higher (205,55,15). The k-means mean of the cluster rounds to
  // (202,52,12); the MODE is the most frequent exact colour, (200,50,10).
  const img = makeImage(10, 10, (x, y) => (y * 10 + x < 60 ? [200, 50, 10] : [205, 55, 15]))
  const res = segmentFlatPalette(img, { maxColors: 1, minShare: 0, modePasses: 0, minRegionArea: 0 })

  assert.equal(res.palette.length, 1)
  // Lands on the exact mode, NOT the count-weighted mean (202,52,12).
  assert.deepEqual(res.palette[0], { r: 200, g: 50, b: 10 })
  assert.notDeepEqual(res.palette[0], { r: 202, g: 52, b: 12 })
})

test('locked palette is used verbatim; pixels snap to the nearest given colour', () => {
  const img = makeImage(10, 10, (x, y) => (y * 10 + x < 60 ? [200, 50, 10] : [205, 55, 15]))
  const locked = [
    { r: 200, g: 50, b: 10 },
    { r: 0, g: 0, b: 255 }, // matches nothing in the image
  ]
  const res = segmentFlatPalette(img, { maxColors: 16, minShare: 0.006, modePasses: 0, minRegionArea: 0 }, locked)

  // Colours emitted exactly as given (the user owns them) — no extraction, no snap.
  assert.deepEqual(res.palette, locked)
  // Both source colours are nearest to locked[0]; nothing reaches the blue.
  assert.equal(res.counts[0], 100)
  assert.equal(res.counts[1], 0)
  // Every pixel is within tolerance of its assigned flat colour.
  assert.equal(res.flatCoverage, 1)
})

test('traceImage honours a locked palette on flat art (gate bypassed)', async () => {
  // Left half colour A, right half colour B — a clean two-region split.
  const A: [number, number, number] = [240, 16, 32]
  const B: [number, number, number] = [16, 64, 240]
  const img = makeImage(32, 32, (x) => (x < 16 ? A : B))
  const doc = await traceImage(img as unknown as ImageData, {
    mode: 'color',
    smoothing: 50,
    despeckle: 0,
    threshold: 128,
    removeBackground: false,
    gradients: false,
    engine: 'planar',
    palette: [
      { r: A[0], g: A[1], b: A[2] },
      { r: B[0], g: B[1], b: B[2] },
    ],
  })

  const fills = new Set(doc.items.filter((it) => it.kind === 'path').map((it) => (it as { fill: string }).fill))
  assert.deepEqual([...fills].sort(), ['#1040f0', '#f01020'])
})

test('auto path tags each region with its alpha MODE (opaque regions stay alpha-free)', () => {
  // 60 px of half-transparent orange (α128), 40 px of opaque teal (α255).
  const img = makeImageA(10, 10, (x, y) =>
    y * 10 + x < 60 ? [200, 50, 10, 128] : [40, 180, 160, 255],
  )
  const res = segmentFlatPalette(img, { maxColors: 16, minShare: 0.006, modePasses: 0, minRegionArea: 0 })

  assert.equal(res.palette.length, 2)
  // Orange region carries its alpha mode; opaque teal omits alpha entirely.
  assert.deepEqual(res.palette[0], { r: 200, g: 50, b: 10, a: 128 })
  assert.deepEqual(res.palette[1], { r: 40, g: 180, b: 160 })
})

test('locked RGBA palette separates the same hue at two opacities (4-D nearest)', () => {
  // Same RGB, two opacities: 50 px opaque, 50 px half-transparent.
  const img = makeImageA(10, 10, (x, y) =>
    y * 10 + x < 50 ? [200, 50, 10, 255] : [200, 50, 10, 128],
  )
  const locked = [
    { r: 200, g: 50, b: 10 }, // opaque target
    { r: 200, g: 50, b: 10, a: 128 }, // translucent target (same hue)
  ]
  const res = segmentFlatPalette(img, { maxColors: 16, minShare: 0.006, modePasses: 0, minRegionArea: 0 }, locked)

  // RGB alone could not separate them — the alpha axis does.
  assert.equal(res.counts[0], 50)
  assert.equal(res.counts[1], 50)
  assert.equal(res.palette[0].a, undefined)
  assert.equal(res.palette[1].a, 128)
})

test('lowering a swatch alpha keeps its region (hue is RGB-nearest, not RGBA)', () => {
  // Two distinct hues, both at α217 (like Bloom's circles). The user drops the
  // indigo swatch to α64 — its region must STAY indigo, not defect to the same-α cyan.
  const indigo: [number, number, number] = [99, 102, 241]
  const cyan: [number, number, number] = [14, 165, 233]
  const img = makeImageA(10, 10, (x, y) => [...(y * 10 + x < 60 ? indigo : cyan), 217] as [number, number, number, number])
  const locked = [
    { r: indigo[0], g: indigo[1], b: indigo[2], a: 64 }, // alpha lowered hard
    { r: cyan[0], g: cyan[1], b: cyan[2], a: 217 },
  ]
  const res = segmentFlatPalette(img, { maxColors: 16, minShare: 0.006, modePasses: 0, minRegionArea: 0 }, locked)

  assert.equal(res.counts[0], 60) // indigo pixels stayed with the indigo swatch
  assert.equal(res.counts[1], 40)
})

test('traceImage paints a translucent locked colour with fill-opacity', async () => {
  const A: [number, number, number] = [240, 16, 32]
  const B: [number, number, number] = [16, 64, 240]
  const img = makeImage(32, 32, (x) => (x < 16 ? A : B))
  const doc = await traceImage(img as unknown as ImageData, {
    mode: 'color',
    smoothing: 50,
    despeckle: 0,
    threshold: 128,
    removeBackground: false,
    gradients: false,
    engine: 'planar',
    palette: [
      { r: A[0], g: A[1], b: A[2] }, // opaque
      { r: B[0], g: B[1], b: B[2], a: 128 }, // translucent
    ],
  })

  const byFill = new Map(
    doc.items
      .filter((it) => it.kind === 'path')
      .map((it) => [(it as { fill: string }).fill, it as { fillOpacity?: number }]),
  )
  assert.equal(byFill.get('#f01020')?.fillOpacity, undefined) // opaque ⇒ no fill-opacity
  assert.ok(Math.abs((byFill.get('#1040f0')?.fillOpacity ?? 1) - 128 / 255) < 1e-6)
})
