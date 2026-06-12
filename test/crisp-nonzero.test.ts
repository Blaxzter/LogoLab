// Verifies the crisp tracer's loop orientation renders holes correctly under the
// nonzero fill rule (the V1a seam fix). Uses the pure rasterizer end-to-end.
//
//   node --test test/crisp-nonzero.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { traceMaskCrisp, type CrispOptions } from '../src/lib/trace/subpixel.ts'
import { rasterizeDoc } from '../src/devtest/raster.ts'
import type { EditableDoc } from '../src/lib/path/types.ts'

const OPTS: CrispOptions = {
  smooth: 0,
  turdsize: 8,
  cornerThreshold: 55,
  simplifyEpsilon: 0.75,
  fitTolerance: 0.8,
}

function mask(w: number, h: number, inside: (x: number, y: number) => boolean): ImageData {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = inside(x, y) ? 0 : 255
      const o = (y * w + x) * 4
      data[o] = v
      data[o + 1] = v
      data[o + 2] = v
      data[o + 3] = 255
    }
  }
  return { width: w, height: h, data } as unknown as ImageData
}

const at = (px: Uint8ClampedArray, w: number, x: number, y: number): number => px[(y * w + x) * 4]

test('square-with-hole renders as a ring under nonzero (orientation fix)', () => {
  const w = 100
  const h = 100
  const sps = traceMaskCrisp(
    mask(w, h, (x, y) => x >= 15 && x < 85 && y >= 15 && y < 85 && !(x >= 40 && x < 60 && y >= 40 && y < 60)),
    OPTS,
  )
  assert.equal(sps.length, 2, 'outer + hole')
  const doc: EditableDoc = {
    viewBox: [0, 0, w, h],
    items: [{ kind: 'path', id: 'ring', fill: '#000000', fillRule: 'nonzero', subPaths: sps, visible: true }],
  }
  const px = rasterizeDoc(doc, w, h)
  // The hole must show the white background (nonzero subtracts the inner loop).
  assert.equal(at(px, w, 50, 50), 255, 'hole center is background')
  // The ring body is filled black.
  assert.equal(at(px, w, 25, 50), 0, 'ring body is filled')
})

test('a single filled square stays filled under nonzero', () => {
  const w = 80
  const h = 80
  const sps = traceMaskCrisp(mask(w, h, (x, y) => x >= 20 && x < 60 && y >= 20 && y < 60), OPTS)
  assert.equal(sps.length, 1)
  const doc: EditableDoc = {
    viewBox: [0, 0, w, h],
    items: [{ kind: 'path', id: 's', fill: '#000000', fillRule: 'nonzero', subPaths: sps, visible: true }],
  }
  const px = rasterizeDoc(doc, w, h)
  assert.equal(at(px, w, 40, 40), 0, 'interior filled')
  assert.equal(at(px, w, 5, 5), 255, 'outside is background')
})
