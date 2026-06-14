// Headless baseline writer: traces the PNG corpus with the crisp engine, scores
// it, and writes docs/harness-baseline.json + prints a markdown table.
//
//   node src/devtest/runBaseline.ts            # crisp (default headless engine)
//
// potrace numbers are captured in the browser harness (vectorize-test.html),
// which can run the WASM tracer + DOMParser the headless path can't.

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ensureImageData, loadPng, PNG_CORPUS } from './nodeHarness.ts'
import { SYNTHETIC_CORPUS, syntheticSource } from './lineArtCorpus.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { score, scoreboardMarkdown, type ScoreRow } from './scoreboard.ts'

ensureImageData()

const engine = (process.argv[2] as 'crisp' | 'potrace') || 'crisp'
const rows: ScoreRow[] = []

for (const c of PNG_CORPUS) {
  const img = loadPng(c.path)
  const row = await score(c.name, engine, img, () =>
    traceImage(img as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine, gradients: true }),
  )
  rows.push(row)
}

// Synthetic line-art corpus (summit, bloom): solid-fill / per-shape-opacity cases
// the pure rasterizer can rebuild headlessly, so the corner-preservation case
// (summit) gates `npm test` too. Source pixels = the ground-truth doc rasterized.
for (const c of SYNTHETIC_CORPUS) {
  const src = syntheticSource(c)
  const row = await score(c.name, engine, src, () =>
    traceImage(src as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine, gradients: true }),
  )
  rows.push(row)
}

const md = scoreboardMarkdown(rows)
console.log(md)

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
writeFileSync(join(root, 'docs', 'harness-baseline.json'), JSON.stringify(rows, null, 2) + '\n')
console.log('\nwrote docs/harness-baseline.json')
