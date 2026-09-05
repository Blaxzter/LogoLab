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

// --- §0 #15: the junction that IS a corner -----------------------------------
// The residue §14 left open. Where the strong boundary TURNS at the junction, the through
// fit is not defined (fitting one line/circle across the bend would round the corner off —
// §14.3 measured a 40° corner passing the residual test), so the junction kept its INTEGER
// lattice corner. A corner is still a sub-pixel place: it is the INTERSECTION of the two
// strong arms' own lines, which is the same evidence §10.6's corner snap uses inside a
// chain and the only thing a junction cannot reach there.
//
// This fixture samples the label at pixel CENTRES, so the staircase it produces is an
// UNBIASED quantization of the authored geometry and the authored apex is exact in lattice
// coordinates — the assertions below are against that apex, not against a blessed number.

/** The corner arms: 45° up-left before the seam, slope SLOPE after it. */
const CORNER_APEX: Vec = { x: SEAM_X, y: SLOPE * SEAM_X + Y0 }
function cornerFixture(): Int32Array {
  const L = new Int32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cx = x + 0.5
      const cy = y + 0.5
      const edgeY = cx < SEAM_X ? CORNER_APEX.y + (SEAM_X - cx) : SLOPE * cx + Y0
      L[y * W + x] = cy > edgeY ? 0 : cx < SEAM_X ? 2 : 1
    }
  }
  return L
}
const offApex = (p: Vec): number => Math.hypot(p.x - CORNER_APEX.x, p.y - CORNER_APEX.y)

test('corner: a junction that IS a corner lands on its arm intersection, not its lattice corner', () => {
  const L = cornerFixture()
  const pinned = seamVertex(tracePlanar(L, W, H))
  const placed = seamVertex(tracePlanar(L, W, H, DEFAULT_PLANAR_FIT, PALETTE))

  assert.ok(Number.isInteger(pinned.x) && Number.isInteger(pinned.y), `lattice corner expected, got ${JSON.stringify(pinned)}`)
  assert.ok(offApex(pinned) > 0.3, `fixture must offer something to fix (lattice sits ${offApex(pinned).toFixed(2)}px off the apex)`)
  assert.ok(
    offApex(placed) < 0.5 * offApex(pinned),
    `corner junction should land on the authored apex: ${offApex(placed).toFixed(2)}px vs ${offApex(pinned).toFixed(2)}px`,
  )
})

test('corner: placing it does not ROUND it — the apex stays as sharp as the art', () => {
  // The reason §14 refused this junction in the first place. A through fit (one line or one
  // circle across the bend) would smooth the 65° turn away; an arm intersection cannot, and
  // this pins that difference rather than trusting it.
  const L = cornerFixture()
  const turnAt = (t: ReturnType<typeof tracePlanar>): number => {
    const v = seamVertex(t)
    // The two strong arms leave the vertex along their own edges; read each one's direction
    // from the fitted node nearest the vertex on each incident strong edge.
    const dirs: Vec[] = []
    for (const e of t.edges) {
      if (e.closed || e.nodes.length < 2) continue
      for (const [a, b] of [
        [e.nodes[0], e.nodes[1]],
        [e.nodes[e.nodes.length - 1], e.nodes[e.nodes.length - 2]],
      ]) {
        if (Math.hypot(a.x - v.x, a.y - v.y) > 0.01) continue
        const h = a.hOut && Math.hypot(a.hOut.x - a.x, a.hOut.y - a.y) > 1e-6 ? a.hOut : b
        const l = Math.hypot(h.x - a.x, h.y - a.y)
        if (l > 1e-6) dirs.push({ x: (h.x - a.x) / l, y: (h.y - a.y) / l })
      }
    }
    assert.ok(dirs.length >= 2, 'expected at least two arms leaving the corner junction')
    // the widest angle between any pair = the corner's own opening
    let best = 0
    for (let i = 0; i < dirs.length; i++)
      for (let j = i + 1; j < dirs.length; j++) {
        const d = Math.max(-1, Math.min(1, dirs[i].x * dirs[j].x + dirs[i].y * dirs[j].y))
        best = Math.max(best, (Math.acos(d) * 180) / Math.PI)
      }
    return best
  }
  const pinned = turnAt(tracePlanar(L, W, H))
  const placed = turnAt(tracePlanar(L, W, H, DEFAULT_PLANAR_FIT, PALETTE))
  // Authored opening between the two arms: 180° − 65.3° of turn.
  assert.ok(Math.abs(placed - pinned) < 12, `corner opening should survive placement: ${placed.toFixed(1)}° vs ${pinned.toFixed(1)}°`)
  assert.ok(placed < 150, `a rounded-off corner would read near 180°, got ${placed.toFixed(1)}°`)
})

test('corner: the strong arms straighten with it', () => {
  // The product-visible half: an edge pinned at a lattice corner carries that error into
  // 100+px of otherwise-good evidence. Both arms are measured against their authored lines.
  const L = cornerFixture()
  const armErr = (palette?: typeof PALETTE): number => {
    const t = tracePlanar(L, W, H, DEFAULT_PLANAR_FIT, palette)
    const off = (p: Vec): number =>
      p.x >= SEAM_X
        ? Math.abs(p.y - (SLOPE * p.x + Y0)) / Math.hypot(SLOPE, 1)
        : Math.abs(p.y - (CORNER_APEX.y + (SEAM_X - p.x))) / Math.SQRT2
    let m = 0
    for (const e of t.edges)
      for (const n of e.nodes) {
        if (n.x < 4 || n.x > W - 4 || n.y < 4 || n.y > H - 4 || off(n) > 3) continue
        m = Math.max(m, off(n))
      }
    return m
  }
  const pinned = armErr()
  const placed = armErr(PALETTE)
  assert.ok(pinned > 0.3, `fixture must show the defect (worst node ${pinned.toFixed(2)}px off)`)
  assert.ok(placed < pinned, `placed should be closer: ${placed.toFixed(2)}px vs ${pinned.toFixed(2)}px`)
})

test('corner: a CONTINUATION under the same seam is still threaded, not intersected', () => {
  // The §14 branch must be untouched: where the boundary runs straight through, the
  // junction is placed on the joint through fit (more evidence than either arm alone).
  const L = fixture()
  const pinned = seamVertex(tracePlanar(L, W, H))
  const threaded = seamVertex(tracePlanar(L, W, H, DEFAULT_PLANAR_FIT, PALETTE))
  const offLine2 = (p: Vec): number => Math.abs(p.y - (SLOPE * p.x + Y0)) / Math.hypot(SLOPE, 1)
  assert.ok(offLine2(threaded) < offLine2(pinned) - 0.2)
  assert.ok(Math.abs(threaded.x - pinned.x) < 0.6, 'a continuation moves ~normal to the edge only')
})

test('thread: it is the colour RANK, not the topology', () => {
  // The same three-arm junction with the band as different from the light side as the
  // navy is: nothing is weak, nothing is strong, no junction is anyone's to place.
  const L = fixture()
  const flat = [NAVY, LIGHT, { r: 250, g: 120, b: 30 }]
  assert.deepEqual(seamVertex(tracePlanar(L, W, H, DEFAULT_PLANAR_FIT, flat)), seamVertex(tracePlanar(L, W, H)))
})

test('corner: cornerJunctions off is byte-identical to the pre-§17 tracer', () => {
  const L = cornerFixture()
  const sig = (t: ReturnType<typeof tracePlanar>): string => JSON.stringify([t.vertices, t.edges.map((e) => e.nodes)])
  const pinned = sig(tracePlanar(L, W, H))
  // §14 alone must not move this junction — its own turn gate refuses it — so the corner
  // fixture with only fitThrough on has to reproduce the no-palette trace exactly.
  assert.equal(sig(tracePlanar(L, W, H, { ...DEFAULT_PLANAR_FIT, cornerJunctions: false }, PALETTE)), pinned)
  assert.notEqual(sig(tracePlanar(L, W, H, DEFAULT_PLANAR_FIT, PALETTE)), pinned, 'the fixture must exercise the corner branch')
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

// --- issue #14: the junction on an ARC, at a coarse raster -----------------------------
// THROUGH_SPAN is 12px of raw lattice at every raster, so at a coarse raster the window
// covers more of the art: the same authored arc reads a chord turn of 21.4° @256 and 7.1°
// @2048 (`threadDiag --case band-cross`, §0.1), and at the coarse end that trips the 20°
// corner gate. The junction is then routed to the §17 apex branch — the two arms' LINES
// intersected — and on an arc those lines are secants, so the apex lands INSIDE the curve:
// measured on band-cross @256, 0.73 artwork-px off the authored arc against 0.51 for the
// lattice corner it replaced (`threadScaleDiag`, §28). The circle the 12px window fits is
// no better (its radius reads 47–56 for an authored 79–81: too little sweep against the
// staircase). What separates an arc from a corner at ANY raster is that an arc keeps
// fitting one circle as the window GROWS, and a corner's straight arms leave any circle at
// a rate set by the corner angle alone — so the fix extends the window while co-circular
// and threads the junction onto the circle the widest window affords.
//
// The fixture: a disc of radius 30 (the band-cross regime, r≈40 @256, made a little
// tighter so the 12px chord turn is unambiguously past the gate) with a band seam ending
// on its top. The disc's centre sits off the lattice so the junction's lattice corner is
// measurably off the authored circle; the placement is measured against that circle.

const ARC_C: Vec = { x: 48, y: 50.4 }
const ARC_R = 30
function arcFixture(): Int32Array {
  const L = new Int32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cx = x + 0.5
      const cy = y + 0.5
      const inside = Math.hypot(cx - ARC_C.x, cy - ARC_C.y) <= ARC_R
      L[y * W + x] = inside ? 0 : cx < SEAM_X ? 2 : 1
    }
  }
  return L
}
const offCircle = (p: Vec): number => Math.abs(Math.hypot(p.x - ARC_C.x, p.y - ARC_C.y) - ARC_R)
/** The seam junction on the disc's TOP (the seam also meets the disc at the bottom). */
function topVertex(t: ReturnType<typeof tracePlanar>): Vec {
  const near = t.vertices.filter((v) => Math.abs(v.x - SEAM_X) < 2 && Math.abs(v.y - (ARC_C.y - ARC_R)) < 2)
  assert.equal(near.length, 1, 'fixture should produce exactly one seam junction on the disc top')
  return { x: near[0].x, y: near[0].y }
}

test('arc: a seam junction on a tight arc lands on the circle, not inside it (issue #14)', () => {
  const L = arcFixture()
  const pinned = topVertex(tracePlanar(L, W, H))
  const placed = topVertex(tracePlanar(L, W, H, DEFAULT_PLANAR_FIT, PALETTE))

  assert.ok(Number.isInteger(pinned.x) && Number.isInteger(pinned.y), `lattice corner expected, got ${JSON.stringify(pinned)}`)
  assert.ok(offCircle(pinned) > 0.3, `fixture must offer something to fix (lattice sits ${offCircle(pinned).toFixed(2)}px off the circle)`)
  assert.ok(
    offCircle(placed) < 0.5 * offCircle(pinned),
    `arc junction should land on the authored circle: ${offCircle(placed).toFixed(2)}px vs lattice ${offCircle(pinned).toFixed(2)}px`,
  )
  // …and only radially: along the arc is the seam's business.
  assert.ok(Math.abs(placed.x - pinned.x) < 0.6, `move should be ~normal to the arc, got dx ${(placed.x - pinned.x).toFixed(2)}`)
})
