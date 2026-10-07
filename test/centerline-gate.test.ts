// CENTRELINE ground-truth gate: trace every line-art fixture as strokes and score it
// against THE STROKES THAT MADE THE PIXELS (bench/lineArtGround.ts + centerlineScore.ts).
//
//   node --test test/centerline-gate.test.ts
//
// The same contract as test/truth-gate.test.ts: every number is an absolute distance
// from correct — centreline chamfer, width error, topology deltas, fill IoU, and the
// trace RENDERED against the source in ΔE — so an improvement moves further inside a
// limit and nothing is ever re-blessed. `KNOWN_DEFECTS` is a boolean list: a case not on
// it must pass every gate; a case on it must still fail, or the entry is stale and the
// build says so. The list can only shrink.

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
import { AB_LINE_ART_CASES } from '../bench/abCorpus.ts'
import { scoreCenterline, centerlineTol } from '../bench/centerlineScore.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The gate's resolutions. 2048 is the A/B line lane's and the app's (an upload traces at
 * its own size times the mono upscale, up to the flat cap); 512 is where the fixtures'
 * widths span 2–18 px — the regime a small icon reaches after that upscale — and where
 * the engine was first measured. The pixel limits scale with the raster (`centerlineTol`).
 */
const RESOLUTIONS = [512, 2048]

/**
 * Cases that FAIL a gate today, and why. Each is a real, understood limit of the engine —
 * measured in docs/vectorization-benchmarks.md §39 — not a fault in the answer sheet.
 * Delete an entry the moment its case passes; the test will tell you when.
 */
const KNOWN_DEFECTS: Record<string, string> = {
  // The 14° chevron's miter exceeds SVG's default limit, so the ink is bevelled 0.7 px
  // short of the authored apex; the apex rebuild's raster check (the distance transform
  // must read a full half-width at the apex) rejects it as a smooth bend and the
  // corner stays at the skeleton's own turn, ~12 px inside. Bevel joins are rare in
  // icons; a check that separates a bevel from a tight bend is open (§39.4).
  'la-caps@512': 'missed: the over-limit miter tip is drawn from the skeleton turn, 12 px short of the apex',
  'la-caps@2048': 'missed: the same miter tip, 73 px short at four times the raster',
  // Lucide's star rounds every vertex with a 0.53 u arc — 8.5 px at 512, HALF the stroke's
  // 16 px half-width. A centreline arc tighter than r has no inner boundary, so the
  // skeleton (any medial axis) rounds it wider, and the fit follows the skeleton (§39.4).
  'lucide-star@512': 'centre: authored corner radii below the half-width round wider than drawn',
  'lucide-star@2048': 'centre: the same radii (34 px against a 64 px half-width), p95 18 px',
  // The field report's three defects (§39.8), each with its fixture. Entries leave this
  // list with the fix that clears them.
  'la-hub@512': 'turns: two sails run on into the ring at its T junctions; the ring is chorded, not one circle',
  'la-hub@2048': 'turns: the same sails into the ring, six turns',
  'la-cup@512': 'turns, ends, paths, missed: the double-line shaft tangles where it crosses the bowl beside the club head',
  'la-cup@2048': 'turns, missed: the same tangle at the crossing',
  'la-stubs@512': 'centre, p95, ends, paths: faint texture on the ring and bar comes back as thin stub strokes',
  'la-stubs@2048': 'centre, p95, ends, paths: the same stubs',
  'la-hybrid@512': 'fills, centre, ends, paths, ΔE: the QR block and the caption are traced as strokes (scribble, "Dro S’op")',
  'la-hybrid@2048': 'fills, centre, ends, paths: the same',
}

for (const RES of RESOLUTIONS)
  for (const c of AB_LINE_ART_CASES) {
    test(`centreline gate: ${c.id} @${RES}`, async () => {
      const svg = readFileSync(join(root, c.path), 'utf8')
      const img = decodePng(
        new Resvg(svg, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng(),
      )
      const plan = decideInkMode(img, 128, { colorMode: 'mono' })
      const doc = await traceImage(img as unknown as ImageData, {
        ...DEFAULT_VECTORIZE_OPTIONS,
        mode: 'mono',
        centerline: true,
        threshold: plan.threshold,
        invert: plan.invert,
      })
      const s = scoreCenterline(svg, doc, img, centerlineTol(RES))
      const line = `centre ${s.centreMean.toFixed(2)}/${s.centreP95.toFixed(2)} missed ${s.missedMean.toFixed(2)} width ${(s.widthErr * 100).toFixed(0)}% ends ${s.endsDelta} paths ${s.pathsDelta} turns ${s.turns} fills ${Number.isFinite(s.fillIoU) ? s.fillIoU.toFixed(2) : '—'} ΔE ${s.deltaE.toFixed(2)}`
      const known = KNOWN_DEFECTS[`${c.id}@${RES}`]
      if (known) {
        assert.ok(
          s.failures.length > 0,
          `${c.id} @${RES} PASSES every gate now (${line}) — delete its KNOWN_DEFECTS entry: "${known}"`,
        )
        return
      }
      assert.deepEqual(s.failures, [], `${c.id} @${RES} fails [${s.failures.join(', ')}]: ${line}`)
      // Every stroked path carries a width the stroke rasterizer can paint.
      for (const it of doc.items)
        if (it.kind === 'path' && it.stroke)
          assert.ok(it.stroke.width > 0 && it.fill === 'none', `${c.id}: ${it.id} is not a stroke-only path`)
    })
  }
