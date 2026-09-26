// A small DISC is a circle, not a polygon. The ±win chord reading mints 2–5 corners on
// the staircase of any disc under r ≈ 6px, the loop was fitted corner-first, and the
// beautify corner veto then refused the circle snap — sheet music's i-dots and repeat
// dots traced as lumpy polygons (planarFit `discExplainsLoop`). The veto against that
// is itself a §9.8 hazard (a small square is radially close to a circle), so this gates
// BOTH sides: discs lose their false corners, squares/diamonds keep their real ones.
//
//   node --test test/small-disc-loops.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { detectLoopCorners, discExplainsLoop, DEFAULT_PLANAR_FIT } from '../src/lib/trace/planarFit.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import type { Vec } from '../src/lib/path/types'

type Inside = (x: number, y: number) => boolean

/** 4×4-supersampled coverage cut at 0.5, crack-followed into the lattice loop the
 *  planar network hands the fitter. */
function latticeLoop(inside: Inside, cx: number, cy: number, reach: number): Vec[] {
  const S = Math.ceil(reach) + 3
  const N = 2 * S
  const ox = Math.floor(cx) - S
  const oy = Math.floor(cy) - S
  const ink = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= N || y >= N) return false
    let c = 0
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) if (inside(ox + x + (a + 0.5) / 4, oy + y + (b + 0.5) / 4)) c++
    return c >= 8
  }
  let sx = -1
  let sy = -1
  outer: for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (ink(x, y)) { sx = x; sy = y; break outer }
  const pts: Vec[] = []
  let x = sx
  let y = sy
  let dx = 1
  let dy = 0
  do {
    pts.push({ x: x + ox, y: y + oy })
    const pix = (ex: number, ey: number, side: number): boolean =>
      ink(Math.floor(x + ex * 0.5 - ey * 0.5 * side), Math.floor(y + ey * 0.5 + ex * 0.5 * side))
    let moved = false
    for (const [ex, ey] of [[-dy, dx], [dx, dy], [dy, -dx]]) {
      if (pix(ex, ey, 1) && !pix(ex, ey, -1)) { dx = ex; dy = ey; x += dx; y += dy; moved = true; break }
    }
    if (!moved) break
  } while (x !== sx || y !== sy)
  return pts
}

const disc = (cx: number, cy: number, r: number): Inside => (x, y) => Math.hypot(x - cx, y - cy) <= r
const polygon = (cx: number, cy: number, r: number, n: number, rot: number): Inside => {
  const P = Array.from({ length: n }, (_, k) => [cx + r * Math.cos(rot + (2 * Math.PI * k) / n), cy + r * Math.sin(rot + (2 * Math.PI * k) / n)])
  return (x, y) => {
    let ins = false
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = P[i]
      const [xj, yj] = P[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins
    }
    return ins
  }
}

const PHASES: [number, number][] = Array.from({ length: 16 }, (_, i) => [(i * 0.37) % 1, (i * 0.61) % 1])
const { cornerTurnDeg, cornerWindow, cornerMerge } = DEFAULT_PLANAR_FIT

/** Loops (over the phases) that still carry ≥2 corners after the disc veto. */
function corneredAfterVeto(make: (cx: number, cy: number) => Inside, reach: number): number {
  let n = 0
  for (const [px, py] of PHASES) {
    const pts = latticeLoop(make(50 + px, 50 + py), 50 + px, 50 + py, reach)
    const c = detectLoopCorners(pts, cornerTurnDeg, cornerWindow, cornerMerge)
    if (c.length >= 2 && !discExplainsLoop(pts, c)) n++
  }
  return n
}

test('small discs: the false staircase corners are vetoed', () => {
  // 7px is the weak size (the arm test ties there on some phases); every other size
  // measured loses all or all-but-one of its false corners.
  for (const d of [5, 6, 8, 9, 10, 11, 12]) {
    const left = corneredAfterVeto((cx, cy) => disc(cx, cy, d / 2), d / 2)
    assert.ok(left <= 1, `${d}px disc: ${left}/16 phases still cornered`)
  }
})

test('small polygons: squares ≥7px, diamonds and rotated squares keep their corners (§9.8)', () => {
  for (const s of [7, 8, 10, 12, 16]) {
    assert.equal(corneredAfterVeto((cx, cy) => polygon(cx, cy, s / Math.SQRT2, 4, Math.PI / 4), s), 16, `${s}px square rounded`)
  }
  for (const s of [5, 6, 7, 8, 10, 12, 16]) {
    assert.equal(corneredAfterVeto((cx, cy) => polygon(cx, cy, s / Math.SQRT2, 4, 0), s), 16, `${s}px diamond rounded`)
  }
  for (const rot of [0.35, 0.52]) for (const s of [8, 10, 12]) {
    assert.equal(corneredAfterVeto((cx, cy) => polygon(cx, cy, s / Math.SQRT2, 4, Math.PI / 4 + rot), s), 16, `${s}px square @${rot} rounded`)
  }
  for (const s of [10, 12, 16]) {
    assert.equal(corneredAfterVeto((cx, cy) => polygon(cx, cy, s / 2, 3, -Math.PI / 2), s), 16, `${s}px triangle rounded`)
  }
})

// One size per trace, several phases — how dots occur in real art (one font, one staff).
// Mixed sizes 0.5px apart would be chained into one radius by planarBeautify's
// equal-radius relation solver, which is a different question from this one.
// KNOWN MISS, deliberately not among the phases: a 9px disc centred EXACTLY on a pixel
// corner rasterizes (50% pixels cut to paper) as an 8×8 square minus its four corner
// pixels — four straight arms, arm RMS 0.35 vs circle 0.36 — and keeps its corners. Only
// the AA could tell it from a notched square. Every dot on the hymn sheet this came from
// is off that tie and traces round.
for (const d of [9, 10, 11, 12]) test(`mono trace: ${d}px dots come back as circles, not corner polygons`, async () => {
  ensureImageData()
  const W = 160
  const H = 60
  const data = new Uint8ClampedArray(W * H * 4).fill(255)
  const dots = [
    [0.3, 0.15],
    [0.25, 0.6],
    [0.75, 0.33],
    [0.5, 0.9],
  ].map(([px, py], i) => ({ cx: 20 + i * 38 + px, cy: 30 + py, r: d / 2 }))
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let cov = 0
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
      const sx = x + (a + 0.5) / 4
      const sy = y + (b + 0.5) / 4
      if (dots.some((q) => Math.hypot(sx - q.cx, sy - q.cy) <= q.r)) cov++
    }
    const v = Math.round(255 * (1 - cov / 16))
    data.set([v, v, v, 255], (y * W + x) * 4)
  }
  const doc = await traceImage({ width: W, height: H, data } as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, mode: 'mono' })
  const nodes = doc.items.flatMap((it) => (it.kind === 'path' ? it.subPaths.flatMap((sp) => sp.nodes) : []))
  for (const q of dots) {
    const mine = nodes.filter((n) => Math.hypot(n.x - q.cx, n.y - q.cy) < q.r + 2)
    assert.ok(mine.length > 0, `dot r=${q.r} missing`)
    // A snapped circle is four smooth nodes; the polygon failure is corner nodes.
    const corners = mine.filter((n) => n.kind === 'corner').length
    assert.equal(corners, 0, `dot r=${q.r}: ${corners} corner nodes (${mine.length} total)`)
    for (const n of mine) {
      const off = Math.abs(Math.hypot(n.x - q.cx, n.y - q.cy) - q.r)
      assert.ok(off < 0.6, `dot r=${q.r}: node ${off.toFixed(2)}px off the authored circle`)
    }
  }
})
