// The transparency-checker backdrop decides its own side from the artwork:
//
//   node --test test/checker-backdrop.test.ts
//
// White line-art on a light checker is invisible, so a light mark sitting on
// transparency flips the backdrop dark. The gate is what keeps that from
// firing on artwork that is merely pale — an opaque white field hides the
// checker anyway, and flipping for it would darken every other view for
// nothing. The same predicate serves the upload path, the example swatches and
// the editor (src/components/editor/SvgEditorStudio.tsx), which is the one
// route the upload heuristic never sees.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { prefersDarkCheckerData } from '../src/lib/image.ts'

ensureImageData()

/**
 * A square of transparency with `coverage` of it painted an opaque grey level
 * — a stand-in for a mark on an empty artboard.
 */
function markOnTransparency(level: number, coverage: number, size = 32): ImageData {
  const img = new ImageData(size, size)
  const painted = Math.round(size * size * coverage)
  for (let i = 0; i < painted; i++) {
    const p = i * 4
    img.data[p] = level
    img.data[p + 1] = level
    img.data[p + 2] = level
    img.data[p + 3] = 255
  }
  return img
}

test('white line-art on transparency asks for the dark checker', () => {
  assert.equal(prefersDarkCheckerData(markOnTransparency(255, 0.2)), true)
})

test('a dark mark on transparency keeps the light checker', () => {
  assert.equal(prefersDarkCheckerData(markOnTransparency(20, 0.2)), false)
})

test('an opaque white field does not flip the backdrop', () => {
  // Nothing shows through it, so there is nothing to keep legible.
  assert.equal(prefersDarkCheckerData(markOnTransparency(255, 1)), false)
})

test('an empty artboard is no evidence either way', () => {
  assert.equal(prefersDarkCheckerData(new ImageData(32, 32)), false)
})
