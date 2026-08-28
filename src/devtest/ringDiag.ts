// RING DIAG — why the co-circular arc snap does not hold on crossing rings.
//
//   node --experimental-strip-types src/devtest/ringDiag.ts                      # olympic-rings
//   node --experimental-strip-types src/devtest/ringDiag.ts --case concentric --res 512
//   node --experimental-strip-types src/devtest/ringDiag.ts olympic-rings.svg --gradients
//   --res N (default 512)   --fid F (probe a different fidelity)   --logos (gallery sweep)
//
// WHY. Issue #10: on `logo-olympic-rings` the black ring's boundaries visibly bend where it
// crosses yellow and green instead of continuing as one arc. The issue lists three shipped
// mechanisms that all aim at exactly this and asks the right first question — not "how do we
// fix it" but "why does none of them hold here":
//   • §1d co-circular arc snap (planarBeautify) — a ring split into arcs by junctions snaps
//     to ONE circle "so it stops kinking";
//   • §10.4 junction re-seat + §14 contrast thread — place junctions off the integer lattice;
//   • §17 corner-junction placement — a junction that IS a corner goes on its arm intersection.
//
// Two of those are answered by `threadDiag` in one line, and the answer is blunt: the §14
// rank only considers a junction with at least one WEAK arm (ΔE ≤ 12), and every edge on
// this mark is ΔE ≥ 60 — five saturated rings on white. The rank has ZERO candidates, so
// §14 and §17 are both structurally inert here and 0 of 46 junctions move. That is not a
// tuning problem; the mechanisms are aimed at posterization seams, and this art has none.
//
// This diag answers the remaining one. `snapCoCircularLoops` weighs each region loop against
// a series of gates and silently `continue`s past the ones that fail, so "the snap did not
// fire" was previously indistinguishable from "the snap fired and did not help". The
// `onArcLoop` out-sink added alongside reports the FIRST gate that declined and the value it
// saw, per loop.
//
// WHAT TO READ. `verdict` is the actionable column:
//   • corner-veto        — the loop turns ≥60° somewhere, so it is judged a polygon, not a
//                          ring. On crossing rings this is the one to watch: an arc between
//                          two crossings is short, and a kink AT a crossing is exactly the
//                          turn the veto reads.
//   • dev-exceeds-budget — the loop is a ring but does not fit one circle within fidelity.
//                          `r`, `radialDev` and `budget` say by how much.
//   • carries-chord      — held out on purpose (a disc cut by a line is a "D", §10.4).
//   • single-edge-loop / no-open-edge — not a split ring at all; 1a's job.
// A ring that reads `dev-exceeds-budget` by a hair is a calibration question; one that reads
// `corner-veto` is a structural one, and they lead to completely different fixes. That is
// the whole reason to measure before touching anything.
//
// PURELY DIAGNOSTIC — no gate, no fix, no production behaviour change.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import type { ArcLoopRecord } from '../lib/trace/planarBeautify.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const flag = (n: string): string | null => {
  const i = argv.indexOf(n)
  if (i < 0) return null
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? '' : v
}
const RES = Number(flag('--res') ?? 512)
const GRADIENTS = argv.includes('--gradients')
const FID = flag('--fid') ? Number(flag('--fid')) : null
const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '   —  ')

const EDGE = join(root, 'public', 'examples', 'edge-cases')
const cases: [string, string][] = []
const CASE = flag('--case')
const FILE = argv.find((a) => a.endsWith('.svg'))
if (CASE) {
  try {
    cases.push([CASE, readFileSync(join(EDGE, `${CASE}.svg`), 'utf8')])
  } catch {
    cases.push([CASE, readFileSync(join(root, 'examples', 'logos', `${CASE}.svg`), 'utf8')])
  }
} else if (FILE) {
  cases.push([FILE.replace(/\.svg$/, ''), readFileSync(join(root, 'examples', 'logos', FILE), 'utf8')])
} else if (argv.includes('--logos')) {
  for (const file of readdirSync(join(root, 'examples', 'logos')).filter((x) => x.endsWith('.svg')))
    cases.push([file.replace(/\.svg$/, ''), readFileSync(join(root, 'examples', 'logos', file), 'utf8')])
} else {
  // The issue's own mark.
  cases.push(['olympic-rings', readFileSync(join(root, 'examples', 'logos', 'olympic-rings.svg'), 'utf8')])
}

const totals = new Map<ArcLoopRecord['verdict'], number>()
console.log(`\n━━━ §1d CO-CIRCULAR ARC-SNAP CENSUS @${RES} ${GRADIENTS ? 'grad' : 'flat'} ━━━`)

for (const [name, text] of cases) {
  const raster = decodePng(new Resvg(text, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
  const loops: ArcLoopRecord[] = []
  await traceImage(raster as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS,
    engine: 'planar',
    gradients: GRADIENTS,
    ...(FID != null ? { fidelity: FID } : {}),
    planarFit: { onArcLoop: (r) => loops.push(r) },
  })
  for (const l of loops) totals.set(l.verdict, (totals.get(l.verdict) ?? 0) + 1)
  if (cases.length > 1) {
    const snapped = loops.filter((l) => l.verdict === 'snapped').length
    const veto = loops.filter((l) => l.verdict === 'corner-veto').length
    const dev = loops.filter((l) => l.verdict === 'dev-exceeds-budget').length
    if (loops.length) console.log(`  ${name.padEnd(28)} loops ${String(loops.length).padStart(4)}   snapped ${String(snapped).padStart(3)}   corner-veto ${String(veto).padStart(3)}   dev ${String(dev).padStart(3)}`)
    continue
  }
  console.log(`\n  ${name} @${RES}px — ${loops.length} candidate region loops\n`)
  console.log(`    ${'label'.padStart(6)}${'edges'.padStart(7)}${'open'.padStart(6)}${'r'.padStart(9)}${'radialDev'.padStart(11)}${'budget'.padStart(9)}${'turn°'.padStart(8)}   verdict`)
  for (const l of loops.slice().sort((a, b) => b.edges - a.edges)) {
    console.log(
      `    ${String(l.label).padStart(6)}${String(l.edges).padStart(7)}${String(l.openEdges).padStart(6)}` +
        `${f(l.r, 1).padStart(9)}${f(l.radialDev, 3).padStart(11)}${f(l.budget, 3).padStart(9)}${f(l.turnDeg, 1).padStart(8)}   ${l.verdict}`,
    )
  }
}

console.log(`\n  VERDICT TOTALS over ${cases.length} case(s):`)
for (const [v, n] of [...totals].sort((a, b) => b[1] - a[1])) console.log(`    ${v.padEnd(22)} ${n}`)
const snapped = totals.get('snapped') ?? 0
const all = [...totals.values()].reduce((s, n) => s + n, 0)
console.log(`\n  ${snapped} of ${all} candidate loops actually snapped to one circle.`)
console.log()
