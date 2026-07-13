// Prototype ground-truth run: authored SVG → raster → trace → score against the SOURCE SVG.
//
//   node --experimental-strip-types src/devtest/groundTruthRun.ts
//
// Unlike the trace-baseline gate (which compares the tracer to ITS OWN previous output and
// therefore cannot tell "correct" from "unchanged"), every number here is measured against
// the vector art that produced the pixels. 0 error / parsimony 1.0 are real optima, so an
// improvement reads as an improvement instead of tripping a ±12% drift band.
//
// Rasterization is resvg (not sharp/librsvg): when the rasterization IS the ground truth,
// fidelity on gradients and filters matters more than sharing a dependency.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from './svgGround.ts'
import { scoreGeometry, scoreRegions, type GeomScore, type RegionScore } from './geomScore.ts'
import { TRUTH_CORPUS, TRUTH_RESOLUTIONS, tierCases, type TruthCase } from './truthCorpus.ts'

ensureImageData()

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// The corpus, the trace options and the gates live in ./truthCorpus.ts so the browser view
// (/labs/truth — src/components/labs/TruthLab.tsx) scores the SAME cases with the SAME settings. One definition, two
// consumers — the view cannot silently drift from what the CLI measures.
const RESOLUTIONS = TRUTH_RESOLUTIONS

// Selection. TRUTH_CORPUS is 125 cases across two tiers and each is traced at three
// resolutions, so running the lot unasked would be a ~10-minute default. Tier 0 — the
// tracer's own named failure-mode suite — stays the default; tier 1 is opt-in.
//
//   groundTruthRun.ts                    tier 0 (16 cases) — the default
//   groundTruthRun.ts --tier 1           tier 1 (109 Fluent Emoji gradient cases)
//   groundTruthRun.ts --all              everything
//   groundTruthRun.ts bloom fluent-olive  just those, by name
const argv = process.argv.slice(2)
const names = argv.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a))
const tierArg = argv.includes('--tier') ? (Number(argv[argv.indexOf('--tier') + 1]) as 0 | 1) : null

const selected: TruthCase[] = names.length
  ? TRUTH_CORPUS.filter((c) => names.includes(c.name))
  : argv.includes('--all')
    ? TRUTH_CORPUS
    : tierCases(tierArg ?? 0)

/** Render an authored SVG to opaque RGBA at `size` px wide. */
function rasterize(svgPath: string, size: number): { width: number; height: number; data: Uint8ClampedArray } {
  const svg = readFileSync(join(root, svgPath), 'utf8')
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'white' }).render().asPng()
  return decodePng(png)
}

const f = (v: number, d = 2): string => v.toFixed(d).padStart(7)

type Row = GeomScore & { size: number; regions: RegionScore }

async function runCase(c: TruthCase, size: number): Promise<Row> {
  const img = rasterize(c.svg, size)
  const gt = parseGroundTruth(readFileSync(join(root, c.svg), 'utf8'))
  const shapes = toRasterSpace(gt, img.width)
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS,
    engine: 'planar',
    gradients: c.gradients,
  })
  return { ...scoreGeometry(shapes, doc, img.width, img.height), size, regions: scoreRegions(img, doc) }
}

for (const c of selected) {
  console.log(`\n━━━ ${c.name}  (${c.svg}) ━━━  ${c.note}`)

  // Refuse to score a case whose ground truth we cannot faithfully produce, rather than
  // approximating it and reporting a confident wrong number.
  const why = unscorable(parseGroundTruth(readFileSync(join(root, c.svg), 'utf8')))
  if (why) {
    console.log(`  ⨯ NOT SCORABLE — ${why}.\n    The tracer is not at fault; the CASE has no usable ground truth yet.`)
    continue
  }

  const rows: Row[] = []
  for (const size of RESOLUTIONS) rows.push(await runCase(c, size))

  // Absolute px is what you care about AT a resolution; the ‰-of-width column is what makes
  // the three rows comparable, so "error grew" can be told apart from "the image got bigger".
  if (rows[0].samples === 0) {
    console.log(
      `\n  BOUNDARY — n/a. This case has no interior boundary to compare: its whole authored\n` +
        `             outline is the canvas border. (Reporting 0.00 here would be a perfect\n` +
        `             score for having measured nothing.) It tests gradient fitting, not geometry.`,
    )
  } else {
    console.log(
      `\n  BOUNDARY AGREEMENT — 0 is perfect\n` +
        `  ${'res'.padStart(5)} ${'chamfer'.padStart(7)} ${'‰ width'.padStart(7)} ${'p95'.padStart(7)} ${'hausdorff'.padStart(9)} │ ${'missed'.padStart(7)} ${'spurious'.padStart(8)}`,
    )
    for (const r of rows) {
      console.log(
        `  ${String(r.size).padStart(5)} ${f(r.chamfer)} ${f((r.chamfer / r.size) * 1000)} ${f(r.p95)} ${f(r.hausdorff).padStart(9)} │ ${f(r.missedMean)} ${f(r.spuriousMean).padStart(8)}`,
      )
    }

    console.log(
      `\n  PARSIMONY — nodes per 100px of boundary; ratio 1.0 = as economical as the artist\n` +
        `  ${'res'.padStart(5)} ${'gt nodes'.padStart(8)} ${'doc nodes'.padStart(9)} ${'gt dens'.padStart(7)} ${'doc dens'.padStart(8)} ${'ratio'.padStart(6)}`,
    )
    for (const r of rows) {
      console.log(
        `  ${String(r.size).padStart(5)} ${String(r.gtNodes).padStart(8)} ${String(r.docNodes).padStart(9)} ${f(r.gtDensity)} ${f(r.docDensity).padStart(8)} ${f(r.parsimony, 1).padStart(6)}×`,
      )
    }
  }

  // Flat art only: on gradient art the "flat regions" are 8-bit quantisation bands, so a
  // tracer that correctly fits ONE gradient would be scored as dropping dozens of them.
  if (c.gradients) {
    console.log(`\n  REGION RECOVERY — n/a (gradient art; flat-region count is a quantisation artifact)`)
  } else {
    console.log(`\n  REGION RECOVERY — every flat region in the composited art must survive tracing`)
    for (const r of rows) {
      const g = r.regions
      const ok = g.recovered === g.trueRegions
      console.log(`  ${String(r.size).padStart(5)} ${g.recovered}/${g.trueRegions} recovered ${ok ? '✓' : '✗'}`)
      for (const m of g.missing.slice(0, 6)) {
        console.log(`        ✗ ${m.hex} (${String(m.areaPx).padStart(6)}px) — the trace paints ${m.paintedHex} there instead, ΔE ${m.deltaE.toFixed(1)}`)
      }
      if (g.missing.length > 6) console.log(`        … and ${g.missing.length - 6} more`)
    }
  }

  console.log(
    `\n  authored shapes: ${rows[0].gtShapes}   traced paths: ${rows.map((r) => r.docPaths).join(' / ')}` +
      `   — counts need not match; compositing splits regions and same-fill regions merge.`,
  )
}
