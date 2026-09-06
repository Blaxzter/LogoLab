// RESEAT DIAG — does the §10.4 junction re-seat land on the AUTHORED crossing, and does the
// same art get a different verdict at another raster? (issue #14: `ARM_MAX` / `R_MIN`;
// issue #39: the arm CERTIFICATION — `LINE_TOL` / `CIRC_TOL` / `MIN_ARC_ARM` / `CAP_MAX`
// over an arm whose length is a span of art.)
//
//   node --experimental-strip-types src/devtest/reseatDiag.ts                      # the fixtures
//   node --experimental-strip-types src/devtest/reseatDiag.ts --case brave-browser --res 512,1024,2048 --verbose
//   node --experimental-strip-types src/devtest/reseatDiag.ts --logos               # gallery sweep
//   node --experimental-strip-types src/devtest/reseatDiag.ts --logos firefox,tiktok
//   --res LIST (default 256,512,1024,2048)   --verbose (every paired junction, every raster)
//   --arm-frac      second lane: ARM_MAX held at 110 ARTWORK px (110·res/512 native) — audit
//                   UNRESOLVED 11, "hold the arm at a fixed artwork fraction and re-count"
//   --tune k=v,…    second lane with explicit overrides (armMax, lineTol, circTol, minArcArm,
//                   capMax; native px)
//   --lanes SPEC    arbitrary lanes: `NAME:k=v,k=v|NAME2:k=v` (ReseatTune fields, native px;
//                   `throughVeto=0` is the pre-§29 pass) — the first lane is the baseline
//
// WHY. `ARM_MAX` 110px caps the arm evidence each incident boundary contributes to a
// junction's primitives, and that length (`Prim.conf`) is also the KEY that ranks candidate
// pairs; `LINE_TOL` 0.8 / `CIRC_TOL` 0.9 then certify the arm as a line or a circle over
// however much art those 110 px cover — half a boundary at 1024, a quarter at 2048. §28.6's
// paired census found the certification, not the ranking, flipping the winning pair's KIND
// on 8 gallery junctions that re-seat (brave-browser @(260,282): 2.72 px onto circle×line at
// 512, 0.50 px onto line×line at 2048, targets 2.7 px apart) — and could not say which
// raster was RIGHT, because nothing scored the placement against the art.
//
// THE ANSWER SHEET (issue #39, Phase 0). A re-seat junction is where two authored outlines
// cross, so the crossing point is computable from the SVG: `authoredCrossings` intersects
// the flattened outlines of every pair of authored subpaths (gradient-flat: line×circle;
// overlap: circle×circle; cross-bars: bar edge × bar edge; gallery marks: whatever
// `svgGround` accepts). Every raster's TARGET (tx,ty) is scored against the nearest
// crossing in artwork px — next to the lattice corner's own error, the cost of not moving —
// and junctions are paired across rasters BY THE CROSSING they land on, never by the lattice
// corner (which slides with the raster). Each crossing also says what the two boundaries
// ARE there (line / curve with its local radius, and the crossing angle), so "certified as
// a circle of r=157" can be checked against the art.
//
// THE ESTIMATORS, GATES IGNORED (§28.1's lesson: measure the estimators before designing
// the selector). With the observer attached, the pass also reports every arm's ungated line
// AND circle fit (full arm, and with the terminal segment excluded), so the diag can put the
// junction where EACH pair of estimators would — line×line, circle×line, circle×circle, and
// the best of all — and score each against the crossing. That table, not the verdict table,
// is what says whether a fix is a selector problem or an evidence problem.
//
// PURELY DIAGNOSTIC — `onReseatVerdict` and `reseatTune` are undefined in production and
// the pass computes nothing extra without them.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { intersectPrims, type ReseatPrim, type ReseatTune, type ReseatVerdict } from '../lib/trace/planarReseat.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from './svgGround.ts'
import { authoredCrossings, boundaryLabel, nearestCrossing, type Crossing } from './authoredCrossings.ts'
import type { Vec } from '../lib/path/types.ts'

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
const LOGOS = flag('--logos')
const GRADIENTS = argv.includes('--gradients')
const VERBOSE = argv.includes('--verbose')
const ARM_FRAC = argv.includes('--arm-frac')
const TUNE_ARG = flag('--tune')
/** `--json PATH`: every scored cell (case, lane, res, verdict, errors) as one JSON array, so a
 *  selector can be evaluated offline without re-tracing. */
const JSON_OUT = flag('--json')
const dump: unknown[] = []
const REF = 512
const ARM_MAX = 110
/** A target this close (artwork px) to an authored crossing is scored against it. */
const MATCH_R = 6
/** A junction with no qualifying pair has only its lattice corner to match with; the slide
 *  population reaches ~8 artwork px at 512, so it gets a wider reach. */
const MATCH_R_LATTICE = 10
const f = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : '—')

// --- lanes ----------------------------------------------------------------------------------

interface Lane {
  name: string
  tune: (res: number) => ReseatTune | undefined
}
const LANES_ARG = flag('--lanes')
const parseTune = (spec: string): ReseatTune => {
  const t: ReseatTune = {}
  for (const kv of spec.split(',')) {
    const [k, v] = kv.split('=')
    if (k && Number.isFinite(Number(v))) (t as Record<string, number>)[k] = Number(v)
  }
  return t
}
const lanes: Lane[] = LANES_ARG
  ? LANES_ARG.split('|').map((l) => {
      const [name, spec] = l.split(':')
      const t = parseTune(spec ?? '')
      return { name, tune: () => t }
    })
  : [{ name: 'HEAD', tune: () => undefined }]
if (ARM_FRAC) lanes.push({ name: 'ARM-FRAC', tune: (res) => ({ armMax: (ARM_MAX * res) / REF }) })
if (TUNE_ARG) {
  const t: ReseatTune = {}
  for (const kv of TUNE_ARG.split(',')) {
    const [k, v] = kv.split('=')
    if (k && Number.isFinite(Number(v))) (t as Record<string, number>)[k] = Number(v)
  }
  lanes.push({ name: 'TUNED', tune: () => t })
}

// --- cases ----------------------------------------------------------------------------------

const EDGE = join(root, 'public', 'examples', 'edge-cases')
const cases: [string, string, boolean][] = []
const readLogo = (name: string): string => readFileSync(join(root, 'examples', 'logos', `${name.replace(/\.svg$/, '')}.svg`), 'utf8')
if (CASE) {
  const alt = join(EDGE, `${CASE}.svg`)
  try {
    cases.push([CASE, readFileSync(alt, 'utf8'), GRADIENTS])
  } catch {
    cases.push([CASE, readLogo(CASE), GRADIENTS])
  }
} else if (LOGOS != null) {
  const names = LOGOS ? LOGOS.split(',') : readdirSync(join(root, 'examples', 'logos')).filter((x) => x.endsWith('.svg'))
  for (const n of names) cases.push([n.replace(/\.svg$/, ''), readLogo(n), false])
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

async function run(text: string, res: number, gradients: boolean, tune: ReseatTune | undefined): Promise<ReseatVerdict[]> {
  const raster = decodePng(new Resvg(text, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng())
  const seen: ReseatVerdict[] = []
  await traceImage(raster as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS,
    engine: 'planar',
    gradients,
    planarFit: { onReseatVerdict: (v) => seen.push(v), reseatTune: tune },
  })
  return seen
}

// --- scoring one verdict against the answer sheet -------------------------------------------

interface AltErr {
  LL: number
  CL: number
  CC: number
  best: number
  bestName: string
}

/** Where each PAIR of ungated estimators would put the junction, scored in artwork px. */
function altErrors(v: ReseatVerdict, s: number, cross: Vec): AltErr {
  const out: AltErr = { LL: NaN, CL: NaN, CC: NaN, best: NaN, bestName: '' }
  const cands = (i: number): [string, ReseatPrim][] => {
    const a = v.arms[i].alt
    if (!a) return []
    const c: [string, ReseatPrim][] = []
    if (a.line) c.push(['L', a.line.prim])
    if (a.circle && a.circle.prim.c!.r >= 1) c.push(['C', a.circle.prim])
    if (a.noCap?.line) c.push(['Lc', a.noCap.line.prim])
    if (a.noCap?.circle && a.noCap.circle.prim.c!.r >= 1) c.push(['Cc', a.noCap.circle.prim])
    return c
  }
  const at = { x: v.x, y: v.y }
  const take = (key: keyof AltErr, e: number): void => {
    if (!(e < (out[key] as number)) && Number.isFinite(out[key] as number)) return
    ;(out[key] as number) = e
  }
  for (let i = 0; i < v.arms.length; i++)
    for (let j = i + 1; j < v.arms.length; j++)
      for (const [ni, pi] of cands(i))
        for (const [nj, pj] of cands(j)) {
          let H: Vec | null = null
          let hd = Infinity
          for (const c of intersectPrims(pi, pj)) {
            const d = Math.hypot(c.x - at.x, c.y - at.y)
            if (d < hd) {
              hd = d
              H = c
            }
          }
          if (!H) continue
          const e = Math.hypot(H.x / s - cross.x, H.y / s - cross.y)
          const full = ni.length === 1 && nj.length === 1
          if (full && ni === 'L' && nj === 'L') take('LL', e)
          else if (full && ni === 'C' && nj === 'C') take('CC', e)
          else if (full) take('CL', e)
          if (!(e >= out.best)) {
            out.best = e
            out.bestName = `${i}${ni}×${j}${nj}`
          }
        }
  return out
}

interface Cell {
  lane: string
  res: number
  v: ReseatVerdict
  /** Artwork-px positions. */
  lat: Vec
  target: Vec | null
  cross: Crossing | null
  /** Lattice corner → crossing; target → crossing; final placement → crossing. */
  latErr: number
  err: number
  placed: number
  alt: AltErr | null
  /** The chosen pair's own uncertainty (NATIVE px): the two arms' fit residuals summed,
   *  amplified by 1/sin of the angle the pair meets at — how far sub-px fit noise can move
   *  the intersection. NaN without a pair. */
  unc: number
  /** Angle the chosen pair meets at (deg). */
  pairDeg: number
}

/** Fit residual and tangent-at-H of a chosen arm, from its ungated record. */
function chosenPrim(v: ReseatVerdict, i: number): { dev: number; t: (H: Vec) => Vec } | null {
  const a = v.arms[i]
  if (!a.kind || !a.alt) return null
  const src = a.skipCap ? a.alt.noCap : a.alt
  const fit = a.kind === 'line' ? src?.line : src?.circle
  if (!fit) return null
  const p = fit.prim
  return {
    dev: fit.dev,
    t: (H) => {
      if (p.kind === 'line') return p.d!
      const dx = H.x - p.c!.cx
      const dy = H.y - p.c!.cy
      const l = Math.hypot(dx, dy) || 1
      return { x: -dy / l, y: dx / l }
    },
  }
}
function pairUnc(v: ReseatVerdict): { unc: number; deg: number } {
  if (!v.pair || !Number.isFinite(v.tx)) return { unc: NaN, deg: NaN }
  const a = chosenPrim(v, v.pair[0])
  const b = chosenPrim(v, v.pair[1])
  if (!a || !b) return { unc: NaN, deg: NaN }
  const H = { x: v.tx, y: v.ty }
  const ta = a.t(H)
  const tb = b.t(H)
  const sin = Math.abs(ta.x * tb.y - ta.y * tb.x)
  return { unc: (a.dev + b.dev) / Math.max(sin, 1e-6), deg: (Math.asin(Math.min(1, sin)) * 180) / Math.PI }
}

function score(lane: string, res: number, v: ReseatVerdict, xs: Crossing[] | null): Cell {
  const s = res / REF
  const lat = { x: v.x / s, y: v.y / s }
  const target = Number.isFinite(v.tx) ? { x: v.tx / s, y: v.ty / s } : null
  let cross: Crossing | null = null
  if (xs) {
    const hit = target ? nearestCrossing(xs, target, MATCH_R) : nearestCrossing(xs, lat, MATCH_R_LATTICE)
    cross = hit?.c ?? null
  }
  const latErr = cross ? Math.hypot(lat.x - cross.x, lat.y - cross.y) : NaN
  const err = cross && target ? Math.hypot(target.x - cross.x, target.y - cross.y) : NaN
  return {
    lane,
    res,
    v,
    lat,
    target,
    cross,
    latErr,
    err,
    placed: v.reason === 'moved' ? err : latErr,
    alt: cross ? altErrors(v, s, cross) : null,
    ...(() => { const u = pairUnc(v); return { unc: u.unc, pairDeg: u.deg } })(),
  }
}

// --- pairing across rasters -----------------------------------------------------------------

interface Row {
  /** Key position (artwork px): the crossing when matched, else the target / lattice. */
  ax: number
  ay: number
  cross: Crossing | null
  cells: Cell[]
}

/** Rows keyed by the authored crossing; unmatched cells fall back to §28.6's greedy pairing
 *  by target (3 artwork px), never by the lattice corner when a target exists. */
function pair(cells: Cell[]): Row[] {
  const rows: Row[] = []
  const byCross = new Map<Crossing, Row>()
  for (const c of cells) {
    if (c.cross) {
      let r = byCross.get(c.cross)
      if (!r) {
        r = { ax: c.cross.x, ay: c.cross.y, cross: c.cross, cells: [] }
        byCross.set(c.cross, r)
        rows.push(r)
      }
      r.cells.push(c)
      continue
    }
    const p = c.target ?? c.lat
    let hit: Row | null = null
    let hd = 3
    for (const r of rows) {
      if (r.cross) continue
      if (r.cells.some((o) => o.res === c.res && o.lane === c.lane)) continue
      const d = Math.hypot(r.ax - p.x, r.ay - p.y)
      if (d < hd) {
        hd = d
        hit = r
      }
    }
    if (!hit) rows.push((hit = { ax: p.x, ay: p.y, cross: null, cells: [] }))
    hit.cells.push(c)
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
      const alt = a.alt ? ` [l${f(a.alt.line?.dev ?? NaN, 2)} c${f(a.alt.circle?.dev ?? NaN, 2)}r${f((a.alt.circle?.prim.c?.r ?? NaN) / s, 0)}]` : ''
      if (a.kind === 'line') return `${chosen}L${f(a.conf / s, 0)}${a.skipCap ? 'c' : ''}${alt}`
      if (a.kind === 'circle') return `${chosen}C${f(a.conf / s, 0)}r${f(a.r / s, 0)}${a.skipCap ? 'c' : ''}${alt}`
      return `${chosen}–(${a.why.replace(/ \| cap-skipped.*/, '').slice(0, 24)})${alt}`
    })
    .join(' ')
const crossStr = (c: Crossing): string => `${boundaryLabel(c.a)} × ${boundaryLabel(c.b)} at ${f(c.angleDeg, 0)}°`

// --- fold -----------------------------------------------------------------------------------

interface LaneRes {
  weighed: number
  moved: number
  matched: number
  movedUnmatched: number
  /** Over MOVED + matched junctions. */
  errs: number[]
  lats: number[]
  worse: number
  better: number
  /** Moved + matched cells whose move exceeds the pair's own uncertainty, split by outcome
   *  (worse / better than the lattice) — and the same for moves within it. */
  overUnc: { worse: number; better: number; same: number }
  underUnc: { worse: number; better: number; same: number }
  /** Over every matched junction with an answer sheet: the final placement vs the oracle. */
  placed: number[]
  bestAlt: number[]
  claims: { L: number; C: number; none: number; arms: number }
  /** Certification against the ART: arms matched (by tangent) to the authored boundary they
   *  lie on — a line, a curve of local radius ≤ 200 artwork px, or a flatter curve — and
   *  what the pass called each. */
  cert: Record<'line' | 'curve' | 'flat', { L: number; C: number; none: number }>
}
const CURVE_R_MAX = 200
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const max = (xs: number[]): number => (xs.length ? Math.max(...xs) : NaN)
const emptyLane = (): LaneRes => ({ weighed: 0, moved: 0, matched: 0, movedUnmatched: 0, errs: [], lats: [], worse: 0, better: 0, overUnc: { worse: 0, better: 0, same: 0 }, underUnc: { worse: 0, better: 0, same: 0 }, placed: [], bestAlt: [], claims: { L: 0, C: 0, none: 0, arms: 0 }, cert: { line: { L: 0, C: 0, none: 0 }, curve: { L: 0, C: 0, none: 0 }, flat: { L: 0, C: 0, none: 0 } } })
const addLane = (a: LaneRes, b: LaneRes): void => {
  a.weighed += b.weighed
  a.moved += b.moved
  a.matched += b.matched
  a.movedUnmatched += b.movedUnmatched
  a.errs.push(...b.errs)
  a.lats.push(...b.lats)
  a.worse += b.worse
  a.better += b.better
  for (const k of ['worse', 'better', 'same'] as const) {
    a.overUnc[k] += b.overUnc[k]
    a.underUnc[k] += b.underUnc[k]
  }
  a.placed.push(...b.placed)
  a.bestAlt.push(...b.bestAlt)
  a.claims.L += b.claims.L
  a.claims.C += b.claims.C
  a.claims.none += b.claims.none
  a.claims.arms += b.claims.arms
  for (const k of ['line', 'curve', 'flat'] as const) {
    a.cert[k].L += b.cert[k].L
    a.cert[k].C += b.cert[k].C
    a.cert[k].none += b.cert[k].none
  }
}
/** Which authored boundary an arm lies on, by the angle between the arm's own line-fit
 *  direction and the crossing's two tangents; null when the crossing is too shallow to tell. */
function armBoundary(c: Cell, i: number): 'line' | 'curve' | 'flat' | null {
  if (!c.cross || c.cross.angleDeg < 20) return null
  const d = c.v.arms[i].alt?.line?.prim.d
  if (!d) return null
  const off = (t: Vec): number => Math.abs(d.x * t.y - d.y * t.x)
  const b = off(c.cross.a.t) <= off(c.cross.b.t) ? c.cross.a : c.cross.b
  if (b.kind === 'line' || !Number.isFinite(b.r)) return 'line'
  return b.r <= CURVE_R_MAX ? 'curve' : 'flat'
}
const certStr = (r: LaneRes): string =>
  (['line', 'curve', 'flat'] as const).map((k) => `${k} ${r.cert[k].L}/${r.cert[k].C}/${r.cert[k].none}`).join(' · ')
const laneLine = (label: string, r: LaneRes): string =>
  `    ${label.padEnd(14)} ${String(r.weighed).padStart(7)}  ${String(r.moved).padStart(5)}  ${`${r.matched}`.padStart(7)}  ${String(r.movedUnmatched).padStart(4)}   ${`${f(mean(r.errs), 2)} / ${f(max(r.errs), 2)}`.padStart(13)}  ${f(mean(r.lats), 2).padStart(6)}  ${`${r.worse} / ${r.better}`.padStart(9)}   ${`${f(mean(r.placed), 2)} vs ${f(mean(r.bestAlt), 2)}`.padStart(14)}   ${`${r.claims.L} / ${r.claims.C} / ${r.claims.none}`.padStart(14)}`
const laneHeader = (): string =>
  `    ${'lane@res'.padEnd(14)} ${'weighed'.padStart(7)}  ${'moved'.padStart(5)}  ${'matched'.padStart(7)}  ${'mv?'.padStart(4)}   ${'moved err mean/max'.padStart(13)}  ${'lat'.padStart(6)}  ${'worse/bet'.padStart(9)}   ${'placed vs oracle'.padStart(14)}   ${'arms L / C / –'.padStart(14)}`

const totals = new Map<string, LaneRes>()
const kindFlipTotal = new Map<string, number>()
let casesScored = 0

for (const [name, text, gradients] of cases) {
  const gt = parseGroundTruth(text)
  const refusal = unscorable(gt)
  const xs = refusal ? null : authoredCrossings(toRasterSpace(gt, REF))
  if (xs) casesScored++
  const cells: Cell[] = []
  const perLane = new Map<string, LaneRes>()
  for (const lane of lanes) {
    for (const res of RESOLUTIONS) {
      let vs: ReseatVerdict[] = []
      try {
        vs = await run(text, res, gradients, lane.tune(res))
      } catch (err) {
        console.log(`  ${name} @${res} [${lane.name}]: failed — ${(err as Error).message}`)
      }
      const r = emptyLane()
      for (const v of vs) {
        if (v.reason === 'border') continue
        const c = score(lane.name, res, v, xs)
        cells.push(c)
        if (JSON_OUT) dump.push({ case: name, ...c, cross: c.cross ? { x: c.cross.x, y: c.cross.y, a: boundaryLabel(c.cross.a), b: boundaryLabel(c.cross.b), angleDeg: c.cross.angleDeg } : null })
        r.weighed++
        v.arms.forEach((a, i) => {
          r.claims.arms++
          const k = a.kind === 'line' ? 'L' : a.kind === 'circle' ? 'C' : 'none'
          r.claims[k]++
          const on = armBoundary(c, i)
          if (on) r.cert[on][k]++
        })
        if (v.reason === 'moved') r.moved++
        if (c.cross) {
          r.matched++
          r.placed.push(c.placed)
          if (c.alt && Number.isFinite(c.alt.best)) r.bestAlt.push(Math.min(c.alt.best, c.latErr))
          if (v.reason === 'moved') {
            r.errs.push(c.err)
            r.lats.push(c.latErr)
            const outcome = c.err > c.latErr + 0.1 ? 'worse' : c.err < c.latErr - 0.1 ? 'better' : 'same'
            if (outcome === 'worse') r.worse++
            else if (outcome === 'better') r.better++
            if (Number.isFinite(c.unc)) (v.move > c.unc ? r.overUnc : r.underUnc)[outcome]++
          }
        } else if (v.reason === 'moved') r.movedUnmatched++
      }
      perLane.set(`${lane.name}@${res}`, r)
      const key = `${lane.name}@${res}`
      if (!totals.has(key)) totals.set(key, emptyLane())
      addLane(totals.get(key)!, r)
    }
  }

  const rows = pair(cells)
  console.log(`\n━━━ ${name}${gradients ? '  [gradients]' : '  [flat]'} — ${xs ? `${xs.length} authored crossings` : `NO answer sheet (${refusal})`} · ${rows.length} junction rows${xs ? `, ${rows.filter((r) => r.cross).length} on a crossing` : ''} ━━━`)
  console.log(laneHeader())
  for (const lane of lanes) for (const res of RESOLUTIONS) console.log(laneLine(`${lane.name}@${res}`, perLane.get(`${lane.name}@${res}`)!))
  if (xs && VERBOSE) for (const lane of lanes) for (const res of RESOLUTIONS) console.log(`    ${`${lane.name}@${res}`.padEnd(14)} arms on an authored (L/C/–): ${certStr(perLane.get(`${lane.name}@${res}`)!)}`)

  // Pair-KIND flips per lane (the §28.6 count), and rows worth printing.
  const flips = new Set<Row>()
  for (const lane of lanes) {
    let n = 0
    for (const r of rows) {
      const kinds = new Set(r.cells.filter((c) => c.lane === lane.name).map((c) => kindOf(c.v)))
      kinds.delete('none')
      if (kinds.size > 1) {
        n++
        flips.add(r)
      }
    }
    kindFlipTotal.set(lane.name, (kindFlipTotal.get(lane.name) ?? 0) + n)
  }
  const worseRows = rows.filter((r) => r.cells.some((c) => c.v.reason === 'moved' && c.cross && c.err > c.latErr + 0.1))
  const show = VERBOSE ? rows : rows.filter((r) => flips.has(r) || worseRows.includes(r))
  if (show.length) {
    console.log(
      `    ${VERBOSE ? 'every junction row' : `${flips.size} pair-KIND flip(s), ${worseRows.length} row(s) moved AWAY from the crossing`} — err = target→crossing, lat = lattice→crossing (artwork px); alt = where line×line / circle×line / circle×circle / the best pair of UNGATED estimators would land; arms: *chosen, L/C = line/circle (fitted px, r = radius, c = cap skipped), – = refused (why), [l c r] = ungated line dev · circle dev · radius`,
    )
    for (const r of show) {
      const head = r.cross ? `crossing @(${f(r.ax, 0)},${f(r.ay, 0)})  ${crossStr(r.cross)}` : `junction @(${f(r.ax, 0)},${f(r.ay, 0)})  (no authored crossing within reach)`
      console.log(`      ${head}${flips.has(r) ? '  ← pair kind flips' : ''}${worseRows.includes(r) ? '  ← moved AWAY' : ''}`)
      for (const lane of lanes)
        for (const res of RESOLUTIONS) {
          const cs = r.cells.filter((c) => c.lane === lane.name && c.res === res)
          const tag = lanes.length > 1 ? `${lane.name.padEnd(8)} ` : ''
          if (!cs.length) {
            console.log(`        ${tag}${String(res).padStart(5)}  (not weighed at this raster)`)
            continue
          }
          for (const c of cs) {
            const s = res / REF
            const alt = c.alt ? `alt LL ${f(c.alt.LL, 2)} CL ${f(c.alt.CL, 2)} CC ${f(c.alt.CC, 2)} best ${f(c.alt.best, 2)} (${c.alt.bestName})` : ''
            console.log(
              `        ${tag}${String(res).padStart(5)}  ${kindOf(c.v).padEnd(5)} ${c.v.reason.padEnd(14)} move ${f(c.v.move / s, 2).padStart(5)}  err ${f(c.err, 2).padStart(5)}  lat ${f(c.latErr, 2).padStart(5)}  unc ${f(c.unc, 2)}n/${f(c.v.move, 2)}n @${f(c.pairDeg, 0)}°${c.v.vetoed ? `  veto ${c.v.vetoed.join('+')}` : ''}  ${alt}`,
            )
            console.log(`        ${tag}       ${armStr(c.v, s)}`)
          }
        }
    }
  }
}

if (cases.length > 1) {
  console.log(`\n━━━ FOLD — ${cases.length} cases, ${casesScored} with an answer sheet ━━━`)
  console.log(laneHeader())
  for (const lane of lanes) for (const res of RESOLUTIONS) console.log(laneLine(`${lane.name}@${res}`, totals.get(`${lane.name}@${res}`)!))
  console.log(`    arms on an authored boundary, certified L/C/– (line = authored straight; curve = local r ≤ ${CURVE_R_MAX} artwork px; flat = r > ${CURVE_R_MAX}; crossings ≥ 20° only):`)
  for (const lane of lanes) for (const res of RESOLUTIONS) console.log(`      ${`${lane.name}@${res}`.padEnd(14)} ${certStr(totals.get(`${lane.name}@${res}`)!)}`)
  console.log(`    pair-KIND flips: ${lanes.map((l) => `${l.name} ${kindFlipTotal.get(l.name) ?? 0}`).join(' · ')}`)
  console.log(`    moved cells by move vs the pair's uncertainty (worse / better / same than the lattice):`)
  for (const lane of lanes)
    for (const res of RESOLUTIONS) {
      const r = totals.get(`${lane.name}@${res}`)!
      console.log(`      ${`${lane.name}@${res}`.padEnd(14)} move > unc: ${r.overUnc.worse} / ${r.overUnc.better} / ${r.overUnc.same}    move ≤ unc: ${r.underUnc.worse} / ${r.underUnc.better} / ${r.underUnc.same}`)
    }
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(dump))
console.log()
