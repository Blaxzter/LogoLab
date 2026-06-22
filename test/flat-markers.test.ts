// "Flat" region markers (VectorizeOptions.flatMarkers / SegmentOptions.flatMarkers)
// — DISTINCT from the keep-separate `markers`. A flat marker EXCLUDES its pre-merge
// fine segment from the Step-3c gradient field merge, so the marked section survives
// as its own region instead of being fused into a (often nonsensical) gradient with
// its neighbours; it is then painted one solid colour. The exclusion runs before the
// Step-4 anti-alias flood, so the region's boundary settles on the true colour edge
// (clean geometry) and a SINGLE marker is enough. The segmenter also exposes
// `preMergeLabels`, the fine regions before the field merge.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { segmentImage, DEFAULT_SEGMENT_OPTIONS } from '../src/lib/trace/segment.ts'
import type { EditableDoc, PathItem } from '../src/lib/path/types.ts'

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

/** A red blob on white with a SOFT (wide) edge — the merger fuses it into ONE region
 *  and fits a nonsense radial gradient (red centre → white rim). The user's case. */
function redOnWhite(w = 120, h = 120): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(w * h * 4)
  const cx = w / 2
  const cy = h / 2
  const R = 22
  const soft = 26
  const RED = [205, 45, 45]
  const WHITE = [248, 248, 248]
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy)
      const t = Math.max(0, Math.min(1, (d - R) / soft))
      const o = (y * w + x) * 4
      data[o] = RED[0] + (WHITE[0] - RED[0]) * t
      data[o + 1] = RED[1] + (WHITE[1] - RED[1]) * t
      data[o + 2] = RED[2] + (WHITE[2] - RED[2]) * t
      data[o + 3] = 255
    }
  return { width: w, height: h, data }
}

const distinct = (labels: Int32Array): number => {
  const s = new Set<number>()
  for (const l of labels) if (l >= 0) s.add(l)
  return s.size
}

const gradientCount = (doc: EditableDoc): number => doc.items.filter((it) => it.kind === 'path' && it.gradient).length
const pathCount = (doc: EditableDoc): number => doc.items.filter((it) => it.kind === 'path').length
const totalNodes = (doc: EditableDoc): number =>
  doc.items.reduce((s, it) => s + (it.kind === 'path' ? it.subPaths.reduce((a, sp) => a + sp.nodes.length, 0) : 0), 0)
/** Is there a SOLID (no-gradient) path whose fill is clearly red (R dominates G,B)? */
const hasSolidRed = (doc: EditableDoc): boolean =>
  doc.items.some((it) => {
    if (it.kind !== 'path' || (it as PathItem).gradient) return false
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec((it as PathItem).fill)
    if (!m) return false
    const r = parseInt(m[1], 16)
    const g = parseInt(m[2], 16)
    const b = parseInt(m[3], 16)
    return r > 140 && r - g > 80 && r - b > 80
  })

const base = { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar' as const, gradients: true }

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

test('flat-markers: a single flat marker excludes its segment from the field merge', () => {
  const img = twoFlats()
  assert.equal(distinct(segmentImage(img, { ...DEFAULT_SEGMENT_OPTIONS }).labels), 1, 'fuses to one region by default')
  const seg = segmentImage(img, { ...DEFAULT_SEGMENT_OPTIONS, flatMarkers: [{ x: 0.2, y: 0.5 }] })
  assert.ok(distinct(seg.labels) >= 2, `marked section excluded, got ${distinct(seg.labels)} region(s)`)
})

// --- end-to-end (traceImage) ------------------------------------------------

test('flat-markers: a single flat marker carves its section out and paints it solid', async () => {
  const img = twoFlats() as unknown as ImageData
  const without = await traceImage(img, base)
  // Baseline: one fused region carrying a gradient.
  assert.equal(pathCount(without), 1)
  assert.ok(gradientCount(without) >= 1)
  // One flat marker on the blue half → it is excluded from the merge and becomes its
  // own SOLID region; the rest stays. The whole region no longer paints as one mean.
  const one = await traceImage(img, { ...base, markers: [{ x: 0.2, y: 0.5, flat: true }] })
  assert.equal(pathCount(one), 2, 'marked section carved out')
  assert.ok(pathCount(one) - gradientCount(one) >= 1, 'the marked side is painted flat')
  // Geometry stays clean (a simple two-region split, not a jagged carve).
  assert.ok(totalNodes(one) < 40, `clean geometry, got ${totalNodes(one)} nodes`)
})

test('flat-markers: recovers a flat colour the merger fused into a fake gradient', async () => {
  // A red blob the merger fuses with white into one radial-gradient region (no red
  // anywhere in the output). One flat marker on the red recovers it as solid red.
  const img = redOnWhite() as unknown as ImageData
  const without = await traceImage(img, base)
  assert.equal(pathCount(without), 1, 'merger fuses red + white into one region')
  assert.ok(gradientCount(without) >= 1, 'fit as a (nonsense) gradient')
  assert.ok(!hasSolidRed(without), 'the red is gone — averaged into the gradient')

  const withFlat = await traceImage(img, { ...base, markers: [{ x: 0.5, y: 0.5, flat: true }] })
  assert.ok(pathCount(withFlat) >= 2, `red split out, got ${pathCount(withFlat)} region(s)`)
  assert.ok(hasSolidRed(withFlat), 'the marked region is solid red, not the white mean')
  assert.ok(totalNodes(withFlat) < 40, `clean geometry, got ${totalNodes(withFlat)} nodes`)
})

test('flat-markers: no flat markers ⇒ baseline unchanged', async () => {
  const img = twoFlats() as unknown as ImageData
  const a = await traceImage(img, base)
  const b = await traceImage(img, { ...base, markers: [] })
  assert.equal(pathCount(a), pathCount(b))
  assert.equal(gradientCount(a), gradientCount(b))
})
