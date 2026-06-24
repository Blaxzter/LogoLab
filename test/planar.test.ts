// Planar subdivision tracer: topology integrity (per-pixel relabel), determinism,
// and shared-edge coincidence. Synthetic label maps have exact ground truth, so
// interior pixels must render their own region's colour and shared boundaries
// must be byte-coincident between the two regions that own them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { tracePlanar } from '../src/lib/trace/planarAssemble.ts'
import { buildPlanarNetwork } from '../src/lib/trace/planarNetwork.ts'
import { detectCorners, detectLoopCorners, presmooth, fitOpenArc, DEFAULT_PLANAR_FIT } from '../src/lib/trace/planarFit.ts'
import { healColorSpikes } from '../src/lib/trace/index.ts'
import { materializeRegion, reverseEdgeNodes } from '../src/lib/path/topology.ts'
import { rasterizeDoc } from '../src/lib/render/raster.ts'
import { segmentControls, segmentCount, cubicAt } from '../src/lib/path/geometry.ts'
import type { EditableDoc, PathItem, SubPath, Vec } from '../src/lib/path/types.ts'

ensureImageData()

function quadrants(w: number, h: number): Int32Array {
  const L = new Int32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) L[y * w + x] = y < h / 2 ? (x < w / 2 ? 0 : 1) : (x < w / 2 ? 2 : 3)
  return L
}
function island(w: number, h: number): Int32Array {
  const L = new Int32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) L[y * w + x] = x >= 6 && x < w - 6 && y >= 6 && y < h - 6 ? 1 : 0
  return L
}

/** Label map (0 outside / 1 inside) of a filled triangle through three vertices. */
function filledTriangle(w: number, h: number, a: [number, number], b: [number, number], c: [number, number]): Int32Array {
  const L = new Int32Array(w * h)
  const sign = (px: number, py: number, p: [number, number], q: [number, number]): number =>
    (px - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (py - q[1])
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d1 = sign(x, y, a, b), d2 = sign(x, y, b, c), d3 = sign(x, y, c, a)
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0
    L[y * w + x] = hasNeg && hasPos ? 0 : 1 // inside ⇔ all same sign
  }
  return L
}

/** Label map (0 outside / 1 inside) of a filled polygon (even-odd ray cast). */
function filledPolygon(w: number, h: number, poly: [number, number][]): Int32Array {
  const L = new Int32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j]
      if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
    }
    L[y * w + x] = inside ? 1 : 0
  }
  return L
}

/** Flatten a closed subpath's cubics to a dense polygon. */
function flattenClosed(sp: SubPath): Vec[] {
  const pts: Vec[] = []
  const count = segmentCount(sp)
  for (let s = 0; s < count; s++) {
    const { p0, c1, c2, p3 } = segmentControls(sp, s)
    for (let k = 0; k < 24; k++) pts.push(cubicAt(p0, c1, c2, p3, k / 24))
  }
  return pts
}

/** Min distance from a point to a closed polygon (segment-wise). */
function minDistToPoly(pt: [number, number], poly: Vec[]): number {
  let m = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy || 1
    let u = ((pt[0] - a.x) * dx + (pt[1] - a.y) * dy) / L
    u = Math.max(0, Math.min(1, u))
    m = Math.min(m, Math.hypot(pt[0] - a.x - u * dx, pt[1] - a.y - u * dy))
  }
  return m
}

function relabelMismatches(labels: Int32Array, w: number, h: number): { interior: number; bad: number; regions: number } {
  const trace = tracePlanar(labels, w, h)
  const edges = new Map(trace.edges.map((e) => [e.id, e]))
  const maxLabel = Math.max(0, ...Array.from(labels))
  const colors: [number, number, number][] = []
  for (let i = 0; i <= maxLabel; i++) colors.push([(i * 73 + 30) % 256, (i * 137 + 60) % 256, (i * 199 + 90) % 256])
  const items: PathItem[] = []
  const order = [...trace.loopsByLabel.keys()].filter((l) => l >= 0).sort((a, b) => a - b)
  for (const Lb of order) {
    const subPaths = materializeRegion(trace.loopsByLabel.get(Lb)!, edges)
    if (!subPaths.length) continue
    const [r, g, b] = colors[Lb]
    items.push({ kind: 'path', id: 'r' + Lb, fill: `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`, fillRule: 'nonzero', subPaths, visible: true })
  }
  const doc: EditableDoc = { viewBox: [0, 0, w, h], items }
  const render = rasterizeDoc(doc, w, h, { background: [0, 0, 0] })
  const isBoundary = (x: number, y: number): boolean => {
    const l = labels[y * w + x]
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return true
      if (labels[ny * w + nx] !== l) return true
    }
    return false
  }
  let bad = 0, interior = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (isBoundary(x, y)) continue
    interior++
    const Lb = labels[y * w + x]
    if (Lb < 0) continue
    const o = (y * w + x) * 4
    const [er, eg, eb] = colors[Lb]
    if (Math.abs(render[o] - er) > 4 || Math.abs(render[o + 1] - eg) > 4 || Math.abs(render[o + 2] - eb) > 4) bad++
  }
  return { interior, bad, regions: order.length }
}

test('planar: quadrants relabel exactly (4 regions, center junction)', () => {
  const r = relabelMismatches(quadrants(16, 16), 16, 16)
  assert.equal(r.regions, 4)
  assert.equal(r.bad, 0)
})

test('planar: island reproduces a hole + inner region (shared edge)', () => {
  const r = relabelMismatches(island(20, 20), 20, 20)
  assert.equal(r.regions, 2)
  assert.equal(r.bad, 0)
})

test('planar: deterministic (identical edges on re-run)', () => {
  const L = quadrants(24, 24)
  const a = tracePlanar(L, 24, 24)
  const b = tracePlanar(L, 24, 24)
  assert.equal(JSON.stringify(a.edges), JSON.stringify(b.edges))
  assert.equal(JSON.stringify([...a.loopsByLabel]), JSON.stringify([...b.loopsByLabel]))
})

// --- sharp-corner preservation (the "rounded valleys" fix) -------------------

/** A sharp V valley as a unit staircase: left arm ↘ to the apex, right arm ↗. */
function vStaircase(arm: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = []
  for (let i = 0; i <= arm; i++) pts.push({ x: i, y: arm - i })
  for (let i = 1; i <= arm; i++) pts.push({ x: arm + i, y: i })
  return pts // apex at (arm, 0)
}

test('planar: detectCorners finds a sharp valley apex and nothing on a circle', () => {
  const arm = 20
  const v = vStaircase(arm)
  const corners = detectCorners(v, 70, false)
  assert.ok(corners.size >= 1, 'the 90° apex must be detected')
  for (const i of corners) assert.ok(Math.hypot(v[i].x - arm, v[i].y - 0) <= 2, 'detected corner sits at the apex')

  // A small circle's staircase has no macro corner at the 70° threshold.
  const circ: { x: number; y: number }[] = []
  let px = -1, py = -1
  for (let a = 0; a <= 360; a += 2) {
    const x = Math.round(8 + 8 * Math.cos((a * Math.PI) / 180))
    const y = Math.round(8 + 8 * Math.sin((a * Math.PI) / 180))
    if (x !== px || y !== py) { circ.push({ x, y }); px = x; py = y }
  }
  assert.equal(detectCorners(circ, 70, true).size, 0, 'a smooth circle yields no false corners')
})

test('planar: corner pinning keeps a sharp apex sharp (vs presmooth rounding it)', () => {
  const arm = 20
  const v = vStaircase(arm)
  const apex = { x: arm, y: 0 }
  const nearestApexDist = (nodes: { x: number; y: number; kind: string }[]): { d: number; kind: string } => {
    let best = { d: Infinity, kind: '' }
    for (const n of nodes) {
      const d = Math.hypot(n.x - apex.x, n.y - apex.y)
      if (d < best.d) best = { d, kind: n.kind }
    }
    return best
  }
  // Legacy: pin only endpoints → the apex drifts inward (rounded).
  const rounded = nearestApexDist(fitOpenArc(presmooth(v, 2, true), DEFAULT_PLANAR_FIT))
  // Fixed: pin the detected corner → the apex stays exact and stays a corner.
  const corners = detectCorners(v, DEFAULT_PLANAR_FIT.cornerTurnDeg, false)
  const sharp = nearestApexDist(fitOpenArc(presmooth(v, 2, true, corners), DEFAULT_PLANAR_FIT))

  assert.ok(rounded.d > 0.4, `legacy presmooth blunts the apex (drift ${rounded.d.toFixed(2)}px)`)
  assert.ok(sharp.d < 0.05, `corner pinning keeps the apex exact (drift ${sharp.d.toFixed(2)}px)`)
  assert.equal(sharp.kind, 'corner', 'the apex node stays a corner')
})

test('planar: detectCorners ignores a straight rasterized diagonal (no false corners)', () => {
  // A near-45° (and a shallower 2:1) diagonal is a constant-direction macro line: its
  // unit stair-steps must NOT read as corners, or the corner-pinning would fragment a
  // straight edge (e.g. the Summit mountain arms) into a jagged staircase.
  const diag45: { x: number; y: number }[] = []
  for (let i = 0; i <= 40; i++) { diag45.push({ x: i, y: i }); diag45.push({ x: i + 1, y: i }) }
  assert.equal(detectCorners(diag45, 70, false).size, 0, '45° staircase yields no false corners')

  const diag21: { x: number; y: number }[] = []
  for (let i = 0; i <= 40; i++) { diag21.push({ x: 2 * i, y: i }); diag21.push({ x: 2 * i + 1, y: i }); diag21.push({ x: 2 * i + 2, y: i }) }
  assert.equal(detectCorners(diag21, 70, false).size, 0, '2:1 staircase yields no false corners')
})

test('planar: corner pinning is region/path-count neutral (count is topology, not the fit)', () => {
  // A sharp-cornered region: corner pinning changes only per-edge GEOMETRY (it runs
  // after the face walk), so it must never change the number of regions or their
  // sub-path counts. This is the invariant the Summit "extra paths" report worried
  // about: path count comes from segmentation/topology, not cornerTurnDeg.
  const w = 64, h = 64
  const tri = new Int32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = y >= h * 0.2 && y <= h * 0.8 && Math.abs(x - w / 2) <= (y - h * 0.2) * 0.9
    tri[y * w + x] = inside ? 1 : 0
  }
  const shape = (cornerTurnDeg: number): { regions: number; subPaths: number[] } => {
    const t = tracePlanar(tri, w, h, { ...DEFAULT_PLANAR_FIT, cornerTurnDeg })
    const edges = new Map(t.edges.map((e) => [e.id, e]))
    const labels = [...t.loopsByLabel.keys()].filter((l) => l >= 0).sort((a, b) => a - b)
    return { regions: labels.length, subPaths: labels.map((lb) => materializeRegion(t.loopsByLabel.get(lb)!, edges).length) }
  }
  const on = shape(70) // corner pinning active
  const off = shape(181) // pinning disabled (legacy)
  assert.deepEqual(on, off, 'cornerTurnDeg must not change region or sub-path counts')
})

test('planar: detectLoopCorners returns exactly one apex per corner on a triangle loop', () => {
  // A triangle staircase (closed loop) has exactly 3 sharp corners; the precise
  // loop detector must return ONE index per corner — collapsing the NMS plateau and
  // the 1px-tip shoulder pairs (incl. the pair split across the loop seam) — at the
  // true vertices, NOT a cluster of 2–3 per corner.
  const w = 64, h = 64
  const verts: [number, number][] = [[12, 52], [52, 52], [32, 12]]
  const tri = filledTriangle(w, h, verts[0], verts[1], verts[2])
  const net = buildPlanarNetwork(tri, w, h)
  // the triangle's own boundary, NOT the image-frame loop of the background label
  const loop = net.edges.find((e) => e.closed && e.pts.every((p) => p.x > 0 && p.x < w && p.y > 0 && p.y < h))!
  const corners = detectLoopCorners(loop.pts, 70)
  assert.equal(corners.length, 3, 'three corners, one per triangle vertex')
  for (const v of verts) {
    const near = corners.some((i) => Math.hypot(loop.pts[i].x - v[0], loop.pts[i].y - v[1]) <= 2)
    assert.ok(near, `a detected corner sits at vertex (${v})`)
  }
})

test('planar: a sharp-cornered closed region keeps EXACT corners (no bevel)', () => {
  // The regression the user hit: planar rounded/beveled the Summit mark's sharp
  // corners (the fitter placed key vertices on the rounded staircase AROUND each
  // tip, missing the apex by >1.5px). cornerTurnDeg 70 snaps each corner to its
  // sub-pixel arm intersection, so the fitted boundary passes within <1px of every
  // true vertex — measurably sharper than the legacy path (181). Uses the actual
  // Summit mountain polygon as the label map.
  const w = 512, h = 512
  const verts: [number, number][] = [[84, 400], [212, 176], [300, 320], [356, 236], [428, 400]]
  const mark = filledPolygon(w, h, verts)
  const measure = (cornerTurnDeg: number): { max: number; nodes: number; allCorner: boolean } => {
    const t = tracePlanar(mark, w, h, { ...DEFAULT_PLANAR_FIT, cornerTurnDeg })
    const edges = new Map(t.edges.map((e) => [e.id, e]))
    const sps = materializeRegion(t.loopsByLabel.get(1)!, edges)
    const sp = sps.reduce((a, b) => (b.nodes.length > a.nodes.length ? b : a))
    const poly = flattenClosed(sp)
    const max = Math.max(...verts.map((v) => minDistToPoly(v, poly)))
    return { max, nodes: sp.nodes.length, allCorner: sp.nodes.every((n) => n.kind === 'corner') }
  }
  const on = measure(70)
  const off = measure(181)
  assert.ok(on.max < 1.0, `corners are sharp: every vertex within 1px of the fit (got ${on.max.toFixed(2)})`)
  assert.ok(on.max < off.max - 0.4, `the fix sharpens vs legacy bevel (on ${on.max.toFixed(2)} < off ${off.max.toFixed(2)})`)
  assert.ok(on.nodes <= 6, `a 5-corner polygon stays low-node (got ${on.nodes})`)
  assert.ok(on.allCorner, 'every node of a polygonal region is a hard corner')
})

test('planar: healColorSpikes fixes a mislabeled stroke pixel, spares AA + real gaps', () => {
  // The schild bottom-tip artifact: at a soft 2-colour junction the segmenter wedges
  // a thin spike of one region (the dark background) into a continuous stroke, so a
  // pixel that is actually a stroke colour ends up labeled background. healColorSpikes
  // reassigns it to the region its colour belongs to — but must leave anti-aliased
  // edge pixels (between colours) and genuine background-coloured pixels alone.
  const palette = [{ r: 0, g: 0, b: 0 }, { r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 }] // 0=bg 1=red 2=blue
  const W = 5, H = 5
  const labels = new Int32Array([
    0, 0, 0, 0, 0,
    0, 1, 0, 2, 0,
    0, 1, 0, 2, 0, // (2,2) is bg-labeled but coloured red below — the "spike"
    0, 1, 0, 2, 0,
    0, 0, 0, 0, 0,
  ])
  const data = new Uint8ClampedArray(W * H * 4)
  const set = (x: number, y: number, r: number, g: number, b: number): void => {
    const o = (y * W + x) * 4
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255
  }
  // paint each pixel its label's flat colour…
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = palette[labels[y * W + x]]; set(x, y, c.r, c.g, c.b) }
  // …then the special pixels:
  set(2, 2, 255, 0, 0) // mislabeled: bg-labeled, fully RED, adjacent to red → must heal to 1
  set(0, 2, 128, 0, 0) // AA: bg-labeled, half-red (between) — must NOT move
  // (4,2) stays a genuine bg pixel inside the blue gap — wait it's blue; use (2,0) as a real bg pixel: black, stays 0
  const healed = healColorSpikes(labels, data, W, H, palette)
  const at = (x: number, y: number): number => healed[y * W + x]
  assert.equal(at(2, 2), 1, 'a red-coloured pixel mislabeled as background heals to the red region')
  assert.equal(at(0, 2), 0, 'a half-red anti-aliased edge pixel is left alone (not unambiguous)')
  assert.equal(at(2, 0), 0, 'a genuine background-coloured pixel stays background')
  assert.equal(at(1, 1), 1, 'a correctly-labeled region pixel is untouched')
  // No spikes ⇒ byte-identical (same reference): a clean flat map returns the input.
  const clean = new Int32Array([0, 0, 0, 0, 1, 1, 0, 1, 1])
  const cleanData = new Uint8ClampedArray(3 * 3 * 4)
  for (let i = 0; i < 9; i++) { const c = palette[clean[i]]; const o = i * 4; cleanData[o] = c.r; cleanData[o + 1] = c.g; cleanData[o + 2] = c.b; cleanData[o + 3] = 255 }
  assert.equal(healColorSpikes(clean, cleanData, 3, 3, palette), clean, 'no mislabeled pixels ⇒ returns the input array (byte-identical)')

  // 8-connectivity: a red pixel orphaned from its region by an overlap, reachable
  // only DIAGONALLY, must still heal (a 4-connected heal would miss it — this is
  // the schild teal-under-the-amber-cap sliver in miniature).
  const dLabels = new Int32Array([1, 0, 0, 0, 0, 0, 0, 0, 0]) // only (0,0) is red-labeled
  const dData = new Uint8ClampedArray(3 * 3 * 4)
  for (let i = 0; i < 9; i++) { const c = palette[0]; const o = i * 4; dData[o] = c.r; dData[o + 1] = c.g; dData[o + 2] = c.b; dData[o + 3] = 255 }
  const red = palette[1]
  const setRed = (idx: number): void => { const o = idx * 4; dData[o] = red.r; dData[o + 1] = red.g; dData[o + 2] = red.b }
  setRed(0) // (0,0): the red region pixel
  setRed(4) // (1,1): red-coloured but bg-labeled, only red neighbour is (0,0) diagonally
  const dHealed = healColorSpikes(dLabels, dData, 3, 3, palette)
  assert.equal(dHealed[4], 1, 'a diagonally-orphaned red pixel heals (8-connected)')
})

test('planar: shared edges are byte-coincident (forward === reversed-of-reverse)', () => {
  const L = quadrants(16, 16)
  const trace = tracePlanar(L, 16, 16)
  // Every internal edge borders two real regions; its reversed view must equal the
  // double-reverse of its forward nodes exactly (pure reindex+swap, no drift).
  for (const e of trace.edges) {
    const back = reverseEdgeNodes(reverseEdgeNodes(e.nodes))
    assert.equal(back.length, e.nodes.length)
    for (let i = 0; i < e.nodes.length; i++) {
      assert.equal(back[i].x, e.nodes[i].x)
      assert.equal(back[i].y, e.nodes[i].y)
    }
  }
})
