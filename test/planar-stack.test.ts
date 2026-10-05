// Stacked output (src/lib/trace/planarStack.ts): the planar graph re-layered by
// containment. A hole whose interior is entirely covered by opaque regions painted
// later is dropped, so the region paints under them as one solid shape. Two failure
// modes look fine in the item list and only show up rendered, which is why every case
// is also RASTERIZED against the tiled trace: dropping a hole over something
// see-through (the region shows through), and painting a container after its contents.
//
//   node --test test/planar-stack.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { rasterizeDoc } from '../src/lib/render/raster.ts'
import { deltaEField, deltaEStats } from '../src/lib/render/fidelity.ts'
import { removeRegionAndHeal } from '../src/lib/path/topologyEdit.ts'
import type { EditableDoc, PathItem } from '../src/lib/path/types.ts'
import type { VectorizeOptions } from '../src/types.ts'

type RGBA = [number, number, number, number]
const W = 96
const WHITE: RGBA = [255, 255, 255, 255]
const RED: RGBA = [220, 40, 40, 255]
const BLUE: RGBA = [30, 60, 200, 255]
const BLACK: RGBA = [15, 15, 20, 255]
const CLEAR: RGBA = [0, 0, 0, 0]

/** Concentric discs (radius → colour, outermost first) over `bg`, 4×4 supersampled. */
function rings(bg: RGBA, discs: [number, RGBA][]): ImageData {
  const data = new Uint8ClampedArray(W * W * 4)
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const acc = [0, 0, 0, 0]
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const r = Math.hypot(x + (sx + 0.5) / 4 - W / 2, y + (sy + 0.5) / 4 - W / 2)
          let c = bg
          for (const [rad, col] of discs) if (r <= rad) c = col
          for (let k = 0; k < 3; k++) acc[k] += c[k] * c[3]
          acc[3] += c[3]
        }
      const p = (y * W + x) * 4
      for (let k = 0; k < 3; k++) data[p + k] = acc[3] > 0 ? acc[k] / acc[3] : 0
      data[p + 3] = Math.round(acc[3] / 16)
    }
  return { width: W, height: W, data, colorSpace: 'srgb' } as ImageData
}

const flat = (patch: Partial<VectorizeOptions> = {}): VectorizeOptions => ({
  ...DEFAULT_VECTORIZE_OPTIONS,
  mode: 'color',
  gradients: false,
  ...patch,
})
const paths = (doc: EditableDoc) => doc.items.filter((it): it is PathItem => it.kind === 'path')
const byFill = (doc: EditableDoc, hex: string) => paths(doc).filter((p) => p.fill === hex)
const near = (fill: string, c: RGBA) => {
  const n = parseInt(fill.slice(1), 16)
  return Math.abs((n >> 16) - c[0]) + Math.abs(((n >> 8) & 255) - c[1]) + Math.abs((n & 255) - c[2]) < 40
}
const itemOf = (doc: EditableDoc, c: RGBA) => paths(doc).filter((p) => near(p.fill, c))

async function both(img: ImageData, patch: Partial<VectorizeOptions> = {}) {
  const tiled = await traceImage(img, flat(patch))
  const stacked = await traceImage(img, flat({ ...patch, layering: 'stacked' }))
  return { tiled, stacked }
}

/** Mean ΔE of a trace against its source (the metric composites the source's alpha
 *  over white, so the render goes over white too). */
function error(src: ImageData, doc: EditableDoc, bg: [number, number, number] = [255, 255, 255]): number {
  return deltaEStats(deltaEField(src.data, rasterizeDoc(doc, W, W, { background: bg }), W, W).de).meanDeltaE
}

/** Stacking may not make the picture worse — and over a backdrop the art does not
 *  share, it should make it BETTER: a tiled shared edge is two half-covered pixels
 *  composited one after the other, so the backdrop bleeds through the seam. */
function samePicture(src: ImageData, tiled: EditableDoc, stacked: EditableDoc, opaqueArt: boolean): void {
  const t = error(src, tiled)
  const s = error(src, stacked)
  assert.ok(s <= t + 0.05, `stacked ΔE ${s.toFixed(3)} vs tiled ${t.toFixed(3)}`)
  if (!opaqueArt) return
  const green: [number, number, number] = [0, 255, 0]
  const tg = error(src, tiled, green)
  const sg = error(src, stacked, green)
  assert.ok(sg < tg, `over green: stacked ΔE ${sg.toFixed(3)} vs tiled ${tg.toFixed(3)}`)
}

test('default is tiled, and explicit tiled is the same document', async () => {
  const img = rings(WHITE, [
    [36, RED],
    [18, BLUE],
  ])
  const a = await traceImage(img, flat())
  const b = await traceImage(img, flat({ layering: 'tiled' }))
  assert.deepEqual(b, a)
})

test('nested discs: each container paints solid under what it holds, same picture', async () => {
  const img = rings(WHITE, [
    [36, RED],
    [18, BLUE],
  ])
  const { tiled, stacked } = await both(img)
  // Tiled: the red annulus has a hole. Stacked: one loop each, bottom to top.
  assert.equal(itemOf(tiled, RED)[0].loops!.length, 2)
  const order = paths(stacked).map((p) => (near(p.fill, WHITE) ? 'W' : near(p.fill, RED) ? 'R' : 'B'))
  assert.deepEqual(order, ['W', 'R', 'B'])
  for (const p of paths(stacked)) assert.equal(p.loops!.length, 1, `${p.id} keeps a hole`)
  samePicture(img, tiled, stacked, true)
})

test('a counter the colour of the page goes on top as its own layer', async () => {
  // An "O": white page, black ring, white counter. The counter is the page's label
  // but must paint ABOVE the ring, so the label splits by depth.
  const img = rings(WHITE, [
    [36, BLACK],
    [20, WHITE],
  ])
  const { tiled, stacked } = await both(img)
  const whites = itemOf(stacked, WHITE)
  assert.equal(whites.length, 2)
  assert.ok(!whites[0].id.includes('-d') && whites[1].id.endsWith('-d2'), whites.map((w) => w.id).join())
  const ids = paths(stacked).map((p) => p.id)
  const ring = itemOf(stacked, BLACK)[0]
  assert.ok(ids.indexOf(whites[0].id) < ids.indexOf(ring.id) && ids.indexOf(ring.id) < ids.indexOf(whites[1].id))
  assert.equal(ring.loops!.length, 1)
  samePicture(img, tiled, stacked, true)
  // Tiled keeps one item per colour, ids unchanged.
  assert.equal(byFill(tiled, whites[0].fill).length, 1)
})

test('a hole onto transparency stays open', async () => {
  // A ring on a transparent canvas with a transparent centre: nothing to cover the hole.
  const img = rings(CLEAR, [
    [36, RED],
    [18, CLEAR],
  ])
  const { tiled, stacked } = await both(img)
  assert.equal(itemOf(stacked, RED)[0].loops!.length, 2)
  samePicture(img, tiled, stacked, false)
})

test('transparency deeper inside keeps every enclosing hole open', async () => {
  // White page ⊃ red disc ⊃ transparent hole ⊃ blue dot: the red shows the hole, so
  // the page under the red must not fill in either.
  const img = rings(WHITE, [
    [36, RED],
    [20, CLEAR],
    [9, BLUE],
  ])
  const { tiled, stacked } = await both(img)
  assert.equal(itemOf(stacked, RED)[0].loops!.length, 2)
  assert.equal(itemOf(stacked, WHITE)[0].loops!.length, 2)
  samePicture(img, tiled, stacked, false)
})

test('a removed background is transparency: what it held becomes the bottom layer', async () => {
  const img = rings(WHITE, [
    [36, RED],
    [18, BLUE],
  ])
  const { tiled, stacked } = await both(img, { removeBackground: true })
  assert.equal(itemOf(stacked, WHITE).length, 0)
  const red = itemOf(stacked, RED)[0]
  assert.equal(red.loops!.length, 1)
  assert.equal(paths(stacked)[0].id, red.id)
  samePicture(img, tiled, stacked, false)
})

test('stacking moves no edge: the topology is the tiled one', async () => {
  const { tiled, stacked } = await both(
    rings(WHITE, [
      [36, BLACK],
      [20, WHITE],
      [8, RED],
    ]),
  )
  assert.deepEqual(stacked.topology, tiled.topology)
  // Every edge is still drawn by someone.
  const used = new Set<number>()
  for (const p of paths(stacked)) for (const l of p.loops!) for (const r of l) used.add(r.edge)
  for (const e of stacked.topology!.edges) assert.ok(used.has(e.id), `edge ${e.id} orphaned`)
})

test('deleting a stacked shape reveals the one under it', async () => {
  // Remove & heal reads the edge sides: the red disc's rim is now drawn by the disc
  // alone (the page under it dropped that hole), so the disc has no neighbour to merge
  // into and is simply removed — and the page beneath shows, as a stack should.
  const { stacked } = await both(
    rings(WHITE, [
      [36, RED],
      [18, BLUE],
    ]),
  )
  const red = itemOf(stacked, RED)[0]
  const healed = removeRegionAndHeal(stacked, red.id, { x: W / 2 + 27, y: W / 2 })
  assert.equal(itemOf(healed, RED).length, 0)
  assert.equal(itemOf(healed, BLUE).length, 1)
  const after = rasterizeDoc(healed, W, W)
  const px = (x: number, y: number) => Array.from(after.slice((y * W + x) * 4, (y * W + x) * 4 + 3))
  assert.deepEqual(px(W / 2 + 27, W / 2), [255, 255, 255], 'the page shows where the disc was')
  assert.ok(
    near(
      '#' +
        px(W / 2, W / 2)
          .map((v) => v.toString(16).padStart(2, '0'))
          .join(''),
      BLUE,
    ),
    'the dot stays',
  )
})
