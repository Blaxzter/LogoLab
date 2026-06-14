// Integration tests for V6 translucent decomposition through the full pipeline
// (traceImage + markers), scored with the harness rasterizer.
//
//   node --test test/layers-integration.test.ts
//
//  - bloom WITH overlap regions present (markers + Region detail) decomposes to a
//    few translucent circles that beat the opaque bands on meanΔE AND path count.
//  - an image with NO translucent structure, even WITH markers, is byte-identical
//    whether layeredDecomposition is on or off (the gate falls back) — the
//    additive / no-regression guarantee.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { SYNTHETIC_CORPUS, syntheticSource } from '../src/devtest/lineArtCorpus.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { scoreDoc } from '../src/devtest/scoreboard.ts'
import { hashDoc } from '../src/devtest/metrics.ts'
import { rasterizeDoc } from '../src/lib/render/raster.ts'
import { ellipseSubPaths } from '../src/lib/path/model.ts'
import type { EditableDoc, PathItem } from '../src/lib/path/types'
import type { VectorizeOptions } from '../src/types'

ensureImageData()

// A small (fast to segment) bloom: three translucent circles over white. Same
// geometry/colours as the 512² corpus bloom, scaled to W so the high-Region-detail
// segmentation the decomposition needs stays quick under `node --test`.
const W = 200
function bloomSource() {
  const k = W / 512
  const circle = (cx: number, cy: number, fill: string): PathItem => ({
    kind: 'path', id: fill, fill, fillRule: 'nonzero', fillOpacity: 0.85,
    subPaths: [ellipseSubPaths(cx * k, cy * k, 104 * k, 104 * k)![0]], visible: true,
  })
  const doc: EditableDoc = { viewBox: [0, 0, W, W], items: [circle(256, 172, '#6366f1'), circle(166, 330, '#ec4899'), circle(346, 330, '#0ea5e9')] }
  return { width: W, height: W, data: rasterizeDoc(doc, W, W) }
}
// 3 circles, 3 pairwise overlaps (no triple). Markers at each region centre + a
// raised Region detail so the overlap colours survive as their own regions.
const bloomMarkers = [
  { x: 256 / 512, y: 90 / 512 }, { x: 110 / 512, y: 350 / 512 }, { x: 402 / 512, y: 350 / 512 },
  { x: 211 / 512, y: 251 / 512 }, { x: 301 / 512, y: 251 / 512 }, { x: 256 / 512, y: 330 / 512 },
]

test('bloom: translucent decomposition beats opaque bands (fewer paths, lower meanΔE)', async () => {
  const src = bloomSource()
  const base: VectorizeOptions = { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'crisp', markers: bloomMarkers, regionDetail: 95 }
  const opaque = await traceImage(src as unknown as ImageData, { ...base, layeredDecomposition: false })
  const trans = await traceImage(src as unknown as ImageData, { ...base, layeredDecomposition: true })
  const so = scoreDoc(src, opaque)
  const st = scoreDoc(src, trans)
  // bg + 3 translucent circles = 4 paths, far fewer than the opaque bands.
  assert.equal(st.paths, 4, `expected bg + 3 circles, got ${st.paths} paths`)
  assert.ok(st.paths < so.paths, `translucent (${st.paths}) must use fewer paths than opaque (${so.paths})`)
  assert.ok(st.meanDeltaE < so.meanDeltaE, `translucent meanΔE (${st.meanDeltaE}) must beat opaque (${so.meanDeltaE})`)
  assert.ok(st.ssim >= so.ssim, `translucent SSIM (${st.ssim}) ≥ opaque (${so.ssim})`)
  // Three of the four items are translucent (fill-opacity < 1).
  const translucentItems = trans.items.filter((it) => it.kind === 'path' && it.fillOpacity !== undefined && it.fillOpacity < 1)
  assert.equal(translucentItems.length, 3, 'three translucent circles emitted')
})

test('bloom: decomposition is deterministic (byte-identical re-run)', async () => {
  const src = bloomSource()
  const opts: VectorizeOptions = { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'crisp', markers: bloomMarkers, regionDetail: 95, layeredDecomposition: true }
  const a = await traceImage(src as unknown as ImageData, opts)
  const b = await traceImage(src as unknown as ImageData, opts)
  assert.equal(hashDoc(a), hashDoc(b))
})

test('no translucent structure (summit) + markers: layeredDecomposition on ≡ off (byte-identical)', async () => {
  const src = syntheticSource(SYNTHETIC_CORPUS.find((c) => c.name === 'summit')!)
  // Markers placed on the mountain mark — but summit has no overlap structure, so
  // the decomposition must not fire and the output must be byte-identical.
  const base: VectorizeOptions = {
    ...DEFAULT_VECTORIZE_OPTIONS,
    engine: 'crisp',
    regionDetail: 80,
    markers: [{ x: 0.4, y: 0.5 }, { x: 0.7, y: 0.6 }],
  }
  const off = await traceImage(src as unknown as ImageData, { ...base, layeredDecomposition: false })
  const on = await traceImage(src as unknown as ImageData, { ...base, layeredDecomposition: true })
  assert.equal(hashDoc(on), hashDoc(off), 'no overlap structure ⇒ decomposition is a byte-identical no-op')
})
