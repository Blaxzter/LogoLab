// Focal-aware radial gradient parameterization (src/lib/trace/gradient.ts).
//
//   node --test test/radial-focal.test.ts
//
// gradientParamT / radialParamT now honour a radial's focal point (fx/fy) so the
// fit-time samplers and the segmenter's profile-gap test agree with the SVG
// rasterizer (raster.ts makeRadialPaint/focalOffset). A CENTRED radial must
// reduce EXACTLY to distance/r (byte-identical to the old behaviour); a focal
// radial must satisfy the SVG construction invariants (t=0 at the focal point,
// t=1 on the circle, monotone along a ray).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gradientParamT, radialParamT, sampleGradient } from '../src/lib/trace/gradient.ts'
import type { RadialGradient } from '../src/lib/path/types'

const stops = [
  { offset: 0, color: '#000000' },
  { offset: 1, color: '#ffffff' },
]

test('centred radial reduces EXACTLY to distance/r (byte-identical parity)', () => {
  const g: RadialGradient = { type: 'radial', cx: 50, cy: 40, r: 30, stops }
  const ref = (x: number, y: number) => {
    const t = Math.hypot(x - 50, y - 40) / 30
    return t < 0 ? 0 : t > 1 ? 1 : t
  }
  for (const [x, y] of [[50, 40], [60, 40], [50, 70], [80, 90], [0, 0], [50, 11]]) {
    assert.equal(gradientParamT(g, x, y), ref(x, y), `parity at ${x},${y}`)
  }
})

test('focal radial: t=0 at the focal point, t=1 on the circle', () => {
  const cx = 60, cy = 50, r = 40, fx = 75, fy = 50
  // At the focal point itself the offset is 0.
  assert.ok(Math.abs(radialParamT(cx, cy, r, fx, fy, fx, fy)) < 1e-9, 't(focal)=0')
  // Any point ON the gradient circle has offset 1 (the SVG focal construction).
  for (const ang of [0, 1, 2, 3, 4, 5]) {
    const px = cx + r * Math.cos(ang)
    const py = cy + r * Math.sin(ang)
    assert.ok(Math.abs(radialParamT(cx, cy, r, fx, fy, px, py) - 1) < 1e-6, `t=1 on circle at angle ${ang}`)
  }
})

test('focal radial: offset increases monotonically along a ray from the focal point', () => {
  const cx = 60, cy = 50, r = 40, fx = 70, fy = 55
  let prev = -1
  // March from the focal point toward the circle along a fixed direction.
  for (let s = 0; s <= 1.0001; s += 0.1) {
    const px = fx + s * (cx + r - fx) // ray toward the +x rim
    const py = fy + s * (cy - fy)
    const t = radialParamT(cx, cy, r, fx, fy, px, py)
    assert.ok(t >= prev - 1e-9, `monotone at s=${s.toFixed(1)} (${t} >= ${prev})`)
    prev = t
  }
})

test('sampleGradient honours the focal point (off-centre vs centred differ)', () => {
  const base = { type: 'radial' as const, cx: 50, cy: 50, r: 40, stops }
  const focal: RadialGradient = { ...base, fx: 78, fy: 50 }
  // A point near the centre: centred gives ~mid grey; the off-centre focal pulls
  // the near-focal-side offset lower (darker) — the two must visibly disagree.
  const p: [number, number] = [62, 50]
  const cCentred = sampleGradient(base, ...p)[0]
  const cFocal = sampleGradient(focal, ...p)[0]
  assert.notEqual(cFocal, cCentred, 'focal point changes the sampled colour')
})

test('gradientParamT clamps to [0,1] outside the circle', () => {
  const g: RadialGradient = { type: 'radial', cx: 0, cy: 0, r: 10, fx: 3, fy: 0, stops }
  assert.equal(gradientParamT(g, 1000, 1000), 1)
})
