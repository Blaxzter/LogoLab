// Maskable safe-zone geometry (src/lib/pwaExport.ts) — issue #30.
//
//   node --test test/pwa-maskable.test.ts
//
// Android's adaptive-icon mask keeps the centre 72dp of 108dp: a CIRCLE of
// 66.7% diameter. renderIcon draws the logo `contain` inside a SQUARE inset
// box, so what has to fit the circle is the drawn rect's half-DIAGONAL, not its
// half-width. These tests drive the real renderIcon through a stub canvas and
// measure that half-diagonal — the "max ink radius" of the issue's table.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MASKABLE_SAFE_DIAMETER,
  MASKABLE_MIN_PADDING_PCT,
  MASKABLE_PADDING_FLOOR_PCT,
  renderIcon,
} from '../src/lib/pwaExport.ts'
import type { RenderIconOpts } from '../src/lib/pwaExport.ts'

/** Safe radius as a fraction of the icon's width. */
const SAFE_R = MASKABLE_SAFE_DIAMETER / 2

/**
 * Minimal `document.createElement('canvas')` stand-in: enough of the 2D context
 * for renderIcon to run headless, recording the destination rect it draws the
 * logo into.
 */
type Drawn = { dx: number; dy: number; cw: number; ch: number }

function withStubCanvas<T>(fn: () => T): { result: T; drawn: Drawn[] } {
  const drawn: Drawn[] = []
  const ctx = {
    fillStyle: '',
    filter: '',
    globalCompositeOperation: '',
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    arcTo() {},
    fill() {},
    fillRect() {},
    clip() {},
    drawImage(_src: unknown, dx: number, dy: number, cw: number, ch: number) {
      drawn.push({ dx, dy, cw, ch })
    },
  }
  const doc = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  }
  const prev = (globalThis as { document?: unknown }).document
  ;(globalThis as { document?: unknown }).document = doc
  try {
    return { result: fn(), drawn }
  } finally {
    ;(globalThis as { document?: unknown }).document = prev
  }
}

const BASE: Omit<RenderIconOpts, 'size'> = {
  background: '#ffffff',
  shape: 'rounded',
  radiusPct: 24,
  paddingPct: 10, // defaultAppearance
  scale: 0.85, // defaultAppearance
}

/**
 * Max ink radius of an export, as a fraction of the icon width: the half-
 * diagonal of the drawn rect, i.e. where corner-filling art actually lands.
 */
function inkRadiusFrac(opts: Partial<RenderIconOpts>, srcW = 512, srcH = 512): number {
  const size = 512
  const { drawn } = withStubCanvas(() =>
    renderIcon({} as unknown as CanvasImageSource, srcW, srcH, { ...BASE, size, ...opts }),
  )
  assert.equal(drawn.length, 1, 'expected exactly one logo draw')
  const { cw, ch } = drawn[0]
  return Math.hypot(cw, ch) / 2 / size
}

test('the safe zone is Android’s 66.7% circle, not the spec’s 80%', () => {
  assert.ok(Math.abs(MASKABLE_SAFE_DIAMETER - 2 / 3) < 1e-12)
  // (1 − D·√½)/2 — the padding at which a square box's corners touch the circle.
  assert.ok(Math.abs(MASKABLE_MIN_PADDING_PCT - 26.43) < 0.01, `${MASKABLE_MIN_PADDING_PCT}`)
  assert.ok(
    MASKABLE_PADDING_FLOOR_PCT >= MASKABLE_MIN_PADDING_PCT,
    'the shipped floor must clear the geometric minimum',
  )
  // The old 18% floor was short even against the spec's 80% circle (21.7%).
  assert.ok(MASKABLE_MIN_PADDING_PCT > 18)
})

test('a corner-filling square mark stays inside the mask at the defaults', () => {
  // The issue's regression: 35.4% of width at the old 18% floor, mask cuts at 33.3%.
  const r = inkRadiusFrac({ maskable: true })
  assert.ok(r <= SAFE_R, `ink radius ${(r * 100).toFixed(1)}% > safe ${(SAFE_R * 100).toFixed(1)}%`)
  // …and with visible margin rather than flush against the mask edge.
  assert.ok(r < SAFE_R - 0.03, `ink radius ${(r * 100).toFixed(1)}% leaves no visible margin`)
})

test('the safe circle survives every padding × scale the sliders allow', () => {
  for (let padding = 0; padding <= 35; padding++) {
    for (let scale = 0.3; scale <= 1.2001; scale += 0.05) {
      for (const [w, h] of [
        [512, 512],
        [1024, 256],
        [256, 1024],
      ]) {
        const r = inkRadiusFrac({ maskable: true, paddingPct: padding, scale }, w, h)
        assert.ok(
          r <= SAFE_R + 1e-9,
          `padding ${padding}% scale ${scale.toFixed(2)} ${w}x${h}: ink radius ${(r * 100).toFixed(1)}%`,
        )
      }
    }
  }
})

test('the clamp is aspect-aware — wide art is not shrunk to the square limit', () => {
  const size = 512
  const wide = withStubCanvas(() =>
    renderIcon({} as unknown as CanvasImageSource, 1024, 256, {
      ...BASE,
      size,
      maskable: true,
      paddingPct: 0,
      scale: 1.2,
    }),
  ).drawn[0]
  // A square box clamped by its corners would cap the width at D·√½ = 47.1%;
  // a 4:1 rect fits far more width inside the same circle before its corners do.
  assert.ok(wide.cw / size > MASKABLE_SAFE_DIAMETER * Math.SQRT1_2, `cw ${(wide.cw / size) * 100}%`)
  assert.ok(wide.cw / size <= MASKABLE_SAFE_DIAMETER + 1e-9)
})

test('non-maskable targets are untouched by the floor and the clamp', () => {
  const size = 512
  const { drawn } = withStubCanvas(() =>
    renderIcon({} as unknown as CanvasImageSource, 512, 512, { ...BASE, size, paddingPct: 0, scale: 1.2 }),
  )
  assert.equal(drawn[0].cw, size * 1.2)
})
