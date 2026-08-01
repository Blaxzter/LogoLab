// §10 scale-relative fidelity sweep (docs/vectorization-benchmarks.md §10).
//
//   node src/devtest/scaleRelSweep.ts            # the focused case set
//   node src/devtest/scaleRelSweep.ts checker    # by name
//
// Traces a focused case set under a GRID of planarBeautify snap configs and scores
// each against the AUTHORED SVG (the truth gate's method, not a blessed baseline).
// It answers two questions §10 raises:
//   1. the SAFE window for `localScaleK` — the k that fixes the small-shape rounding
//      WITHOUT dropping a genuine small circle's snap (parsimony / node blow-up); and
//   2. VETO SUBSUMPTION — with the §9.8 corner-turn veto OFF, does a scale-relative ε
//      alone hold `checker`'s corner recall ≥ 80% (the §10 claim), and at what k.
//
// Configs are applied via VectorizeOptions.planarFit, which planarFitOptionsFor
// spreads last — so { localScaleK, cornerVeto } override the shipped defaults.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { serializeDoc } from '../lib/path/model.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from './svgGround.ts'
import { scoreGeometry, scoreRegions } from './geomScore.ts'
import { evaluateTruthGates } from './truthCorpus.ts'
import { TRUTH_CORPUS, type TruthCase } from './truthCorpus.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RES = 512

// A round/corner/thin mix: `checker` is the §9.8 target; the rest are the shapes a
// too-tight scale-relative ε would REGRESS by refusing a genuine small circle snap.
const DEFAULT_CASES = ['checker', 'concentric', 'nebula', 'annulus', 'bloom', 'petals', 'sharp-star', 'hairlines', 'aa-seam']

const K_GRID = [0.1, 0.12, 0.14, 0.16, 0.18, 0.2, 0.25]

interface Config {
  label: string
  planarFit: Record<string, unknown>
}
const CONFIGS: Config[] = [
  { label: 'baseline (veto,k=0)', planarFit: {} },
  { label: 'vetoOFF k=0', planarFit: { cornerVeto: false } },
  ...K_GRID.map((k) => ({ label: `scaleONLY veto- k=${k}`, planarFit: { cornerVeto: false, localScaleK: k } })),
  ...K_GRID.map((k) => ({ label: `additive veto+ k=${k}`, planarFit: { localScaleK: k } })),
]

const argv = process.argv.slice(2)
const wantNames = argv.filter((a) => !a.startsWith('--'))
const cases: TruthCase[] = (wantNames.length ? wantNames : DEFAULT_CASES)
  .map((n) => TRUTH_CORPUS.find((c) => c.name === n))
  .filter((c): c is TruthCase => c != null)

function rasterize(svgPath: string): { width: number; height: number; data: Uint8ClampedArray } {
  const svg = readFileSync(join(root, svgPath), 'utf8')
  return decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
}

interface Scored {
  changed: boolean
  chamfer: number
  p95: number
  parsimony: number
  docNodes: number
  regionsMissing: number
  cornerApplicable: boolean
  cornerRecallPct: number
  cornerPass: boolean
}

const f = (v: number, d = 2): string => v.toFixed(d)

for (const c of cases) {
  const svg = readFileSync(join(root, c.svg), 'utf8')
  const gt = parseGroundTruth(svg)
  const why = unscorable(gt)
  console.log(`\n━━━ ${c.name} (${c.gradients ? 'gradients ON' : 'flat'})${why ? ` — NOT SCORABLE: ${why}` : ''} ━━━`)
  if (why) continue
  const img = rasterize(c.svg)
  const shapes = toRasterSpace(gt, img.width)

  let baselineSvg = ''
  const rows: (Scored & { label: string })[] = []
  for (const cfg of CONFIGS) {
    const doc = await traceImage(img as unknown as ImageData, {
      ...DEFAULT_VECTORIZE_OPTIONS,
      engine: 'planar',
      gradients: c.gradients,
      planarFit: cfg.planarFit,
    })
    const outSvg = serializeDoc(doc)
    if (cfg.label.startsWith('baseline')) baselineSvg = outSvg
    const g = scoreGeometry(shapes, doc, img.width, img.height, img)
    const r = scoreRegions(img, doc)
    const gates = evaluateTruthGates({
      samples: g.samples, chamfer: g.chamfer, p95: g.p95, parsimony: g.parsimony,
      trueRegions: r.trueRegions, recovered: r.recovered,
      gtCorners: g.gtCorners, cornersRecovered: g.cornersRecovered,
      flatArt: !c.gradients, tier: c.tier,
    })
    const cornerGate = gates.find((x) => x.key === 'corners')!
    rows.push({
      label: cfg.label,
      changed: outSvg !== baselineSvg,
      chamfer: g.chamfer,
      p95: g.p95,
      parsimony: g.parsimony,
      docNodes: g.docNodes,
      regionsMissing: r.trueRegions - r.recovered,
      cornerApplicable: cornerGate.applicable,
      cornerRecallPct: g.gtCorners > 0 ? (g.cornersRecovered / g.gtCorners) * 100 : 100,
      cornerPass: cornerGate.pass,
    })
  }

  console.log(
    `  ${'config'.padEnd(22)} ${'chg'.padStart(3)} ${'chamfer'.padStart(7)} ${'p95'.padStart(6)} ${'parsim'.padStart(6)} ${'nodes'.padStart(6)} ${'rMiss'.padStart(5)} ${'corner%'.padStart(8)}`,
  )
  for (const r of rows) {
    const corner = r.cornerApplicable ? `${f(r.cornerRecallPct, 1)}${r.cornerPass ? '' : '✗'}` : 'n/a'
    console.log(
      `  ${r.label.padEnd(22)} ${(r.changed ? 'Δ' : '·').padStart(3)} ${f(r.chamfer).padStart(7)} ${f(r.p95).padStart(6)} ${f(r.parsimony, 1).padStart(6)} ${String(r.docNodes).padStart(6)} ${String(r.regionsMissing).padStart(5)} ${corner.padStart(8)}`,
    )
  }
}
