// Unit tests for Oklab conversion (src/lib/trace/oklab.ts).
//
//   node --test test/oklab.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { srgbToOklab, oklabDeltaE, srgbDeltaEOk } from '../src/lib/trace/oklab.ts'

function near(a: number, b: number, tol = 0.004) {
  assert.ok(Math.abs(a - b) <= tol, `got ${a.toFixed(4)} want ~${b} (Δ ${Math.abs(a - b).toFixed(4)})`)
}

test('white and black map to the L axis extremes', () => {
  const w = srgbToOklab(255, 255, 255)
  near(w[0], 1.0)
  near(w[1], 0)
  near(w[2], 0)
  const k = srgbToOklab(0, 0, 0)
  near(k[0], 0)
  near(k[1], 0)
  near(k[2], 0)
})

test('primaries match Ottosson reference Oklab', () => {
  // Reference values from Ottosson's sRGB→Oklab.
  const red = srgbToOklab(255, 0, 0)
  near(red[0], 0.6279, 0.01)
  near(red[1], 0.2249, 0.01)
  near(red[2], 0.1258, 0.01)
  const green = srgbToOklab(0, 255, 0)
  near(green[0], 0.8664, 0.01)
  near(green[1], -0.2339, 0.01)
})

test('oklabDeltaE is zero for equal colors and grows with difference', () => {
  assert.equal(oklabDeltaE(srgbToOklab(10, 20, 30), srgbToOklab(10, 20, 30)), 0)
  const small = srgbDeltaEOk(100, 100, 100, 105, 100, 100)
  const big = srgbDeltaEOk(100, 100, 100, 200, 50, 250)
  assert.ok(big > small * 5, `big ${big} should dwarf small ${small}`)
})

test('black↔white ΔE is ~1.0 (the L-axis length)', () => {
  const d = srgbDeltaEOk(0, 0, 0, 255, 255, 255)
  assert.ok(Math.abs(d - 1) < 0.01, `black↔white Oklab ΔE ${d}`)
})
