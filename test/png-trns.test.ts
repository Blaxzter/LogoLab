// The headless PNG decoder (src/lib/png/decode.ts — the MCP server's first choice)
// honours a tRNS COLOUR KEY on grey and RGB images, not only the palette alpha
// table. Optimizers (oxipng/optipng) turn binary-alpha RGBA into RGB + a key, with
// the transparent pixels usually stored black; ignoring the key decoded that
// background as opaque black paper.
//
//   node --test test/png-trns.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { decodePng } from '../src/lib/png/decode.ts'

const SIG = [137, 80, 78, 71, 13, 10, 26, 10]

function chunk(type: string, data: number[] | Uint8Array): number[] {
  const len = data.length
  // The decoder skips CRCs, so zeros will do.
  return [
    len >>> 24,
    (len >>> 16) & 255,
    (len >>> 8) & 255,
    len & 255,
    ...[...type].map((c) => c.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ]
}

/** A one-row PNG, filter 0, from raw sample bytes. */
function png(width: number, bitDepth: number, colorType: number, row: number[], trns: number[]): Uint8Array {
  const ihdr = [0, 0, 0, width, 0, 0, 0, 1, bitDepth, colorType, 0, 0, 0]
  return new Uint8Array([
    ...SIG,
    ...chunk('IHDR', ihdr),
    ...chunk('tRNS', trns),
    ...chunk('IDAT', deflateSync(new Uint8Array([0, ...row]))),
    ...chunk('IEND', []),
  ])
}

const alphas = (img: { data: Uint8ClampedArray }) => [...img.data].filter((_, i) => i % 4 === 3)

test('RGB 8-bit: the keyed colour decodes transparent', () => {
  const img = decodePng(png(2, 8, 2, [0, 0, 0, 255, 0, 0], [0, 0, 0, 0, 0, 0]))
  assert.deepEqual(alphas(img), [0, 255])
  assert.deepEqual([...img.data.slice(4, 8)], [255, 0, 0, 255])
})

test('RGB 16-bit: the key is compared at full depth', () => {
  // Pixel 0 = key exactly; pixel 1 shares the high bytes but not the low ones.
  const img = decodePng(png(2, 16, 2, [1, 2, 3, 4, 5, 6, 1, 3, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6]))
  assert.deepEqual(alphas(img), [0, 255])
})

test('grey 8-bit and sub-byte grey: the key is the stored (unscaled) sample', () => {
  assert.deepEqual(alphas(decodePng(png(2, 8, 0, [200, 10], [0, 200]))), [0, 255])
  // 2-bit grey: samples 3, 1, 3, 0 packed in one byte; key = 3.
  assert.deepEqual(alphas(decodePng(png(4, 2, 0, [0b11011100], [0, 3]))), [0, 255, 0, 255])
})

test('no tRNS: everything stays opaque', () => {
  const ihdr = [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]
  const bytes = new Uint8Array([
    ...SIG,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', deflateSync(new Uint8Array([0, 0, 0, 0]))),
    ...chunk('IEND', []),
  ])
  assert.deepEqual(alphas(decodePng(bytes)), [255])
})
