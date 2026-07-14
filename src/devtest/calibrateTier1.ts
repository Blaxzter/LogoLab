// Calibrate tier-1 tolerances against the ART, instead of guessing them.
//
//   node --experimental-strip-types src/devtest/calibrateTier1.ts [--res 512]
//
// TRUTH_TOL (chamfer 1.0px / p95 2.5px / parsimony 3.0×) was calibrated on crisp handcrafted
// FLAT art. Tier 1 is soft-edged authored GRADIENT art drawn at 32 units, where the boundary
// between two gradient stops is a ramp several pixels wide rather than a step. Whether tier 0's
// thresholds mean anything there is an empirical question, so this answers it empirically:
// trace all 109 cases, print the DISTRIBUTION of each metric, and show what each candidate
// threshold would pass.
//
// The bar we are setting: a threshold just above the bulk of the distribution, so that a
// REGRESSION trips it while the tracer's current honest behaviour does not. A gate everything
// fails is noise; a gate nothing can ever fail is decoration.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from './svgGround.ts'
import { scoreGeometry } from './geomScore.ts'
import { tierCases, TRUTH_TOL, TIER_TOL } from './truthCorpus.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const RES = Number(argv[argv.indexOf('--res') + 1]) || 512

const cases = tierCases(1)
console.log(`calibrating tier 1: ${cases.length} cases @ ${RES}px\n`)

interface Row {
  name: string; chamfer: number; p95: number; parsimony: number; gtNodes: number; docNodes: number
  /** GT → trace: authored boundary the tracer MISSED. */
  missed: number
  /** trace → GT: boundary the tracer INVENTED. Splitting these two is the whole story here. */
  spurious: number
}
const rows: Row[] = []

for (const c of cases) {
  const svg = readFileSync(join(root, c.svg), 'utf8')
  const gt = parseGroundTruth(svg)
  const why = unscorable(gt)
  if (why) { console.log(`  ⨯ ${c.name} — ${why}`); continue }

  const png = new Resvg(svg, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng()
  const img = decodePng(png)
  const doc = await traceImage(img as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: true })
  const g = scoreGeometry(toRasterSpace(gt, img.width), doc, img.width, img.height, img)
  if (g.samples === 0) { console.log(`  · ${c.name} — no interior boundary, skipped`); continue }

  rows.push({
    name: c.name, chamfer: g.chamfer, p95: g.p95, parsimony: g.parsimony,
    gtNodes: g.gtNodes, docNodes: g.docNodes, missed: g.missedMean, spurious: g.spuriousMean,
  })
  process.stdout.write(`\r  traced ${rows.length}/${cases.length}`)
}
console.log('\n')

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
  if (tier0 !== null) console.log(`   tier-0 limit ${tier0}${unit}: only ${under(tier0)} cases would pass`)
  const worst = [...rows].sort((a, b) => b[key] - a[key]).slice(0, 3)
  console.log(`   worst: ${worst.map((r) => `${r.name.replace('fluent-', '')} ${r[key].toFixed(1)}`).join(' · ')}`)
  console.log(`   candidates: ${cands.map((t) => `${t}${unit} → ${under(t)}`).join('   ')}`)
  console.log()
}

console.log(`━━━ TIER-1 DISTRIBUTION (${rows.length} scorable cases @ ${RES}px) ━━━\n`)
report('chamfer', TRUTH_TOL.chamfer, 'px', [1, 1.5, 2, 3, 5])
report('p95', TRUTH_TOL.p95, 'px', [4, 8, 15, 30, 60])
report('parsimony', TRUTH_TOL.parsimony, '×', [2, 3, 4, 5, 6])

console.log('━━━ THE SPLIT THAT MATTERS ━━━')
console.log('chamfer averages the two directions together, which HIDES the story on this corpus:\n')
report('missed', null, 'px', [0.5, 1, 2, 3])
report('spurious', null, 'px', [1, 5, 15, 30, 60])

const gtN = rows.reduce((s, r) => s + r.gtNodes, 0) / rows.length
const docN = rows.reduce((s, r) => s + r.docNodes, 0) / rows.length
const mMissed = rows.reduce((s, r) => s + r.missed, 0) / rows.length
const mSpur = rows.reduce((s, r) => s + r.spurious, 0) / rows.length
console.log(`mean authored nodes ${gtN.toFixed(0)} · mean traced nodes ${docN.toFixed(0)}`)
console.log(`mean MISSED ${mMissed.toFixed(2)}px · mean INVENTED ${mSpur.toFixed(2)}px  (ratio ${(mSpur / mMissed).toFixed(1)}×)`)

// The gate must be GREEN on the day it lands, or it gets switched off before it ever catches
// anything. So print exactly what the gated subset does against the proposed tier-1 limits.
const gated = new Set(tierCases(1).filter((c) => c.gated).map((c) => c.name))
const g = rows.filter((r) => gated.has(r.name))
const T = TIER_TOL[1]
console.log(`\n━━━ GATED SUBSET (${g.length} cases — what CI would run) vs proposed tier-1 limits ━━━`)
console.log(`    limits: chamfer ≤ ${T.chamfer}px · p95 ≤ ${T.p95}px · parsimony ≤ ${T.parsimony}×\n`)
for (const r of [...g].sort((a, b) => b.chamfer - a.chamfer)) {
  const ok = r.chamfer <= T.chamfer && r.p95 <= T.p95 && r.parsimony <= T.parsimony
  console.log(
    `  ${ok ? '✓' : '✗'} ${r.name.replace('fluent-', '').padEnd(30)} chamfer ${r.chamfer.toFixed(2).padStart(6)} · ` +
      `p95 ${r.p95.toFixed(1).padStart(6)} · parsimony ${r.parsimony.toFixed(1).padStart(4)}×`,
  )
}
const fails = g.filter((r) => !(r.chamfer <= T.chamfer && r.p95 <= T.p95 && r.parsimony <= T.parsimony))
console.log(`\n  ${g.length - fails.length}/${g.length} of the gated subset pass. ${fails.length ? '⚠ CI WOULD BE RED ON LANDING.' : 'CI is green on landing.'}`)

const corpusFails = rows.filter((r) => !(r.chamfer <= T.chamfer && r.p95 <= T.p95 && r.parsimony <= T.parsimony))
console.log(`  Across the FULL 109: ${rows.length - corpusFails.length} pass, ${corpusFails.length} fail — those are real defects, browse them at /labs/truth.`)
if (corpusFails.length) console.log(`  failing: ${corpusFails.map((r) => r.name.replace('fluent-', '')).join(', ')}`)

