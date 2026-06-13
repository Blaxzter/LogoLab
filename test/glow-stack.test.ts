// Unit tests for the V4 glow-stack decomposition (gradient.ts §3.2.4).
//
//   node --test test/glow-stack.test.ts
//
// A 2-D colour field (a base ramp PLUS a localized radial glow) cannot be fit by
// any single SVG gradient; fitGlowStack peels the glow into a translucent radial
// overlay above the base. These tests build synthetic fields and check the
// decomposition recovers the glow, leaves flat/linear fields alone, composites
// the way the rasterizer does, and is deterministic.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fitGlowStack,
  sampleGlowStack,
  type RegionSamples,
  type GlowStack,
} from '../src/lib/trace/gradient.ts'
import type { LinearGradient } from '../src/lib/path/types.ts'
import { srgbToLab, deltaE76 } from '../src/lib/trace/lab.ts'

const W = 80
const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)

/** A grey horizontal ramp 32→128 as a base LinearGradient. */
const BASE: LinearGradient = {
  type: 'linear',
  x1: 0,
  y1: W / 2,
  x2: W,
  y2: W / 2,
  stops: [
    { offset: 0, color: '#202020' },
    { offset: 1, color: '#808080' },
  ],
}
const baseGrey = (x: number) => 32 + (96 * x) / W

/** Sample the W×W field built by `color(x,y)` into RegionSamples. */
function field(color: (x: number, y: number) => [number, number, number]): RegionSamples {
  const n = W * W
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const rs = new Float64Array(n)
  const gs = new Float64Array(n)
  const bs = new Float64Array(n)
  let k = 0
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
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

const meanLab = (s: RegionSamples, ev: (x: number, y: number) => [number, number, number]) => {
  let sum = 0
  for (let i = 0; i < s.n; i++) {
    const [pr, pg, pb] = ev(s.xs[i], s.ys[i])
    sum += deltaE76(srgbToLab(s.rs[i], s.gs[i], s.bs[i]), srgbToLab(pr, pg, pb))
  }
  return sum / s.n
}

// --- recovery ---------------------------------------------------------------

test('a base ramp + radial glow is decomposed into base + a radial overlay', () => {
  const cx = 40
  const cy = 40
  const sigma = 14
  const sample = (x: number, y: number): [number, number, number] => {
    const g = baseGrey(x)
    const amt = 70 * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma * sigma))
    return [clamp(g + amt), clamp(g), clamp(g)] // glow reddens toward the centre
  }
  const s = field(sample)
  const stack = fitGlowStack(s, s, BASE)
  assert.ok(stack, 'a glow should be detected')
  assert.ok(stack!.overlays.length >= 1, 'at least one overlay')
  const ov = stack!.overlays[0]
  assert.ok(Math.abs(ov.cx - cx) < 8 && Math.abs(ov.cy - cy) < 8, `overlay centred near glow, got [${ov.cx},${ov.cy}]`)
  assert.ok(ov.type === 'radial' && ov.stops[ov.stops.length - 1].opacity === 0, 'rim fades to opacity 0')
  // The composite must fit the field better than the base alone.
  const baseRes = meanLab(s, (x, y) => sampleGradient3(BASE, x, y))
  const glowRes = meanLab(s, (x, y) => sampleGlowStack(stack!, x, y))
  assert.ok(glowRes < baseRes - 1, `glow cuts residual (${baseRes.toFixed(2)} → ${glowRes.toFixed(2)})`)
})

test('a pure linear ramp (no glow) yields no overlay', () => {
  const s = field((x) => [baseGrey(x), baseGrey(x), baseGrey(x)])
  const stack = fitGlowStack(s, s, BASE)
  assert.equal(stack, null, 'a flat-residual field must not invent a glow')
})

// --- compositing matches the rasterizer's alpha-over -------------------------

test('sampleGlowStack composites base then overlay with straight alpha-over', () => {
  const stack: GlowStack = {
    base: { type: 'linear', x1: 0, y1: 0, x2: 100, y2: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#000000' }] },
    overlays: [
      { type: 'radial', cx: 50, cy: 50, r: 50, stops: [{ offset: 0, color: '#ffffff', opacity: 0.5 }, { offset: 1, color: '#ffffff', opacity: 0 }] },
    ],
  }
  // At the centre the overlay alpha is 0.5 over black → mid grey.
  const [r, g, b] = sampleGlowStack(stack, 50, 50)
  assert.ok(Math.abs(r - 127.5) < 1 && Math.abs(g - 127.5) < 1 && Math.abs(b - 127.5) < 1, `centre [${r},${g},${b}]`)
  // At the rim alpha is 0 → pure base (black).
  const rim = sampleGlowStack(stack, 100, 50)
  assert.ok(rim[0] < 1 && rim[1] < 1 && rim[2] < 1, `rim should be base colour, got [${rim}]`)
})

// --- determinism ------------------------------------------------------------

test('fitGlowStack is deterministic', () => {
  const cx = 30
  const cy = 50
  const sample = (x: number, y: number): [number, number, number] => {
    const g = baseGrey(x)
    const amt = 60 * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * 12 * 12))
    return [clamp(g), clamp(g), clamp(g + amt)] // blue glow
  }
  const a = fitGlowStack(field(sample), field(sample), BASE)
  const b = fitGlowStack(field(sample), field(sample), BASE)
  assert.deepEqual(a, b)
})

// A tiny local copy of the linear-gradient evaluator (the module's sampleGradient
// is also exported, but importing one symbol keeps this test self-contained).
function sampleGradient3(g: LinearGradient, x: number, y: number): [number, number, number] {
  const dx = g.x2 - g.x1
  const dy = g.y2 - g.y1
  const len2 = dx * dx + dy * dy || 1
  let t = ((x - g.x1) * dx + (y - g.y1) * dy) / len2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const a = g.stops[0]
  const b = g.stops[g.stops.length - 1]
  const hx = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
  return [
    hx(a.color, 0) + (hx(b.color, 0) - hx(a.color, 0)) * t,
    hx(a.color, 1) + (hx(b.color, 1) - hx(a.color, 1)) * t,
    hx(a.color, 2) + (hx(b.color, 2) - hx(a.color, 2)) * t,
  ]
}
