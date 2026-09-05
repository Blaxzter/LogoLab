// STEP-RAMP DIAG — where the fusion of two DISJOINT FLAT objects into one "gradient"
// region is actually decided (docs/handoff-fused-gradient.md §5).
//
//   node --experimental-strip-types src/devtest/stepRampDiag.ts                       # olympic-rings @512 on white, gradients ON
//   node --experimental-strip-types src/devtest/stepRampDiag.ts --case letter-joins    # a fixture (white, like the truth gate)
//   node --experimental-strip-types src/devtest/stepRampDiag.ts --case letter-joins --transparent   # the /labs/ab fixture-lane input
//   node --experimental-strip-types src/devtest/stepRampDiag.ts --pair 0081c8,00a651   # the two colours to follow through the merge
//   --res N (default 512)   --all (print EVERY evaluated pair)   --jump J (counterfactual maxUnwitnessedJump)
//   node --experimental-strip-types src/devtest/stepRampDiag.ts --census              # every accepted merge, every /labs/ab case
//
// --census is the CALIBRATION, labelled by ground truth rather than by eye (the handoff's
// §6 warning): each accepted Step-3c merge across the /labs/ab corpus (both lanes' inputs:
// fixtures transparent + white, gallery on white) with the terms it was accepted on, the
// sample-resolution hole, and how many gradients the SOURCE SVG authors. In a case that
// authors NONE, every accepted union of two flat blocks of different colour is a fusion of
// distinct objects by definition — there is no ramp in the art for it to be. Those rows are
// the positives any candidate signal has to catch; the rows from gradient-authoring cases
// (posterized bands reuniting, a field re-joining across an occluder) are what it must not.
//
// WHY. Traced with gradients ON, `logo-olympic-rings` comes back with its blue and green
// rings — two disjoint solids 182 authored units apart — as ONE region painted with a
// linear gradient that is a step: #0078d0 to t=0.35, #00a651 from t=0.65. The shipped
// unwitnessed-jump veto (§10.3) exists for exactly this shape and the handoff's §4
// counterfactual shows it is NOT the gate that decides here: at maxUnwitnessedJump 0 the
// olympic output is unchanged. So either the veto's own measurement reads ~0 on this pair
// (the union's samples fill every t-bin, the jump is "witnessed"), or the pair never
// reaches `evalPair` at all and is fused by something else. Those lead to different fixes,
// and §24.1's lesson is that an instrument naming the FIRST failing gate cannot tell you
// which gate is load-bearing — so this prints ALL FOUR terms of the acceptance condition
// for every evaluation, plus the reason a pair stopped short of the fit.
//
// WHAT TO READ. The MERGE SEQUENCE is the fact: each accepted union in order, with the
// terms it was accepted on and the two sides' own flatness. A row where BOTH sides are
// flat blocks (solid ≤ FLAT_FLANK_RES 0.008) and their means differ is a step-paste
// candidate and is flagged `FLAT∪FLAT`. The TRACKED PAIR section then follows the two
// named colours: every evaluation whose sides contain them, whether it was reached,
// accepted, and — if they ended up together — the step at which it happened and via
// which intermediate group. That answers §5's question directly.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import type { MergePairRecord } from '../lib/trace/segment.ts'
import { srgbToOklab, oklabDeltaE } from '../lib/trace/oklab.ts'
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
const ALL = argv.includes('--all')
const CENSUS = argv.includes('--census')
const TRANSPARENT = argv.includes('--transparent')
const JUMP = flag('--jump') ? Number(flag('--jump')) : null
const f = (v: number, d = 4): string => (Number.isFinite(v) ? v.toFixed(d) : '—'.padStart(d + 2))
const hex = (c: [number, number, number]): string =>
  '#' + [c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
const parseHex = (h: string): [number, number, number] => {
  const s = h.replace(/^#/, '')
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}
const dE = (a: [number, number, number], b: [number, number, number]): number =>
  oklabDeltaE(srgbToOklab(a[0], a[1], a[2]), srgbToOklab(b[0], b[1], b[2]))

// --- --census: every accepted merge over the A/B corpus, labelled by authored ground truth --
if (CENSUS) {
  const { AB_CORPUS, AB_LOGO_CASES } = await import('./abCorpus.ts')
  const { existsSync } = await import('node:fs')
  const FLAT = 0.008
  type Row = { case: string; bg: string; authored: string; union: string; res: number; jump: number; gap: number; minSolid: number; dE: number; holeT: number; fit: string }
  const rows: Row[] = []
  const inputs: { id: string; path: string; kind: 'svg' | 'png'; bg: 'white' | 'transparent' }[] = []
  for (const c of AB_CORPUS) {
    inputs.push({ id: c.id, path: c.path, kind: c.kind, bg: 'transparent' })
    if (c.kind === 'svg') inputs.push({ id: c.id, path: c.path, kind: c.kind, bg: 'white' })
  }
  for (const c of AB_LOGO_CASES) inputs.push({ id: c.id, path: c.path, kind: c.kind, bg: 'white' })
  for (const inp of inputs) {
    const p = join(root, inp.path)
    if (!existsSync(p)) continue
    const src = readFileSync(p)
    const authored = inp.kind === 'svg' ? String((src.toString('utf8').match(/<(linear|radial)Gradient\b/g) ?? []).length) : 'png'
    const png = inp.kind === 'svg'
      ? new Resvg(src.toString('utf8'), { fitTo: { mode: 'width', value: RES }, ...(inp.bg === 'white' ? { background: 'white' } : {}) }).render().asPng()
      : src
    const img = decodePng(png)
    const recs: MergePairRecord[] = []
    await traceImage(img as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: true, segment: { onPair: (r) => recs.push(r) } })
    const evalOfC = new Map<string, MergePairRecord>()
    for (const r of recs) if (r.kind === 'eval') evalOfC.set(r.gi < r.gj ? `${r.gi}:${r.gj}` : `${r.gj}:${r.gi}`, r)
    for (const m of recs) {
      if (m.kind !== 'merged') continue
      const e = evalOfC.get(m.gi < m.gj ? `${m.gi}:${m.gj}` : `${m.gj}:${m.gi}`)
      if (!e) continue
      rows.push({
        case: inp.id, bg: inp.bg, authored,
        union: `${hex(m.meanI)}(${m.membersI.length})∪${hex(m.meanJ)}(${m.membersJ.length})`,
        res: m.res, jump: e.jump, gap: e.gap, minSolid: Math.min(e.solidI, e.solidJ), dE: dE(m.meanI, m.meanJ),
        holeT: e.holeT ?? NaN, fit: e.fitType ?? '?',
      })
    }
  }
  console.log(`
━━━ STEP-3C MERGE CENSUS @${RES} — every ACCEPTED merge, labelled by the SOURCE's authored gradient count ━━━
`)
  console.log(`  ${'case'.padEnd(22)}${'bg'.padEnd(12)}${'auth'.padStart(5)}  ${'union'.padEnd(34)}${'res'.padStart(7)}${'jump'.padStart(8)}${'gap'.padStart(7)}${'minSol'.padStart(8)}${'ΔEmean'.padStart(8)}${'holeT'.padStart(8)}  fit`)
  // Print the rows that matter first: FLAT∪FLAT (min solid ≤ FLAT) with a colour difference —
  // the only population a step-paste can hide in — sorted by holeJ, then the rest.
  const flatDiff = rows.filter((r) => r.minSolid <= FLAT && r.dE > 0.02).sort((a, b) => b.jump - a.jump)
  const other = rows.filter((r) => !(r.minSolid <= FLAT && r.dE > 0.02)).sort((a, b) => b.jump - a.jump)
  const pr = (r: Row): void =>
    console.log(`  ${r.case.padEnd(22)}${r.bg.padEnd(12)}${r.authored.padStart(5)}  ${r.union.padEnd(34)}${f(r.res).padStart(7)}${f(r.jump, 3).padStart(8)}${f(r.gap, 3).padStart(7)}${f(r.minSolid).padStart(8)}${f(r.dE, 3).padStart(8)}${f(r.holeT, 3).padStart(8)}  ${r.fit}`)
  console.log(`
  FLAT∪FLAT, different colour (${flatDiff.length}) — a fusion of distinct objects wherever auth = 0:
`)
  for (const r of flatDiff) pr(r)
  console.log(`
  everything else (${other.length}) — same-colour reunites and ramped sides (flat-flank escape):
`)
  for (const r of other) pr(r)
  console.log()
  process.exit(0)
}

// --- the case ---------------------------------------------------------------------------
const EDGE = join(root, 'public', 'examples', 'edge-cases')
const CASE = flag('--case')
let name = 'olympic-rings'
let svgPath = join(root, 'examples', 'logos', 'olympic-rings.svg')
if (CASE) {
  const tries = [join(EDGE, `${CASE}.svg`), join(root, 'public', 'examples', `${CASE}.svg`), join(root, 'examples', 'logos', `${CASE}.svg`), join(root, 'public', 'corpus', 'fluent', 'flat', `${CASE.replace(/-flat$/, '')}.svg`)]
  const hit = tries.find((t) => { try { readFileSync(t); return true } catch { return false } })
  if (!hit) throw new Error(`no such case: ${CASE}`)
  name = CASE
  svgPath = hit
}
const text = readFileSync(svgPath, 'utf8')
const raster = decodePng(new Resvg(text, { fitTo: { mode: 'width', value: RES }, ...(TRANSPARENT ? {} : { background: 'white' }) }).render().asPng())

// Which two colours to follow. Default: the olympic blue ∪ green pair the handoff names.
const pairArg = flag('--pair')
const tracked: [number, number, number][] | null = pairArg
  ? pairArg.split(',').map((h) => parseHex(h.trim()))
  : name === 'olympic-rings'
    ? [parseHex('0081c8'), parseHex('00a651')]
    : null

// --- trace with the observer ----------------------------------------------------------
const records: MergePairRecord[] = []
const doc = await traceImage(raster as unknown as ImageData, {
  ...DEFAULT_VECTORIZE_OPTIONS,
  engine: 'planar',
  gradients: true,
  segment: { onPair: (r) => records.push(r), ...(JUMP != null ? { maxUnwitnessedJump: JUMP } : {}) },
})

const evals = records.filter((r) => r.kind === 'eval')
const merges = records.filter((r) => r.kind === 'merged')
// Fine segments: every singleton side ever described.
const fine = new Map<number, { px: number; mean: [number, number, number]; solid: number }>()
for (const r of evals) {
  if (r.membersI.length === 1 && !fine.has(r.gi)) fine.set(r.gi, { px: r.pxI, mean: r.meanI, solid: r.solidI })
  if (r.membersJ.length === 1 && !fine.has(r.gj)) fine.set(r.gj, { px: r.pxJ, mean: r.meanJ, solid: r.solidJ })
  if (r.membersI.length === 1 && Number.isFinite(r.solidI)) fine.get(r.gi)!.solid = r.solidI
  if (r.membersJ.length === 1 && Number.isFinite(r.solidJ)) fine.get(r.gj)!.solid = r.solidJ
}
const S = Math.max(...[...fine.keys()], -1) + 1
const gated = S > 64
// The eval record a merge was accepted on (each (gi,gj) is evaluated once per lifetime).
const key = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`)
const evalOf = new Map<string, MergePairRecord>()
for (const r of evals) evalOf.set(key(r.gi, r.gj), r)

const sideName = (members: number[], mean: [number, number, number]): string =>
  `{${members.join(',')}}${hex(mean)}`
const FLAT = 0.008
const geom = (r: MergePairRecord): string => {
  const g = r.fit
  if (!g) return ''
  if (g.type === 'linear') return `linear (${g.x1.toFixed(0)},${g.y1.toFixed(0)})→(${g.x2.toFixed(0)},${g.y2.toFixed(0)}) len ${Math.hypot(g.x2 - g.x1, g.y2 - g.y1).toFixed(0)}px`
  return `radial c(${g.cx.toFixed(0)},${g.cy.toFixed(0)}) r ${g.r.toFixed(0)}px${g.fx != null && (g.fx !== g.cx || g.fy !== g.cy) ? ` f(${g.fx.toFixed(0)},${g.fy!.toFixed(0)})` : ''}`
}
const binsTxt = (b?: number[]): string => (b ? b.map((c) => (c === 0 ? '·' : c < 10 ? String(c) : c < 100 ? '#' : '█')).join('') : '')
const stopsTxt = (r: MergePairRecord): string => (r.fit ? r.fit.stops.map((s) => `${s.color}@${s.offset.toFixed(3)}`).join(' ') : '')

console.log(`
━━━ STEP-RAMP DIAG — ${name} @${RES} ${TRANSPARENT ? 'transparent' : 'on white'}, gradients ON${JUMP != null ? ` — COUNTERFACTUAL maxUnwitnessedJump=${JUMP}` : ''} ━━━
`)
console.log(`  fine segments S = ${S}   candidate gate ${gated ? 'ON (S > 64: adjacency-only)' : 'OFF (S ≤ 64: every pair eligible)'}`)
console.log(`  evaluations ${evals.length}   accepted merges ${merges.length}   final groups ${S - merges.length}`)
const stopped = new Map<string, number>()
for (const r of evals) stopped.set(r.reached, (stopped.get(r.reached) ?? 0) + 1)
console.log(`  reached: ${[...stopped].map(([k, v]) => `${k} ${v}`).join('   ')}`)

// --- fine segments --------------------------------------------------------------------
console.log(`
  FINE SEGMENTS (px = opaque pixels; solid = RMS Oklab ΔE from own mean, flat block ≤ ${FLAT})
`)
console.log(`    ${'id'.padStart(4)}${'px'.padStart(9)}   ${'mean'.padEnd(8)}${'solid'.padStart(9)}   nearest tracked`)
for (const [id, s] of [...fine].sort((a, b) => b[1].px - a[1].px)) {
  const near = tracked
    ? tracked.map((c, i) => [dE(s.mean, c), i] as const).sort((a, b) => a[0] - b[0])[0]
    : null
  const tag = near && near[0] < 0.08 ? `${hex(tracked![near[1]])} (ΔE ${f(near[0], 3)})` : ''
  console.log(`    ${String(id).padStart(4)}${String(s.px).padStart(9)}   ${hex(s.mean)}${f(s.solid).padStart(9)}   ${tag}`)
}

// --- merge sequence --------------------------------------------------------------------
console.log(`
  MERGE SEQUENCE (in order; terms are the acceptance condition's — res ≤ 0.06, gap ≤ 0.34, jump ≤ 0.12 unless min(solid) > ${FLAT})
`)
console.log(`    ${'step'.padStart(4)}  ${'union'.padEnd(44)}${'res'.padStart(8)}${'gap'.padStart(8)}${'jump'.padStart(8)}${'solidI'.padStart(8)}${'solidJ'.padStart(8)}${'ΔEmeans'.padStart(9)}${'holeT'.padStart(8)}  fit    flag`)
merges.forEach((m, step) => {
  const e = evalOf.get(key(m.gi, m.gj))
  const both = e && e.solidI <= FLAT && e.solidJ <= FLAT
  const d = dE(m.meanI, m.meanJ)
  const flagTxt = both && d > 0.05 ? 'FLAT∪FLAT step-paste' : both ? 'flat∪flat same colour' : ''
  console.log(
    `    ${String(step + 1).padStart(4)}  ${`${sideName(m.membersI, m.meanI)} ∪ ${sideName(m.membersJ, m.meanJ)} → ${m.c}`.padEnd(44)}` +
      `${f(m.res).padStart(8)}${f(e?.gap ?? NaN, 3).padStart(8)}${f(e?.jump ?? NaN, 3).padStart(8)}${f(e?.solidI ?? NaN).padStart(8)}${f(e?.solidJ ?? NaN).padStart(8)}${f(d, 3).padStart(9)}${f(e?.holeT ?? NaN, 3).padStart(8)}  ${(e?.fitType ?? '?').padEnd(6)} ${flagTxt}`,
  )
})

// --- the tracked pair ------------------------------------------------------------------
if (tracked) {
  const isColour = (id: number, c: [number, number, number]): boolean => {
    const s = fine.get(id)
    return !!s && dE(s.mean, c) < 0.08
  }
  const [A, B] = tracked
  const hasA = (m: number[]): boolean => m.some((id) => isColour(id, A))
  const hasB = (m: number[]): boolean => m.some((id) => isColour(id, B))
  const involves = (r: MergePairRecord): boolean =>
    (hasA(r.membersI) && hasB(r.membersJ)) || (hasB(r.membersI) && hasA(r.membersJ))
  console.log(`
  TRACKED PAIR ${hex(A)} ∪ ${hex(B)} — every evaluation whose two sides contain them
`)
  console.log(`    ${'pair'.padEnd(44)}${'reached'.padEnd(11)}${'res'.padStart(8)}${'gap'.padStart(8)}${'jump'.padStart(8)}${'solidI'.padStart(8)}${'solidJ'.padStart(8)}  fit/stops  accepted`)
  const rows = evals.filter(involves)
  for (const r of rows) {
    console.log(
      `    ${`${sideName(r.membersI, r.meanI)} ∪ ${sideName(r.membersJ, r.meanJ)}`.padEnd(44)}${r.reached.padEnd(11)}` +
        `${f(r.res).padStart(8)}${f(r.gap, 3).padStart(8)}${f(r.jump, 3).padStart(8)}${f(r.solidI).padStart(8)}${f(r.solidJ).padStart(8)}  ${(r.fitType ?? '—').padEnd(6)}/${String(r.stops ?? '—').padEnd(3)}  ${r.accepted ? 'YES' : 'no'}`,
    )
    if (r.fit) {
      console.log(`        fit    ${geom(r)}`)
      console.log(`        stops  ${stopsTxt(r)}`)
      console.log(`        t-bins ${binsTxt(r.bins)}   (24 bins; · empty, digit = n, # ≥10, █ ≥100)   jump ${f(r.jump, 3)} at t ${f(r.jumpT ?? NaN, 3)}; widest sample-free stretch ${f(r.holeT ?? NaN, 4)} of t`)
    }
  }
  if (!rows.length) console.log(`    (no evaluation ever put ${hex(A)} and ${hex(B)} on opposite sides)`)
  const fused = merges.findIndex(involves)
  if (fused >= 0) {
    const m = merges[fused]
    console.log(`
  → FUSED at merge step ${fused + 1}: ${sideName(m.membersI, m.meanI)} ∪ ${sideName(m.membersJ, m.meanJ)} → group ${m.c}`)
  } else {
    console.log(`
  → never fused in Step 3c`)
  }
}

// --- every evaluation ------------------------------------------------------------------
if (ALL) {
  console.log(`
  ALL EVALUATIONS
`)
  for (const r of evals) {
    console.log(
      `    ${`${sideName(r.membersI, r.meanI)} ∪ ${sideName(r.membersJ, r.meanJ)}`.padEnd(48)}${r.reached.padEnd(11)}` +
        `${f(r.res).padStart(8)}${f(r.gap, 3).padStart(8)}${f(r.jump, 3).padStart(8)}${f(r.solidI).padStart(8)}${f(r.solidJ).padStart(8)}  ${r.accepted ? 'YES' : 'no'}`,
    )
  }
}

// --- the emitted paint -----------------------------------------------------------------
console.log(`
  EMITTED GRADIENTS (Stage 2 paint of the final regions)
`)
let gi = 0
for (const it of doc.items) {
  if (it.kind !== 'path') continue
  const p = it as PathItem
  if (!p.gradient) continue
  gi++
  const g = p.gradient
  const stops = g.stops.map((s) => `${s.color}@${s.offset.toFixed(3)}`).join(' ')
  console.log(`    ${String(gi).padStart(3)}  ${g.type.padEnd(7)} ${String(g.stops.length).padStart(2)} stops  ${stops}`)
}
if (!gi) console.log('    (none)')
console.log()
