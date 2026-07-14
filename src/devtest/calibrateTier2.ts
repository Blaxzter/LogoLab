// Calibrate tier-2 tolerances against the ART, instead of guessing them — the tier-2 mirror
// of calibrateTier1.ts.
//
//   node --experimental-strip-types src/devtest/calibrateTier2.ts [--res 512]
//
// Tier 2 is the Fluent glyphs' FLAT variants promoted to first-class cases. Two questions,
// in order of importance:
//
//   1. REGION RECOVERY — the dropped-region gate is inapplicable on all 109 gradient cases,
//      so before tier 2 it ran on just the 12 flat tier-0 cases. This corpus takes it to
//      ~118. A dropped region is the failure raster fidelity is structurally blind to and
//      the one that destroys logo topology, so its distribution here is the headline number.
//   2. BOUNDARY — TRUTH_TOL was calibrated on crisp handcrafted flat art; whether Fluent's
//      flat twins (drawn at 32 units, scaled 16×) behave like that population is empirical.
//      Print the distribution and candidate thresholds; TIER_TOL[2] gets read off the data.
//
// The bar, same as tier 1: a threshold just above the bulk of the distribution, so a
// REGRESSION trips it while the tracer's current honest behaviour does not.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from './svgGround.ts'
import { scoreGeometry, scoreRegions, type RegionScore } from './geomScore.ts'
import { tierCases, TRUTH_TOL } from './truthCorpus.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const RES = Number(argv[argv.indexOf('--res') + 1]) || 512

const cases = tierCases(2)
console.log(`calibrating tier 2: ${cases.length} cases @ ${RES}px\n`)

interface Row {
  name: string; chamfer: number; p95: number; parsimony: number; gtNodes: number; docNodes: number
  /** GT → trace: authored boundary the tracer MISSED. */
  missed: number
  /** trace → GT: boundary the tracer INVENTED. */
  spurious: number
  regions: RegionScore
}
const rows: Row[] = []

for (const c of cases) {
  const svg = readFileSync(join(root, c.svg), 'utf8')
  const gt = parseGroundTruth(svg)
  const why = unscorable(gt)
  if (why) { console.log(`  ⨯ ${c.name} — ${why}`); continue }

  const png = new Resvg(svg, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng()
  const img = decodePng(png)
  const doc = await traceImage(img as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false })
  const g = scoreGeometry(toRasterSpace(gt, img.width), doc, img.width, img.height, img)
  if (g.samples === 0) { console.log(`  · ${c.name} — no interior boundary, skipped`); continue }

  rows.push({
    name: c.name, chamfer: g.chamfer, p95: g.p95, parsimony: g.parsimony,
    gtNodes: g.gtNodes, docNodes: g.docNodes, missed: g.missedMean, spurious: g.spuriousMean,
    regions: scoreRegions(img, doc),
  })
  process.stdout.write(`\r  traced ${rows.length}/${cases.length}`)
}
console.log('\n')

const short = (n: string): string => n.replace('fluent-', '').replace(/-flat$/, '')

// ---------------------------------------------------------------------------
// 1. REGION RECOVERY — the metric this tier exists to scale up
// ---------------------------------------------------------------------------

const dropped = rows.filter((r) => r.regions.recovered < r.regions.trueRegions)
const totalTrue = rows.reduce((s, r) => s + r.regions.trueRegions, 0)
const totalRec = rows.reduce((s, r) => s + r.regions.recovered, 0)

console.log(`━━━ REGION RECOVERY (${rows.length} flat cases @ ${RES}px) ━━━\n`)
console.log(`  cases with every region recovered: ${rows.length - dropped.length}/${rows.length}`)
console.log(`  regions recovered overall:         ${totalRec}/${totalTrue} (${((totalRec / totalTrue) * 100).toFixed(1)}%)`)
console.log(`  regions dropped overall:           ${totalTrue - totalRec}\n`)

if (dropped.length) {
  console.log(`  the ${dropped.length} failing cases, worst first (every dropped region listed):`)
  for (const r of [...dropped].sort(
    (a, b) => (b.regions.trueRegions - b.regions.recovered) - (a.regions.trueRegions - a.regions.recovered),
  )) {
    console.log(`  ✗ ${short(r.name).padEnd(30)} ${r.regions.recovered}/${r.regions.trueRegions} recovered`)
    for (const m of r.regions.missing) {
      console.log(`        ${m.hex} (${String(m.areaPx).padStart(6)}px) — trace paints ${m.paintedHex} there, ΔE ${m.deltaE.toFixed(1)}`)
    }
  }
  const des = dropped.flatMap((r) => r.regions.missing.map((m) => m.deltaE)).filter(Number.isFinite)
  const areas = dropped.flatMap((r) => r.regions.missing.map((m) => m.areaPx))
  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b)
  const q = (xs: number[], p: number) => sorted(xs)[Math.min(xs.length - 1, Math.floor(p * xs.length))]
  console.log(`\n  dropped-region ΔE (truth vs what the trace painted): p50 ${q(des, 0.5).toFixed(1)} · p90 ${q(des, 0.9).toFixed(1)} · max ${Math.max(...des).toFixed(1)}`)
  console.log(`  dropped-region area (px): p50 ${q(areas, 0.5)} · p90 ${q(areas, 0.9)} · max ${Math.max(...areas)}`)
}

// ---------------------------------------------------------------------------
// 2. BOUNDARY — the distribution TIER_TOL[2] must be read off
// ---------------------------------------------------------------------------

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

const report = (key: 'chamfer' | 'p95' | 'parsimony' | 'missed' | 'spurious', tier0: number | null, unit: string, cands: number[]): void => {
  const xs = rows.map((r) => r[key])
  const q = (p: number) => pct(xs, p).toFixed(2)
  console.log(`── ${key} ${'─'.repeat(60 - key.length)}`)
  console.log(`   p10 ${q(0.1)}  p50 ${q(0.5)}  p75 ${q(0.75)}  p90 ${q(0.9)}  p95 ${q(0.95)}  max ${Math.max(...xs).toFixed(2)} ${unit}`)
  const under = (t: number) => `${rows.filter((r) => r[key] <= t).length}/${rows.length}`
  if (tier0 !== null) console.log(`   tier-0 limit ${tier0}${unit}: ${under(tier0)} cases would pass`)
  const worst = [...rows].sort((a, b) => b[key] - a[key]).slice(0, 3)
  console.log(`   worst: ${worst.map((r) => `${short(r.name)} ${r[key].toFixed(1)}`).join(' · ')}`)
  console.log(`   candidates: ${cands.map((t) => `${t}${unit} → ${under(t)}`).join('   ')}`)
  console.log()
}

console.log(`\n━━━ TIER-2 BOUNDARY DISTRIBUTION (${rows.length} scorable cases @ ${RES}px) ━━━\n`)
report('chamfer', TRUTH_TOL.chamfer, 'px', [0.5, 1, 1.5, 2, 3])
report('p95', TRUTH_TOL.p95, 'px', [2.5, 4, 8, 15, 30])
report('parsimony', TRUTH_TOL.parsimony, '×', [2, 3, 4, 5, 6])

console.log('━━━ THE SPLIT ━━━\n')
report('missed', null, 'px', [0.5, 1, 2, 3, 5])
report('spurious', null, 'px', [0.25, 0.5, 1, 2, 5])

const gtN = rows.reduce((s, r) => s + r.gtNodes, 0) / rows.length
const docN = rows.reduce((s, r) => s + r.docNodes, 0) / rows.length
const mMissed = rows.reduce((s, r) => s + r.missed, 0) / rows.length
const mSpur = rows.reduce((s, r) => s + r.spurious, 0) / rows.length
console.log(`mean authored nodes ${gtN.toFixed(0)} · mean traced nodes ${docN.toFixed(0)}`)
console.log(`mean MISSED ${mMissed.toFixed(2)}px · mean INVENTED ${mSpur.toFixed(2)}px`)
