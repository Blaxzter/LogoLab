// §14 — contrast rank: a WEAK colour boundary must not aim a STRONG one
// (src/lib/trace/planarThread.ts).
//
// Flat-tracing ramp art posterizes it into bands, and a band seam that ends on a real
// logo edge plants a junction there. A junction is an INTEGER lattice corner, so the
// real edge — sub-pixel, and carrying 100+px of its own staircase evidence — is pinned
// to the seam's rounding: it does not step, it ROTATES (0.98px end to end on the
// user-reported Affinity mark). The fix places such a junction on a fit taken THROUGH
// it from both strong arms' raw lattice chains, before anything is fitted.
//
// The fixture is the mechanism at its smallest: one sub-pixel diagonal boundary between
// two strongly different colours, cut by a vertical seam between two nearly equal ones.
// Nothing here depends on the raster having anti-aliasing — the defect is the lattice
// quantization of the junction, which a label map has by construction.
//
// Asserts: the seam junction lands on the true edge (not on the lattice corner it was
// quantized to), the edge it lands on straightens, the SAME junction is left alone when
// the third arm is a real corner rather than a continuation, the colour rank is what
// drives it (equal contrast ⇒ no move), and the whole pass is off without a palette.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tracePlanar } from '../src/lib/trace/planarAssemble.ts'
import { DEFAULT_PLANAR_FIT } from '../src/lib/trace/planarFit.ts'
import type { Vec } from '../src/lib/path/types.ts'

const W = 96
const H = 96
/** The authored boundary: y = SLOPE·x + Y0 — deliberately off the lattice. */
const SLOPE = 0.37
const Y0 = 30.62
/** …cut by a vertical band seam at this column. */
const SEAM_X = 48

const NAVY = { r: 19, g: 72, b: 129 } // the mark's colour: ΔE ~50 from the light side
const LIGHT = { r: 67, g: 197, b: 250 }
const BAND = { r: 73, g: 201, b: 250 } // a posterization step: ΔE 2.7 from LIGHT

/** Labels: 0 = below the diagonal (strong), 1 = above it, 2 = the band left of the
 *  seam. `corner` turns the diagonal 65° at the seam instead of continuing through. */
function fixture(corner = false): Int32Array {
  const L = new Int32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const edgeY = corner && x < SEAM_X ? SLOPE * SEAM_X + Y0 + (SEAM_X - x) : SLOPE * x + Y0
      L[y * W + x] = y > edgeY ? 0 : x < SEAM_X ? 2 : 1
    }
  }
  return L
}

const PALETTE = [NAVY, LIGHT, BAND]
/** Perpendicular distance from the authored diagonal. */
const offLine = (p: Vec): number => Math.abs(p.y - (SLOPE * p.x + Y0)) / Math.hypot(SLOPE, 1)

/** The vertex where the seam meets the diagonal (the only degree-3 junction there). */
function seamVertex(t: ReturnType<typeof tracePlanar>): Vec {
  const near = t.vertices.filter((v) => Math.abs(v.x - SEAM_X) < 2 && Math.abs(v.y - (SLOPE * SEAM_X + Y0)) < 2)
  assert.equal(near.length, 1, 'fixture should produce exactly one seam junction')
  return { x: near[0].x, y: near[0].y }
}

test('thread: the seam junction lands on the true edge, not on its lattice corner', () => {
  const L = fixture()
  const pinned = seamVertex(tracePlanar(L, W, H))
  const threaded = seamVertex(tracePlanar(L, W, H, DEFAULT_PLANAR_FIT, PALETTE))

  // The lattice corner is quantized ACROSS the boundary; the through fit is not.
  assert.ok(Number.isInteger(pinned.x) && Number.isInteger(pinned.y), `lattice corner expected, got ${JSON.stringify(pinned)}`)
  assert.ok(offLine(pinned) > 0.3, `fixture must offer something to fix (lattice sits ${offLine(pinned).toFixed(2)}px off)`)
  assert.ok(
    offLine(threaded) < offLine(pinned) - 0.2,
    `threaded junction should sit on the edge: ${offLine(threaded).toFixed(2)}px vs ${offLine(pinned).toFixed(2)}px`,
  )
  // …and only across it: the seam decides where along the edge the junction sits, and
  // an error there is invisible. Moving it along would be the tracer inventing a place.
  assert.ok(Math.abs(threaded.x - pinned.x) < 0.6, `move should be ~normal to the edge, got dx ${(threaded.x - pinned.x).toFixed(2)}`)
})

test('thread: the strong edge stops being aimed by the seam', () => {
  const L = fixture()
  const worst = (palette?: typeof PALETTE): number => {
    const t = tracePlanar(L, W, H, DEFAULT_PLANAR_FIT, palette)
    // Every node of the two halves of the diagonal, against the authored line. The
    // pinned fit rotates a half to reach its corner; the threaded one does not.
    let m = 0
    for (const e of t.edges) {
      for (const n of e.nodes) {
        if (n.x < 4 || n.x > W - 4 || offLine(n) > 3) continue
        m = Math.max(m, offLine(n))
      }
    }
    return m
  }
  const pinned = worst()
  const threaded = worst(PALETTE)
  assert.ok(pinned > 0.4, `fixture must show the defect (worst node ${pinned.toFixed(2)}px off)`)
  assert.ok(threaded < pinned, `threaded should be closer: ${threaded.toFixed(2)}px vs ${pinned.toFixed(2)}px`)
})

test('thread: a real corner under the seam is left on its lattice corner', () => {
  // Same seam, same colours — but the strong boundary TURNS 65° there. The chord-turn
  // gate is what separates this from a continuation; without it the corner would be
  // rounded off, and a circle fitted across a 40° bend passes the residual test (§14.3).
  const L = fixture(true)
  const pinned = seamVertex(tracePlanar(L, W, H))
  const threaded = seamVertex(tracePlanar(L, W, H, DEFAULT_PLANAR_FIT, PALETTE))
  assert.deepEqual(threaded, pinned, 'a corner junction must not move')
})

test('thread: it is the colour RANK, not the topology', () => {
  // The same three-arm junction with the band as different from the light side as the
  // navy is: nothing is weak, nothing is strong, no junction is anyone's to place.
  const L = fixture()
  const flat = [NAVY, LIGHT, { r: 250, g: 120, b: 30 }]
  assert.deepEqual(seamVertex(tracePlanar(L, W, H, DEFAULT_PLANAR_FIT, flat)), seamVertex(tracePlanar(L, W, H)))
})

test('thread: no palette (or fitThrough off) is byte-identical', () => {
  const L = fixture()
  const sig = (t: ReturnType<typeof tracePlanar>): string =>
    JSON.stringify([t.vertices, t.edges.map((e) => e.nodes)])
  const base = sig(tracePlanar(L, W, H))
  assert.equal(sig(tracePlanar(L, W, H, DEFAULT_PLANAR_FIT, undefined)), base)
  assert.equal(sig(tracePlanar(L, W, H, { ...DEFAULT_PLANAR_FIT, fitThrough: false }, PALETTE)), base)
  assert.notEqual(sig(tracePlanar(L, W, H, DEFAULT_PLANAR_FIT, PALETTE)), base, 'the fixture must actually exercise the pass')
})

test('thread: deterministic', () => {
  const L = fixture()
  const a = tracePlanar(L, W, H, DEFAULT_PLANAR_FIT, PALETTE)
  const b = tracePlanar(L, W, H, DEFAULT_PLANAR_FIT, PALETTE)
  assert.deepEqual(a.vertices, b.vertices)
  assert.deepEqual(a.edges, b.edges)
})
