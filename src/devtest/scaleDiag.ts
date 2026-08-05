// CROSS-RESOLUTION CONSISTENCY — the Phase-0 instrument for §0 #8 (sub-pixel edge
// placement). It answers ONE question with a number: does the same artwork yield the
// SAME SHAPE when it is rasterized at 256, 512 and 1024?
//
//   node --experimental-strip-types src/devtest/scaleDiag.ts                    # tier 0
//   node --experimental-strip-types src/devtest/scaleDiag.ts --lattice          # + attribution
//   node --experimental-strip-types src/devtest/scaleDiag.ts --tier2            # the flat twins
//   node --experimental-strip-types src/devtest/scaleDiag.ts --logos            # the 5 witnesses
//   node --experimental-strip-types src/devtest/scaleDiag.ts --logos all        # every fetched mark
//   node --experimental-strip-types src/devtest/scaleDiag.ts --res 256,512,1024,2048
//   node --experimental-strip-types src/devtest/scaleDiag.ts --json out.json    # machine-readable
//
// The ARITHMETIC lives in scaleScore.ts, shared with test/scale-invariance.test.ts — this
// file only chooses cases and prints. Read that module's header for the method (one
// reference space, the affine that makes lanes comparable, and the rasterizeDoc trap that
// this measurement is built to avoid).
//
// ---------------------------------------------------------------------------
// WHY THIS DID NOT EXIST, AND WHAT IT ADDS
//
// Every gate in this repo scores ONE resolution independently: truth-gate @512, the LOWRES
// lane @256, each against tolerances calibrated at THAT raster. Nothing forces the same art
// to produce the same geometry at two sizes, so a tracer whose output is a function of the
// LATTICE rather than of the ARTWORK passes every gate at every size while being, in the
// product's terms, wrong: the user's logo looks different depending on how big we happened
// to rasterize it.
//
// ---------------------------------------------------------------------------
// THE THREE MEASUREMENT TRAPS THIS IS BUILT AGAINST
//
// 1. NO RENDERING. rasterizeDoc(doc, w, h) draws one viewBox unit per output pixel and does
//    NOT fit the viewBox to the buffer, so scoring an enlarged doc in a native-size buffer
//    silently CROPS it. Geometry-only end to end; nothing here rasterizes a doc.
// 2. NO PAINT METRIC AS THE HEADLINE. meanΔE can PREFER a structurally broken trace — a
//    carved-up icon outscores an intact one by reproducing shading faithfully. The headline
//    numbers are structural: boundary distance against the authored geometry, corner
//    recovery, region recovery, node economy.
// 3. NO MEAN-ONLY REPORTING. A mean over a big flat field hides a destroyed small glyph.
//    Every boundary row carries p95 AND the worst single excursion, and `--json` dumps the
//    per-lane values so a bad number can be located rather than merely reported.
//
// ---------------------------------------------------------------------------
// THE NUMBERS
//
//   chamfer / p95   boundary error vs the AUTHORED SVG, in reference px. Comparable across
//                   lanes by construction.
//   drift           chamfer(coarsest) / chamfer(finest) — the machine-checkable definition
//                   of "size invariant": 1.0 = a function of the ARTWORK (the goal), ~R =
//                   a function of the LATTICE (R = the resolution ratio, 4.0 for 256→1024).
//   self            coarsest geometry vs finest geometry, directly — "the same art, two
//                   sizes, how far apart are the two shapes". Needs no answer sheet, so it
//                   also grades art whose SVG svgGround refuses.
//   lattice μ       (--lattice) the RAW crack chains vs the authored SVG. See scaleScore's
//                   latticeDoc: this is what separates "the samples are quantized" from
//                   "the fit loses it", instead of assuming which.

import { readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ensureImageData } from './nodeHarness.ts'
import { measureScale, SCALE_RESOLUTIONS, type ScaleResult } from './scaleScore.ts'
import { tierCases, type TruthCase } from './truthCorpus.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
/** `--flag value`, or '' when the flag is present but bare (the next token is another flag). */
const flag = (name: string): string | null => {
  if (!argv.includes(name)) return null
  const v = argv[argv.indexOf(name) + 1]
  return v === undefined || v.startsWith('--') ? '' : v
}

const RES: number[] = (flag('--res') ?? SCALE_RESOLUTIONS.join(','))
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
  .sort((a, b) => a - b)
const REF = RES[RES.length - 1]
/** Also score the RAW crack lattice against the answer sheet — the attribution measurement. */
const LATTICE = argv.includes('--lattice')

/**
 * The five marks the user reported from /labs/gallery, each with a NAMED visible defect
 * that shrinks 3–4× with lattice resolution. They are the witnesses this workstream exists
 * for, so they are the default `--logos` slice. (examples/logos/ is gitignored —
 * `npm run fetch:logos` rehydrates it; a clean clone reports the lane as empty and
 * everything else still works.)
 */
const WITNESSES = ['bluetooth', 'chupa-chups', 'cnn', 'coca-cola', 'ahrefs-wordmark']

interface Case {
  name: string
  svg: string
  gradients: boolean
}

function logoCases(): Case[] {
  const dir = join(root, 'examples', 'logos')
  let onDisk: string[]
  try {
    onDisk = readdirSync(dir).filter((f) => f.endsWith('.svg'))
  } catch {
    console.log('  (examples/logos/ is absent — `npm run fetch:logos` rehydrates it)\n')
    return []
  }
  const arg = flag('--logos')
  const wanted =
    arg === 'all' ? onDisk.map((f) => f.replace(/\.svg$/, '')) : arg ? arg.split(',').map((s) => s.trim().replace(/\.svg$/, '')) : WITNESSES
  const out: Case[] = []
  for (const w of wanted) {
    if (!onDisk.includes(`${w}.svg`)) {
      console.log(`  (missing: examples/logos/${w}.svg)`)
      continue
    }
    // Flat brand art: gradients OFF, the setting /labs/gallery and the product both use.
    out.push({ name: w, svg: `examples/logos/${w}.svg`, gradients: false })
  }
  return out
}

const fromTruth = (c: TruthCase): Case => ({ name: c.name, svg: c.svg, gradients: c.gradients })
const cases: Case[] = argv.includes('--logos')
  ? logoCases()
  : argv.includes('--tier2')
    ? tierCases(2).map(fromTruth)
    : tierCases(0).map(fromTruth)

console.log(`cross-resolution consistency — ${cases.length} case(s) @ ${RES.join('/')}px, scored in ${REF}px reference space\n`)

const rows: ScaleResult[] = []
for (const c of cases) {
  const r = await measureScale(c.name, join(root, c.svg), { gradients: c.gradients, resolutions: RES, lattice: LATTICE })
  if (r.noAnswerSheet) console.log(`  ~ ${c.name} — no answer sheet (${r.noAnswerSheet.split(' — ')[0]}); self-consistency only`)
  rows.push(r)
  if (process.stdout.isTTY) process.stdout.write(`\r${' '.repeat(50)}\r`)
}

const f = (v: number, d = 3): string => (Number.isFinite(v) ? v.toFixed(d) : 'n/a').padStart(7)
const med = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[s.length >> 1] : NaN
}

// ---------------------------------------------------------------------------
// Per-case detail
// ---------------------------------------------------------------------------

console.log(`\n━━━ PER-CASE, scored in ${REF}px reference space ━━━\n`)
for (const row of rows) {
  console.log(`  ${row.name}${row.noAnswerSheet ? '   (no answer sheet — self-consistency only)' : ''}`)
  console.log(
    `    ${'res'.padStart(5)} ${'chamfer'.padStart(7)} ${'p95'.padStart(7)} ${'worst'.padStart(7)}` +
      ` ${'missed'.padStart(7)} ${'spur'.padStart(7)} ${'parsim'.padStart(7)} ${'nodes'.padStart(6)}` +
      ` ${'corners'.padStart(8)} ${'regions'.padStart(8)} ${'ms'.padStart(6)}` +
      (LATTICE ? `   ${'lattice'.padStart(7)} ${'lat p95'.padStart(7)} ${'fit adds'.padStart(8)}` : ''),
  )
  for (const l of row.lanes) {
    const corners = l.gtCorners > 0 ? `${l.cornersRecovered}/${l.gtCorners}` : 'n/a'
    const regions = l.trueRegions > 0 ? `${l.recovered}/${l.trueRegions}` : 'n/a'
    const adds = Number.isFinite(l.latChamfer) && l.latChamfer > 0 ? `${(l.chamfer / l.latChamfer).toFixed(2)}×` : 'n/a'
    console.log(
      `    ${String(l.res).padStart(5)} ${f(l.chamfer)} ${f(l.p95)} ${f(l.worst, 2)}` +
        ` ${f(l.missedMean)} ${f(l.spuriousMean)} ${f(l.parsimony, 2)} ${String(l.docNodes).padStart(6)}` +
        ` ${corners.padStart(8)} ${regions.padStart(8)} ${String(Math.round(l.ms)).padStart(6)}` +
        (LATTICE ? `   ${f(l.latChamfer)} ${f(l.latP95)} ${adds.padStart(8)}` : ''),
    )
  }
  console.log(
    row.noAnswerSheet
      ? `    → self ${row.selfChamfer.toFixed(3)} / ${row.selfP95.toFixed(3)} px  (@${RES[0]} vs @${REF}; ideal 0.000)`
      : `    → drift ${row.drift.toFixed(2)}× chamfer, ${row.p95Drift.toFixed(2)}× p95 over a ${row.ratio}× lattice` +
        `   ·   self ${row.selfChamfer.toFixed(3)} / ${row.selfP95.toFixed(3)} px`,
  )
  for (const l of row.lanes) {
    // Capped: a posterized ramp traced flat reports every 8-bit band as a lost "region"
    // (aurora: 80+ @1024), a known artifact of the metric on ramp art rather than a finding
    // — see geomScore.scoreRegions' FLAT ART ONLY warning. The count in the table is the
    // number; this list only exists to LOCATE a real drop.
    for (const m of l.missing.slice(0, 4)) console.log(`      ✗ @${l.res}: ${m.hex} (${m.areaPx}px) painted ${m.paintedHex}, ΔE ${m.deltaE.toFixed(1)}`)
    if (l.missing.length > 4) console.log(`      … +${l.missing.length - 4} more @${l.res}`)
  }
  console.log()
}

// ---------------------------------------------------------------------------
// The ranking — which cases are most a function of the lattice
// ---------------------------------------------------------------------------

const scored = rows.filter((r) => Number.isFinite(r.drift) && r.lanes[0].samples > 0)
scored.sort((a, b) => b.drift - a.drift)

console.log(`━━━ RANKED BY SCALE DRIFT (${scored.length} scorable) ━━━`)
console.log(`  1.00 = the trace is a function of the ARTWORK.  ${(REF / RES[0]).toFixed(2)} = a function of the LATTICE.\n`)
console.log(
  `  ${'case'.padEnd(26)} ${'drift'.padStart(6)} ${'p95Δ'.padStart(6)} ${`ch@${RES[0]}`.padStart(8)} ${`ch@${REF}`.padStart(8)}` +
    ` ${'self'.padStart(7)} ${'nodes'.padStart(11)}`,
)
for (const r of scored) {
  const n0 = r.lanes[0].docNodes
  const n1 = r.lanes[r.lanes.length - 1].docNodes
  console.log(
    `  ${r.name.padEnd(26)} ${r.drift.toFixed(2).padStart(6)} ${r.p95Drift.toFixed(2).padStart(6)}` +
      ` ${f(r.lanes[0].chamfer)} ${f(r.lanes[r.lanes.length - 1].chamfer)} ${f(r.selfChamfer)}` +
      ` ${`${n0}→${n1}`.padStart(11)}`,
  )
}
console.log(`\n  median drift ${med(scored.map((r) => r.drift)).toFixed(2)}×   ·   ideal 1.00   ·   pure-lattice ${(REF / RES[0]).toFixed(2)}`)

// ---------------------------------------------------------------------------
// ATTRIBUTION — is the error IN THE SAMPLES, or added by the fit?
// ---------------------------------------------------------------------------

if (LATTICE) {
  console.log(`\n━━━ ATTRIBUTION: raw crack lattice vs fitted output ━━━`)
  console.log(
    `  "lattice/px" is the raw chain's error expressed in the LANE'S OWN pixels. If boundary\n` +
      `  samples are quantized to the integer crack lattice, this is a CONSTANT — the same\n` +
      `  fraction of a pixel at every resolution — and the drift above follows from it.\n`,
  )
  console.log(`  ${'case'.padEnd(20)}` + RES.map((r) => `  lattice/px @${String(r).padStart(4)}`).join('') + `   fit adds (mean)`)
  const perRes: number[][] = RES.map(() => [])
  for (const r of scored) {
    const cells: string[] = []
    let addsSum = 0
    let addsN = 0
    for (let i = 0; i < RES.length; i++) {
      const l = r.lanes[i]
      const inLanePx = l.latChamfer * (l.res / REF) // reference px → the lane's own px
      if (Number.isFinite(inLanePx) && l.latChamfer > 0) {
        perRes[i].push(inLanePx)
        cells.push(inLanePx.toFixed(3).padStart(18))
        addsSum += l.chamfer / l.latChamfer
        addsN++
      } else cells.push('n/a'.padStart(18))
    }
    if (!addsN) continue
    console.log(`  ${r.name.padEnd(20)}${cells.join('')}   ${(addsSum / addsN).toFixed(2)}×`)
  }
  console.log(
    `\n  median lattice error, in the lane's OWN pixels: ` + perRes.map((xs, i) => `@${RES[i]} ${med(xs).toFixed(3)}px`).join('   ·   '),
  )
  console.log(
    `  A CONSTANT here is the quantization floor of integer-lattice sampling, measured. A\n` +
      `  "fit adds" below 1.00 means the FIT is already averaging lattice error away and is\n` +
      `  not what loses the accuracy — the samples are.`,
  )
}

// Cases with no usable answer sheet still get the metric that needs none.
const selfOnly = rows.filter((r) => r.noAnswerSheet && Number.isFinite(r.selfChamfer))
if (selfOnly.length) {
  console.log(`\n━━━ SELF-CONSISTENCY ONLY (no answer sheet) — @${RES[0]} geometry vs @${REF} geometry, ideal 0 ━━━\n`)
  console.log(`  ${'case'.padEnd(26)} ${'self μ'.padStart(8)} ${'self p95'.padStart(9)} ${'nodes'.padStart(11)}  why`)
  for (const r of [...selfOnly].sort((a, b) => b.selfChamfer - a.selfChamfer)) {
    console.log(
      `  ${r.name.padEnd(26)} ${f(r.selfChamfer).padStart(8)} ${f(r.selfP95).padStart(9)}` +
        ` ${`${r.lanes[0].docNodes}→${r.lanes[r.lanes.length - 1].docNodes}`.padStart(11)}  ${r.noAnswerSheet!.split(' — ')[0]}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Structure vs resolution — the axis paint metrics are blind to
// ---------------------------------------------------------------------------

console.log(`\n━━━ STRUCTURE vs RESOLUTION (recovery at each lane's own raster) ━━━\n`)
// Ramp art is excluded from the region aggregate: a posterized ramp's "region count" is an
// artifact of 8-bit banding and GROWS with resolution (aurora: 24 → 60 → 131), so pooling it
// turns a metric artifact into a fake regression. The tell is exactly that — a case whose
// trueRegions is not the same at every lane is not measuring regions.
const stableRegions = (r: ScaleResult): boolean => new Set(r.lanes.map((l) => l.trueRegions)).size === 1
const rampish = rows.filter((r) => !stableRegions(r)).map((r) => r.name)
if (rampish.length) console.log(`  (regions exclude ramp art whose band count itself moves with resolution: ${rampish.join(', ')})\n`)
for (const res of RES) {
  let regOk = 0, regTot = 0, cOk = 0, cTot = 0
  for (const r of rows) {
    const l = r.lanes.find((x) => x.res === res)
    if (!l) continue
    if (stableRegions(r)) { regOk += l.recovered; regTot += l.trueRegions }
    cOk += l.cornersRecovered
    cTot += l.gtCorners
  }
  console.log(
    `  @${String(res).padStart(4)}  regions ${regOk}/${regTot}${regTot ? ` (${((100 * regOk) / regTot).toFixed(1)}%)` : ''}` +
      `   corners ${cOk}/${cTot}${cTot ? ` (${((100 * cOk) / cTot).toFixed(1)}%)` : ''}`,
  )
}

const out = flag('--json')
if (out) {
  writeFileSync(out, JSON.stringify({ ref: REF, resolutions: RES, rows }, null, 1))
  console.log(`\nwrote ${out}`)
}
