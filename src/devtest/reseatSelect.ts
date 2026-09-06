// RESEAT SELECT — evaluate candidate pair-selection rules OFFLINE against the answer sheet
// (issue #39), on the cells `reseatDiag --json` dumped. Nothing is re-traced: every cell
// carries each arm's ungated fits (line / circle, full arm and cap-skipped), the lattice
// vertex, and the authored crossing, so any rule that reads those can be scored here — the
// §28.1 "measure the estimators before designing the selector" step, made cheap enough to
// iterate on.
//
//   node --experimental-strip-types src/devtest/reseatSelect.ts <cells.json> [--lane NAME] [--min-cross 5]
//        [--k 1,1.5,2] [--t 30,45,60] [--verbose | --worse | --lost]
//
// The pass today: certify each arm (line if lineDev ≤ 0.8 over ≥ 8px, else circle if
// circDev ≤ 0.9 over ≥ 24px with 6 ≤ r ≤ 2500; the same again with the terminal segment
// dropped when it is ≤ 24px), then among the certified pairs that pass the SENSOR gates
// (vertex within NEAR_TOL 3 of both, intersection within MAX_SLIDE 12, transversal ≥ 5°)
// pick the one with the LONGEST summed arm and move if the slide is ≥ MIN_MOVE 1.5. What is
// evaluated here, per rule and raster, over every cell with an answer sheet: how many
// junctions move, how many land closer to the authored crossing than the lattice corner
// (better) and how many further (worse), and the mean placement error.
//
// The rules:
//   HEAD        the pass as shipped (re-derived from the fits; must reproduce the dump).
//   UNC·k       HEAD's pair, but the slide must exceed k × the pair's own UNCERTAINTY —
//               (devᵢ + devⱼ)/sin θ, the two residuals amplified by the pair's angle: how
//               far sub-px fit noise alone can move the intersection. A correction smaller
//               than its own error bar is noise, not a slide.
//   MIN-UNC     rank the qualifying pairs by uncertainty (smallest first) instead of by arm
//               length, then MIN_MOVE as today.
//   MIN-UNC·k   both.
//   THROUGH     HEAD's ranking, but a pair may not be the two halves of ONE boundary passing
//               through the junction: of the three arm pairs, the one with the smallest TURN
//               (180° minus the angle between the arms' away-from-vertex directions — 0 for a
//               boundary continuing straight through) is the through-boundary, and a re-seat
//               is the intersection of two DIFFERENT boundaries. brave-browser's witness pairs
//               the two sides of a 24° notch (turn 24°) while the seam that actually crosses
//               there was refused; the §10.4 driver's pair turns 168° (a needle) next to a
//               0° hypotenuse→chord continuation.
import { readFileSync } from 'node:fs'
import { intersectPrims, type ReseatPrim } from '../lib/trace/planarReseat.ts'
import type { Vec } from '../lib/path/types.ts'

const argv = process.argv.slice(2)
const file = argv.find((a) => !a.startsWith('--'))
if (!file) throw new Error('usage: reseatSelect <cells.json>')
const flag = (n: string): string | null => {
  const i = argv.indexOf(n)
  return i < 0 ? null : (argv[i + 1] ?? '')
}
const KS = (flag('--k') || '1,1.5,2').split(',').map(Number)
/** Crossings shallower than this (deg) are coincident authored arcs — no crossing POINT exists
 *  there and the along-boundary position is free — so they are not scored. */
const MIN_CROSS = Number(flag('--min-cross') ?? 5)
/** Third-arm transversality (deg) the THROUGH veto needs, one lane per value. */
const TS = (flag('--t') || '30,45,60').split(',').map(Number)
/** Which dumped lane to read as the baseline (the dump may carry counterfactual lanes too). */
const LANE = flag('--lane') || 'HEAD'
const VERBOSE = argv.includes('--verbose')
/** `--worse`: verbose listing restricted to cells HEAD moved AWAY from the crossing. */
const WORSE_ONLY = argv.includes('--worse')
/** `--lost`: cells where HEAD moved closer to the crossing but the THROUGH veto refuses its pair. */
const LOST_ONLY = argv.includes('--lost')
const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '—')

const NEAR_TOL = 3.0
const MAX_SLIDE = 12
const MIN_MOVE = 1.5
const MIN_ANGLE_SIN = Math.sin((5 * Math.PI) / 180)
const REF = 512

interface Fit {
  prim: ReseatPrim
  dev: number
}
interface ArmRec {
  kind: 'line' | 'circle' | null
  conf: number
  skipCap: boolean
  segLen0: number
  alt: { len: number; line: Fit | null; circle: Fit | null; noCap: { len: number; line: Fit | null; circle: Fit | null } | null } | null
}
interface CellRec {
  case: string
  lane: string
  res: number
  v: { x: number; y: number; tx: number; ty: number; move: number; reason: string; pair: [number, number] | null; arms: ArmRec[] }
  cross: { x: number; y: number; a: string; b: string; angleDeg: number } | null
  latErr: number
  err: number
}

const cells = (JSON.parse(readFileSync(file, 'utf8')) as CellRec[]).filter((c) => c.lane === LANE && c.cross && c.cross.angleDeg >= MIN_CROSS)

const primDist = (p: Vec, pr: ReseatPrim): number => {
  if (pr.kind === 'line') return Math.abs((p.x - pr.a!.x) * pr.d!.y - (p.y - pr.a!.y) * pr.d!.x)
  return Math.abs(Math.hypot(p.x - pr.c!.cx, p.y - pr.c!.cy) - pr.c!.r)
}
const tangent = (p: Vec, pr: ReseatPrim): Vec => {
  if (pr.kind === 'line') return pr.d!
  const dx = p.x - pr.c!.cx
  const dy = p.y - pr.c!.cy
  const l = Math.hypot(dx, dy) || 1
  return { x: -dy / l, y: dx / l }
}

/** HEAD's certified primitive for an arm, with the residual the gate read. */
function certified(a: ArmRec): { prim: ReseatPrim; dev: number } | null {
  if (!a.kind || !a.alt) return null
  const src = a.skipCap ? a.alt.noCap : a.alt
  const fit = a.kind === 'line' ? src?.line : src?.circle
  return fit ? { prim: { ...fit.prim, skipCap: a.skipCap }, dev: fit.dev } : null
}

interface Cand {
  i: number
  j: number
  /** Is this pair the smallest-turn pair of the junction (the through-boundary)? */
  through: boolean
  /** The smaller of the third arm's turns against the two pair members (deg) — how
   *  transversal the third arm is; Infinity with no third direction. */
  thirdTurn: number
  H: Vec
  hd: number
  conf: number
  unc: number
  sin: number
  /** Artwork-px error of H against the crossing. */
  err: number
}

/** Turn between two arms' away-from-vertex directions (see THROUGH). */
function turnOf(c: CellRec, i: number, j: number): number {
  const v = { x: c.v.x, y: c.v.y }
  const dir = (k: number): Vec | null => {
    const p = c.v.arms[k]?.alt?.line?.prim.a
    if (!p) return null
    const dx = p.x - v.x
    const dy = p.y - v.y
    const l = Math.hypot(dx, dy) || 1
    return { x: dx / l, y: dy / l }
  }
  const a = dir(i)
  const b = dir(j)
  if (!a || !b) return NaN
  return 180 - (Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y))) * 180) / Math.PI
}

/** Every pair that passes the pass's SENSOR gates, with its uncertainty and its error. */
function candidates(c: CellRec): Cand[] {
  const s = c.res / REF
  const v = { x: c.v.x, y: c.v.y }
  const prims = c.v.arms.map(certified)
  const out: Cand[] = []
  // Away-from-vertex direction of every arm (certified or not): toward its line fit's centroid.
  const dirs = c.v.arms.map((a) => {
    const p = a.alt?.line?.prim.a
    if (!p) return null
    const dx = p.x - v.x
    const dy = p.y - v.y
    const l = Math.hypot(dx, dy) || 1
    return { x: dx / l, y: dy / l }
  })
  const turn = (i: number, j: number): number => {
    const a = dirs[i]
    const b = dirs[j]
    if (!a || !b) return Infinity
    return 180 - (Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y))) * 180) / Math.PI
  }
  let minTurn = Infinity
  let minPair = ''
  for (let i = 0; i < dirs.length; i++)
    for (let j = i + 1; j < dirs.length; j++) {
      const t = turn(i, j)
      if (t < minTurn) {
        minTurn = t
        minPair = `${i},${j}`
      }
    }
  for (let i = 0; i < prims.length; i++) {
    const pi = prims[i]
    if (!pi || primDist(v, pi.prim) > NEAR_TOL) continue
    for (let j = i + 1; j < prims.length; j++) {
      const pj = prims[j]
      if (!pj || primDist(v, pj.prim) > NEAR_TOL) continue
      let H: Vec | null = null
      let hd = Infinity
      for (const cand of intersectPrims(pi.prim, pj.prim)) {
        const d = Math.hypot(cand.x - v.x, cand.y - v.y)
        if (d < hd) {
          hd = d
          H = cand
        }
      }
      if (!H || hd > MAX_SLIDE) continue
      if (pi.prim.kind === 'circle' && hd > 0.5 * pi.prim.c!.r) continue
      if (pj.prim.kind === 'circle' && hd > 0.5 * pj.prim.c!.r) continue
      const t1 = tangent(H, pi.prim)
      const t2 = tangent(H, pj.prim)
      const sin = Math.abs(t1.x * t2.y - t1.y * t2.x)
      if (sin < MIN_ANGLE_SIN) continue
      const k = [0, 1, 2].find((x) => x !== i && x !== j)
      out.push({
        i,
        j,
        through: dirs.length === 3 && minPair === `${i},${j}`,
        thirdTurn: k === undefined ? Infinity : Math.min(turn(i, k), turn(j, k)),
        H,
        hd,
        conf: pi.prim.conf + pj.prim.conf,
        unc: (pi.dev + pj.dev) / sin,
        sin,
        err: Math.hypot(H.x / s - c.cross!.x, H.y / s - c.cross!.y),
      })
    }
  }
  return out
}

interface Rule {
  name: string
  pick: (cands: Cand[]) => Cand | null
  /** Move when true. */
  go: (c: Cand) => boolean
}
const byConf = (cands: Cand[]): Cand | null => cands.reduce<Cand | null>((b, c) => (!b || c.conf > b.conf ? c : b), null)
const byUnc = (cands: Cand[]): Cand | null => cands.reduce<Cand | null>((b, c) => (!b || c.unc < b.unc ? c : b), null)
const rules: Rule[] = [{ name: 'HEAD', pick: byConf, go: (c) => c.hd >= MIN_MOVE }]
for (const k of KS) rules.push({ name: `UNC·${k}`, pick: byConf, go: (c) => c.hd >= Math.max(MIN_MOVE, k * c.unc) })
rules.push({ name: 'THROUGH', pick: (cands) => byConf(cands.filter((c) => !c.through)), go: (c) => c.hd >= MIN_MOVE })
for (const t of TS) rules.push({ name: `T-VETO·${t}`, pick: (cands) => byConf(cands.filter((c) => !(c.through && c.thirdTurn >= t))), go: (c) => c.hd >= MIN_MOVE })
rules.push({ name: 'MIN-UNC', pick: byUnc, go: (c) => c.hd >= MIN_MOVE })
for (const k of KS) rules.push({ name: `MIN-UNC·${k}`, pick: byUnc, go: (c) => c.hd >= Math.max(MIN_MOVE, k * c.unc) })

interface Tally {
  n: number
  moved: number
  worse: number
  better: number
  same: number
  placed: number[]
  movedErr: number[]
}
const tally = (): Tally => ({ n: 0, moved: 0, worse: 0, better: 0, same: 0, placed: [], movedErr: [] })
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const max = (xs: number[]): number => (xs.length ? Math.max(...xs) : NaN)

const resList = [...new Set(cells.map((c) => c.res))].sort((a, b) => a - b)
const table = new Map<string, Tally>()
const key = (rule: string, res: number): string => `${rule}@${res}`
let reproduced = 0
let mismatched = 0
const disagreements: string[] = []

for (const c of cells) {
  const cands = candidates(c)
  const head = byConf(cands)
  // Does the re-derivation reproduce the dump? (It must — the fits are the same code.)
  const headMoved = head != null && head.hd >= MIN_MOVE
  const dumpMoved = c.v.reason === 'moved'
  if (headMoved === dumpMoved && (!headMoved || Math.hypot(head!.H.x - c.v.tx, head!.H.y - c.v.ty) < 0.05)) reproduced++
  else {
    mismatched++
    if (disagreements.length < 8) disagreements.push(`${c.case}@${c.res} (${f(c.v.x, 0)},${f(c.v.y, 0)}): dump ${c.v.reason}${dumpMoved ? ` → (${f(c.v.tx, 1)},${f(c.v.ty, 1)})` : ''}, re-derived ${head ? `${headMoved ? 'moved' : 'below MIN_MOVE'} → (${f(head.H.x, 1)},${f(head.H.y, 1)}) hd ${f(head.hd)}` : 'no pair'}`)
  }
  for (const r of rules) {
    const k = key(r.name, c.res)
    if (!table.has(k)) table.set(k, tally())
    const t = table.get(k)!
    t.n++
    const pick = r.pick(cands)
    const go = pick != null && r.go(pick)
    const placed = go ? pick!.err : c.latErr
    t.placed.push(placed)
    if (go) {
      t.moved++
      t.movedErr.push(pick!.err)
      if (pick!.err > c.latErr + 0.1) t.worse++
      else if (pick!.err < c.latErr - 0.1) t.better++
      else t.same++
    }
  }
  const headWorse = head != null && head.hd >= MIN_MOVE && head.err > c.latErr + 0.1
  const headLost = head != null && head.hd >= MIN_MOVE && head.err < c.latErr - 0.1 && head.through
  if ((VERBOSE || (WORSE_ONLY && headWorse) || (LOST_ONLY && headLost)) && cands.length) {
    console.log(`${c.case}@${c.res} (${f(c.v.x, 0)},${f(c.v.y, 0)}) ${c.cross!.a} × ${c.cross!.b} at ${f(c.cross!.angleDeg, 0)}°  lat ${f(c.latErr)}`)
    for (const cd of cands.sort((a, b) => b.conf - a.conf))
      console.log(`    pair ${cd.i}${c.v.arms[cd.i].kind === 'line' ? 'L' : 'C'}×${cd.j}${c.v.arms[cd.j].kind === 'line' ? 'L' : 'C'}  conf ${f(cd.conf, 0).padStart(4)}  slide ${f(cd.hd).padStart(5)}  unc ${f(cd.unc).padStart(5)}  @${f((Math.asin(Math.min(1, cd.sin)) * 180) / Math.PI, 0)}°  err ${f(cd.err)}${cd.through ? '  [through]' : ''}${cd === head ? '  ← HEAD' : ''}`)
    const s = c.res / REF
    console.log(`    turns: ${[[0, 1], [0, 2], [1, 2]].map(([i, j]) => `${i}-${j} ${f(turnOf(c, i, j), 0)}°`).join('  ')}`)
    for (let i = 0; i < c.v.arms.length; i++) {
      const a = c.v.arms[i]
      const al = a.alt
      const fit = (x: Fit | null): string => (x ? `dev ${f(x.dev)}${x.prim.kind === 'circle' ? ` r${f(x.prim.c!.r / s, 0)}` : ''}` : '—')
      console.log(`    arm ${i}: ${a.kind ?? 'refused'}${a.skipCap ? ' (cap skipped)' : ''} len ${f(a.conf / s, 0)}art cap ${f(a.segLen0 / s, 1)}art${al ? ` | full: L ${fit(al.line)} · C ${fit(al.circle)}${al.noCap ? ` | no-cap (${f(al.noCap.len / s, 0)}art): L ${fit(al.noCap.line)} · C ${fit(al.noCap.circle)}` : ''}` : ''}`)
    }
  }
}

console.log(`\n${cells.length} HEAD cells with an answer sheet; re-derivation reproduces the dump on ${reproduced}, differs on ${mismatched}`)
for (const d of disagreements) console.log(`    ${d}`)
console.log(`\n${'rule@res'.padEnd(16)} ${'cells'.padStart(5)}  ${'moved'.padStart(5)}  ${'worse'.padStart(5)}  ${'better'.padStart(6)}  ${'same'.padStart(4)}   ${'moved err mean/max'.padStart(18)}   ${'placed mean'.padStart(11)}`)
for (const r of rules) {
  for (const res of resList) {
    const t = table.get(key(r.name, res))
    if (!t) continue
    console.log(
      `${key(r.name, res).padEnd(16)} ${String(t.n).padStart(5)}  ${String(t.moved).padStart(5)}  ${String(t.worse).padStart(5)}  ${String(t.better).padStart(6)}  ${String(t.same).padStart(4)}   ${`${f(mean(t.movedErr))} / ${f(max(t.movedErr))}`.padStart(18)}   ${f(mean(t.placed), 3).padStart(11)}`,
    )
  }
  const all = tally()
  for (const res of resList) {
    const t = table.get(key(r.name, res))
    if (!t) continue
    all.n += t.n
    all.moved += t.moved
    all.worse += t.worse
    all.better += t.better
    all.same += t.same
    all.placed.push(...t.placed)
    all.movedErr.push(...t.movedErr)
  }
  console.log(
    `${`${r.name}@all`.padEnd(16)} ${String(all.n).padStart(5)}  ${String(all.moved).padStart(5)}  ${String(all.worse).padStart(5)}  ${String(all.better).padStart(6)}  ${String(all.same).padStart(4)}   ${`${f(mean(all.movedErr))} / ${f(max(all.movedErr))}`.padStart(18)}   ${f(mean(all.placed), 3).padStart(11)}`,
  )
}
console.log()
