// Unit tests for the sub-pixel marching-squares + Schneider tracer.
//
//   node --test test/subpixel.test.ts
//
// ImageData isn't available in Node, but traceMaskCrisp only reads
// {width,height,data}, so a plain object stands in.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { traceMaskCrisp, type CrispOptions } from '../src/lib/trace/subpixel.ts'
import type { SubPath, Vec } from '../src/lib/path/types.ts'

const OPTS: CrispOptions = {
  smooth: 0,
  turdsize: 8,
  cornerThreshold: 55,
  simplifyEpsilon: 0.75,
  fitTolerance: 0.8,
}

/** Build a potrace-style mask (inside = black) from an inside-predicate. */
function mask(w: number, h: number, inside: (x: number, y: number) => boolean): ImageData {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = inside(x, y) ? 0 : 255
      const o = (y * w + x) * 4
      data[o] = v
      data[o + 1] = v
      data[o + 2] = v
      data[o + 3] = 255
    }
  }
  return { width: w, height: h, data } as unknown as ImageData
}

function bbox(sp: SubPath): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of sp.nodes) {
    minX = Math.min(minX, node.x)
    minY = Math.min(minY, node.y)
    maxX = Math.max(maxX, node.x)
    maxY = Math.max(maxY, node.y)
  }
  return { minX, minY, maxX, maxY }
}

const countCorners = (sp: SubPath): number => sp.nodes.filter((n) => n.kind === 'corner').length
const isStraight = (sp: SubPath): boolean => sp.nodes.every((n) => !n.hIn && !n.hOut)

test('axis-aligned square → 1 closed loop, 4 corners, straight edges', () => {
  const sps = traceMaskCrisp(
    mask(80, 80, (x, y) => x >= 20 && x < 60 && y >= 20 && y < 60),
    OPTS,
  )
  assert.equal(sps.length, 1)
  assert.equal(sps[0].closed, true)
  assert.equal(sps[0].nodes.length, 4, `want 4 nodes, got ${sps[0].nodes.length}`)
  assert.equal(countCorners(sps[0]), 4)
  assert.ok(isStraight(sps[0]), 'square edges should be straight lines (null handles)')
  const b = bbox(sps[0])
  assert.ok(Math.abs(b.minX - 19.5) < 1.2 && Math.abs(b.minY - 19.5) < 1.2, `min ${b.minX},${b.minY}`)
  assert.ok(Math.abs(b.maxX - 59.5) < 1.2 && Math.abs(b.maxY - 59.5) < 1.2, `max ${b.maxX},${b.maxY}`)
})

test('filled circle → 1 smooth low-node loop with no hard corners', () => {
  const cx = 40
  const cy = 40
  const r = 28
  const sps = traceMaskCrisp(
    mask(80, 80, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r),
    { ...OPTS, smooth: 0.8 },
  )
  assert.equal(sps.length, 1)
  assert.equal(sps[0].closed, true)
  // A circle should fit in a handful of cubic nodes — far fewer than the
  // hundred-odd marching-squares vertices.
  assert.ok(sps[0].nodes.length <= 12, `circle node count ${sps[0].nodes.length} should be small`)
  assert.equal(countCorners(sps[0]), 0, 'a circle has no hard corners')
  // Every anchor sits on the circle (the curve itself reaches the extremes
  // between anchors, so an anchor bbox would under-report the radius).
  let worst = 0
  for (const node of sps[0].nodes) worst = Math.max(worst, Math.abs(Math.hypot(node.x - cx, node.y - cy) - r))
  assert.ok(worst < 1.6, `anchors should lie on the circle, worst ${worst.toFixed(2)}px`)
  // And the loop spans essentially the whole diameter.
  const b = bbox(sps[0])
  assert.ok(b.maxX - b.minX > 2 * r - 8, `span ${(b.maxX - b.minX).toFixed(1)} too small`)
})

test('square with a square hole → two loops (outer + hole)', () => {
  const sps = traceMaskCrisp(
    mask(
      100,
      100,
      (x, y) =>
        x >= 15 && x < 85 && y >= 15 && y < 85 && !(x >= 40 && x < 60 && y >= 40 && y < 60),
    ),
    OPTS,
  )
  assert.equal(sps.length, 2, `want outer + hole, got ${sps.length}`)
  // Both are closed; one bbox contains the other.
  const areas = sps.map((sp) => {
    const b = bbox(sp)
    return (b.maxX - b.minX) * (b.maxY - b.minY)
  })
  assert.ok(Math.max(...areas) > Math.min(...areas) * 4, 'outer should be much larger than hole')
})

test('speck below turdsize is dropped', () => {
  const sps = traceMaskCrisp(
    mask(60, 60, (x, y) => x >= 30 && x < 32 && y >= 30 && y < 32), // area 4 < turdsize 8
    OPTS,
  )
  assert.equal(sps.length, 0)
})

test('fitted curve stays close to the source circle (max error bound)', () => {
  const cx = 50
  const cy = 50
  const r = 35
  const sps = traceMaskCrisp(
    mask(100, 100, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r),
    { ...OPTS, smooth: 0.8, fitTolerance: 0.6 },
  )
  assert.equal(sps.length, 1)
  // Sample anchors + handles: every anchor should sit ~on the circle.
  const onCircle = (p: Vec) => Math.abs(Math.hypot(p.x - cx, p.y - cy) - r)
  let worst = 0
  for (const node of sps[0].nodes) worst = Math.max(worst, onCircle(node))
  assert.ok(worst < 2, `anchors should sit on the circle, worst deviation ${worst.toFixed(2)}px`)
})
