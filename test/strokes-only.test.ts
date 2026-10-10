// `strokesOnly`: the centreline engine with NO filled paths. The ink no stroke explains —
// note heads, dots, a speck, a caption — is drawn as round-capped strokes of its own
// skeleton (centerline/blobStrokes.ts) instead of going to the planar tracer, and nothing
// is dropped: the rendered trace stays close to the source.
//
//   node --test test/strokes-only.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { ensureImageData } from '../bench/nodeHarness.ts'
import { decodePng } from '../src/lib/png/decode.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { decideInkMode } from '../src/lib/traceInput/ink.ts'
import { rasterizeDoc } from '../src/lib/render/raster.ts'
import { fidelity } from '../src/lib/render/fidelity.ts'
import { baseOptions } from '../src/mcp/trace.ts'
import type { EditableDoc } from '../src/lib/path/types.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RES = 512

async function trace(name: string, strokesOnly: boolean) {
  const svg = readFileSync(join(root, 'public/examples/line-art', `${name}.svg`), 'utf8')
  const img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
  const plan = decideInkMode(img, 128, { colorMode: 'mono' })
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS,
    mode: 'mono',
    centerline: true,
    strokesOnly,
    threshold: plan.threshold,
    invert: plan.invert,
  })
  const de = fidelity(img.data, rasterizeDoc(doc, img.width, img.height), img.width, img.height).meanDeltaE
  return { doc, de }
}

/** Filled ink paths: everything with a fill but the paper rectangle. */
const fills = (doc: EditableDoc) =>
  doc.items.filter((it) => it.kind === 'path' && it.fill !== 'none' && it.id !== 'paper')

// Note heads (la-score), specks and dots (la-stubs), a QR block and a caption (la-hybrid):
// every kind of ink the engine would otherwise fill.
for (const name of ['la-score', 'la-stubs', 'la-hybrid']) {
  test(`strokes only: ${name} comes back with no filled path, and no ink left out`, async () => {
    const mixed = await trace(name, false)
    const only = await trace(name, true)
    assert.ok(fills(mixed.doc).length > 0, `${name} has fills without the option — the case tests nothing`)
    assert.deepEqual(
      fills(only.doc).map((it) => it.id),
      [],
      `${name}: strokesOnly still emitted fills`,
    )
    for (const it of only.doc.items)
      if (it.kind === 'path' && it.id !== 'paper')
        assert.ok(it.stroke && it.stroke.width > 0 && it.fill === 'none', `${name}: ${it.id} is not a stroke-only path`)
    // Approximated, not dropped: a dropped note head or caption costs far more than this.
    // (la-hybrid's QR block is the worst case: a dense grid read as strokes, 1.8 → 3.5 ΔE.)
    assert.ok(
      only.de <= mixed.de + 2,
      `${name}: ΔE ${only.de.toFixed(2)} with strokesOnly vs ${mixed.de.toFixed(2)} — ink went missing`,
    )
  })
}

test('MCP: strokesOnly reaches the tracer only together with strokes', () => {
  assert.equal(baseOptions({ strokes: true, strokesOnly: true }).strokesOnly, true)
  assert.equal(baseOptions({ strokes: true }).strokesOnly, undefined)
  // Without strokes there is no centreline trace for it to apply to.
  assert.equal(baseOptions({ strokesOnly: true }).strokesOnly, undefined)
})
