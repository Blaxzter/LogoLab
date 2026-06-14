// Unit tests for the pure EditableDoc rasterizer (src/devtest/raster.ts).
//
//   node --test test/raster.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rasterizeDoc, boundaryMask, parseHex } from '../src/devtest/raster.ts'
import type { EditableDoc, PathItem, SubPath } from '../src/lib/path/types.ts'

/** A closed rectangle subpath with straight (null-handle) edges. */
function rect(x: number, y: number, w: number, h: number): SubPath {
  const c = (px: number, py: number) => ({ x: px, y: py, hIn: null, hOut: null, kind: 'corner' as const })
  return { closed: true, nodes: [c(x, y), c(x + w, y), c(x + w, y + h), c(x, y + h)] }
}

function pathItem(id: string, subPaths: SubPath[], fill: string, extra: Partial<PathItem> = {}): PathItem {
  return { kind: 'path', id, fill, fillRule: 'nonzero', subPaths, visible: true, ...extra }
}

function doc(w: number, h: number, items: PathItem[]): EditableDoc {
  return { viewBox: [0, 0, w, h], items }
}

const at = (px: Uint8ClampedArray, w: number, x: number, y: number): [number, number, number] => {
  const o = (y * w + x) * 4
  return [px[o], px[o + 1], px[o + 2]]
}

test('empty doc → all background (white)', () => {
  const px = rasterizeDoc(doc(8, 8, []), 8, 8)
  for (let i = 0; i < px.length; i += 4) assert.equal(px[i], 255)
})

test('axis-aligned black square covers exactly 1/4 of a 40² canvas', () => {
  const d = doc(40, 40, [pathItem('a', [rect(10, 10, 20, 20)], '#000000')])
  const px = rasterizeDoc(d, 40, 40)
  let sum = 0
  for (let i = 0; i < px.length; i += 4) sum += px[i]
  const mean = sum / (40 * 40)
  // 0.25 black + 0.75 white = 191.25.
  assert.ok(Math.abs(mean - 191.25) < 1.0, `mean R ${mean.toFixed(2)} should be ~191.25`)
  // Interior is black, far corner is white.
  assert.deepEqual(at(px, 40, 20, 20), [0, 0, 0])
  assert.deepEqual(at(px, 40, 2, 2), [255, 255, 255])
})

test('even-odd compound path leaves an inner hole', () => {
  const d = doc(40, 40, [pathItem('donut', [rect(0, 0, 40, 40), rect(12, 12, 16, 16)], '#000000', { fillRule: 'evenodd' })])
  const px = rasterizeDoc(d, 40, 40)
  assert.deepEqual(at(px, 40, 20, 20), [255, 255, 255], 'hole shows background')
  assert.deepEqual(at(px, 40, 4, 20), [0, 0, 0], 'ring is filled')
})

test('painter order: a top layer paints over the bottom', () => {
  const d = doc(20, 20, [
    pathItem('bg', [rect(0, 0, 20, 20)], '#ff0000'),
    pathItem('fg', [rect(5, 5, 10, 10)], '#0000ff'),
  ])
  const px = rasterizeDoc(d, 20, 20)
  assert.deepEqual(at(px, 20, 10, 10), [0, 0, 255], 'center is the top layer')
  assert.deepEqual(at(px, 20, 1, 1), [255, 0, 0], 'corner is the bottom layer')
})

test('linear gradient ramps black→white left to right', () => {
  const g: PathItem = pathItem('grad', [rect(0, 0, 100, 10)], '#000000', {
    gradient: { type: 'linear', x1: 0, y1: 5, x2: 100, y2: 5, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] },
  })
  const px = rasterizeDoc(doc(100, 10, [g]), 100, 10)
  const left = at(px, 100, 2, 5)[0]
  const midC = at(px, 100, 50, 5)[0]
  const right = at(px, 100, 97, 5)[0]
  assert.ok(left < 20, `left dark, got ${left}`)
  assert.ok(Math.abs(midC - 127) < 12, `mid ~127, got ${midC}`)
  assert.ok(right > 235, `right light, got ${right}`)
})

test('centered radial gradient: white center → blue rim', () => {
  const g: PathItem = pathItem('rad', [rect(0, 0, 64, 64)], '#ffffff', {
    gradient: { type: 'radial', cx: 32, cy: 32, r: 32, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#0000ff' }] },
  })
  const px = rasterizeDoc(doc(64, 64, [g]), 64, 64)
  const center = at(px, 64, 32, 32)
  const rim = at(px, 64, 32, 1)
  assert.ok(center[2] > 240 && center[0] > 240, `center white, got ${center}`)
  assert.ok(rim[2] > rim[0], `rim bluer than center, got ${rim}`)
})

test('per-stop opacity lets the background show through', () => {
  // A full-bleed red rect whose gradient fades to fully transparent at offset 1.
  const g: PathItem = pathItem('fade', [rect(0, 0, 100, 10)], '#ff0000', {
    gradient: { type: 'linear', x1: 0, y1: 5, x2: 100, y2: 5, stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#ff0000', opacity: 0 }] },
  })
  const px = rasterizeDoc(doc(100, 10, [g]), 100, 10)
  const opaqueEnd = at(px, 100, 1, 5)
  assert.ok(opaqueEnd[0] === 255 && opaqueEnd[1] < 8 && opaqueEnd[2] < 8, `opaque end ~red, got ${opaqueEnd}`)
  const farRight = at(px, 100, 99, 5)
  assert.ok(farRight[0] > 250 && farRight[1] > 250 && farRight[2] > 250, `transparent end shows white bg, got ${farRight}`)
})

test('boundaryMask marks pixels along a shape edge', () => {
  const d = doc(40, 40, [pathItem('a', [rect(10, 10, 20, 20)], '#000000')])
  const mask = boundaryMask(d, 40, 40, 0)
  // A point on the top edge is marked; the deep interior is not.
  assert.equal(mask[10 * 40 + 20], 1)
  assert.equal(mask[20 * 40 + 20], 0)
})

test('parseHex handles #rrggbb and #rgb', () => {
  assert.deepEqual(parseHex('#ff8800'), [255, 136, 0])
  assert.deepEqual(parseHex('#f80'), [255, 136, 0])
})
