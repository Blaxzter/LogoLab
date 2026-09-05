// CHORD DIAG — was CHORD_MAX_LEN really dead above ~1024, and on what? (Now: what does the
// chord pass's length bound stop, and would an absolute cap have stopped more?)
//
//   node --experimental-strip-types src/devtest/chordDiag.ts                     # the driver case
//   node --experimental-strip-types src/devtest/chordDiag.ts --case overlap --res 256,512,1024,2048
//   node --experimental-strip-types src/devtest/chordDiag.ts --logos [--verbose] # gallery sweep
//   --res LIST (default 256,512,1024,2048)   --cap N (counterfactual: an ABSOLUTE px cap)
//   --verbose: one row per candidate — length, the two certifying line arms, the deviation
//              overall and in the chord's INTERIOR (past 8 / 16 / 24px from either end)
//
// WHY. The Phase-0 absolute-pixel audit (docs/absolute-px-audit.md) classified
// `CHORD_MAX_LEN` 80px (planarReseat.ts) as ART — it is compared against `dist(a,b)`, the
// span between two junction anchors, which is a length of ARTWORK and therefore doubles
// with the raster. The audit's claim, and issue #14's first actionable line, is stronger
// than a classification: it says the constant is MEASURED DEAD on its own driver case
// above ~1024, because gradient-flat's authored disc chord is 32.9px @512 but 130.7px
// @2048, i.e. past the veto. §28 replaced it with a bound on the chord's own EVIDENCE
// (len ≤ the two line arms summed, `CHORD_ARM_K`); this census is what chose that shape.
//
// Nothing in the repo could see that. `reseatJunctions` returns only the SET of edges it
// straightened, so a candidate rejected by the length veto is indistinguishable from an
// edge that was never a candidate — the difference between "the mechanism declined" and
// "the mechanism does not apply" was invisible, which is exactly the state §0 says an
// instrument has to end before a fix is allowed. This drives the `onChord` out-sink added
// alongside it (undefined in production; the pass is byte-identical without an observer).
//
// WHAT TO READ. Per resolution: how many edges reach the chord gate at all, and the fate of
// each — `too-long` (the veto under test), `not-collinear` (the two junction lines are not
// one continuing occluder — not this constant's business), `dev-exceeded` (a genuinely
// different boundary between the junctions, correctly preserved), `straightened`.
//
// The number that settles it is the TOO-LONG column against resolution. If the mechanism is
// alive at every raster, `straightened` should hold roughly constant and `too-long` stay at
// zero; if the audit is right, `straightened` collapses to 0 as `too-long` picks up the
// same candidates. `--cap` re-runs with a different veto so the counterfactual is measured
// rather than argued: `--cap 400` at 2048 says what a scale-aware constant would recover.
//
// PURELY DIAGNOSTIC — no gate, no fix, no production behaviour change.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import type { ChordCandidate } from '../lib/trace/planarReseat.ts'


ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const flag = (n: string): string | null => {
  const i = argv.indexOf(n)
  if (i < 0) return null
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? '' : v
}
const RESOLUTIONS = (flag('--res') || '256,512,1024,2048').split(',').map(Number).filter(Number.isFinite)
const CASE = flag('--case')
const GRADIENTS = argv.includes('--gradients')
const f = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : '  —  ')

// The audit's own driver case. gradient-flat is the §10.4 witness — a triangle hypotenuse
// occluding a disc — and the one the 32.9px/130.7px measurement was taken on.
const EDGE = join(root, 'public', 'examples', 'edge-cases')
const cases: [string, string, boolean][] = []
if (CASE) {
  const alt = join(EDGE, `${CASE}.svg`)
  try {
    cases.push([CASE, readFileSync(alt, 'utf8'), GRADIENTS])
  } catch {
    cases.push([CASE, readFileSync(join(root, 'examples', 'logos', `${CASE}.svg`), 'utf8'), GRADIENTS])
  }
} else if (argv.includes('--logos')) {
  for (const file of readdirSync(join(root, 'examples', 'logos')).filter((x) => x.endsWith('.svg')))
    cases.push([file.replace(/\.svg$/, ''), readFileSync(join(root, 'examples', 'logos', file), 'utf8'), false])
} else {
  // gradient-flat traces through the MS segmenter, so its lane is gradients-ON; overlap is
  // the other case the §10.4 record names, on the flat path.
  cases.push(['gradient-flat', readFileSync(join(EDGE, 'gradient-flat.svg'), 'utf8'), true])
  cases.push(['overlap', readFileSync(join(EDGE, 'overlap.svg'), 'utf8'), false])
}

/** Collect one case at one resolution. */
async function run(text: string, res: number, gradients: boolean): Promise<ChordCandidate[]> {
  const raster = decodePng(new Resvg(text, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng())
  const seen: ChordCandidate[] = []
  await traceImage(raster as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS,
    engine: 'planar',
    gradients,
    planarFit: { onChord: (c) => seen.push(c) },
  })
  return seen
}

const CAP = Number(flag('--cap') ?? 80)
const VERBOSE = argv.includes('--verbose')
console.log(`\n━━━ CHORD-STRAIGHTENING CENSUS ━━━  build: len ≤ armA + armB (§28)` + (CAP !== 80 ? `, counterfactual ABSOLUTE cap ${CAP}px` : `; --cap N compares an absolute cap`))
console.log(`    verdicts: straightened · too-long (the length bound) · not-collinear · dev-exceeded`)
console.log(`    no-cap = passes collinearity AND CHORD_TOL regardless of length — what NO length bound would straighten\n`)

/** Max deviation of the samples farther than `z` px (arc) from EITHER endpoint — the
 *  INTERIOR of the chord, past the junction-local mangle zone. NaN when the edge has no
 *  interior at that depth. */
const interiorDev = (c: ChordCandidate, z: number): number => {
  let m = -1
  for (const p of c.profile) if (p.s > z && p.dev > m) m = p.dev
  return m < 0 ? NaN : m
}

/** One line per candidate — the numbers the summary row folds. */
function verbose(cands: ChordCandidate[]): void {
  if (!cands.length) return
  console.log(`      ${'edge'.padStart(5)}  ${'len'.padStart(7)}  ${'armA'.padStart(6)}  ${'armB'.padStart(6)}  ${'maxDev'.padStart(6)}  ${'in>8'.padStart(6)}  ${'in>16'.padStart(6)}  ${'in>24'.padStart(6)}  coll  verdict`)
  for (const c of cands.slice().sort((a, b) => a.len - b.len)) {
    console.log(
      `      ${String(c.edgeId).padStart(5)}  ${f(c.len).padStart(7)}  ${f(c.armA, 0).padStart(6)}  ${f(c.armB, 0).padStart(6)}  ${f(c.maxDev, 2).padStart(6)}` +
        `  ${f(interiorDev(c, 8), 2).padStart(6)}  ${f(interiorDev(c, 16), 2).padStart(6)}  ${f(interiorDev(c, 24), 2).padStart(6)}   ${c.sameLine ? 'y' : 'n'}   ${c.verdict}`,
    )
  }
}

/** Gallery-wide roll-up: every candidate the length veto alone stops, by case. */
const noCapOnly: { name: string; res: number; c: ChordCandidate }[] = []

for (const [name, text, gradients] of cases) {
  console.log(`  ${name}${gradients ? '  [gradients]' : '  [flat]'}`)
  console.log(`    ${'res'.padStart(6)}${'cands'.padStart(8)}${'straight'.padStart(10)}${'too-long'.padStart(10)}${'not-coll'.padStart(10)}${'dev-exc'.padStart(9)}${'no-cap'.padStart(8)}${'len p50'.padStart(9)}${'len max'.padStart(9)}${CAP !== 80 ? `${'@cap'.padStart(7)}` : ''}`)
  for (const res of RESOLUTIONS) {
    let cands: ChordCandidate[]
    try {
      cands = await run(text, res, gradients)
    } catch (err) {
      console.log(`    ${String(res).padStart(6)}   failed: ${(err as Error).message}`)
      continue
    }
    const by = (v: ChordCandidate['verdict']): number => cands.filter((c) => c.verdict === v).length
    const lens = cands.map((c) => c.len).sort((a, b) => a - b)
    const p50 = lens.length ? lens[lens.length >> 1] : NaN
    const mx = lens.length ? lens[lens.length - 1] : NaN
    // The counterfactual: candidates that pass every OTHER gate and are stopped only by length.
    const noCap = cands.filter((c) => c.sameLine && c.maxDev <= 2.5)
    const atCap = noCap.filter((c) => c.len <= CAP).length
    for (const c of noCap) if (c.verdict === 'too-long') noCapOnly.push({ name, res, c })
    console.log(
      `    ${String(res).padStart(6)}${String(cands.length).padStart(8)}${String(by('straightened')).padStart(10)}` +
        `${String(by('too-long')).padStart(10)}${String(by('not-collinear')).padStart(10)}${String(by('dev-exceeded')).padStart(9)}` +
        `${String(noCap.length).padStart(8)}${f(p50).padStart(9)}${f(mx).padStart(9)}${CAP !== 80 ? String(atCap).padStart(7) : ''}`,
    )
    if (VERBOSE) verbose(cands)
  }
  console.log()
}

if (cases.length > 1) {
  console.log(`━━━ LENGTH-BOUND-ONLY CANDIDATES (${noCapOnly.length}) — what NO length bound would ADD, corpus-wide ━━━`)
  console.log(`      ${'case'.padEnd(28)} ${'res'.padStart(5)} ${'len'.padStart(7)}  ${'armA'.padStart(5)}  ${'armB'.padStart(5)}  ${'maxDev'.padStart(6)}  ${'in>8'.padStart(6)}  ${'in>16'.padStart(6)}  ${'in>24'.padStart(6)}`)
  for (const { name, res, c } of noCapOnly.sort((a, b) => a.c.len - b.c.len))
    console.log(
      `      ${name.padEnd(28)} ${String(res).padStart(5)} ${f(c.len).padStart(7)}  ${f(c.armA, 0).padStart(5)}  ${f(c.armB, 0).padStart(5)}  ${f(c.maxDev, 2).padStart(6)}` +
        `  ${f(interiorDev(c, 8), 2).padStart(6)}  ${f(interiorDev(c, 16), 2).padStart(6)}  ${f(interiorDev(c, 24), 2).padStart(6)}`,
    )
  console.log()
}
