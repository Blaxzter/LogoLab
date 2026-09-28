// "Reset" in the vectorize studio restores what a fresh upload of the image gets,
// which is not the bare defaults: the ink and rampiness probes decide per image.
//
//   node --test test/fresh-settings.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshSettings, sameSettings } from '../src/components/vectorize/studio/freshSettings.ts'
import { DEFAULT_VECTORIZE_OPTIONS, suggestGradients } from '../src/lib/trace/index.ts'
import { applyInkMode, decideInkMode } from '../src/lib/traceInput/ink.ts'
import type { VectorizeOptions } from '../src/types.ts'

type RGBA = [number, number, number, number]

/** A `w`×`h` image on `bg` with one filled rect of `ink`, typed as the probe's raster. */
function art(w: number, h: number, bg: RGBA, ink: RGBA): ImageData {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set(bg, i * 4)
  for (let y = h >> 2; y < h - (h >> 2); y++) {
    for (let x = w >> 2; x < w - (w >> 2); x++) data.set(ink, (y * w + x) * 4)
  }
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData
}

const BASE = DEFAULT_VECTORIZE_OPTIONS

test('before the probe lands, reset is the base options in the starting mode', () => {
  const f = freshSettings(BASE, 'auto', null, true)
  assert.deepEqual(f.opts, BASE)
  assert.equal(f.colorMode, 'auto')
  assert.equal(f.forceColorOn, false)
  assert.equal(f.forceColor, null)
})

test('one dark ink: mono with the measured cut, no recolour (the ink is black)', () => {
  const img = art(64, 64, [255, 255, 255, 255], [20, 20, 20, 255])
  const f = freshSettings(BASE, 'auto', img, true)
  assert.equal(f.opts.mode, 'mono')
  assert.equal(f.opts.invert, false)
  assert.notEqual(f.opts.threshold, BASE.threshold, 'the cut is measured, not the 128 default')
  assert.equal(f.forceColorOn, false)
})

test('light ink on dark paper: inverted mono, recoloured in the ink', () => {
  const img = art(64, 64, [16, 24, 56, 255], [255, 255, 255, 255])
  const f = freshSettings(BASE, 'auto', img, true)
  assert.equal(f.opts.mode, 'mono')
  assert.equal(f.opts.invert, true)
  assert.equal(f.forceColorOn, true)
  assert.equal(f.forceColor, '#ffffff')
})

test('matches what the two probes apply to a fresh image', () => {
  const img = art(64, 64, [255, 255, 255, 255], [200, 30, 30, 255])
  const probe = applyInkMode(BASE, decideInkMode(img, BASE.threshold, { colorMode: 'auto' }))
  const expected = { ...probe, gradients: suggestGradients(img) }
  assert.deepEqual(freshSettings(BASE, 'auto', img, true).opts, expected)
})

test("a host's plan keeps its gradients decision when the probe is not asked", () => {
  const img = art(64, 64, [255, 255, 255, 255], [20, 20, 20, 255])
  const plan: VectorizeOptions = { ...BASE, gradients: true, smoothing: 30 }
  const f = freshSettings(plan, 'auto', img, false)
  assert.equal(f.opts.gradients, true)
  assert.equal(f.opts.smoothing, 30)
})

test('sameSettings ignores markers and compares nested overrides by value', () => {
  const a: VectorizeOptions = { ...BASE, planarFit: { epsilon: 0.5 } }
  const b: VectorizeOptions = { ...BASE, planarFit: { epsilon: 0.5 }, markers: [{ x: 0.5, y: 0.5 }] }
  assert.ok(sameSettings(a, b))
  assert.ok(!sameSettings(a, { ...a, smoothing: 51 }))
  assert.ok(!sameSettings(a, { ...a, planarFit: { epsilon: 0.6 } }))
  assert.ok(sameSettings({ ...BASE, invert: undefined }, BASE), 'an explicit undefined equals an absent key')
  assert.ok(!sameSettings({ ...BASE, invert: true }, BASE))
})
