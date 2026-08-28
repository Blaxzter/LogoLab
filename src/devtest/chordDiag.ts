// CHORD DIAG — is CHORD_MAX_LEN really dead above ~1024, and on what?
//
//   node --experimental-strip-types src/devtest/chordDiag.ts                     # the driver case
//   node --experimental-strip-types src/devtest/chordDiag.ts --case overlap --res 256,512,1024,2048
//   node --experimental-strip-types src/devtest/chordDiag.ts --logos             # gallery sweep
//   --res LIST (default 256,512,1024,2048)   --cap N (try a different CHORD_MAX_LEN)
//
// WHY. The Phase-0 absolute-pixel audit (docs/absolute-px-audit.md) classified
// `CHORD_MAX_LEN` 80px (planarReseat.ts) as ART — it is compared against `dist(a,b)`, the
// span between two junction anchors, which is a length of ARTWORK and therefore doubles
// with the raster. The audit's claim, and issue #14's first actionable line, is stronger
// than a classification: it says the constant is MEASURED DEAD on its own driver case
// above ~1024, because gradient-flat's authored disc chord is 32.9px @512 but 130.7px
// @2048, i.e. past the veto.
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
console.log(`\n━━━ CHORD-STRAIGHTENING CENSUS ━━━  CHORD_MAX_LEN = 80px in the build` + (CAP !== 80 ? `, counterfactual cap ${CAP}px` : ''))
console.log(`    verdicts: straightened · too-long (the veto under test) · not-collinear · dev-exceeded\n`)

for (const [name, text, gradients] of cases) {
  console.log(`  ${name}${gradients ? '  [gradients]' : '  [flat]'}`)
  console.log(`    ${'res'.padStart(6)}${'cands'.padStart(8)}${'straight'.padStart(10)}${'too-long'.padStart(10)}${'not-coll'.padStart(10)}${'dev-exc'.padStart(9)}${'len p50'.padStart(9)}${'len max'.padStart(9)}${CAP !== 80 ? `${'@cap'.padStart(7)}` : ''}`)
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
    const atCap = cands.filter((c) => c.sameLine && c.maxDev <= 2.5 && c.len <= CAP).length
    console.log(
      `    ${String(res).padStart(6)}${String(cands.length).padStart(8)}${String(by('straightened')).padStart(10)}` +
        `${String(by('too-long')).padStart(10)}${String(by('not-collinear')).padStart(10)}${String(by('dev-exceeded')).padStart(9)}` +
        `${f(p50).padStart(9)}${f(mx).padStart(9)}${CAP !== 80 ? String(atCap).padStart(7) : ''}`,
    )
  }
  console.log()
}
