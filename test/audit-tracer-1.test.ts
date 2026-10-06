// healColorSpikes must be PASS-SYNCHRONOUS: every pass reads only the previous pass's
// labels. It used to be synchronous for pass 1 only — from pass 2 on it read and wrote
// one array, so a strand running +x/+y was swallowed in one pass while its mirror
// peeled one pixel per pass, and mirrored art healed differently under the 6-pass cap.
//
//   node --test test/audit-tracer-1.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { healColorSpikes } from '../src/lib/trace/index.ts'

const RED = { r: 220, g: 30, b: 30 }
const BLUE = { r: 30, g: 30, b: 220 }
const WHITE = { r: 255, g: 255, b: 255 }
const palette = [RED, BLUE, WHITE]

/** A 1px strand of BLUE-coloured pixels mislabelled RED (0), anchored on a BLUE (1)
 *  pixel at one end and a true RED pixel at the other, between WHITE (2) rows. */
function strand(width: number, rightward: boolean) {
  const height = 3
  const labels = new Int32Array(width * height).fill(2)
  const data = new Uint8ClampedArray(width * height * 4)
  const put = (x: number, y: number, lab: number, c: { r: number; g: number; b: number }) => {
    const i = y * width + x
    labels[i] = lab
    data.set([c.r, c.g, c.b, 255], i * 4)
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, 2, WHITE)
  for (let k = 0; k < width; k++) {
    const x = rightward ? k : width - 1 - k
    if (k === 0)
      put(x, 1, 1, BLUE) // the region the strand really belongs to
    else if (k === width - 1)
      put(x, 1, 0, RED) // the region it was mis-grouped into
    else put(x, 1, 0, BLUE)
  }
  return { labels, data, width, height }
}

const row = (labels: Int32Array, width: number) => Array.from(labels.subarray(width, 2 * width))

test('healColorSpikes heals a strand and its mirror image identically', () => {
  const W = 14 // 12 mislabelled pixels: longer than the 6-pass cap
  const r = strand(W, true)
  const l = strand(W, false)
  const outR = row(healColorSpikes(r.labels, r.data, r.width, r.height, palette), W)
  const outL = row(healColorSpikes(l.labels, l.data, l.width, l.height, palette), W)
  assert.deepEqual(outL.slice().reverse(), outR, 'mirrored art must heal as the mirror image')
})

test('healColorSpikes peels one pixel per pass (pass-synchronous)', () => {
  const W = 14
  const r = strand(W, true)
  const out = row(healColorSpikes(r.labels, r.data, r.width, r.height, palette), W)
  // anchor + 6 peeled pixels are BLUE; the remaining 6 strand pixels + the RED end stay 0
  assert.deepEqual(out, [1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0])
})

test('healColorSpikes returns the input itself when nothing moves', () => {
  const W = 6
  const labels = new Int32Array(W * 3).fill(2)
  const data = new Uint8ClampedArray(W * 3 * 4).fill(255)
  assert.equal(healColorSpikes(labels, data, W, 3, palette), labels)
})
