// Unit tests for the harness metrics (src/devtest/metrics.ts).
//
//   node --test test/metrics.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fidelity, usefulness, hashDoc } from '../src/devtest/metrics.ts'
import { rasterizeDoc } from '../src/devtest/raster.ts'
import type { EditableDoc, PathItem, SubPath } from '../src/lib/path/types.ts'

function solidBuf(w: number, h: number, r: number, g: number, b: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = r
    px[i * 4 + 1] = g
    px[i * 4 + 2] = b
    px[i * 4 + 3] = 255
  }
  return px
}

test('identical images → zero error, SSIM 1', () => {
  const a = solidBuf(16, 16, 120, 60, 200)
  const m = fidelity(a, a, 16, 16)
  assert.equal(m.l1Lab, 0)
  assert.equal(m.meanDeltaE, 0)
  assert.equal(m.p95DeltaE, 0)
  assert.ok(Math.abs(m.ssim - 1) < 1e-9, `ssim ${m.ssim}`)
})

test('black vs white → ΔE ~100, SSIM near zero', () => {
  const black = solidBuf(16, 16, 0, 0, 0)
  const white = solidBuf(16, 16, 255, 255, 255)
  const m = fidelity(black, white, 16, 16)
  assert.ok(Math.abs(m.meanDeltaE - 100) < 1, `meanDeltaE ${m.meanDeltaE}`)
  assert.ok(m.ssim < 0.01, `ssim ${m.ssim}`)
})

test('seam metric maxes ΔE over boundary pixels only', () => {
  const w = 16
  const h = 16
  const source = solidBuf(w, h, 255, 255, 255)
  const render = solidBuf(w, h, 255, 255, 255)
  // Inject one black pixel at (8,8); only counts if the boundary mask covers it.
  const o = (8 * w + 8) * 4
  render[o] = 0
  render[o + 1] = 0
  render[o + 2] = 0
  const noMask = fidelity(source, render, w, h)
  assert.equal(noMask.seamMax, 0)
  const mask = new Uint8Array(w * h)
  mask[8 * w + 8] = 1
  const withMask = fidelity(source, render, w, h, mask)
  assert.ok(withMask.seamMax > 99, `seamMax ${withMask.seamMax}`)
})

function rect(x: number, y: number, w: number, h: number): SubPath {
  const c = (px: number, py: number) => ({ x: px, y: py, hIn: null, hOut: null, kind: 'corner' as const })
  return { closed: true, nodes: [c(x, y), c(x + w, y), c(x + w, y + h), c(x, y + h)] }
}

test('usefulness counts paths, nodes, distinct gradients', () => {
  const grad = { type: 'linear' as const, x1: 0, y1: 0, x2: 10, y2: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] }
  const items: PathItem[] = [
    { kind: 'path', id: 'a', fill: '#000000', fillRule: 'nonzero', subPaths: [rect(0, 0, 10, 10)], visible: true, gradient: grad },
    { kind: 'path', id: 'b', fill: '#ffffff', fillRule: 'nonzero', subPaths: [rect(2, 2, 4, 4)], visible: true },
  ]
  const doc: EditableDoc = { viewBox: [0, 0, 10, 10], items }
  const u = usefulness(doc)
  assert.equal(u.paths, 2)
  assert.equal(u.nodes, 8)
  assert.equal(u.gradients, 1)
})

test('hashDoc is stable and content-sensitive', () => {
  const mk = (fill: string): EditableDoc => ({
    viewBox: [0, 0, 10, 10],
    items: [{ kind: 'path', id: 'a', fill, fillRule: 'nonzero', subPaths: [rect(0, 0, 10, 10)], visible: true }],
  })
  assert.equal(hashDoc(mk('#000000')), hashDoc(mk('#000000')))
  assert.notEqual(hashDoc(mk('#000000')), hashDoc(mk('#010000')))
})

test('round-trip: rasterize a doc and score it against itself = perfect', () => {
  const doc: EditableDoc = {
    viewBox: [0, 0, 32, 32],
    items: [{ kind: 'path', id: 'a', fill: '#3366cc', fillRule: 'nonzero', subPaths: [rect(4, 4, 24, 24)], visible: true }],
  }
  const px = rasterizeDoc(doc, 32, 32)
  const m = fidelity(px, px, 32, 32)
  assert.equal(m.meanDeltaE, 0)
  assert.ok(Math.abs(m.ssim - 1) < 1e-9)
})
