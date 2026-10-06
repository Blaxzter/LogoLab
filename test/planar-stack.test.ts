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
import { cubicAt, segmentControls, segmentCount } from '../src/lib/path/geometry.ts'
import type { EditableDoc, PathItem } from '../src/lib/path/types.ts'
import type { VectorizeOptions } from '../src/types.ts'

type RGBA = [number, number, number, number]
const W = 96
const WHITE: RGBA = [255, 255, 255, 255]
const RED: RGBA = [220, 40, 40, 255]
const BLUE: RGBA = [30, 60, 200, 255]
const BLACK: RGBA = [15, 15, 20, 255]
const CLEAR: RGBA = [0, 0, 0, 0]

/** A W×W image whose colour at each point is `at(x, y)`, 4×4 supersampled. */
function draw(at: (x: number, y: number) => RGBA): ImageData {
  const data = new Uint8ClampedArray(W * W * 4)
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const acc = [0, 0, 0, 0]
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const c = at(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)
          for (let k = 0; k < 3; k++) acc[k] += c[k] * c[3]
          acc[3] += c[3]
        }
      const p = (y * W + x) * 4
      for (let k = 0; k < 3; k++) data[p + k] = acc[3] > 0 ? acc[k] / acc[3] : 0
      data[p + 3] = Math.round(acc[3] / 16)
    }
  return { width: W, height: W, data, colorSpace: 'srgb' } as ImageData
}

/** Concentric discs (radius → colour, outermost first) over `bg`. */
const rings = (bg: RGBA, discs: [number, RGBA][]): ImageData =>
  draw((x, y) => {
    const r = Math.hypot(x - W / 2, y - W / 2)
    let c = bg
    for (const [rad, col] of discs) if (r <= rad) c = col
    return c
  })
const inDisc = (x: number, y: number, cx: number, cy: number, r: number) => Math.hypot(x - cx, y - cy) <= r

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
  // Containment adds no edge, and no edge the tiled trace has moves.
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

// --- side by side --------------------------------------------------------------

const GREEN: RGBA = [40, 170, 70, 255]

/** The area a path paints (nonzero: outer loops add, holes subtract). */
function areaOf(p: PathItem): number {
  let a = 0
  for (const sp of p.subPaths) {
    const pts: { x: number; y: number }[] = []
    for (let seg = 0; seg < segmentCount(sp); seg++) {
      const { p0, c1, c2, p3 } = segmentControls(sp, seg)
      for (let k = 0; k < 8; k++) pts.push(cubicAt(p0, c1, c2, p3, k / 8))
    }
    for (let i = 0; i < pts.length; i++) {
      const q = pts[(i + 1) % pts.length]
      a += (pts[i].x * q.y - q.x * pts[i].y) / 2
    }
  }
  return Math.abs(a)
}
const near1 = (got: number, want: number, tol = 0.03) => Math.abs(got / want - 1) < tol

/** Stacking may only ADD to a region: every pixel a label covered tiled, its stacked
 *  layers still cover. (A completion whose replaced span looped round the far side of
 *  its new path once dropped half a star arm while its area still grew.) */
function keepsEveryRegion(tiled: EditableDoc, stacked: EditableDoc): void {
  const cover = (doc: EditableDoc, fill: string) => {
    const items = paths(doc)
      .filter((p) => p.fill === fill)
      .map((p) => ({ ...p, fill: '#000000' }))
    return rasterizeDoc({ ...doc, items }, W, W)
  }
  for (const t of paths(tiled)) {
    const a = cover(tiled, t.fill)
    const b = cover(stacked, t.fill)
    let lost = 0
    for (let i = 0; i < W * W; i++) if (a[i * 4] < 64 && b[i * 4] > 192) lost++
    assert.equal(lost, 0, `${t.fill} lost ${lost} px it covered tiled`)
  }
}
const ORANGE: RGBA = [240, 150, 30, 255]
const YELLOW: RGBA = [240, 210, 40, 255]

test('two overlapping circles: one paints whole under the other and the overlap', async () => {
  // Mastercard: red and yellow discs, the overlap its own orange. Both circles' arcs
  // stay drawn through the overlap, so either could complete along the other's edge —
  // but the completed one then shares the overlap's rim with the other crescent, and
  // that is only fringe-free if the other paints above it. So exactly ONE completes.
  const img = draw((x, y) => {
    const a = inDisc(x, y, 36, 48, 24)
    const b = inDisc(x, y, 60, 48, 24)
    return a && b ? ORANGE : a ? RED : b ? YELLOW : WHITE
  })
  const { tiled, stacked } = await both(img)
  const red = itemOf(stacked, RED)[0]
  const yellow = itemOf(stacked, YELLOW)[0]
  const orange = itemOf(stacked, ORANGE)[0]
  const ids = paths(stacked).map((p) => p.id)
  const disc = Math.PI * 24 * 24
  const whole = [red, yellow].filter((p) => near1(areaOf(p), disc))
  assert.equal(whole.length, 1, [red, yellow].map((p) => `${p.fill} ${areaOf(p).toFixed(0)}`).join(', '))
  const other = whole[0] === red ? yellow : red
  assert.ok(areaOf(other) < disc * 0.8, 'the other stays a crescent')
  assert.ok(ids.indexOf(whole[0].id) < ids.indexOf(other.id) && ids.indexOf(whole[0].id) < ids.indexOf(orange.id))
  samePicture(img, tiled, stacked, true)
  keepsEveryRegion(tiled, stacked)
  // No hidden edge was needed: the circles' outlines were drawn.
  assert.equal(stacked.topology!.edges.length, tiled.topology!.edges.length)
})

test('a square behind a circle is completed under it with a hidden edge', async () => {
  // The circle straddles the square's right side: the square's top and bottom sides
  // stop at the circle (T-junctions), the circle's arc runs through. The square goes
  // under, rejoined by a straight hidden edge; the circle stays whole on top.
  const img = draw((x, y) =>
    inDisc(x, y, 70, 48, 18) ? BLUE : x >= 16 && x <= 70 && y >= 26 && y <= 70 ? GREEN : WHITE,
  )
  const { tiled, stacked } = await both(img)
  const green = itemOf(stacked, GREEN)[0]
  const blue = itemOf(stacked, BLUE)[0]
  const ids = paths(stacked).map((p) => p.id)
  assert.ok(ids.indexOf(green.id) < ids.indexOf(blue.id), 'the square under the circle')
  assert.equal(stacked.topology!.edges.length, tiled.topology!.edges.length + 1, 'one hidden edge')
  // The whole square: its right side runs straight through under the circle.
  assert.ok(near1(areaOf(green), 54 * 44), `square paints ${areaOf(green).toFixed(0)} of ${54 * 44}`)
  const xs = green.subPaths[0].nodes.map((n) => n.x)
  assert.ok(Math.max(...xs) < 72, `nothing past the square's right side (${Math.max(...xs).toFixed(1)})`)
  samePicture(img, tiled, stacked, true)
  keepsEveryRegion(tiled, stacked)
})

test('a disc split in two colours stays tiled: a completion would fringe the rim', async () => {
  // Either half could complete along the other's rim, but that rim borders the page:
  // both halves would anti-alias it, and the lower one's colour would show round it.
  const img = draw((x, y) => (inDisc(x, y, 48, 48, 30) ? (x < 48 ? RED : BLUE) : WHITE))
  const { tiled, stacked } = await both(img)
  for (const c of [RED, BLUE]) assert.ok(areaOf(itemOf(stacked, c)[0]) < Math.PI * 30 * 30 * 0.6, 'still a half')
  samePicture(img, tiled, stacked, true)
})

test('a checkerboard stays tiled: no cell outline carries on into another', async () => {
  const img = draw((x, y) => ((Math.floor(x / 24) + Math.floor(y / 24)) % 2 ? BLACK : WHITE))
  const { tiled, stacked } = await both(img)
  assert.equal(stacked.topology!.edges.length, tiled.topology!.edges.length)
  const loopsOf = (d: EditableDoc) => paths(d).reduce((n, p) => n + p.loops!.length, 0)
  assert.equal(loopsOf(stacked), loopsOf(tiled))
  samePicture(img, tiled, stacked, false)
})

test('a shape behind several, in a ring: completions keep every region', async () => {
  // Bands behind a ring of discs, the discs over every seam: many T-junctions at once,
  // completions that share spans, a band whose bridge would have to cross itself.
  const BANDS: RGBA[] = [RED, GREEN, YELLOW, ORANGE]
  const img = draw((x, y) => {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2
      if (inDisc(x, y, 48 + Math.cos(a) * 28, 48 + Math.sin(a) * 28, 9)) return BLUE
    }
    return BANDS[Math.min(3, Math.floor(y / 24))]
  })
  const { tiled, stacked } = await both(img)
  // The bands complete under the discs on their seams (hidden edges), each one strip.
  assert.ok(stacked.topology!.edges.length > tiled.topology!.edges.length, 'no band completed')
  for (const c of BANDS) assert.equal(itemOf(stacked, c)[0].loops!.length, 1, 'a band is one strip')
  keepsEveryRegion(tiled, stacked)
  samePicture(img, tiled, stacked, true)
})
