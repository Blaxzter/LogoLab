// Unit tests for the Stage-2 paint-model ladder (gradient.ts fitPaintLadder).
//
//   node --test test/paint-ladder.test.ts
//
// Synthesizes regions with known paint (flat / linear-shaded / radial) and asserts
// the MDL ladder picks the right model, never letting a flat colour beat a clearly
// better gradient, nor a near-flat region graduate to a spurious gradient.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitPaintLadder, type RegionSamples } from '../src/lib/trace/gradient.ts'

type ColorFn = (x: number, y: number) => [number, number, number]

function grid(w: number, h: number, color: ColorFn): RegionSamples {
  const n = w * h
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const rs = new Float64Array(n)
  const gs = new Float64Array(n)
  const bs = new Float64Array(n)
  let k = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = color(x, y)
      xs[k] = x; ys[k] = y; rs[k] = r; gs[k] = g; bs[k] = b
      k++
    }
  }
  return { xs, ys, rs, gs, bs, n }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

test('flat region → solid (no gradient)', () => {
  const r = fitPaintLadder(grid(40, 40, () => [120, 60, 200]))
  assert.equal(r.model, 'solid')
  assert.equal(r.gradient, null)
})

test('near-flat region (sub-threshold noise) stays solid', () => {
  const r = fitPaintLadder(grid(40, 40, (x, y) => {
    const d = (x + y) % 2 === 0 ? 2 : -2
    return [128 + d, 128 - d, 128 + d]
  }))
  assert.equal(r.model, 'solid')
})

test('linear-shaded region → linear gradient (solid never wins it)', () => {
  const W = 64
  const r = fitPaintLadder(grid(W, 40, (x) => {
    const v = Math.round(lerp(40, 230, x / (W - 1)))
    return [v, 80, 255 - v]
  }))
  assert.equal(r.model, 'linear')
  assert.ok(r.gradient && r.gradient.type === 'linear')
  // The chosen model must fit far better than the flat fallback.
  assert.ok(r.debug!.linearRes < r.debug!.solidRes * 0.5, 'linear must markedly beat solid')
})

test('radial region → radial gradient', () => {
  const W = 64
  const H = 64
  const cx = (W - 1) / 2
  const cy = (H - 1) / 2
  const maxD = Math.hypot(cx, cy)
  const r = fitPaintLadder(grid(W, H, (x, y) => {
    const t = Math.hypot(x - cx, y - cy) / maxD
    return [Math.round(lerp(255, 0, t)), Math.round(lerp(255, 0, t)), 255]
  }))
  assert.equal(r.model, 'radial')
  assert.ok(r.gradient && r.gradient.type === 'radial')
})

test('MDL: a strongly-shaded region never collapses to solid', () => {
  // The bug class V2 fixed: an over-weighted complexity penalty letting solid beat
  // a clearly-better gradient. A 5 ΔE-ish ramp must graduate to a gradient.
  const W = 80
  const r = fitPaintLadder(grid(W, 48, (x) => {
    const t = x / (W - 1)
    return [Math.round(lerp(43, 120, t)), Math.round(lerp(168, 113, t)), Math.round(lerp(229, 238, t))]
  }))
  assert.notEqual(r.model, 'solid')
})

test('too few samples → solid', () => {
  const r = fitPaintLadder(grid(4, 4, (x) => [x * 60, 0, 0]))
  assert.equal(r.model, 'solid')
})
