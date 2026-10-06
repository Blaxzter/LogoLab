// The "How it works" explainer (PipelineExplainer) shows the region map and count of the
// segmentation the trace ACTUALLY ran (src/lib/trace/explainStages.ts). It used to always
// run the Mumford–Shah segmenter, so flat art with gradients off — palette-first in the
// real trace — and every mono image showed regions the output never had.
//
// The drift gate here is `explainSegmenter` against traceImage itself: on the palette
// path traceImage hands `onPreMerge` the palette segmenter's own labels, so they match
// byte for byte exactly when the two agree on which segmenter ran.
//
//   node --test test/explain-stages.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../bench/nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS, paletteOptionsFor } from '../src/lib/trace/index.ts'
import { segmentFlatPalette } from '../src/lib/trace/paletteSegment.ts'
import { analyzeStages, explainSegmenter } from '../src/lib/trace/explainStages.ts'
import type { VectorizeOptions } from '../src/types.ts'

ensureImageData()

type RGB = [number, number, number]

/** A white page with filled rectangles, hard-edged. */
function page(w: number, h: number, rects: [number, number, number, number, RGB][]): ImageData {
  const img = new ImageData(w, h)
  img.data.fill(255)
  for (const [x0, y0, rw, rh, c] of rects)
    for (let y = y0; y < y0 + rh; y++)
      for (let x = x0; x < x0 + rw; x++) {
        const o = (y * w + x) * 4
        img.data[o] = c[0]
        img.data[o + 1] = c[1]
        img.data[o + 2] = c[2]
      }
  return img
}

const flatIcon = () =>
  page(96, 96, [
    [12, 12, 30, 30, [220, 40, 40]],
    [52, 52, 32, 32, [30, 80, 210]],
  ])

/** A 6×6 grid of distinct colours — flat, but too many inks for the palette gate. */
function richGrid(): ImageData {
  const rects: [number, number, number, number, RGB][] = []
  for (let j = 0; j < 6; j++)
    for (let i = 0; i < 6; i++) rects.push([i * 16, j * 16, 16, 16, [i * 45 + 10, j * 45 + 10, ((i + j) * 23) % 255]])
  return page(96, 96, rects)
}

const flat: VectorizeOptions = { ...DEFAULT_VECTORIZE_OPTIONS, gradients: false }
const filled = (svg: string): number => (svg.match(/<path\b/g) ?? []).length

test('explain: flat art with gradients off shows the PALETTE map the trace used', async () => {
  const img = flatIcon()
  assert.equal(explainSegmenter(img, flat), 'palette')
  let preMerge: Int32Array | null = null
  await traceImage(img, flat, undefined, undefined, (pm) => {
    preMerge = pm.labels
  })
  const fp = segmentFlatPalette(img, paletteOptionsFor(flat))
  assert.deepEqual(preMerge, fp.labels, 'traceImage ran the palette segmenter')

  const a = await analyzeStages(img, flat)
  assert.equal(a.segmenter, 'palette')
  assert.equal(a.smoothed, null, 'no smoothing stage on the palette path')
  assert.equal(a.regionCount, 3, 'white + red + blue')
  assert.equal(a.regionCount, filled(a.svg), 'one shape per region, as the explainer claims')
  assert.equal(a.paints.filter(Boolean).length, a.regionCount)
})

test('explain: art the flat gate refuses is explained by the smoothness segmenter', async () => {
  const img = richGrid()
  assert.equal(explainSegmenter(img, flat), 'smooth')
  let preMerge: Int32Array | null = null
  await traceImage(img, flat, undefined, undefined, (pm) => {
    preMerge = pm.labels
  })
  const fp = segmentFlatPalette(img, paletteOptionsFor(flat))
  assert.notDeepEqual(preMerge, fp.labels, 'traceImage fell through to the smoothness segmenter')

  const a = await analyzeStages(img, flat)
  assert.ok(a.smoothed && a.disc, 'smoothing stage shown')
})

test('explain: mono shows the two-label ink cut', async () => {
  const img = flatIcon()
  const mono: VectorizeOptions = { ...DEFAULT_VECTORIZE_OPTIONS, mode: 'mono' }
  const a = await analyzeStages(img, mono)
  assert.equal(a.segmenter, 'ink')
  assert.equal(a.smoothed, null)
  assert.equal(a.regionCount, 2, 'ink and paper')
})

test('explain: gradients on keeps the smoothness segmenter', async () => {
  const a = await analyzeStages(flatIcon(), { ...DEFAULT_VECTORIZE_OPTIONS, gradients: true })
  assert.equal(a.segmenter, 'smooth')
  assert.ok(a.smoothed && a.disc)
  assert.equal(a.regionCount, a.paints.filter(Boolean).length)
})
