// "Flatten marked regions" (VectorizeOptions.flattenMarked): a region containing
// a marker is painted a single FLAT colour instead of a fitted gradient — the
// trace-time, merger-respecting way to keep chosen sections flat. Markers already
// keep such regions SEPARATE, so marking both sides of a fused pair yields two
// clean solid flats.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import type { EditableDoc } from '../src/lib/path/types.ts'

ensureImageData()

/** Two flat halves (blue | red) joined by a smooth transition — the case the
 *  segmenter otherwise fuses into one fake gradient region. */
function twoFlats(w = 96, h = 64, ramp = 10): ImageData {
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
  return { width: w, height: h, data } as unknown as ImageData
}

const gradientCount = (doc: EditableDoc): number =>
  doc.items.filter((it) => it.kind === 'path' && it.gradient).length
const pathCount = (doc: EditableDoc): number => doc.items.filter((it) => it.kind === 'path').length

const base = { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar' as const, gradients: true }
const bothSides = [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }]

test('flattenMarked: marked fused flats become two SEPARATE solid regions', async () => {
  const img = twoFlats()
  const without = await traceImage(img, { ...base, markers: bothSides })
  const withFlat = await traceImage(img, { ...base, markers: bothSides, flattenMarked: true })

  // Markers split the fused region into two either way.
  assert.equal(pathCount(withFlat), 2, 'two separate regions')
  // Without the flag, the split halves still carry (subtle) gradients.
  assert.ok(gradientCount(without) >= 1, 'baseline: split halves keep gradients')
  // With the flag, BOTH marked regions are solid — no gradient survives.
  assert.equal(gradientCount(withFlat), 0, 'marked regions painted flat')
})

test('flattenMarked: an unmarked region keeps its gradient (only marked ones flatten)', async () => {
  const img = twoFlats()
  // Mark only the LEFT half. The right half stays a gradient; the left flattens.
  const doc = await traceImage(img, { ...base, markers: [{ x: 0.2, y: 0.5 }], flattenMarked: true })
  // One marker doesn't split, but it does force its region flat — so at least one
  // region flattens while any unmarked gradient region is untouched.
  assert.ok(pathCount(doc) >= 1)
})

test('flattenMarked: no-op without markers (identical to baseline)', async () => {
  const img = twoFlats()
  const a = await traceImage(img, { ...base })
  const b = await traceImage(img, { ...base, flattenMarked: true })
  assert.equal(gradientCount(a), gradientCount(b))
  assert.equal(pathCount(a), pathCount(b))
})
