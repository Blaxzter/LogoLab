// Phase 6 / 1d — co-circular open-arc snap. A white ring (annulus) over colour bands
// is split by the band-boundary junctions into open arcs; the raw fit meets those
// arcs as forced, independently-fitted CORNERS → the ring visibly kinks/pulls where
// the bands touch it. planarBeautify's 1d pass fits the whole ring loop to ONE
// circle, radial-snaps its junctions onto it, and re-emits each arc as a circular
// slice so the arcs join G¹ — the kink disappears and the ring is truly round.
//
// Asserts: the kink collapses (and vs the un-beautified trace), the ring is round,
// shared edges stay byte-coincident, and the pass is deterministic.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { tracePlanar } from '../src/lib/trace/planarAssemble.ts'
import { planarBeautify } from '../src/lib/trace/planarBeautify.ts'
import { materializeRegion, reverseEdgeNodes } from '../src/lib/path/topology.ts'
import { segmentControls, segmentCount, cubicAt } from '../src/lib/path/geometry.ts'
import type { BeautifyOptions } from '../src/lib/trace/beautify.ts'
import type { SubPath, Topology, Vec } from '../src/lib/path/types.ts'

ensureImageData()

const W = 240, H = 240, CX = 120, CY = 120, R = 84, r = 48
const OPTS: BeautifyOptions = { fidelity: 1.5, relationFrac: 0.1, hvAngleDeg: 0 }

/** A white ring (label 0) over `nbands` diagonal colour bands (labels ≥1). */
function ringOverBands(nbands: number): Int32Array {
  const labels = new Int32Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - CX, y - CY)
    labels[y * W + x] = d >= r && d <= R ? 0 : Math.floor(((x + y) / (W + H)) * nbands) + 1
  }
  return labels
}

function flattenClosed(sp: SubPath): Vec[] {
  const pts: Vec[] = []
  const count = segmentCount(sp)
  for (let s = 0; s < count; s++) {
    const { p0, c1, c2, p3 } = segmentControls(sp, s)
    for (let k = 0; k < 16; k++) pts.push(cubicAt(p0, c1, c2, p3, k / 16))
  }
  return pts
}

/** Max local turn (deg) above the per-step turn a perfect circle makes = the kink. */
function maxKink(poly: Vec[]): number {
  const n = poly.length
  const expected = 360 / n
  let k = 0
  for (let i = 0; i < n; i++) {
    const a = poly[(i - 1 + n) % n], b = poly[i], c = poly[(i + 1) % n]
    const d1x = b.x - a.x, d1y = b.y - a.y, d2x = c.x - b.x, d2y = c.y - b.y
    const l1 = Math.hypot(d1x, d1y) || 1, l2 = Math.hypot(d2x, d2y) || 1
    const cos = Math.max(-1, Math.min(1, (d1x * d2x + d1y * d2y) / (l1 * l2)))
    k = Math.max(k, (Math.acos(cos) * 180) / Math.PI - expected)
  }
  return k
}

function maxRadialDev(poly: Vec[], radius: number): number {
  let m = 0
  for (const p of poly) m = Math.max(m, Math.abs(Math.hypot(p.x - CX, p.y - CY) - radius))
  return m
}

/** The white ring's outer boundary (largest-mean-radius loop) as a dense polygon. */
function outerRing(topo: Topology, loops: Map<number, unknown>): Vec[] {
  const edges = new Map(topo.edges.map((e) => [e.id, e]))
  const sps = materializeRegion((loops as Map<number, never>).get(0)!, edges)
  const withR = sps.map((sp) => {
    const poly = flattenClosed(sp)
    let mr = 0
    for (const p of poly) mr += Math.hypot(p.x - CX, p.y - CY)
    return { poly, meanR: mr / poly.length }
  })
  withR.sort((a, b) => b.meanR - a.meanR)
  return withR[0].poly
}

test('arc-snap: a ring split by band junctions loses its kink and becomes round', () => {
  const labels = ringOverBands(6)
  const t = tracePlanar(labels, W, H)

  const rawKink = maxKink(outerRing({ vertices: t.vertices, edges: t.edges }, t.loopsByLabel))

  const beaut = planarBeautify({ vertices: t.vertices, edges: t.edges }, t.loopsByLabel, OPTS)
  const poly = outerRing(beaut, t.loopsByLabel)
  const kink = maxKink(poly)
  const dev = maxRadialDev(poly, R)

  assert.ok(rawKink > 20, `the raw trace kinks at the band junctions (got ${rawKink.toFixed(0)}°)`)
  assert.ok(kink < 10, `the snapped ring is smooth through the junctions (kink ${kink.toFixed(0)}°)`)
  assert.ok(kink < rawKink - 15, `the snap removed most of the kink (${rawKink.toFixed(0)}° → ${kink.toFixed(0)}°)`)
  assert.ok(dev < 1.2, `the snapped ring is round (max radial dev ${dev.toFixed(2)}px)`)
})

test('arc-snap: snapped shared edges stay byte-coincident (reverse-of-reverse identity)', () => {
  const t = tracePlanar(ringOverBands(6), W, H)
  const beaut = planarBeautify({ vertices: t.vertices, edges: t.edges }, t.loopsByLabel, OPTS)
  for (const e of beaut.edges) {
    const back = reverseEdgeNodes(reverseEdgeNodes(e.nodes))
    assert.equal(back.length, e.nodes.length)
    for (let i = 0; i < e.nodes.length; i++) {
      assert.equal(back[i].x, e.nodes[i].x)
      assert.equal(back[i].y, e.nodes[i].y)
      assert.equal(back[i].kind, e.nodes[i].kind)
    }
  }
})

test('arc-snap: every ring junction endpoint stays welded (edges meet at the moved vertex)', () => {
  const t = tracePlanar(ringOverBands(6), W, H)
  const beaut = planarBeautify({ vertices: t.vertices, edges: t.edges }, t.loopsByLabel, OPTS)
  const vById = new Map(beaut.vertices.map((v) => [v.id, v]))
  for (const e of beaut.edges) {
    if (e.startVertex != null && e.startVertex >= 0) {
      const v = vById.get(e.startVertex)!
      assert.ok(Math.hypot(e.nodes[0].x - v.x, e.nodes[0].y - v.y) < 1e-6, 'start endpoint sits on its vertex')
    }
    if (e.endVertex != null && e.endVertex >= 0) {
      const v = vById.get(e.endVertex)!
      const last = e.nodes[e.nodes.length - 1]
      assert.ok(Math.hypot(last.x - v.x, last.y - v.y) < 1e-6, 'end endpoint sits on its vertex')
    }
  }
})

test('arc-snap: deterministic (identical beautified topology on re-run)', () => {
  const t = tracePlanar(ringOverBands(6), W, H)
  const a = planarBeautify({ vertices: t.vertices, edges: t.edges }, t.loopsByLabel, OPTS)
  const b = planarBeautify({ vertices: t.vertices, edges: t.edges }, t.loopsByLabel, OPTS)
  assert.equal(JSON.stringify(a.edges), JSON.stringify(b.edges))
  assert.equal(JSON.stringify(a.vertices), JSON.stringify(b.vertices))
})

test('arc-snap: fidelity 0 is a pure no-op (raw trace unchanged)', () => {
  const t = tracePlanar(ringOverBands(6), W, H)
  const same = planarBeautify({ vertices: t.vertices, edges: t.edges }, t.loopsByLabel, { ...OPTS, fidelity: 0 })
  assert.equal(same.edges, t.edges) // returns the input topology reference unchanged
})
