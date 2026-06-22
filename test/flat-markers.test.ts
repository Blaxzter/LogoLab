// "Flat" region markers (VectorizeOptions.flatMarkers / SegmentOptions.flatMarkers)
// — DISTINCT from the keep-separate `markers`. A flat marker pins its region to its
// PRE-merge flat form: the region's fine segment is excluded from the Step-3c
// gradient field-merge (so two flats the merger would fuse stay separate) and the
// region is painted one solid colour. The segmenter also exposes `preMergeLabels`,
// the fine regions BEFORE that merge.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { segmentImage, DEFAULT_SEGMENT_OPTIONS } from '../src/lib/trace/segment.ts'
import type { EditableDoc } from '../src/lib/path/types.ts'

ensureImageData()

/** Two flat halves (blue | red) joined by a smooth transition — the case the
 *  field-merge otherwise fuses into one fake gradient region. */
function twoFlats(w = 96, h = 64, ramp = 10): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(w * h * 4)
  const A = [40, 90, 200]
  const B = [220, 80, 60]
  const mid = w / 2
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const t = Math.max(0, Math.min(1, (x - (mid - ramp / 2)) / ramp))
      const o = (y * w + x) * 4
      data[o] = A[0] + (B[0] - A[0]) * t
      data[o + 1] = A[1] + (B[1] - A[1]) * t
      data[o + 2] = A[2] + (B[2] - A[2]) * t
      data[o + 3] = 255
    }
  return { width: w, height: h, data }
}

const distinct = (labels: Int32Array): number => {
  const s = new Set<number>()
  for (const l of labels) if (l >= 0) s.add(l)
  return s.size
}

// --- segmenter level --------------------------------------------------------

test('flat-markers: segmenter exposes preMergeLabels (fine regions ≥ final regions)', () => {
  const img = twoFlats()
  const seg = segmentImage(img, { ...DEFAULT_SEGMENT_OPTIONS })
  assert.ok(seg.preMergeLabels instanceof Int32Array)
  assert.equal(seg.preMergeLabels.length, img.width * img.height)
  // The fused-gradient case: final has 1 macro region, pre-merge has the two
  // flats (+ transition bands) before the field merge.
  assert.equal(distinct(seg.labels), 1, 'gradient merge fuses to one macro region')
  assert.ok(distinct(seg.preMergeLabels) >= 2, 'pre-merge keeps the flats separate')
})

test('flat-markers: a flat marker on each half keeps them separate (excluded from field merge)', () => {
  const img = twoFlats()
  const seg = segmentImage(img, {
    ...DEFAULT_SEGMENT_OPTIONS,
    flatMarkers: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }],
  })
  // Both flats survive as their own macro regions (not fused into one gradient).
  assert.ok(distinct(seg.labels) >= 2, `flats stay separate, got ${distinct(seg.labels)} region(s)`)
})

// --- end-to-end (traceImage) ------------------------------------------------

const gradientCount = (doc: EditableDoc): number => doc.items.filter((it) => it.kind === 'path' && it.gradient).length
const pathCount = (doc: EditableDoc): number => doc.items.filter((it) => it.kind === 'path').length
const base = { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar' as const, gradients: true }

test('flat-markers: fused flats → two SEPARATE solid regions end-to-end', async () => {
  const img = twoFlats() as unknown as ImageData
  const without = await traceImage(img, base)
  const withFlat = await traceImage(img, {
    ...base,
    markers: [{ x: 0.2, y: 0.5, flat: true }, { x: 0.8, y: 0.5, flat: true }],
  })

  // Baseline: one fused region carrying a gradient.
  assert.equal(pathCount(without), 1)
  assert.ok(gradientCount(without) >= 1)

  // With flat markers: two separate regions, both solid (no gradient).
  assert.equal(pathCount(withFlat), 2, 'two separate regions')
  assert.equal(gradientCount(withFlat), 0, 'both painted flat')
})

test('flat-markers: no flat markers ⇒ baseline unchanged', async () => {
  const img = twoFlats() as unknown as ImageData
  const a = await traceImage(img, base)
  const b = await traceImage(img, { ...base, markers: [] })
  assert.equal(pathCount(a), pathCount(b))
  assert.equal(gradientCount(a), gradientCount(b))
})
