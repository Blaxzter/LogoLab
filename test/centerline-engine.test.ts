// The centreline engine's pieces on masks small enough to reason about by hand:
// the distance transform, thinning (strictly thin, topology kept), the skeleton graph
// (a T is one node with three chains; a ring is one closed chain), spur pruning, the
// blob split (a disc on a stem is a fill; a thick uniform stroke is not) and the cap
// read (butt vs round).
//
//   node --test test/centerline-engine.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { distanceTransform } from '../src/lib/trace/centerline/distance.ts'
import { thinZhangSuen, connectivity8 } from '../src/lib/trace/centerline/thin.ts'
import {
  contractClusterLinks,
  nodeDegree,
  pruneSpurs,
  skeletonGraph,
  weldCrossings,
} from '../src/lib/trace/centerline/graph.ts'
import { coverageField, refineChain } from '../src/lib/trace/centerline/profile.ts'
import { splitBlobs, strokeRuns } from '../src/lib/trace/centerline/blobs.ts'
import { readEnd } from '../src/lib/trace/centerline/ends.ts'
import { monoLabels, MONO_INK } from '../src/lib/trace/mono.ts'
import { traceCenterline } from '../src/lib/trace/centerline/index.ts'
import { DEFAULT_PLANAR_FIT } from '../src/lib/trace/planarFit.ts'
import type { ImageDataLike } from '../src/lib/traceInput/ink.ts'

/** A white canvas with black ink drawn by a predicate over pixel centres (no AA). */
function canvas(w: number, h: number, ink: (x: number, y: number) => boolean): ImageDataLike {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = ink(x + 0.5, y + 0.5) ? 0 : 255
      data.set([v, v, v, 255], (y * w + x) * 4)
    }
  return { width: w, height: h, data }
}
const segDisc = (cx: number, cy: number, r: number) => (x: number, y: number) => Math.hypot(x - cx, y - cy) <= r
const hbar = (x0: number, x1: number, cy: number, w: number) => (x: number, y: number) =>
  x >= x0 && x <= x1 && Math.abs(y - cy) < w / 2
const vbar = (cx: number, y0: number, y1: number, w: number) => (x: number, y: number) =>
  y >= y0 && y <= y1 && Math.abs(x - cx) < w / 2
const seg = (x0: number, y0: number, x1: number, y1: number, w: number) => (x: number, y: number) => {
  const dx = x1 - x0
  const dy = y1 - y0
  const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)) <= w / 2
}
const union =
  (...fs: ((x: number, y: number) => boolean)[]) =>
  (x: number, y: number) =>
    fs.some((f) => f(x, y))

function inkMask(img: ImageDataLike): Uint8Array {
  const m = new Uint8Array(img.width * img.height)
  for (let i = 0; i < m.length; i++) m[i] = img.data[i * 4] < 128 ? 1 : 0
  return m
}

test('distance transform: the centre of a bar reads its half-width, paper reads 0', () => {
  // A 9-row bar, rows 11..19, columns 10..49.
  const mask = new Uint8Array(60 * 30)
  for (let y = 11; y <= 19; y++) for (let x = 10; x <= 49; x++) mask[y * 60 + x] = 1
  const dt = distanceTransform(mask, 60, 30)
  assert.equal(dt[5 * 60 + 30], 0)
  // Centre row 15: the nearest paper centre is 5 rows away (row 10 or 20).
  assert.equal(dt[15 * 60 + 30], 5)
  assert.equal(dt[11 * 60 + 30], 1)
  // A corner pixel of the bar is one step from paper on two sides — still 1.
  assert.equal(dt[11 * 60 + 10], 1)
})

test('thinning: a bar thins to one pixel-wide run, a diagonal has no elbows', () => {
  const img = canvas(60, 30, hbar(5, 55, 15, 7))
  const s = thinZhangSuen(inkMask(img), 60, 30)
  let n = 0
  for (let i = 0; i < s.length; i++) n += s[i]
  // One pixel per column across the bar's length (the caps peel a little).
  assert.ok(n >= 40 && n <= 51, `skeleton has ${n} px`)
  for (let i = 0; i < s.length; i++) if (s[i]) assert.ok(connectivity8(s, i, 60) <= 2, 'a bar has no junctions')

  const diag = canvas(64, 64, (x, y) => Math.abs(x - y) <= 3 && x > 6 && x < 58)
  const sd = thinZhangSuen(inkMask(diag), 64, 64)
  for (let i = 0; i < sd.length; i++) {
    if (!sd[i]) continue
    const x = i % 64
    const y = (i / 64) | 0
    if (x < 2 || y < 2 || x > 61 || y > 61) continue
    let count = 0
    for (const o of [-64, -63, 1, 65, 64, 63, -1, -65]) count += sd[i + o]
    assert.ok(count <= 2, `diagonal skeleton pixel (${x},${y}) has ${count} neighbours — an elbow survived`)
  }
})

test('graph: a T is one junction with three chains; a ring is one closed chain', () => {
  const t = canvas(80, 60, union(hbar(10, 70, 15, 7), vbar(40, 15, 50, 7)))
  const mask = inkMask(t)
  const dt = distanceTransform(mask, 80, 60)
  const g = skeletonGraph(thinZhangSuen(mask, 80, 60), dt, 80, 60)
  pruneSpurs(g, dt)
  const nodes = g.nodes.filter((n) => n.alive)
  assert.equal(nodes.length, 1)
  assert.equal(nodeDegree(g, nodes[0]), 3)
  assert.ok(
    Math.abs(nodes[0].x - 40) <= 2 && Math.abs(nodes[0].y - 15) <= 3,
    `junction at (${nodes[0].x}, ${nodes[0].y})`,
  )

  const ring = canvas(80, 80, (x, y) => Math.abs(Math.hypot(x - 40, y - 40) - 25) <= 3.5)
  const rm = inkMask(ring)
  const rdt = distanceTransform(rm, 80, 80)
  const rg = skeletonGraph(thinZhangSuen(rm, 80, 80), rdt, 80, 80)
  pruneSpurs(rg, rdt)
  const chains = rg.chains.filter((c) => c.alive)
  assert.equal(rg.nodes.filter((n) => n.alive).length, 0)
  assert.equal(chains.length, 1)
  assert.ok(chains[0].closed)
})

test('graph: a bowtie welds its crossing to one four-arm node, and each lobe is a loop on it', () => {
  // Two triangles sharing an apex at (60, 35): the bars cross at 53°, so thinning splits
  // the X into two Y's ~7 px apart. Each lobe is ONE chain with BOTH ends on its Y — the
  // weld has to read the two ends as two arms (by chain id it saw one direction twice,
  // never fired, and a figure-8 traced as two open strokes).
  const bow = canvas(
    120,
    70,
    union(
      seg(10, 10, 60, 35, 6),
      seg(60, 35, 10, 60, 6),
      seg(10, 60, 10, 10, 6),
      seg(110, 10, 60, 35, 6),
      seg(60, 35, 110, 60, 6),
      seg(110, 60, 110, 10, 6),
    ),
  )
  const mask = inkMask(bow)
  const dt = distanceTransform(mask, 120, 70)
  const g = skeletonGraph(thinZhangSuen(mask, 120, 70), dt, 120, 70)
  contractClusterLinks(g, dt)
  pruneSpurs(g, dt)
  weldCrossings(g, dt)
  pruneSpurs(g, dt)
  const nodes = g.nodes.filter((n) => n.alive)
  assert.equal(nodes.length, 1, `one crossing, got ${nodes.length}`)
  const X = nodes[0]
  assert.equal(nodeDegree(g, X), 4)
  assert.ok(Math.abs(X.x - 60) <= 2 && Math.abs(X.y - 35) <= 2, `crossing at (${X.x}, ${X.y})`)
  const lobes = g.chains.filter((c) => c.alive)
  assert.equal(lobes.length, 2)
  for (const c of lobes) assert.ok(c.a === X.id && c.b === X.id, 'each lobe starts and ends on the crossing')
})

test('blob split: a disc on a stem is a fill, a thick uniform stroke is a stroke', () => {
  const lollipop = canvas(120, 60, union(hbar(10, 80, 30, 5), segDisc(95, 30, 16)))
  const seg = monoLabels(lollipop, 128, false, 1)
  const mask = inkMask(lollipop)
  const dt = distanceTransform(mask, 120, 60)
  const g = skeletonGraph(thinZhangSuen(mask, 120, 60), dt, 120, 60)
  pruneSpurs(g, dt)
  const f = coverageField(seg.image, seg.labels, MONO_INK)
  const lines = g.chains
    .filter((c) => c.alive && c.pixels.length)
    .map((c) => refineChain(g, c, f, dt, (i) => g.nodes[i].r))
  const split = splitBlobs(lines, mask, dt, 120, 60)
  assert.ok(Math.abs(split.W - 5) <= 1, `stroke width ${split.W}`)
  assert.ok(split.blobMask, 'the disc is a fill')
  assert.ok(split.blobPixels > 500 && split.blobPixels < 900, `disc ${split.blobPixels} px`)
  const runs = strokeRuns(lines, split, 120)
  assert.ok(
    runs.some((r) => r.blobAtB || r.blobAtA),
    'the stem is cut where it enters the disc',
  )

  const ladder = canvas(120, 80, union(hbar(10, 110, 15, 4), hbar(10, 110, 45, 14)))
  const lm = inkMask(ladder)
  const ldt = distanceTransform(lm, 120, 80)
  const lg = skeletonGraph(thinZhangSuen(lm, 120, 80), ldt, 120, 80)
  pruneSpurs(lg, ldt)
  const lseg = monoLabels(ladder, 128, false, 1)
  const lf = coverageField(lseg.image, lseg.labels, MONO_INK)
  const llines = lg.chains
    .filter((c) => c.alive && c.pixels.length)
    .map((c) => refineChain(lg, c, lf, ldt, (i) => lg.nodes[i].r))
  const lsplit = splitBlobs(llines, lm, ldt, 120, 80)
  assert.equal(lsplit.blobMask, null, 'a 14 px bar beside a 4 px bar is a thick stroke, not a fill')
})

test('blob split: a stem out of a disc leaves the disc whole — no bay in the rim where the stem exits', () => {
  // The stem runs to the disc's centre, as a lollipop is drawn. Its channel (the stroke
  // mask) cuts through the rim; the deep interior grows back by the inscribed radius,
  // but within a stroke width of the rim that radius is bounded by the paper pockets
  // beside the stem, and a bay stayed — 6 px deep, wider than the stem — which the fill
  // was traced around (five nodes stacked at the join, and a bite in the rim above and
  // below the stem). The bridge rule reads the ink ACROSS the stroke instead.
  const lollipop = canvas(120, 60, union(hbar(10, 95, 30, 6), segDisc(95, 30, 16)))
  const seg = monoLabels(lollipop, 128, false, 1)
  const mask = inkMask(lollipop)
  const dt = distanceTransform(mask, 120, 60)
  const g = skeletonGraph(thinZhangSuen(mask, 120, 60), dt, 120, 60)
  pruneSpurs(g, dt)
  const f = coverageField(seg.image, seg.labels, MONO_INK)
  const lines = g.chains
    .filter((c) => c.alive && c.pixels.length)
    .map((c) => refineChain(g, c, f, dt, (i) => g.nodes[i].r))
  const split = splitBlobs(lines, mask, dt, 120, 60)
  assert.ok(split.blobMask, 'the disc is a fill')
  let bay = 0
  let stem = 0
  for (let y = 0; y < 60; y++)
    for (let x = 0; x < 120; x++) {
      const i = y * 120 + x
      if (!mask[i]) continue
      const inDisc = Math.hypot(x + 0.5 - 95, y + 0.5 - 30) <= 14.5
      if (inDisc && !split.blobMask![i]) bay++
      if (x < 76 && split.blobMask![i]) stem++
    }
  assert.equal(bay, 0, `${bay} disc pixels inside the rim are not fill`)
  assert.equal(stem, 0, `${stem} stem pixels became fill`)
})

test('traceCenterline: a line through a filled disc is one stroke, not two ending in it', () => {
  // Inside the disc the skeleton is the disc's own, so the line's chain is cut at the
  // rim on both sides; the two cut ends are collinear across one fill and pair.
  const img = canvas(120, 60, union(hbar(10, 110, 30, 6), segDisc(60, 30, 12)))
  const seg = monoLabels(img, 128, false, 1)
  const { doc, report } = traceCenterline({
    seg,
    width: 120,
    height: 60,
    fitOpts: DEFAULT_PLANAR_FIT,
    fidelity: 1.5,
    traceFills: () => ({ items: [] }),
  })
  assert.ok(report.fillShare > 0, 'the disc is a fill')
  assert.equal(report.strokes, 1, `one stroke through the disc, got ${report.strokes}`)
  const it = doc.items[0]
  assert.equal(it.kind, 'path')
  if (it.kind !== 'path') return
  const xs = it.subPaths[0].nodes.map((n) => n.x)
  // Within a half-width of each end of the bar: where exactly an end sits is the cap
  // read's business (this one reads round and sits 3 px in); this test is topology.
  assert.ok(
    Math.min(...xs) <= 13.5 && Math.max(...xs) >= 106.5,
    `spans x ${Math.min(...xs).toFixed(1)}..${Math.max(...xs).toFixed(1)}`,
  )
})

test('cap read: a flat end reads butt, a round end reads round, both at the ink end', () => {
  const flat = canvas(80, 40, hbar(10, 60, 20, 9))
  const round = canvas(80, 40, union(hbar(10, 60, 20, 9), segDisc(60, 20, 4.5)))
  for (const [img, cap] of [
    [flat, 'butt'],
    [round, 'round'],
  ] as const) {
    const seg = monoLabels(img, 128, false, 1)
    const f = coverageField(seg.image, seg.labels, MONO_INK)
    // A centreline that stops 6 px short of the end, as a thinned skeleton does.
    const pts = Array.from({ length: 40 }, (_, k) => ({ x: 15 + k, y: 20 }))
    const read = readEnd(pts, 'b', 4.5, f, null, false)
    assert.equal(read.cap, cap)
    // Butt: the centreline ends where the ink ends (x=60); round: one radius before the cap's tip.
    assert.ok(Math.abs(read.end.x - 60) <= 1.2, `${cap} end at ${read.end.x.toFixed(1)}`)
  }
})

test('traceCenterline: an L of two bars comes back as one three-node stroke of the drawn width', () => {
  // The bars overrun the corner by a half-width so the outer corner is square, as a
  // miter join draws it; two butt-capped bars leave that corner empty, and the apex
  // rebuild's raster check (rightly) reads no full radius there.
  const img = canvas(100, 100, union(hbar(20, 83.5, 20, 7), vbar(80, 16.5, 80, 7)))
  const seg = monoLabels(img, 128, false, 1)
  const { doc, report } = traceCenterline({
    seg,
    width: 100,
    height: 100,
    fitOpts: DEFAULT_PLANAR_FIT,
    fidelity: 1.5,
    traceFills: () => ({ items: [] }),
  })
  assert.equal(report.strokes, 1)
  assert.equal(report.fills, 0)
  const it = doc.items[0]
  assert.equal(it.kind, 'path')
  if (it.kind !== 'path') return
  assert.equal(it.fill, 'none')
  assert.ok(it.stroke && Math.abs(it.stroke.width - 7) <= 1, `width ${it.stroke?.width}`)
  const nodes = it.subPaths[0].nodes
  assert.equal(nodes.length, 3, `an L is three nodes, got ${nodes.length}`)
  const apex = nodes[1]
  assert.ok(
    Math.abs(apex.x - 80) <= 1.5 && Math.abs(apex.y - 20) <= 1.5,
    `apex at (${apex.x.toFixed(1)}, ${apex.y.toFixed(1)})`,
  )
})
