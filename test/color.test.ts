// Unit tests for the harness colour science (src/devtest/color.ts).
//
//   node --test test/color.test.ts
//
// Reference CIELAB values are the standard sRGB→Lab (D65) conversions; we allow
// a small tolerance to absorb matrix-rounding differences between sources.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { srgbToLab, deltaE76, l1Lab, luma709 } from '../src/devtest/color.ts'

function assertLabNear(got: [number, number, number], want: [number, number, number], tol = 0.6) {
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(got[i] - want[i]) <= tol,
      `Lab[${i}]: got ${got[i].toFixed(3)} want ~${want[i]} (Δ ${Math.abs(got[i] - want[i]).toFixed(3)})`,
    )
  }
}

test('sRGB→Lab matches reference values for primaries', () => {
  assertLabNear(srgbToLab(255, 255, 255), [100, 0, 0])
  assertLabNear(srgbToLab(0, 0, 0), [0, 0, 0])
  assertLabNear(srgbToLab(255, 0, 0), [53.24, 80.09, 67.2])
  assertLabNear(srgbToLab(0, 255, 0), [87.74, -86.18, 83.18])
  assertLabNear(srgbToLab(0, 0, 255), [32.3, 79.19, -107.86])
  assertLabNear(srgbToLab(128, 128, 128), [53.59, 0, 0])
})

test('deltaE76 is zero for identical colors and symmetric', () => {
  const a = srgbToLab(120, 60, 200)
  const b = srgbToLab(120, 60, 200)
  assert.equal(deltaE76(a, b), 0)
  const c = srgbToLab(10, 200, 90)
  assert.ok(Math.abs(deltaE76(a, c) - deltaE76(c, a)) < 1e-9)
})

test('deltaE76 black↔white is ~100 (the L axis length)', () => {
  const d = deltaE76(srgbToLab(0, 0, 0), srgbToLab(255, 255, 255))
  assert.ok(Math.abs(d - 100) < 0.6, `black↔white ΔE ${d}`)
})

test('l1Lab is the sum of absolute channel diffs', () => {
  const a: [number, number, number] = [50, 10, -20]
  const b: [number, number, number] = [40, 30, -25]
  assert.equal(l1Lab(a, b), 10 + 20 + 5)
})

test('luma709 weights green most, blue least', () => {
  assert.ok(Math.abs(luma709(255, 255, 255) - 255) < 1e-9)
  assert.ok(luma709(0, 255, 0) > luma709(255, 0, 0))
  assert.ok(luma709(255, 0, 0) > luma709(0, 0, 255))
})
