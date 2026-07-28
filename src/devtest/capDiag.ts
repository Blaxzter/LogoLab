// bar-caps cap-corner diagnosis (§0 #6b) — WHERE do the cap corners die?
//
//   node src/devtest/capDiag.ts
//
// The gearDiag.ts instrument re-pointed at the bar-caps rack: traces bar-caps @512
// exactly as the truth gate does, then instruments the corner pipeline on EVERY bar
// loop (the rack has 12 ink loops — 10 graded bars + 2 below the grading floor):
//   Stage A  detectCorners (raw ±win macro-turn set, presmooth pin set)
//   Stage B  detectLoopCorners (clustered apexes + mergeDist fuse — the fit's breakpoints)
//   Stage C  fitCorneredLoop output (sub-pixel snapped corners, arcs fitted at ε)
//   FINAL    the real traceImage doc (fit + beautify + reseat), scored the scorer's way.
// Plus the CAP-SPECIFIC anatomy §10.2/§10.6 predict: for each bar end (a pair of GT
// corners joined by the short side), whether its two shoulders sit in ONE contiguous
// sub-threshold run (⇒ one apex ⇒ pointed/domed cap — the §0 #6b mechanism), and the
// per-vertex turn / perp-deviation profile across that run (the twin-peak evidence a
// cap/tip discriminator would have to find).
//
// PURELY DIAGNOSTIC: no src/lib/trace/ code is modified; private scorer/pipeline pieces
// are re-implemented here verbatim (same as gearDiag.ts).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS, healColorSpikes } from '../lib/trace/index.ts'
import { segmentFlatPalette } from '../lib/trace/paletteSegment.ts'
import { buildPlanarNetwork } from '../lib/trace/planarNetwork.ts'
import {
  detectCorners,
  detectLoopCorners,
  fitCorneredLoop,
  fitLoopEdge,
  presmooth,
  DEFAULT_PLANAR_FIT,
  FLAT_LINE_COST,
  type PlanarFitOptions,
} from '../lib/trace/planarFit.ts'
import { parseGroundTruth, toRasterSpace } from './svgGround.ts'
import type { PathNode, SubPath, Vec } from '../lib/path/types'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RES = 512
const CASE_SVG = 'public/examples/edge-cases/bar-caps.svg'

// --- scorer constants (geomScore.ts, verbatim) ------------------------------
const CORNER_MIN_TURN = Math.PI / 3
const CORNER_MATCH_R = 2.5
const CORNER_MIN_EDGE = 7
const VIS_PROBE = 2
const VIS_SAME = 2
const DETECT_R = 3

interface Corner { x: number; y: number; itx: number; ity: number; otx: number; oty: number }

function pickCtrl(at: { x: number; y: number }, ...cands: ({ x: number; y: number } | null | undefined)[]): { x: number; y: number } {
  for (const c of cands) if (c && Math.hypot(c.x - at.x, c.y - at.y) >= 1e-6) return c
  return at
}

/** geomScore.sharpCorners re-implementation (tangent-based, minEdge on chords). */
function sharpCorners(sets: SubPath[][], minEdge = 0): Corner[] {
  const cosMax = Math.cos(CORNER_MIN_TURN)
  const out: Corner[] = []
  for (const set of sets) {
    for (const sp of set) {
      const nodes = sp.nodes
      const n = nodes.length
      if (n < 3) continue
      const closed = sp.closed !== false
      const lo = closed ? 0 : 1
      const hi = closed ? n : n - 1
      for (let i = lo; i < hi; i++) {
        const cur = nodes[i]
        const prev = nodes[(i - 1 + n) % n]
        const next = nodes[(i + 1) % n]
        const li = Math.hypot(cur.x - prev.x, cur.y - prev.y)
        const lo2 = Math.hypot(next.x - cur.x, next.y - cur.y)
        if (li < 1e-6 || lo2 < 1e-6) continue
        if (li < minEdge || lo2 < minEdge) continue
        const tin = pickCtrl(cur, cur.hIn, prev.hOut, prev)
        const tout = pickCtrl(cur, cur.hOut, next.hIn, next)
        let ix = cur.x - tin.x, iy = cur.y - tin.y
        let ox = tout.x - cur.x, oy = tout.y - cur.y
        const ln = Math.hypot(ix, iy)
        const lt = Math.hypot(ox, oy)
        if (ln < 1e-6 || lt < 1e-6) continue
        ix /= ln; iy /= ln; ox /= lt; oy /= lt
        if (ix * ox + iy * oy <= cosMax) out.push({ x: cur.x, y: cur.y, itx: ix, ity: iy, otx: ox, oty: oy })
      }
    }
  }
  return out
}

function makeVisibleAt(raster: { width: number; height: number; data: Uint8ClampedArray }): (q: { x: number; y: number; tx: number; ty: number }) => boolean {
  const { width, height, data } = raster
  const at = (x: number, y: number): number => {
    const xi = Math.round(x), yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return -1
    const o = (yi * width + xi) * 4
    return (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]
  }
  const same = (a: number, b: number): boolean =>
    Math.abs(((a >> 16) & 255) - ((b >> 16) & 255)) <= VIS_SAME &&
    Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) <= VIS_SAME &&
    Math.abs((a & 255) - (b & 255)) <= VIS_SAME
  return (q) => {
    const a = at(q.x - VIS_PROBE * q.ty, q.y + VIS_PROBE * q.tx)
    const b = at(q.x + VIS_PROBE * q.ty, q.y - VIS_PROBE * q.tx)
    const c = at(q.x, q.y)
    if (a < 0 || b < 0 || c < 0) return true
    return !same(a, b) || !same(c, a) || !same(c, b)
  }
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y)

function nearest(p: { x: number; y: number }, targets: { x: number; y: number }[]): number {
  let best = Infinity
  for (const t of targets) {
    const d = dist(p, t)
    if (d < best) best = d
  }
  return best
}

const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '∞')
const pct = (a: number, b: number): string => `${a}/${b} (${((100 * a) / Math.max(1, b)).toFixed(1)}%)`

// ---------------------------------------------------------------------------
// 1. rasterize + ground truth (the gate's exact path)
// ---------------------------------------------------------------------------
const svg = readFileSync(join(root, CASE_SVG), 'utf8')
const img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
const shapes = toRasterSpace(parseGroundTruth(svg), img.width)
const visible = makeVisibleAt(img)

// Per-bar metadata from the GT polygon itself: width = short side, angle = long-side
// orientation (0° = axis-aligned horizontal bar; 90° = vertical).
interface BarInfo {
  id: number
  width: number
  len: number
  angleDeg: number
  nodes: Vec[]
  /** The two cap corner-index pairs (adjacent nodes joined by a SHORT side). */
  caps: [number, number][]
  graded: boolean
}
const bars: BarInfo[] = []
let barId = 0
for (const s of shapes) {
  if (s.tag !== 'polygon') continue
  const nodes = s.subPaths[0].nodes.map((n) => ({ x: n.x, y: n.y }))
  if (nodes.length !== 4) continue
  const side = (i: number): number => dist(nodes[i], nodes[(i + 1) % 4])
  const sides = [side(0), side(1), side(2), side(3)]
  const width = Math.min(...sides)
  const len = Math.max(...sides)
  const li = sides.indexOf(len)
  const a = nodes[li], b = nodes[(li + 1) % 4]
  let angleDeg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
  angleDeg = ((angleDeg % 180) + 180) % 180
  if (angleDeg > 90) angleDeg = 180 - angleDeg
  const caps: [number, number][] = []
  for (let i = 0; i < 4; i++) if (Math.abs(side(i) - width) < 0.5) caps.push([i, (i + 1) % 4])
  bars.push({ id: barId++, width, len, angleDeg, nodes, caps, graded: width >= CORNER_MIN_EDGE })
}

interface GtCorner extends Corner { bar: BarInfo | null; kind: 'canvas' | 'cap' }
const gtCorners: GtCorner[] = []
for (const s of shapes) {
  const cs = sharpCorners([s.subPaths], CORNER_MIN_EDGE).filter(
    (c) => visible({ x: c.x, y: c.y, tx: c.itx, ty: c.ity }) || visible({ x: c.x, y: c.y, tx: c.otx, ty: c.oty }),
  )
  for (const c of cs) {
    const bar = s.tag === 'polygon' ? bars.find((b) => b.nodes.some((n) => dist(n, c) < 0.5)) ?? null : null
    gtCorners.push({ ...c, bar, kind: bar ? 'cap' : 'canvas' })
  }
}
const capGt = gtCorners.filter((c) => c.kind === 'cap')
const canvasGt = gtCorners.filter((c) => c.kind === 'canvas')
console.log(`bars parsed: ${bars.length} (graded ${bars.filter((b) => b.graded).length})`)
for (const b of bars)
  console.log(
    `  bar${b.id}: width ${f(b.width, 1)}px  len ${f(b.len, 0)}  angle ${f(b.angleDeg, 1)}°  ${b.graded ? 'GRADED' : 'below floor'}`,
  )
console.log(`GT corners (scorer's reader, minEdge=${CORNER_MIN_EDGE}, visible): total ${gtCorners.length} = ${capGt.length} cap + ${canvasGt.length} canvas`)

// ---------------------------------------------------------------------------
// 2. reproduce the pipeline's final label map (traceImage's flat path, verbatim)
// ---------------------------------------------------------------------------
const paletteOpts = {
  maxColors: 16,
  minShare: Math.max(0.0006, 0.006 - 0 * 0.0052 + 0.25 * 0.004),
  modePasses: 2,
  minRegionArea: Math.max(24, Math.round(0.25 * 0.25 * 800)),
}
const fp = segmentFlatPalette(img as unknown as { width: number; height: number; data: Uint8ClampedArray }, paletteOpts, undefined)
console.log(`\nsegmentFlatPalette: ${fp.palette.length} colours, flatCoverage ${f(fp.flatCoverage, 3)}, dominantColors ${fp.dominantColors}`)
const labels = healColorSpikes(fp.labels, img.data as unknown as Uint8ClampedArray, img.width, img.height, fp.palette)

let inkLabel = 0
{
  let best = Infinity
  fp.palette.forEach((c, i) => {
    const d = (c.r - 26) ** 2 + (c.g - 26) ** 2 + (c.b - 34) ** 2
    if (d < best) { best = d; inkLabel = i }
  })
}

const net = buildPlanarNetwork(labels, img.width, img.height)
const inkLoops = net.edges.filter((e) => e.closed && (e.left === inkLabel || e.right === inkLabel))
const inkOpen = net.edges.filter((e) => !e.closed && (e.left === inkLabel || e.right === inkLabel))
console.log(`planar network: ${net.edges.length} edges, ${net.junctions.length} junctions; ink label ${inkLabel} → ${inkLoops.length} closed loop(s) + ${inkOpen.length} open edge(s)`)

const fitOpts: PlanarFitOptions = { ...DEFAULT_PLANAR_FIT, lineCost: FLAT_LINE_COST, smoothPasses: 2 }

// Associate each bar with its nearest ink loop (bars are well separated).
function loopForBar(b: BarInfo): Vec[] | null {
  let bestLoop: Vec[] | null = null
  let bestD = Infinity
  for (const e of inkLoops) {
    const d = nearest(b.nodes[0], e.pts)
    if (d < bestD) { bestD = d; bestLoop = e.pts }
  }
  return bestD < 8 ? bestLoop : null
}

// ---------------------------------------------------------------------------
// 3. stages A / B / C per bar loop
// ---------------------------------------------------------------------------
interface LoopStages { rawPts: Vec[]; apexPts: Vec[]; apexIdx: number[]; pts: Vec[]; fitCornerPts: Corner[]; fitNodes: PathNode[] }
const stagesByBar = new Map<number, LoopStages>()
for (const b of bars) {
  const pts = loopForBar(b)
  if (!pts) { console.log(`  !! bar${b.id} has no matching ink loop`); continue }
  const rawSet = detectCorners(pts, fitOpts.cornerTurnDeg, true)
  const apexIdx = detectLoopCorners(pts, fitOpts.cornerTurnDeg)
  let fitNodes: PathNode[]
  if (apexIdx.length >= 2) fitNodes = fitCorneredLoop(pts, apexIdx, fitOpts)
  else fitNodes = fitLoopEdge(presmooth(pts, fitOpts.smoothPasses, false, rawSet), fitOpts)
  stagesByBar.set(b.id, {
    pts,
    rawPts: [...rawSet].map((i) => pts[i]),
    apexIdx,
    apexPts: apexIdx.map((i) => pts[i]),
    fitNodes,
    fitCornerPts: sharpCorners([[{ nodes: fitNodes, closed: true }]]),
  })
}

// FINAL — the real full pipeline, scorer-matched.
const doc = await traceImage(img as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false })
const docSets: SubPath[][] = []
for (const item of doc.items) {
  if (item.kind !== 'path' || item.visible === false) continue
  docSets.push(item.subPaths)
}
const docCorners = sharpCorners(docSets)
const recoveredAll = gtCorners.filter((g) => nearest(g, docCorners) <= CORNER_MATCH_R)
const floorLost = Math.floor(gtCorners.length * 0.2)
console.log(`FINAL doc: ${docCorners.length} sharp corners; scorer match: ${pct(recoveredAll.length, gtCorners.length)}  [gate needs ≥80% ⇒ RED iff lost > ${floorLost}]`)

// ---------------------------------------------------------------------------
// 4. per-corner attribution + histogram + per-bar table
// ---------------------------------------------------------------------------
interface Verdict { g: GtCorner; dA: number; dB: number; dC: number; dF: number; fate: string }
const verdicts: Verdict[] = gtCorners.map((g) => {
  const st = g.bar ? stagesByBar.get(g.bar.id) : undefined
  const dA = st ? nearest(g, st.rawPts) : NaN
  const dB = st ? nearest(g, st.apexPts) : NaN
  const dC = st ? nearest(g, st.fitCornerPts) : NaN
  const dF = nearest(g, docCorners)
  let fate: string
  if (dF <= CORNER_MATCH_R) fate = 'RECOVERED'
  else if (!st) fate = 'lost:canvas'
  else if (dA > DETECT_R) fate = 'A:never-detected'
  else if (dB > DETECT_R) fate = 'B:fused/clustered-away'
  else if (dC > CORNER_MATCH_R) fate = 'C:fit-melted/misplaced'
  else fate = 'D:post-fit (beautify/reseat)'
  return { g, dA, dB, dC, dF, fate }
})

const hist = new Map<string, number>()
for (const v of verdicts) hist.set(v.fate, (hist.get(v.fate) ?? 0) + 1)
console.log(`\n=== HISTOGRAM (all ${gtCorners.length} GT corners) ===`)
for (const [fate, n] of [...hist.entries()].sort()) console.log(`  ${fate.padEnd(28)} ${n}`)

console.log('\n=== PER-BAR (graded corners: A ≤3px | B ≤3px | C ≤2.5px | FINAL ≤2.5px) ===')
console.log('  bar  width  angle | n |  A  B  C  F')
for (const b of bars.filter((x) => x.graded)) {
  const vs = verdicts.filter((v) => v.g.bar?.id === b.id)
  const cnt = (sel: (v: Verdict) => boolean): number => vs.filter(sel).length
  console.log(
    `  ${String(b.id).padStart(3)}  ${f(b.width, 1).padStart(5)}  ${f(b.angleDeg, 0).padStart(4)}° | ${vs.length} |  ${cnt((v) => v.dA <= DETECT_R)}  ${cnt((v) => v.dB <= DETECT_R)}  ${cnt((v) => v.dC <= CORNER_MATCH_R)}  ${cnt((v) => v.dF <= CORNER_MATCH_R)}`,
  )
}

console.log('\nlost corners detail (x,y width angle | dA dB dC dF):')
for (const v of verdicts.filter((x) => x.fate !== 'RECOVERED')) {
  const b = v.g.bar
  console.log(
    `  (${f(v.g.x, 1)},${f(v.g.y, 1)}) w${b ? f(b.width, 1) : '—'} ${b ? f(b.angleDeg, 0) : '—'}° | A ${f(v.dA, 1)}  B ${f(v.dB, 1)}  C ${f(v.dC, 1)}  F ${f(v.dF, 1)}  → ${v.fate}`,
  )
}

// ---------------------------------------------------------------------------
// 5. CAP ANATOMY — the §0 #6b mechanism, measured per cap
// ---------------------------------------------------------------------------
// For each cap (pair of GT corners joined by the short side): find the contiguous
// sub-threshold run(s) of the ±4 window test near the cap. ONE run containing both
// shoulders ⇒ the cluster the row says must be SPLIT. Print the run's turn profile
// so the twin-peak evidence (or its absence) is measured, not assumed.
const WIN = 4
console.log('\n=== CAP ANATOMY (per cap: cluster structure + turn profile across the run) ===')
for (const b of bars) {
  const st = stagesByBar.get(b.id)
  if (!st) continue
  const pts = st.pts
  const n = pts.length
  const wrap = (i: number): number => ((i % n) + n) % n
  const thr = Math.cos((fitOpts.cornerTurnDeg * Math.PI) / 180)
  const cosArr = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = pts[wrap(i - WIN)], m = pts[i], c = pts[wrap(i + WIN)]
    const inD = { x: m.x - a.x, y: m.y - a.y }
    const outD = { x: c.x - m.x, y: c.y - m.y }
    const li = Math.hypot(inD.x, inD.y), lo = Math.hypot(outD.x, outD.y)
    cosArr[i] = li < 1e-9 || lo < 1e-9 ? 1 : (inD.x * outD.x + inD.y * outD.y) / (li * lo)
  }
  // run id per vertex (contiguous cos<thr), cyclic
  const runId = new Int32Array(n).fill(-1)
  let nRuns = 0
  for (let s = 0; s < n; s++) {
    if (cosArr[s] >= thr || runId[s] >= 0) continue
    let i = s
    while (cosArr[wrap(i - 1)] < thr && wrap(i - 1) !== s) i = wrap(i - 1) // rewind to run start
    if (runId[wrap(i)] >= 0) continue
    const id = nRuns++
    let j = i
    while (cosArr[wrap(j)] < thr && runId[wrap(j)] < 0) {
      runId[wrap(j)] = id
      j = wrap(j + 1)
    }
  }
  const nearestIdx = (g: { x: number; y: number }): number => {
    let bi = 0, bd = Infinity
    for (let i = 0; i < n; i++) {
      const d = dist(g, pts[i])
      if (d < bd) { bd = d; bi = i }
    }
    return bi
  }
  for (const [ci, cj] of b.caps) {
    const g1 = b.nodes[ci], g2 = b.nodes[cj]
    const i1 = nearestIdx(g1), i2 = nearestIdx(g2)
    const r1 = runId[i1] >= 0 ? runId[i1] : runId[wrap(i1 + 1)] >= 0 ? runId[wrap(i1 + 1)] : runId[wrap(i1 - 1)]
    const r2 = runId[i2] >= 0 ? runId[i2] : runId[wrap(i2 + 1)] >= 0 ? runId[wrap(i2 + 1)] : runId[wrap(i2 - 1)]
    const fused = r1 >= 0 && r1 === r2
    // walk the run containing i1 (if any) and print its profile
    let profile = ''
    let runLen = 0
    let apexInRun = ''
    if (r1 >= 0) {
      let s = i1
      while (runId[wrap(s - 1)] === r1) s = wrap(s - 1)
      const turns: string[] = []
      let i = s
      while (runId[wrap(i)] === r1) {
        const t = (Math.acos(Math.max(-1, Math.min(1, cosArr[wrap(i)]))) * 180) / Math.PI
        const isApex = st.apexIdx.includes(wrap(i))
        turns.push(`${isApex ? '*' : ''}${t.toFixed(0)}`)
        if (isApex) apexInRun += ` apex@${wrap(i)}(${f(pts[wrap(i)].x, 1)},${f(pts[wrap(i)].y, 1)})`
        runLen++
        i = wrap(i + 1)
      }
      profile = turns.join(' ')
    }
    const apexNear = nearest({ x: (g1.x + g2.x) / 2, y: (g1.y + g2.y) / 2 }, st.apexPts)
    // EVERY apex within 10px of the cap (not just the first run's) — the 15°
    // failure emits a spurious mid-cap apex whose run is separate.
    const capMid = { x: (g1.x + g2.x) / 2, y: (g1.y + g2.y) / 2 }
    const allNear = st.apexIdx
      .filter((i) => dist(pts[i], capMid) <= 10)
      .map((i) => `@${i}(${f(pts[i].x, 0)},${f(pts[i].y, 0)})`)
      .join(' ')
    console.log(
      `  bar${b.id} w${f(b.width, 1)} ${f(b.angleDeg, 0)}° cap (${f(g1.x, 0)},${f(g1.y, 0)})–(${f(g2.x, 0)},${f(g2.y, 0)}): ` +
        `${fused ? 'ONE fused run' : r1 < 0 || r2 < 0 ? `NO run at a shoulder (r1 ${r1} r2 ${r2})` : 'two runs'}` +
        ` len ${runLen}; apex→capMid ${f(apexNear, 1)}px; apexes≤10px: ${allNear || 'NONE'}`,
    )
    if (profile) console.log(`      turn° per vertex: ${profile}`)
  }
}

// ---------------------------------------------------------------------------
// 6. snapped-corner positions per bar end (what the fit actually emitted)
// ---------------------------------------------------------------------------
console.log('\n=== FITTED SHARP NODES near each graded cap (scorer-visible geometry) ===')
for (const b of bars.filter((x) => x.graded)) {
  const st = stagesByBar.get(b.id)
  if (!st) continue
  for (const [ci, cj] of b.caps) {
    const g1 = b.nodes[ci], g2 = b.nodes[cj]
    const near = st.fitCornerPts
      .map((c) => ({ c, d: Math.min(dist(c, g1), dist(c, g2)) }))
      .filter((x) => x.d < 8)
      .sort((a, b2) => a.d - b2.d)
    const desc = near.length === 0 ? 'NONE <8px' : near.map((x) => `(${f(x.c.x, 1)},${f(x.c.y, 1)}) d${f(x.d, 1)}`).join('  ')
    // ALL fitted nodes near the cap with their tangent turn — a corner "present but
    // blunt" (turn diluted below 60° by a spurious neighbour node) shows up here.
    const capMid = { x: (g1.x + g2.x) / 2, y: (g1.y + g2.y) / 2 }
    const nn = st.fitNodes.length
    const nodesNear: string[] = []
    for (let i = 0; i < nn; i++) {
      const cur = st.fitNodes[i]
      if (dist(cur, capMid) > 9) continue
      const prev = st.fitNodes[(i - 1 + nn) % nn]
      const next = st.fitNodes[(i + 1) % nn]
      const tin = pickCtrl(cur, cur.hIn, prev.hOut, prev)
      const tout = pickCtrl(cur, cur.hOut, next.hIn, next)
      let ix = cur.x - tin.x, iy = cur.y - tin.y
      let ox = tout.x - cur.x, oy = tout.y - cur.y
      const ln = Math.hypot(ix, iy) || 1, lt = Math.hypot(ox, oy) || 1
      ix /= ln; iy /= ln; ox /= lt; oy /= lt
      const turn = (Math.acos(Math.max(-1, Math.min(1, ix * ox + iy * oy))) * 180) / Math.PI
      nodesNear.push(`(${f(cur.x, 1)},${f(cur.y, 1)})${f(turn, 0)}°`)
    }
    console.log(`  bar${b.id} w${f(b.width, 1)} ${f(b.angleDeg, 0)}° cap (${f(g1.x, 0)},${f(g1.y, 0)})–(${f(g2.x, 0)},${f(g2.y, 0)}): ${desc}`)
    console.log(`      fit nodes ≤9px: ${nodesNear.join('  ') || 'NONE'}`)
  }
}
