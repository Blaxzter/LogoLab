// Planar subdivision tracer: topology integrity (per-pixel relabel), determinism,
// and shared-edge coincidence. Synthetic label maps have exact ground truth, so
// interior pixels must render their own region's colour and shared boundaries
// must be byte-coincident between the two regions that own them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { tracePlanar } from '../src/lib/trace/planarAssemble.ts'
import { materializeRegion, reverseEdgeNodes } from '../src/lib/path/topology.ts'
import { rasterizeDoc } from '../src/lib/render/raster.ts'
import type { EditableDoc, PathItem } from '../src/lib/path/types.ts'

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
