// Unit tests for the per-region gradient fitter (src/lib/trace/gradient.ts).
//
// Pure math, no DOM — runs under Node's built-in test runner with native TS
// type-stripping:  node --test test/gradient-fit.test.ts
//
// We synthesize regions with known structure (flat / linear / radial) and assert
// the fitter classifies them correctly and recovers sane axes and stop colors.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fitRegionFill,
  fitBestGradient,
  channelsToHex,
  gradientToSvgDef,
  type RegionSamples,
} from '../src/lib/trace/gradient.ts'

type ColorFn = (x: number, y: number) => [number, number, number]

/** Build a W×H grid of samples colored by `color`. */
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
      xs[k] = x
      ys[k] = y
      rs[k] = r
      gs[k] = g
      bs[k] = b
      k++
    }
  }
  return { xs, ys, rs, gs, bs, n }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by)

/** Roughly-equal hex colors (per-channel tolerance, default 12/255). */
function assertColorNear(got: string, want: string, tol = 12, msg = '') {
  const p = (s: string) => [
    parseInt(s.slice(1, 3), 16),
    parseInt(s.slice(3, 5), 16),
    parseInt(s.slice(5, 7), 16),
  ]
  const a = p(got)
  const b = p(want)
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(a[i] - b[i]) <= tol,
      `${msg} channel ${i}: got ${got} want ~${want} (Δ ${Math.abs(a[i] - b[i])})`,
    )
  }
}

test('flat region → solid (no gradient)', () => {
  const r = fitRegionFill(grid(40, 40, () => [120, 60, 200]))
  assert.equal(r.kind, 'solid')
  assert.equal(r.gradient, null)
  assertColorNear(channelsToHex(r.solid[0], r.solid[1], r.solid[2]), '#783cc8')
})

test('near-flat region (tiny noise) stays solid', () => {
  // ±2 per channel checkerboard — under the flatResidual gate.
  const r = fitRegionFill(
    grid(40, 40, (x, y) => {
      const d = (x + y) % 2 === 0 ? 2 : -2
      return [128 + d, 128 - d, 128 + d]
    }),
  )
  assert.equal(r.kind, 'solid')
  assert.equal(r.gradient, null)
})

test('horizontal linear ramp → linear gradient along x with correct stops', () => {
  // black (x=0) → red (x=63)
  const W = 64
  const r = fitRegionFill(grid(W, 40, (x) => [Math.round(lerp(0, 255, x / (W - 1))), 0, 0]))
  assert.equal(r.kind, 'linear')
  assert.ok(r.gradient && r.gradient.type === 'linear')
  const g = r.gradient
  assert.ok(g.type === 'linear')
  // Axis essentially horizontal.
  assert.ok(
    Math.abs(g.y2 - g.y1) < Math.abs(g.x2 - g.x1) * 0.05,
    `axis should be horizontal, got (${g.x1},${g.y1})->(${g.x2},${g.y2})`,
  )
  // Endpoints span the full width (order-independent).
  const xmin = Math.min(g.x1, g.x2)
  const xmax = Math.max(g.x1, g.x2)
  assert.ok(xmin < 2 && xmax > W - 3, `endpoints span x, got ${xmin}..${xmax}`)
  // Stop colors are {black, red} in some order.
  const colors = g.stops.map((s) => s.color).sort()
  assertColorNear(colors[0], '#000000', 12, 'dark stop')
  assertColorNear(colors[colors.length - 1], '#ff0000', 12, 'red stop')
  assert.ok(r.linearResidual < 6, `linear residual low, got ${r.linearResidual}`)
})

test('vertical linear ramp → axis along y', () => {
  const H = 64
  const r = fitRegionFill(grid(40, H, (_x, y) => [0, Math.round(lerp(0, 255, y / (H - 1))), 0]))
  assert.equal(r.kind, 'linear')
  assert.ok(r.gradient && r.gradient.type === 'linear')
  const g = r.gradient
  assert.ok(g.type === 'linear')
  assert.ok(
    Math.abs(g.x2 - g.x1) < Math.abs(g.y2 - g.y1) * 0.05,
    `axis should be vertical, got (${g.x1},${g.y1})->(${g.x2},${g.y2})`,
  )
})

test('radial ramp → radial gradient centered in the middle', () => {
  const W = 64
  const H = 64
  const cx = (W - 1) / 2
  const cy = (H - 1) / 2
  const maxD = dist(0, 0, cx, cy)
  // white at center → blue at the rim.
  const r = fitRegionFill(
    grid(W, H, (x, y) => {
      const t = dist(x, y, cx, cy) / maxD
      return [Math.round(lerp(255, 0, t)), Math.round(lerp(255, 0, t)), 255]
    }),
  )
  assert.equal(r.kind, 'radial')
  assert.ok(r.gradient && r.gradient.type === 'radial')
  const g = r.gradient
  assert.ok(g.type === 'radial')
  // Center within a few px of the true center.
  assert.ok(dist(g.cx, g.cy, cx, cy) < 6, `center near middle, got (${g.cx},${g.cy})`)
  assertColorNear(g.stops[0].color, '#ffffff', 16, 'inner stop')
  assertColorNear(g.stops[g.stops.length - 1].color, '#0000ff', 24, 'outer stop')
  assert.ok(r.radialResidual < r.linearResidual + 1e-6, 'radial should fit at least as well as linear')
})

test('eased (non-linear) ramp emits intermediate stops', () => {
  // Quadratic ease black→white along x: a 2-stop linear fit reads wrong, so the
  // multi-stop emission must add at least one interior knot.
  const W = 96
  const r = fitRegionFill(
    grid(W, 40, (x) => {
      const t = x / (W - 1)
      const v = Math.round(255 * t * t)
      return [v, v, v]
    }),
  )
  assert.notEqual(r.kind, 'solid')
  assert.ok(r.gradient, 'eased ramp fits a gradient')
  assert.ok(r.gradient!.stops.length >= 3, `eased ramp should add stops, got ${r.gradient!.stops.length}`)
})

test('fitBestGradient fits a linear ramp with low Oklab residual', () => {
  const W = 64
  const fit = fitBestGradient(grid(W, 40, (x) => [Math.round(lerp(0, 255, x / (W - 1))), 0, 0]))
  assert.ok(fit, 'returns a gradient')
  assert.ok(fit!.oklabResidual < 0.03, `clean ramp should fit well, oklabResidual ${fit!.oklabResidual}`)
})

test('too few samples → solid (never gradient)', () => {
  const r = fitRegionFill(grid(4, 4, (x) => [x * 60, 0, 0])) // 16 < minSamples
  assert.equal(r.kind, 'solid')
  assert.equal(r.gradient, null)
})

test('gradientToSvgDef emits valid linear/radial markup', () => {
  const lin = gradientToSvgDef(
    { type: 'linear', x1: 0, y1: 0, x2: 100, y2: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] },
    'grad-x',
  )
  assert.match(lin, /<linearGradient id="grad-x" gradientUnits="userSpaceOnUse"/)
  assert.match(lin, /x2="100"/)
  assert.match(lin, /<stop offset="1" stop-color="#ffffff"\/>/)

  const rad = gradientToSvgDef(
    { type: 'radial', cx: 50, cy: 50, r: 25, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#00ff00' }] },
    'grad-y',
  )
  assert.match(rad, /<radialGradient id="grad-y"[^>]*cx="50"[^>]*r="25"/)
})
