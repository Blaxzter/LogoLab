// THE TIER-1 EXPERIMENT: score the SAME glyph flat and gradient, and report the delta.
//
//   node --experimental-strip-types src/devtest/fluentAbRun.ts [--res 512] [--limit N]
//
// Fluent Emoji ships every glyph in a Color style (multi-stop linear + radial gradients,
// translucency) AND a Flat style (the same subject, solid fills). That pairing is the reason
// tier 1 is worth its repo weight: it is a CONTROLLED comparison. Nobody in the vectorization
// literature has been able to run it — §2 of docs/vectorization-benchmarks.md — because no
// public corpus carries the same artwork in both a flat and a gradient authoring.
//
// It isolates the one variable we care about. Both variants are authored SVGs, so both have
// exact ground truth; both go through the same rasterizer, the same tracer, the same scorer.
// The only thing that differs is whether the art has gradients in it. So any gap in the score
// is attributable to GRADIENTS, not to the subject, the complexity, or the artist.
//
// ⚠ HONEST CAVEAT, and it matters: Flat is a separately AUTHORED drawing, not the Color art
// with its gradients deleted. Microsoft redrew it — usually simpler, with fewer shapes. So
// this is a matched pair, not an ablation: read it as "how does the tracer do on flat art vs
// gradient art of the same subject, at the same size, by the same artist", and NOT as "here
// is exactly what adding a gradient costs". `shapes` in the output is printed precisely so
// the size of that confound is visible per case rather than assumed away.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from './svgGround.ts'
import { scoreGeometry } from './geomScore.ts'
import { tierCases } from './truthCorpus.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const RES = Number(argv[argv.indexOf('--res') + 1]) || 512
const LIMIT = Number(argv[argv.indexOf('--limit') + 1]) || Infinity

/** Trace one authored SVG and score it against itself. `gradients` matches the art. */
async function run(svgPath: string, gradients: boolean) {
  const svg = readFileSync(join(root, svgPath), 'utf8')
  const gt = parseGroundTruth(svg)
  if (unscorable(gt)) return null
  const img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
  const doc = await traceImage(img as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients })
  const g = scoreGeometry(toRasterSpace(gt, img.width), doc, img.width, img.height)
  return g.samples > 0 ? g : null
}

const pairs = tierCases(1).filter((c) => c.flatSvg && existsSync(join(root, c.flatSvg))).slice(0, LIMIT)
console.log(`flat ↔ gradient A/B — ${pairs.length} matched glyph pairs @ ${RES}px\n`)

interface Row {
  name: string
  cChamfer: number; cMissed: number; cSpurious: number; cParsimony: number; cShapes: number
  fChamfer: number; fMissed: number; fSpurious: number; fParsimony: number; fShapes: number
}
const rows: Row[] = []

for (const c of pairs) {
  // The Color art is traced WITH gradient fitting, the Flat art WITHOUT — each gets the
  // setting its own art calls for, which is what makes this a fair comparison rather than a
  // test of one toggle.
  const g = await run(c.svg, true)
  const f = await run(c.flatSvg!, false)
  if (!g || !f) continue
  rows.push({
    name: c.name.replace('fluent-', ''),
    cChamfer: g.chamfer, cMissed: g.missedMean, cSpurious: g.spuriousMean, cParsimony: g.parsimony, cShapes: g.gtShapes,
    fChamfer: f.chamfer, fMissed: f.missedMean, fSpurious: f.spuriousMean, fParsimony: f.parsimony, fShapes: f.gtShapes,
  })
  process.stdout.write(`\r  ${rows.length}/${pairs.length}`)
}
console.log('\n')

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0)
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] ?? 0 }

const worst = [...rows].sort((a, b) => (b.cChamfer - b.fChamfer) - (a.cChamfer - a.fChamfer)).slice(0, 12)
console.log('WHERE GRADIENTS HURT MOST — the 12 biggest chamfer gaps (gradient minus flat)\n')
console.log(`  ${'glyph'.padEnd(26)} ${'GRADIENT (Color)'.padStart(26)}   ${'FLAT'.padStart(24)}   delta`)
console.log(`  ${''.padEnd(26)} ${'chamfer  missed  invent'.padStart(26)}   ${'chamfer  missed  invent'.padStart(24)}`)
for (const r of worst) {
  console.log(
    `  ${r.name.padEnd(26)} ${r.cChamfer.toFixed(2).padStart(7)} ${r.cMissed.toFixed(2).padStart(7)} ${r.cSpurious.toFixed(2).padStart(7)}   ` +
      `${r.fChamfer.toFixed(2).padStart(7)} ${r.fMissed.toFixed(2).padStart(7)} ${r.fSpurious.toFixed(2).padStart(7)}   ` +
      `${(r.cChamfer - r.fChamfer >= 0 ? '+' : '') + (r.cChamfer - r.fChamfer).toFixed(2)}px`,
  )
}

const cC = rows.map((r) => r.cChamfer), fC = rows.map((r) => r.fChamfer)
const cM = rows.map((r) => r.cMissed), fM = rows.map((r) => r.fMissed)
const cS = rows.map((r) => r.cSpurious), fS = rows.map((r) => r.fSpurious)
const cP = rows.map((r) => r.cParsimony), fP = rows.map((r) => r.fParsimony)

console.log(`\n━━━ THE RESULT (${rows.length} matched pairs @ ${RES}px) ━━━\n`)
const line = (label: string, c: number[], f: number[], unit: string) =>
  console.log(
    `  ${label.padEnd(24)} gradient ${mean(c).toFixed(2).padStart(6)}${unit}  ·  flat ${mean(f).toFixed(2).padStart(6)}${unit}  ` +
      `·  ${mean(c) > mean(f) ? 'gradient is' : 'flat is'} ${(Math.max(mean(c), mean(f)) / Math.max(1e-9, Math.min(mean(c), mean(f)))).toFixed(1)}× worse`,
  )
line('boundary error (mean)', cC, fC, 'px')
line('  …authored MISSED', cM, fM, 'px')
line('  …boundary INVENTED', cS, fS, 'px')
line('node economy', cP, fP, '×')
console.log(`\n  medians — chamfer: gradient ${med(cC).toFixed(2)}px · flat ${med(fC).toFixed(2)}px`)

const worseCount = rows.filter((r) => r.cChamfer > r.fChamfer).length
console.log(`  gradient art scores worse on ${worseCount}/${rows.length} pairs (${((worseCount / rows.length) * 100).toFixed(0)}%)`)
console.log(
  `\n  authored complexity (the confound): gradient art averages ${mean(rows.map((r) => r.cShapes)).toFixed(0)} shapes,\n` +
    `  the redrawn flat variant ${mean(rows.map((r) => r.fShapes)).toFixed(0)}. Flat is a SIMPLER drawing as well as a flatter one,\n` +
    `  so part of any gap is subject complexity, not gradients. Treat the direction as solid and\n` +
    `  the magnitude as an upper bound.`,
)
