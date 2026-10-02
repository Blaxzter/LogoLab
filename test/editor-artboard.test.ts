// The growing artboard: the viewBox follows the VISIBLE drawing (strokes
// included) on commit, and the infinite board's camera pans and zooms freely
// around it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EditableDoc, PathItem } from '../src/lib/path/types.ts'
import {
  drawingBounds,
  fitArtboardToDrawing,
  fitGrowingArtboard,
  outwardBox,
  resizeArtboard,
  setArtboardMode,
} from '../src/lib/editor/artboard.ts'
import { cameraView, fitCamera, panCamera, zoomCamera } from '../src/lib/editor/camera.ts'

const rect = (id: string, x: number, y: number, w: number, h: number, extra: Partial<PathItem> = {}): PathItem => ({
  kind: 'path',
  id,
  fill: '#000000',
  fillRule: 'nonzero',
  visible: true,
  subPaths: [
    {
      closed: true,
      nodes: [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ],
    },
  ],
  ...extra,
})

const doc = (items: PathItem[], grow = true): EditableDoc => ({
  viewBox: [0, 0, 512, 512],
  items,
  ...(grow ? { artboard: 'grow' as const } : {}),
})

test('a growing artboard wraps the drawing in every direction', () => {
  const d = fitGrowingArtboard(doc([rect('a', -100, 20, 50, 50), rect('b', 600, 700, 10, 10)]))
  assert.deepEqual(d.viewBox, [-100, 20, 710, 690])
})

test('hidden items do not stretch it; strokes do, by half their width', () => {
  const d = fitGrowingArtboard(
    doc([
      rect('a', 10, 10, 20, 20, { stroke: { color: '#000000', width: 4, cap: 'butt', join: 'miter' } }),
      rect('h', 900, 900, 10, 10, { visible: false }),
    ]),
  )
  assert.deepEqual(d.viewBox, [8, 8, 24, 24])
})

test('fixed, empty and already-fitted documents come back as the same object', () => {
  const fixed = doc([rect('a', -50, 0, 10, 10)], false)
  assert.equal(fitGrowingArtboard(fixed), fixed)
  const empty = doc([])
  assert.equal(fitGrowingArtboard(empty), empty)
  const fitted = fitGrowingArtboard(doc([rect('a', 0.5, 0.5, 9, 9)]))
  assert.equal(fitGrowingArtboard(fitted), fitted)
})

test('outward rounding never cuts the art and absorbs float noise', () => {
  assert.deepEqual(outwardBox({ x: 0.5, y: -0.5, w: 10, h: 10 }), [0, -1, 11, 11])
  assert.deepEqual(outwardBox({ x: 1e-9, y: 0, w: 512.0000000001, h: 3 }), [0, 0, 512, 3])
})

test('switching modes: Grow refits at once, Fixed keeps the grown size', () => {
  const fixed = doc([rect('a', -20, -20, 40, 40)], false)
  const grown = setArtboardMode(fixed, true)
  assert.equal(grown.artboard, 'grow')
  assert.deepEqual(grown.viewBox, [-20, -20, 40, 40])
  const back = setArtboardMode(grown, false)
  assert.equal(back.artboard, undefined)
  assert.deepEqual(back.viewBox, [-20, -20, 40, 40])
  // A fixed artboard no longer follows the drawing.
  assert.equal(fitGrowingArtboard({ ...back, items: [rect('b', 0, 0, 999, 999)] }).viewBox, back.viewBox)
})

test('resize keeps the corner; fit-to-drawing is a one-off and needs art', () => {
  const d = doc([rect('a', 5, 5, 10, 10)], false)
  assert.deepEqual(resizeArtboard(d, 100, 200).viewBox, [0, 0, 100, 200])
  assert.deepEqual(fitArtboardToDrawing(d)?.viewBox, [5, 5, 10, 10])
  assert.equal(fitArtboardToDrawing(doc([], false)), null)
  assert.equal(drawingBounds([]), null)
})

test('imported markup it cannot measure keeps the artboard from shrinking past it', () => {
  const raw = { kind: 'raw', id: 'r', markup: '<text>lyrics</text>', visible: true } as unknown as PathItem
  const d = fitGrowingArtboard(doc([rect('a', 10, 10, 20, 20), raw, rect('b', -30, 0, 5, 5)]))
  assert.deepEqual(d.viewBox, [-30, 0, 542, 512])
})

test('the board camera: the view fills the pane, pans 1:1, zooms about the pointer', () => {
  const cam = fitCamera({ x: 0, y: 0, w: 512, h: 512 }, 1000, 500)
  const v = cameraView(cam, 1000, 500)
  // Fitted with a margin, centred, and the view has the pane's aspect.
  assert.ok(v.x < 0 && v.y < 0 && v.x + v.w > 512 && v.y + v.h > 512)
  assert.ok(Math.abs(v.w / v.h - 2) < 1e-9)
  assert.ok(Math.abs(v.x + v.w / 2 - 256) < 1e-9)

  // Panning has no limit: drag the board 10 000 px and the view follows.
  const far = cameraView(panCamera(cam, -10000, 0), 1000, 500)
  assert.ok(Math.abs(far.x - (v.x + 10000 / cam.ppu)) < 1e-6)

  // The document point under the pointer stays under it while zooming out.
  const at = (c: typeof cam, px: number, py: number) => {
    const vv = cameraView(c, 1000, 500)
    return { x: vv.x + (px / 1000) * vv.w, y: vv.y + (py / 500) * vv.h }
  }
  const before = at(cam, 800, 100)
  const z = zoomCamera(cam, 800, 100, 1000, 500, 0.25, 0, Infinity)
  const after = at(z, 800, 100)
  assert.ok(Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6)
  assert.ok(z.ppu < cam.ppu)
  // …and the clamp holds.
  assert.equal(zoomCamera(cam, 0, 0, 1000, 500, 1e-6, cam.ppu, cam.ppu), cam)
})
