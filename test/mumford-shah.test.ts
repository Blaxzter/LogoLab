// Unit tests for the discrete Mumford–Shah solver (src/lib/trace/mumfordShah.ts).
//
//   node --test test/mumford-shah.test.ts
//
// Pure math, no DOM. We synthesize images with known structure (flat, noisy-flat,
// a sharp two-region edge, a smooth ramp) and assert the solver denoises within
// regions, preserves true edges as discontinuities, and is deterministic.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { solveMumfordShah, DEFAULT_MS_OPTIONS } from '../src/lib/trace/mumfordShah.ts'

type ColorFn = (x: number, y: number) => [number, number, number, number?]

/** Build an RGBA image of w×h from a per-pixel color function (0–255, opt alpha). */
function img(w: number, h: number, color: ColorFn): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = color(x, y)
      const o = (y * w + x) * 4
      data[o] = r
      data[o + 1] = g
      data[o + 2] = b
      data[o + 3] = a ?? 255
    }
  }
  return { width: w, height: h, data }
}

function discontinuityCount(d: Uint8Array): number {
  let c = 0
  for (let i = 0; i < d.length; i++) c += d[i]
  return c
}

test('flat image stays flat with zero discontinuities', () => {
  const res = solveMumfordShah(img(32, 32, () => [120, 60, 200]))
  assert.equal(discontinuityCount(res.discontinuity), 0, 'no edges in a flat field')
  // Center pixel unchanged (to float tolerance).
  const i = 16 * 32 + 16
  assert.ok(Math.abs(res.r[i] - 120 / 255) < 1e-3)
  assert.ok(Math.abs(res.g[i] - 60 / 255) < 1e-3)
  assert.ok(Math.abs(res.b[i] - 200 / 255) < 1e-3)
})

test('noisy flat field is denoised below its input variance, no edges', () => {
  // ±6/255 per-channel checkerboard noise on a mid grey — well under the edge cap.
  const base = 128
  const src = img(40, 40, (x, y) => {
    const d = (x + y) % 2 === 0 ? 6 : -6
    return [base + d, base + d, base + d]
  })
  const res = solveMumfordShah(src)
  assert.equal(discontinuityCount(res.discontinuity), 0, 'noise must not create edges')
  // Variance of the smoothed centre block is far below the input's.
  let mean = 0
  const vals: number[] = []
  for (let y = 10; y < 30; y++) {
    for (let x = 10; x < 30; x++) {
      const v = res.r[y * 40 + x]
      vals.push(v)
      mean += v
    }
  }
  mean /= vals.length
  let varr = 0
  for (const v of vals) varr += (v - mean) ** 2
  varr /= vals.length
  const inputVar = (6 / 255) ** 2
  assert.ok(varr < inputVar * 0.25, `denoised variance ${varr} should be ≪ input ${inputVar}`)
})

test('sharp two-region edge → discontinuity on the seam, regions preserved', () => {
  const W = 40
  const H = 24
  // Left half black, right half white: a maximal step, definitely a discontinuity.
  const res = solveMumfordShah(img(W, H, (x) => (x < W / 2 ? [10, 10, 10] : [245, 245, 245])))
  // The vertical seam column x = W/2-1 should be flagged on its row.
  const seamX = W / 2 - 1
  let seamFlagged = 0
  for (let y = 0; y < H; y++) if (res.discontinuity[y * W + seamX]) seamFlagged++
  assert.ok(seamFlagged >= H - 2, `seam column should be in 𝒟, got ${seamFlagged}/${H}`)
  // Interior of each region stays its color and is NOT in 𝒟.
  const li = 12 * W + 5
  const ri = 12 * W + (W - 6)
  assert.equal(res.discontinuity[li], 0, 'left interior is smooth')
  assert.equal(res.discontinuity[ri], 0, 'right interior is smooth')
  assert.ok(res.r[li] < 0.1, 'left stays dark')
  assert.ok(res.r[ri] > 0.9, 'right stays light')
})

test('smooth linear ramp keeps no interior discontinuities', () => {
  // Black→white over 64 px: per-pixel step ≈ 1/63 ≈ 0.016 ≪ edge threshold.
  const W = 64
  const res = solveMumfordShah(img(W, 20, (x) => {
    const v = Math.round((255 * x) / (W - 1))
    return [v, v, v]
  }))
  // Allow the two border columns (clamped) but the interior must be smooth.
  let interiorEdges = 0
  for (let y = 0; y < 20; y++) {
    for (let x = 2; x < W - 2; x++) if (res.discontinuity[y * W + x]) interiorEdges++
  }
  assert.equal(interiorEdges, 0, 'a gentle ramp has no discontinuities')
})

test('transparent pixels are excluded and never couple across', () => {
  const W = 16
  const res = solveMumfordShah(img(W, 8, (x) => (x < 8 ? [200, 0, 0, 255] : [0, 0, 0, 0])))
  for (let y = 0; y < 8; y++) {
    for (let x = 8; x < W; x++) assert.equal(res.opaque[y * W + x], 0, 'right half transparent')
  }
  // The opaque red stays red (not pulled toward the transparent zeros).
  const i = 4 * W + 3
  assert.ok(res.r[i] > 0.7, `opaque red preserved, got ${res.r[i]}`)
})

test('deterministic: identical input → identical output', () => {
  const src = img(48, 48, (x, y) => [((x * 7) % 256), ((y * 5) % 256), ((x + y) % 256)])
  const a = solveMumfordShah(src, DEFAULT_MS_OPTIONS)
  const b = solveMumfordShah(src, DEFAULT_MS_OPTIONS)
  for (let i = 0; i < a.r.length; i++) {
    assert.equal(a.r[i], b.r[i])
    assert.equal(a.g[i], b.g[i])
    assert.equal(a.b[i], b.b[i])
    assert.equal(a.discontinuity[i], b.discontinuity[i])
  }
})
