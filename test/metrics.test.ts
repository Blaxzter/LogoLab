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

test('seam metric: catches a crack in a smooth field, ignores a true edge', () => {
  const w = 32
  const h = 32

  // (a) Smooth source (uniform white). A boundary pixel rendered black is a crack.
  const src = solidBuf(w, h, 255, 255, 255)
  const crackRender = solidBuf(w, h, 255, 255, 255)
  const ci = 16 * w + 16
  crackRender[ci * 4] = 0
  crackRender[ci * 4 + 1] = 0
  crackRender[ci * 4 + 2] = 0
  assert.equal(fidelity(src, crackRender, w, h).seamMax, 0, 'no boundary mask → no seam')
  const mask = new Uint8Array(w * h)
  mask[ci] = 1
  assert.ok(fidelity(src, crackRender, w, h, mask).seamMax > 99, 'crack in smooth field is caught')

  // (b) True high-contrast edge: source has a black/white step; render reproduces
  // it but shifted 1px. Boundary pixels sit on a high source gradient → excluded.
  const edgeSrc = new Uint8ClampedArray(w * h * 4)
  const edgeRender = new Uint8ClampedArray(w * h * 4)
  const edgeMask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const sv = x < 16 ? 0 : 255 // source edge at x=16
      const rv = x < 17 ? 0 : 255 // render edge shifted to x=17
      for (let c = 0; c < 3; c++) {
        edgeSrc[i * 4 + c] = sv
        edgeRender[i * 4 + c] = rv
      }
      edgeSrc[i * 4 + 3] = 255
      edgeRender[i * 4 + 3] = 255
      if (x === 16 || x === 17) edgeMask[i] = 1 // boundary straddles the edge
    }
  }
  const edge = fidelity(edgeSrc, edgeRender, w, h, edgeMask)
  assert.equal(edge.seamMax, 0, 'true edge excluded by source gradient — no false seam')
})

test('seam metric still catches a crack 2px from a true edge (not masked)', () => {
  // A true edge at x≈16 in a two-tone-gray field, plus a black crack column at
  // x=18 (2px into the smooth right field). The crack must NOT be hidden by the
  // edge exclusion — it is an edge in the render but the source is smooth there.
  const w = 32
  const h = 32
  const src = new Uint8ClampedArray(w * h * 4)
  const render = new Uint8ClampedArray(w * h * 4)
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const field = x < 16 ? 80 : 170
      const rv = x === 18 ? 0 : field // black crack at x=18
      for (let c = 0; c < 3; c++) {
        src[i * 4 + c] = field
        render[i * 4 + c] = rv
      }
      src[i * 4 + 3] = 255
      render[i * 4 + 3] = 255
      if (x === 18) mask[i] = 1
    }
  }
  const m = fidelity(src, render, w, h, mask)
  assert.ok(m.seamMax > 50, `crack near a true edge must still be caught, got ${m.seamMax.toFixed(1)}`)
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
