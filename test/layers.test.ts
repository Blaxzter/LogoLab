// Unit tests for V6 translucent layer decomposition (src/lib/trace/layers.ts).
//
//   node --test test/layers.test.ts
//
// Builds synthetic scenes of N translucent circles over a flat background — the
// exact alpha-over composite, segmented into its exclusive/overlap regions — and
// asserts decomposeTranslucent recovers the original {colour, α} and reproduces
// every region. Plus: determinism, and that images with NO translucent structure
// (flat, or non-overlapping shapes) yield a no-op (null).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decomposeTranslucent, DEFAULT_DECOMPOSE_OPTIONS } from '../src/lib/trace/layers.ts'
import type { RegionSamples } from '../src/lib/trace/gradient.ts'
import type { PaletteColor } from '../src/lib/trace/types'

type RGB = [number, number, number]
interface Circle { cx: number; cy: number; r: number; color: RGB }

/** Build the segmented inputs (labels/palette/counts/fullSamples) for N circles
 *  at shared opacity α over `bg`, composited in array order (first = bottom). The
 *  region of a pixel is its exact covering-set; flat regions ⇒ palette = the exact
 *  composite colour — i.e. what a perfect segmentation would hand decompose. */
function scene(W: number, H: number, bg: RGB, alpha: number, circles: Circle[]) {
  const over = (x: RGB, c: RGB): RGB => [alpha * c[0] + (1 - alpha) * x[0], alpha * c[1] + (1 - alpha) * x[1], alpha * c[2] + (1 - alpha) * x[2]]
  // Map each distinct covering-set (as a sorted bitmask) → region label. bg (empty
  // set) is forced to label 0 so it is the border-dominant background.
  const labelOf = new Map<number, number>()
  labelOf.set(0, 0)
  let next = 1
  const labels = new Int32Array(W * H)
  const sums: number[][] = [[0, 0, 0]]
  const cnts: number[] = [0]
  const xsA: number[][] = [[]]
  const ysA: number[][] = [[]]
  const rsA: number[][] = [[]]
  const gsA: number[][] = [[]]
  const bsA: number[][] = [[]]
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let mask = 0
      let col: RGB = [bg[0], bg[1], bg[2]]
      circles.forEach((c, i) => {
        if ((x - c.cx) ** 2 + (y - c.cy) ** 2 <= c.r * c.r) {
          mask |= 1 << i
          col = over(col, c.color)
        }
      })
      let lab = labelOf.get(mask)
      if (lab === undefined) {
        lab = next++
        labelOf.set(mask, lab)
        sums.push([0, 0, 0]); cnts.push(0); xsA.push([]); ysA.push([]); rsA.push([]); gsA.push([]); bsA.push([])
      }
      labels[y * W + x] = lab
      const rr = Math.round(col[0]), gg = Math.round(col[1]), bb = Math.round(col[2])
      sums[lab][0] += rr; sums[lab][1] += gg; sums[lab][2] += bb; cnts[lab]++
      xsA[lab].push(x); ysA[lab].push(y); rsA[lab].push(rr); gsA[lab].push(gg); bsA[lab].push(bb)
    }
  }
  const palette: PaletteColor[] = sums.map((s, l) => ({ r: Math.round(s[0] / Math.max(1, cnts[l])), g: Math.round(s[1] / Math.max(1, cnts[l])), b: Math.round(s[2] / Math.max(1, cnts[l])) }))
  const full: RegionSamples[] = cnts.map((_, l) => ({
    xs: Float64Array.from(xsA[l]), ys: Float64Array.from(ysA[l]),
    rs: Float64Array.from(rsA[l]), gs: Float64Array.from(gsA[l]), bs: Float64Array.from(bsA[l]), n: cnts[l],
  }))
  return { labels, width: W, height: H, palette, counts: cnts, full }
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
const colorNear = (got: RGB, want: RGB, tol = 4) => near(got[0], want[0], tol) && near(got[1], want[1], tol) && near(got[2], want[2], tol)
const hexToRgb = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

test('two translucent circles → 2 shapes with recovered {colour, α}', () => {
  const A: RGB = [40, 90, 220]
  const B: RGB = [230, 70, 60]
  const s = scene(160, 160, [255, 255, 255], 0.75, [
    { cx: 70, cy: 80, r: 46, color: A },
    { cx: 100, cy: 80, r: 46, color: B },
  ])
  const dec = decomposeTranslucent(s.labels, s.width, s.height, s.palette, s.counts, s.full)
  assert.ok(dec, 'decomposition fires on two overlapping translucent circles')
  assert.equal(dec!.shapes.length, 2)
  assert.ok(near(dec!.debug.alpha, 0.75, 0.04), `alpha ≈ 0.75, got ${dec!.debug.alpha}`)
  const colors = dec!.shapes.map((sh) => hexToRgb(sh.color))
  assert.ok(colors.some((c) => colorNear(c, A)), `recovered a colour ≈ ${A}`)
  assert.ok(colors.some((c) => colorNear(c, B)), `recovered a colour ≈ ${B}`)
})

test('three translucent circles → 3 shapes, correct colours, all regions consumed', () => {
  const A: RGB = [99, 102, 241]
  const B: RGB = [236, 72, 153]
  const C: RGB = [14, 165, 233]
  const s = scene(200, 200, [255, 255, 255], 0.85, [
    { cx: 100, cy: 72, r: 52, color: A },
    { cx: 72, cy: 128, r: 52, color: B },
    { cx: 128, cy: 128, r: 52, color: C },
  ])
  const dec = decomposeTranslucent(s.labels, s.width, s.height, s.palette, s.counts, s.full)
  assert.ok(dec, 'decomposition fires on three overlapping translucent circles')
  assert.equal(dec!.shapes.length, 3)
  assert.ok(near(dec!.debug.alpha, 0.85, 0.04), `alpha ≈ 0.85, got ${dec!.debug.alpha}`)
  const colors = dec!.shapes.map((sh) => hexToRgb(sh.color))
  for (const want of [A, B, C]) assert.ok(colors.some((c) => colorNear(c, want)), `recovered ≈ ${want}`)
  // The composite reproduces the regions: full-region residual is tiny.
  assert.ok(dec!.debug.transMeanDE < 2, `translucent residual small, got ${dec!.debug.transMeanDE}`)
})

test('deterministic: identical inputs → identical decomposition', () => {
  const s = scene(160, 160, [250, 250, 250], 0.8, [
    { cx: 68, cy: 80, r: 44, color: [30, 160, 90] },
    { cx: 96, cy: 80, r: 44, color: [200, 60, 160] },
  ])
  const a = decomposeTranslucent(s.labels, s.width, s.height, s.palette, s.counts, s.full)
  const b = decomposeTranslucent(s.labels, s.width, s.height, s.palette, s.counts, s.full)
  assert.deepEqual(a, b)
})

test('no translucent structure: a single flat region → no-op (null)', () => {
  const s = scene(120, 120, [240, 240, 240], 1, []) // no circles → just bg
  assert.equal(decomposeTranslucent(s.labels, s.width, s.height, s.palette, s.counts, s.full), null)
})

test('no translucent structure: two NON-overlapping shapes → no-op (null)', () => {
  // bg + two opaque-ish shapes that never overlap ⇒ no overlap region ⇒ nothing to
  // decompose. (A real overlap is what the decomposition needs.)
  const s = scene(200, 120, [255, 255, 255], 0.8, [
    { cx: 45, cy: 60, r: 38, color: [40, 90, 220] },
    { cx: 155, cy: 60, r: 38, color: [230, 70, 60] },
  ])
  assert.equal(decomposeTranslucent(s.labels, s.width, s.height, s.palette, s.counts, s.full), null)
})

test('no background (no opaque border) → no-op (null)', () => {
  // One big shape covering the whole frame ⇒ the border isn't a distinct bg.
  const s = scene(120, 120, [255, 255, 255], 0.8, [{ cx: 60, cy: 60, r: 200, color: [40, 90, 220] }])
  assert.equal(decomposeTranslucent(s.labels, s.width, s.height, s.palette, s.counts, s.full), null)
})

test('options are respected: an absurd maxResidual=0 rejects everything', () => {
  const s = scene(160, 160, [255, 255, 255], 0.75, [
    { cx: 70, cy: 80, r: 46, color: [40, 90, 220] },
    { cx: 100, cy: 80, r: 46, color: [230, 70, 60] },
  ])
  const dec = decomposeTranslucent(s.labels, s.width, s.height, s.palette, s.counts, s.full, { ...DEFAULT_DECOMPOSE_OPTIONS, maxResidual: 0 })
  assert.equal(dec, null)
})
