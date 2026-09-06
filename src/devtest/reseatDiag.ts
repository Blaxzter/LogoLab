// RESEAT DIAG — does the §10.4 junction re-seat reach a different VERDICT on the same art at
// another raster? (issue #14: `ARM_MAX` and `R_MIN`, the audit's ART rows for this pass)
//
//   node --experimental-strip-types src/devtest/reseatDiag.ts                      # the fixtures
//   node --experimental-strip-types src/devtest/reseatDiag.ts --case cross-bars --gradients --verbose
//   node --experimental-strip-types src/devtest/reseatDiag.ts --logos               # gallery sweep
//   --res LIST (default 256,512,1024,2048)   --verbose (every paired junction, every raster)
//
// WHY. `ARM_MAX` 110px caps the arm evidence each incident boundary contributes to a
// junction's primitives, and that length (`Prim.conf`) is also the KEY that ranks candidate
// pairs — so the audit predicted "which primitive pair wins can change with raster size on
// identical art". §28's synthetic occluded-disc fixture showed it live: at 3× the disc arm
// saturates near 110 while the straight chord reads its full length, and the chord outranks
// the disc. `R_MIN` 6px rejects a circle arm whose fitted radius is under 6 — an authored dot
// that is r=5 @512 is r=10 @1024 and is judged differently. Both are predictions about the
// same junction at two sizes, so the census is PAIRED: every degree-3 interior junction the
// pass weighs is keyed by its lattice position in 512-px ARTWORK space and matched across
// rasters (re-seat junctions sit where two AUTHORED boundaries cross, so unlike §28's band
// seams they pair on real marks too).
//
// WHAT TO READ. Per paired junction, per raster: each arm's verdict (L = line, C = circle
// with its radius, – = refused, with the gate that refused it), the pair that won, and the
// move — all lengths in artwork px so the lanes compare. The fold counts (a) junctions whose
// winning pair changes KIND across rasters (line+circle at one size, line+line at another:
// the ARM_MAX prediction), (b) arms refused by R_MIN at one raster while the same junction
// holds a circle arm at a finer one (the R_MIN prediction), and (c) how often `conf` sits at
// or past ARM_MAX at all (the saturation that makes the ranking blind).
//
// PURELY DIAGNOSTIC — `onReseatVerdict` is undefined in production and the pass computes
// nothing extra without it.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import type { ReseatVerdict } from '../lib/trace/planarReseat.ts'

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
const VERBOSE = argv.includes('--verbose')
const REF = 512
const ARM_MAX = 110
const f = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : '—')

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
  // The §10.4 driver (MS lane), and the flat-lane fixtures with authored crossings.
  cases.push(['gradient-flat', readFileSync(join(EDGE, 'gradient-flat.svg'), 'utf8'), true])
  for (const n of ['overlap', 'cross-bars', 'ring-cross', 'band-cross', 'bloom']) {
    try {
      cases.push([n, readFileSync(join(EDGE, `${n}.svg`), 'utf8'), false])
    } catch {
      cases.push([n, readFileSync(join(root, 'public', 'examples', `${n}.svg`), 'utf8'), false])
    }
  }
}

async function run(text: string, res: number, gradients: boolean): Promise<ReseatVerdict[]> {
  const raster = decodePng(new Resvg(text, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng())
  const seen: ReseatVerdict[] = []
  await traceImage(raster as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS,
    engine: 'planar',
    gradients,
    planarFit: { onReseatVerdict: (v) => seen.push(v) },
  })
  return seen
}

interface Cell {
  res: number
  v: ReseatVerdict
}
interface Row {
  ax: number
  ay: number
  cells: Map<number, Cell>
}

/** Pair verdicts across rasters by artwork position (greedy, 3 artwork px). A junction
 *  with a qualifying pair is keyed by the pair's INTERSECTION — the slid lattice corner
 *  moves with the raster (1.85px @256, 8.4px @512 on gradient-flat), the crossing it
 *  belongs to does not — and by its lattice corner otherwise. */
function pair(byRes: Map<number, ReseatVerdict[]>): Row[] {
  const rows: Row[] = []
  for (const res of RESOLUTIONS) {
    const s = res / REF
    for (const v of byRes.get(res) ?? []) {
      if (v.reason === 'border') continue
      const ax = (Number.isFinite(v.tx) ? v.tx : v.x) / s
      const ay = (Number.isFinite(v.ty) ? v.ty : v.y) / s
      let hit: Row | null = null
      let hd = 3
      for (const r of rows) {
        if (r.cells.has(res)) continue
        const d = Math.hypot(r.ax - ax, r.ay - ay)
        if (d < hd) {
          hd = d
          hit = r
        }
      }
      if (!hit) rows.push((hit = { ax, ay, cells: new Map() }))
      hit.cells.set(res, { res, v })
    }
  }
  return rows.sort((a, b) => a.ay - b.ay || a.ax - b.ax)
}

const kindOf = (v: ReseatVerdict): string => {
  if (!v.pair) return v.reason === 'no pair' ? 'none' : '?'
  return v.arms
    .filter((_, i) => v.pair!.includes(i))
    .map((a) => (a.kind === 'line' ? 'L' : 'C'))
    .sort()
    .join('+')
}
const armStr = (v: ReseatVerdict, s: number): string =>
  v.arms
    .map((a, i) => {
      const chosen = v.pair?.includes(i) ? '*' : ' '
      if (a.kind === 'line') return `${chosen}L${f(a.conf / s, 0)}${a.skipCap ? 'c' : ''}`
      if (a.kind === 'circle') return `${chosen}C${f(a.conf / s, 0)}r${f(a.r / s, 0)}${a.skipCap ? 'c' : ''}`
      return `${chosen}–(${a.why.replace(/ \| cap-skipped.*/, '').slice(0, 24)})`
    })
    .join(' ')

interface Fold {
  name: string
  paired: number
  full: number
  kindFlips: number
  rminFlips: number
  satByRes: Map<number, [number, number]>
  movedByRes: Map<number, number>
}
const folds: Fold[] = []

for (const [name, text, gradients] of cases) {
  const byRes = new Map<number, ReseatVerdict[]>()
  for (const res of RESOLUTIONS) {
    try {
      byRes.set(res, await run(text, res, gradients))
    } catch (err) {
      console.log(`  ${name} @${res}: failed — ${(err as Error).message}`)
    }
  }
  const rows = pair(byRes)
  const full = rows.filter((r) => RESOLUTIONS.every((res) => r.cells.has(res)))
  const fold: Fold = { name, paired: rows.length, full: full.length, kindFlips: 0, rminFlips: 0, satByRes: new Map(), movedByRes: new Map() }
  for (const res of RESOLUTIONS) {
    const vs = byRes.get(res) ?? []
    let arms = 0
    let sat = 0
    for (const v of vs) for (const a of v.arms) {
      arms++
      if (a.kind && a.conf >= ARM_MAX) sat++
    }
    fold.satByRes.set(res, [sat, arms])
    fold.movedByRes.set(res, vs.filter((v) => v.reason === 'moved').length)
  }
  const flipRows: Row[] = []
  const rminRows: Row[] = []
  for (const r of full) {
    const kinds = new Set(RESOLUTIONS.map((res) => kindOf(r.cells.get(res)!.v)))
    // Only a change between two QUALIFYING pairs is the ARM_MAX prediction; a junction that
    // has no pair at one raster is a different question (arms not certified there).
    kinds.delete('none')
    if (kinds.size > 1) {
      fold.kindFlips++
      flipRows.push(r)
    }
    const rminAt = RESOLUTIONS.filter((res) => r.cells.get(res)!.v.arms.some((a) => a.why.includes('R_MIN')))
    const circleAt = RESOLUTIONS.filter((res) => r.cells.get(res)!.v.arms.some((a) => a.kind === 'circle'))
    if (rminAt.length && circleAt.some((res) => res > Math.max(...rminAt))) {
      fold.rminFlips++
      rminRows.push(r)
    }
  }
  folds.push(fold)

  console.log(`\n━━━ ${name}${gradients ? '  [gradients]' : '  [flat]'} — ${rows.length} re-seat junctions paired, ${full.length} present at every raster ━━━`)
  console.log(`    ${'res'.padStart(5)}  ${'weighed'.padStart(7)}  ${'moved'.padStart(5)}  ${'arms at ARM_MAX'.padStart(16)}`)
  for (const res of RESOLUTIONS) {
    const [sat, arms] = fold.satByRes.get(res)!
    console.log(`    ${String(res).padStart(5)}  ${String((byRes.get(res) ?? []).filter((v) => v.reason !== 'border').length).padStart(7)}  ${String(fold.movedByRes.get(res)).padStart(5)}  ${`${sat} / ${arms}`.padStart(16)}`)
  }
  const show = VERBOSE ? rows : [...flipRows, ...rminRows.filter((r) => !flipRows.includes(r))]
  if (show.length) {
    console.log(`    ${VERBOSE ? 'every paired junction' : `${flipRows.length} pair-KIND flip(s), ${rminRows.length} R_MIN flip(s)`} — arms: *chosen, L/C = line/circle (fitted px, r = radius, c = cap skipped), – = refused (why); lengths in artwork px`)
    for (const r of show) {
      // How far apart the rasters' TARGET points are (artwork px): the bound on what a
      // different winning pair can cost, since each raster's placement is its own target.
      const targets = [...r.cells.values()].filter((c) => Number.isFinite(c.v.tx)).map((c) => ({ x: c.v.tx / (c.res / REF), y: c.v.ty / (c.res / REF) }))
      let spread = 0
      for (let i = 0; i < targets.length; i++)
        for (let j = i + 1; j < targets.length; j++) spread = Math.max(spread, Math.hypot(targets[i].x - targets[j].x, targets[i].y - targets[j].y))
      console.log(`      junction @(${f(r.ax, 0)},${f(r.ay, 0)})  target spread ${f(spread, 2)}px${flipRows.includes(r) ? '  ← pair kind flips' : ''}${rminRows.includes(r) ? '  ← R_MIN flip' : ''}`)
      for (const res of RESOLUTIONS) {
        const c = r.cells.get(res)
        if (!c) {
          console.log(`        ${String(res).padStart(5)}  (not weighed at this raster)`)
          continue
        }
        const s = res / REF
        console.log(`        ${String(res).padStart(5)}  ${kindOf(c.v).padEnd(5)} ${c.v.reason.padEnd(14)} move ${f(c.v.move / s, 2).padStart(5)}   ${armStr(c.v, s)}`)
      }
    }
  }
}

if (cases.length > 1) {
  console.log(`\n━━━ FOLD — the two ART predictions, per case ━━━`)
  console.log(`    ${'case'.padEnd(28)} ${'paired'.padStart(6)} ${'all-res'.padStart(7)} ${'kind flips'.padStart(10)} ${'R_MIN flips'.padStart(11)}   ${RESOLUTIONS.map((r) => `sat@${r}`.padStart(10)).join('')}`)
  let tf = 0
  let tr = 0
  let tp = 0
  for (const fo of folds) {
    tf += fo.kindFlips
    tr += fo.rminFlips
    tp += fo.full
    if (!fo.paired) continue
    console.log(
      `    ${fo.name.padEnd(28)} ${String(fo.paired).padStart(6)} ${String(fo.full).padStart(7)} ${String(fo.kindFlips).padStart(10)} ${String(fo.rminFlips).padStart(11)}   ` +
        RESOLUTIONS.map((r) => {
          const [s, a] = fo.satByRes.get(r) ?? [0, 0]
          return `${s}/${a}`.padStart(10)
        }).join(''),
    )
  }
  console.log(`    ${'TOTAL'.padEnd(28)} ${''.padStart(6)} ${String(tp).padStart(7)} ${String(tf).padStart(10)} ${String(tr).padStart(11)}`)
}
console.log()
