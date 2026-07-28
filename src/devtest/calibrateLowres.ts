// Calibrate the LOW-RESOLUTION (@256) truth-gate lane against the ART — the §0 #6/#11
// resolution: nothing was gated below 512, so the low-res scale-blindness family (thin
// features break up, small regions fall under the absolute floors) had no red number to
// beat. Same recipe as calibrateTier1/2.ts: measure the population, read the limits off
// the healthy side with margin, and let the failing cases land in KNOWN_DEFECTS.
//
//   node --experimental-strip-types src/devtest/calibrateLowres.ts            # tier 0 + flute-flat
//   node --experimental-strip-types src/devtest/calibrateLowres.ts --tier2    # sweep all 106 flat twins
//   node --experimental-strip-types src/devtest/calibrateLowres.ts --res 256  # (the default)
//
// Why a separate lane instead of running TIER_TOL @256: every boundary limit is in PIXELS
// and pixel error scales with the raster (truth-gate.test.ts's RES comment) — the @512
// limits are neither valid nor honest at 256. The lane gets its own numbers, and the @512
// numbers stay exactly as calibrated.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from './svgGround.ts'
import { scoreGeometry, scoreRegions, type RegionScore } from './geomScore.ts'
import { scoreDoc } from './scoreboard.ts'
import { tierCases, LOWRES_CORPUS, TRUTH_TOL, type TruthCase } from './truthCorpus.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const RES = Number(argv[argv.indexOf('--res') + 1]) || 256

// Default = the gated lane itself (ONE definition — truthCorpus.LOWRES_CORPUS);
// --tier2 sweeps all 106 flat twins for NEW low-res failures beyond the lane.
const cases: TruthCase[] = argv.includes('--tier2') ? tierCases(2) : LOWRES_CORPUS

console.log(`calibrating the low-res lane: ${cases.length} cases @ ${RES}px\n`)

interface Row {
  name: string
  tier: 0 | 1 | 2
  gradients: boolean
  samples: number
  chamfer: number
  p95: number
  parsimony: number
  gtCorners: number
  cornersRecovered: number
  paintMean: number | null
  paintP95: number | null
  regions: RegionScore
}
const rows: Row[] = []

for (const c of cases) {
  const svg = readFileSync(join(root, c.svg), 'utf8')
  const gt = parseGroundTruth(svg)
  const why = unscorable(gt)
  if (why) {
    console.log(`  ⨯ ${c.name} — ${why}`)
    continue
  }
  const img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
  const doc = await traceImage(img as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: c.gradients })
  const g = scoreGeometry(toRasterSpace(gt, img.width), doc, img.width, img.height, img)
  const paint = c.gradients && c.tier === 0 ? scoreDoc(img, doc) : null
  rows.push({
    name: c.name, tier: c.tier, gradients: c.gradients,
    samples: g.samples, chamfer: g.chamfer, p95: g.p95, parsimony: g.parsimony,
    gtCorners: g.gtCorners, cornersRecovered: g.cornersRecovered,
    paintMean: paint?.meanDeltaE ?? null, paintP95: paint?.p95DeltaE ?? null,
    regions: scoreRegions(img, doc),
  })
  process.stdout.write(`\r  traced ${rows.length}/${cases.length}`)
}
console.log('\n')

const f = (v: number, d = 2): string => v.toFixed(d).padStart(7)

// ---------------------------------------------------------------------------
// 1. Per-case values — every gate, so the failing numbers can be quoted verbatim
//    in KNOWN_DEFECTS and the healthy ones read as the calibration population.
// ---------------------------------------------------------------------------

console.log(`━━━ PER-CASE GATE VALUES @ ${RES}px ━━━\n`)
console.log(
  `  ${'case'.padEnd(24)} ${'chamfer'.padStart(7)} ${'p95'.padStart(7)} ${'parsim'.padStart(7)}` +
    ` ${'corners'.padStart(9)} ${'regions'.padStart(9)} ${'paint μ/p95'.padStart(12)}`,
)
for (const r of rows) {
  const corners = r.gtCorners > 0 && !r.gradients ? `${r.cornersRecovered}/${r.gtCorners}` : 'n/a'
  const regions = r.gradients ? 'n/a' : `${r.regions.recovered}/${r.regions.trueRegions}`
  const paint = r.paintMean !== null ? `${r.paintMean.toFixed(2)}/${r.paintP95!.toFixed(2)}` : 'n/a'
  const bnd = r.samples > 0 ? `${f(r.chamfer)} ${f(r.p95)} ${f(r.parsimony, 1)}` : `${'n/a'.padStart(7)} ${'n/a'.padStart(7)} ${'n/a'.padStart(7)}`
  console.log(`  ${r.name.padEnd(24)} ${bnd} ${corners.padStart(9)} ${regions.padStart(9)} ${paint.padStart(12)}`)
}

for (const r of rows) {
  for (const m of r.regions.missing) {
    if (r.gradients) continue
    console.log(`      ✗ ${r.name}: ${m.hex} (${m.areaPx}px) painted ${m.paintedHex}, ΔE ${m.deltaE.toFixed(1)}`)
  }
}

// ---------------------------------------------------------------------------
// 2. Distributions over the flat, scorable population — the numbers the lane's
//    limits get read off. Failing outliers are OBVIOUS here (they are the point).
// ---------------------------------------------------------------------------

const scorable = rows.filter((r) => r.samples > 0)
const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}
const report = (key: 'chamfer' | 'p95' | 'parsimony', tol512: number, unit: string, cands: number[]): void => {
  const xs = scorable.map((r) => r[key])
  const q = (p: number) => pct(xs, p).toFixed(2)
  const under = (t: number) => `${scorable.filter((r) => r[key] <= t).length}/${scorable.length}`
  console.log(`── ${key} ${'─'.repeat(60 - key.length)}`)
  console.log(`   p10 ${q(0.1)}  p50 ${q(0.5)}  p75 ${q(0.75)}  p90 ${q(0.9)}  max ${Math.max(...xs).toFixed(2)} ${unit}`)
  console.log(`   @512 limit ${tol512}${unit}: ${under(tol512)} would pass`)
  const worst = [...scorable].sort((a, b) => b[key] - a[key]).slice(0, 4)
  console.log(`   worst: ${worst.map((r) => `${r.name} ${r[key].toFixed(2)}`).join(' · ')}`)
  console.log(`   candidates: ${cands.map((t) => `${t}${unit} → ${under(t)}`).join('   ')}`)
  console.log()
}

console.log(`\n━━━ DISTRIBUTIONS (${scorable.length} scorable cases @ ${RES}px) ━━━\n`)
report('chamfer', TRUTH_TOL.chamfer, 'px', [0.5, 0.75, 1, 1.5, 2])
report('p95', TRUTH_TOL.p95, 'px', [1.5, 2, 2.5, 4, 6])
report('parsimony', TRUTH_TOL.parsimony, '×', [2, 3, 4, 5, 6])
