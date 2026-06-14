// Unit tests for the pure pipeline-stage visualizers (shared by the dev
// scoreboard and the user-facing "How it works" explainer).
//
//   node --test test/stageViz.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { labelColor, segmentsToRgba, regionFillsToRgba } from '../src/lib/trace/stageViz.ts'

test('labelColor is deterministic and in 0–255 range', () => {
  for (let l = 0; l < 20; l++) {
    const c = labelColor(l)
    assert.deepEqual(c, labelColor(l), 'same label → same colour')
    for (const v of c) assert.ok(v >= 0 && v <= 255, `channel ${v} in range`)
  }
  assert.notDeepEqual(labelColor(0), labelColor(1), 'adjacent labels differ')
})

test('segmentsToRgba: labelled pixels opaque, negative labels transparent', () => {
  const w = 2
  const h = 1
  const labels = Int32Array.from([0, -1])
  const px = segmentsToRgba(labels, w, h)
  assert.equal(px.length, w * h * 4)
  assert.equal(px[3], 255, 'label 0 is opaque')
  const [r, g, b] = labelColor(0)
  assert.deepEqual([px[0], px[1], px[2]], [r, g, b], 'label 0 uses its hue')
  assert.equal(px[7], 0, 'label -1 (transparent) has alpha 0')
})

test('regionFillsToRgba paints each region its palette colour', () => {
  const w = 2
  const h = 1
  const labels = Int32Array.from([0, 1])
  const palette = [
    { r: 10, g: 20, b: 30 },
    { r: 200, g: 100, b: 50 },
  ]
  const px = regionFillsToRgba(labels, palette, w, h)
  assert.deepEqual([px[0], px[1], px[2], px[3]], [10, 20, 30, 255])
  assert.deepEqual([px[4], px[5], px[6], px[7]], [200, 100, 50, 255])
})
