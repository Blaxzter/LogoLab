// PAINT PROBE — the §10.3 paint gate's numbers (render-vs-source mean / p95 CIE76 ΔE) for
// any case in EITHER lane, plus how many gradients the trace emitted and how many the
// SOURCE authors. docs/handoff-fused-gradient.md §3 names `letter-joins` in the gradient
// lane at p95 18.72 against the gate's 8.0 — this is the instrument that confirms it.
//
//   node --experimental-strip-types src/devtest/paintProbe.ts --case letter-joins
//   node --experimental-strip-types src/devtest/paintProbe.ts --ab            # every /labs/ab case, both lanes
//   node --experimental-strip-types src/devtest/paintProbe.ts --ab --lane grad
//   --res N (default 512)   --transparent (the fixture-lane input; default composites on white like the gates)
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { scoreDoc } from './scoreboard.ts'
import { AB_CORPUS, AB_LOGO_CASES } from './abCorpus.ts'
import type { PathItem } from '../lib/path/types.ts'

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
const TRANSPARENT = argv.includes('--transparent')
const LANE = flag('--lane') // 'flat' | 'grad' | null (both)
const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '—')

interface Case { id: string; path: string; kind: 'svg' | 'png'; background?: string }
const cases: Case[] = []
const CASE = flag('--case')
if (CASE) {
  const EDGE = join(root, 'public', 'examples', 'edge-cases')
  const tries = [join(EDGE, `${CASE}.svg`), join(root, 'public', 'examples', `${CASE}.svg`), join(root, 'examples', 'logos', `${CASE}.svg`), join(root, 'public', 'corpus', 'fluent', 'flat', `${CASE.replace(/-flat$/, '')}.svg`)]
  const hit = tries.find((t) => existsSync(t))
  if (!hit) throw new Error(`no such case: ${CASE}`)
  cases.push({ id: CASE, path: hit, kind: 'svg', background: TRANSPARENT ? undefined : 'white' })
} else if (argv.includes('--ab')) {
  for (const c of [...AB_CORPUS, ...AB_LOGO_CASES]) {
    const p = join(root, c.path)
    if (!existsSync(p)) continue
    cases.push({ id: c.id, path: p, kind: c.kind, background: TRANSPARENT ? c.background : 'white' })
  }
} else {
  cases.push({ id: 'letter-joins', path: join(root, 'public', 'examples', 'edge-cases', 'letter-joins.svg'), kind: 'svg', background: TRANSPARENT ? undefined : 'white' })
}

const authoredGradients = (svg: string): number => (svg.match(/<(linear|radial)Gradient\b/g) ?? []).length

console.log(`
━━━ PAINT PROBE @${RES} ${TRANSPARENT ? '(fixture-lane transparent input)' : '(on white, like the gates)'} — render-vs-source CIE76 ΔE; gate: mean ≤ 3.0, p95 ≤ 8.0 ━━━
`)
console.log(`    ${'case'.padEnd(26)}${'authored'.padStart(9)}  ${'lane'.padEnd(5)}${'mean'.padStart(7)}${'p95'.padStart(7)}${'grads'.padStart(6)}${'paths'.padStart(6)}  gate`)
for (const c of cases) {
  const src = readFileSync(c.path)
  const authored = c.kind === 'svg' ? authoredGradients(src.toString('utf8')) : NaN
  const png = c.kind === 'svg'
    ? new Resvg(src.toString('utf8'), { fitTo: { mode: 'width', value: RES }, ...(c.background ? { background: c.background } : {}) }).render().asPng()
    : src
  const img = decodePng(png)
  for (const lane of ['flat', 'grad'] as const) {
    if (LANE && LANE !== lane) continue
    const doc = await traceImage(img as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: lane === 'grad' })
    const s = scoreDoc(img, doc)
    const paths = doc.items.filter((i) => i.kind === 'path')
    const grads = paths.filter((i) => (i as PathItem).gradient).length
    const red = s.meanDeltaE > 3.0 || s.p95DeltaE > 8.0
    console.log(`    ${c.id.padEnd(26)}${(Number.isFinite(authored) ? String(authored) : 'png').padStart(9)}  ${lane.padEnd(5)}${f(s.meanDeltaE).padStart(7)}${f(s.p95DeltaE).padStart(7)}${String(grads).padStart(6)}${String(paths.length).padStart(6)}  ${red ? 'RED' : 'ok'}`)
  }
}
console.log()
