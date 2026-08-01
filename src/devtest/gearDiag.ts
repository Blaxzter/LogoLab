// gear-teeth corner-loss diagnosis (§10.5 / §0 #12) — WHERE do the 39 corners die?
//
//   node src/devtest/gearDiag.ts
//
// Traces gear-teeth @512 exactly as the truth gate does, then instruments the corner
// pipeline on the gear's dense staircase loop:
//   Stage A  detectCorners (raw ±win macro-turn set, presmooth pin set)
//   Stage B  detectLoopCorners (clustered apexes + mergeDist fuse — the fit's breakpoints)
//   Stage C  fitCorneredLoop output (sub-pixel snapped corners, arcs fitted at ε)
//   FINAL    the real traceImage doc (fit + beautify + weld), scored the scorer's way.
// For each authored GT corner (the scorer's own reader + visibility filter) we record the
// nearest evidence at each stage and attribute every lost corner to the stage that killed
// it. Then a pure-detector sensitivity sweep over win × mergeDist.
//
// PURELY DIAGNOSTIC: no src/lib/trace/ code is modified; private scorer/pipeline pieces
// (sharpCorners, matchCorners, makeVisibleAt, paletteOptionsFor) are re-implemented here
// verbatim rather than exported.

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
import { cubicAt, segmentControls, segmentCount } from '../lib/path/geometry.ts'
import { parseGroundTruth, toRasterSpace } from './svgGround.ts'
import type { PathNode, SubPath, Vec } from '../lib/path/types'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RES = 512
const CASE_SVG = 'public/examples/edge-cases/gear-teeth.svg'

// --- scorer constants (geomScore.ts, verbatim) ------------------------------
const CORNER_MIN_TURN = Math.PI / 3
const CORNER_MATCH_R = 2.5
const CORNER_MIN_EDGE = 7
const VIS_PROBE = 2
const VIS_SAME = 2
/** Stage A/B match radius: a detected staircase vertex is "this corner's evidence"
 *  when within 3px (lattice corner vs authored apex can differ ~1px + AA shift). */
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

/** Nearest distance from p to any of `targets` (∞ if empty). */
function nearest(p: { x: number; y: number }, targets: { x: number; y: number }[]): number {
  let best = Infinity
  for (const t of targets) {
    const d = dist(p, t)
    if (d < best) best = d
  }
  return best
}

function flattenNodes(nodes: PathNode[]): Vec[] {
  if (nodes.length < 2) return nodes.map((n) => ({ x: n.x, y: n.y }))
  const sp = { nodes, closed: true }
  const pts: Vec[] = []
  const count = segmentCount(sp)
  for (let seg = 0; seg < count; seg++) {
    const { p0, c1, c2, p3 } = segmentControls(sp, seg)
    for (let k = 0; k < 6; k++) pts.push(cubicAt(p0, c1, c2, p3, k / 6))
  }
  return pts
}

function polySignedArea(poly: { x: number; y: number }[]): number {
  let a = 0
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
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

// GT corners per shape (rect / circle / polygon), scorer rules: minEdge 7 + visibility.
interface GtCorner extends Corner { shape: string; kind: 'canvas' | 'tip' | 'root' }
const GEAR_C = { x: 156, y: 344 } // authored (78,172) ×2
const gtCorners: GtCorner[] = []
for (const s of shapes) {
  const cs = sharpCorners([s.subPaths], CORNER_MIN_EDGE).filter(
    (c) => visible({ x: c.x, y: c.y, tx: c.itx, ty: c.ity }) || visible({ x: c.x, y: c.y, tx: c.otx, ty: c.oty }),
  )
  for (const c of cs) {
    const r = dist(c, GEAR_C)
    const kind: GtCorner['kind'] = s.tag === 'polygon' ? (Math.abs(r - 112 / 2) < 6 ? 'tip' : 'root') : 'canvas'
    gtCorners.push({ ...c, shape: s.tag, kind })
  }
}
const gearGt = gtCorners.filter((c) => c.shape === 'polygon')
const canvasGt = gtCorners.filter((c) => c.shape !== 'polygon')
console.log(`GT corners (scorer's reader, minEdge=${CORNER_MIN_EDGE}, visible): total ${gtCorners.length}`)
console.log(`  gear polygon: ${gearGt.length} (tips ${gearGt.filter((c) => c.kind === 'tip').length}, roots ${gearGt.filter((c) => c.kind === 'root').length}), canvas rect: ${canvasGt.length}`)

// Authored chord lengths (feature size at the teeth) from consecutive gear GT vertices.
{
  const poly = shapes.find((s) => s.tag === 'polygon')!.subPaths[0].nodes
  const chords: number[] = []
  for (let i = 0; i < poly.length; i++) chords.push(dist(poly[i], poly[(i + 1) % poly.length]))
  chords.sort((a, b) => a - b)
  console.log(`  gear chords @${RES}: min ${f(chords[0])} median ${f(chords[chords.length >> 1])} max ${f(chords[chords.length - 1])} px  (disc r=124, gear rTip=56 rRoot=44, tooth height 12)`)
}

// AUTHORED turn angle at each GT corner (from the scorer's own tangents) — how the
// geometry compares to the detector's cornerTurnDeg=70 and the scorer's 60° floor.
{
  const turnOf = (c: Corner): number => (Math.acos(Math.max(-1, Math.min(1, c.itx * c.otx + c.ity * c.oty))) * 180) / Math.PI
  for (const kind of ['tip', 'root'] as const) {
    const ts = gearGt.filter((c) => c.kind === kind).map(turnOf).sort((a, b) => a - b)
    console.log(`  authored turn (${kind}s): min ${f(ts[0], 1)}° median ${f(ts[ts.length >> 1], 1)}° max ${f(ts[ts.length - 1], 1)}°   [detector needs >70°, scorer grades ≥60°]`)
  }
}

// ---------------------------------------------------------------------------
// 2. reproduce the pipeline's final label map (traceImage's flat path, verbatim)
// ---------------------------------------------------------------------------
// paletteOptionsFor(DEFAULTS + gradients:false): detail 0, despeckle 25.
const paletteOpts = {
  maxColors: 16,
  minShare: Math.max(0.0006, 0.006 - 0 * 0.0052 + 0.25 * 0.004),
  modePasses: 2,
  minRegionArea: Math.max(24, Math.round(0.25 * 0.25 * 800)),
}
const fp = segmentFlatPalette(img as unknown as { width: number; height: number; data: Uint8ClampedArray }, paletteOpts, undefined)
console.log(`\nsegmentFlatPalette: ${fp.palette.length} colours, flatCoverage ${f(fp.flatCoverage, 3)}, dominantColors ${fp.dominantColors} (kept: ${fp.flatCoverage >= 0.7 && fp.dominantColors <= 14})`)
const labels = healColorSpikes(fp.labels, img.data as unknown as Uint8ClampedArray, img.width, img.height, fp.palette)

// Ink label = palette entry nearest the authored INK rgb(26,26,34).
let inkLabel = 0
{
  let best = Infinity
  fp.palette.forEach((c, i) => {
    const d = (c.r - 26) ** 2 + (c.g - 26) ** 2 + (c.b - 34) ** 2
    if (d < best) { best = d; inkLabel = i }
  })
}

const net = buildPlanarNetwork(labels, img.width, img.height)
const gearEdges = net.edges.filter((e) => e.closed && (e.left === inkLabel || e.right === inkLabel))
const gearOpenEdges = net.edges.filter((e) => !e.closed && (e.left === inkLabel || e.right === inkLabel))
console.log(`planar network: ${net.edges.length} edges, ${net.junctions.length} junctions; ink label ${inkLabel} → ${gearEdges.length} closed loop(s) + ${gearOpenEdges.length} open edge(s)`)
const loop = gearEdges.reduce((a, b) => (a.pts.length >= b.pts.length ? a : b))
const pts = loop.pts
console.log(`gear loop: ${pts.length} staircase pts (perimeter ≈ ${pts.length}px crack steps)`)

// The exact fit options traceImage uses for this case (planarFitOptionsFor: flat art,
// smoothing 50 ⇒ 2 passes, lineCost=FLAT_LINE_COST).
const fitOpts: PlanarFitOptions = { ...DEFAULT_PLANAR_FIT, lineCost: FLAT_LINE_COST, smoothPasses: 2 }

// ---------------------------------------------------------------------------
// 3. stages A / B / C on the gear loop
// ---------------------------------------------------------------------------
// Stage A — raw macro-turn vertices (what presmooth pins; both shoulders allowed).
const rawSet = detectCorners(pts, fitOpts.cornerTurnDeg, true)
const rawPts = [...rawSet].map((i) => pts[i])

// Stage B — clustered + fused apexes (what fitCorneredLoop actually breaks at).
const apexIdx = detectLoopCorners(pts, fitOpts.cornerTurnDeg)
const apexPts = apexIdx.map((i) => pts[i])

// Inter-apex staircase arc lengths (the fit's actual local scale at the teeth).
{
  const arcs: number[] = []
  for (let k = 0; k < apexIdx.length; k++) {
    const a = apexIdx[k]
    const b = apexIdx[(k + 1) % apexIdx.length]
    arcs.push(((b - a) % pts.length + pts.length) % pts.length)
  }
  arcs.sort((x, y) => x - y)
  console.log(`\nStage A: ${rawSet.size} raw sharp vertices   Stage B: ${apexIdx.length} apexes (of ${gearGt.length} true corners)`)
  if (arcs.length > 0) console.log(`  inter-apex staircase arcs: min ${arcs[0]} median ${arcs[arcs.length >> 1]} max ${arcs[arcs.length - 1]} steps`)
}

// Stage C — the exact per-edge fit assemblePlanar runs for this loop.
let fitNodes: PathNode[]
if (apexIdx.length >= 2) fitNodes = fitCorneredLoop(pts, apexIdx, fitOpts)
else fitNodes = fitLoopEdge(presmooth(pts, fitOpts.smoothPasses, false, rawSet), fitOpts)
const rawArea = Math.abs(polySignedArea(pts))
const fitArea = Math.abs(polySignedArea(flattenNodes(fitNodes)))
const areaGuardTripped = rawArea >= 4 && fitArea < rawArea * 0.75
console.log(`Stage C: fitCorneredLoop → ${fitNodes.length} nodes; area ${f(fitArea, 0)}/${f(rawArea, 0)} (guard tripped: ${areaGuardTripped})`)
const fitCornerPts = sharpCorners([[{ nodes: fitNodes, closed: true }]])

// FINAL — the real full pipeline (fit + beautify + reseat + weld), scorer-matched.
const doc = await traceImage(img as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false })
const docSets: SubPath[][] = []
for (const item of doc.items) {
  if (item.kind !== 'path' || item.visible === false) continue
  docSets.push(item.subPaths)
}
const docCorners = sharpCorners(docSets)
const recoveredAll = gtCorners.filter((g) => nearest(g, docCorners) <= CORNER_MATCH_R)
console.log(`FINAL doc: ${docCorners.length} sharp corners; scorer match: ${pct(recoveredAll.length, gtCorners.length)}  [gate measured 21/60]`)

// ---------------------------------------------------------------------------
// 4. per-corner attribution + histogram
// ---------------------------------------------------------------------------
interface Verdict { g: GtCorner; dA: number; dB: number; dC: number; dF: number; fate: string }
const verdicts: Verdict[] = gtCorners.map((g) => {
  const dA = g.shape === 'polygon' ? nearest(g, rawPts) : NaN
  const dB = g.shape === 'polygon' ? nearest(g, apexPts) : NaN
  const dC = g.shape === 'polygon' ? nearest(g, fitCornerPts) : NaN
  const dF = nearest(g, docCorners)
  let fate: string
  if (dF <= CORNER_MATCH_R) fate = 'RECOVERED'
  else if (g.shape !== 'polygon') fate = 'lost:canvas'
  else if (dA > DETECT_R) fate = 'A:never-detected'
  else if (dB > DETECT_R) fate = 'B:fused/clustered-away'
  else if (dC > CORNER_MATCH_R) fate = 'C:fit-melted'
  else fate = 'D:post-fit (beautify/weld)'
  return { g, dA, dB, dC, dF, fate }
})

const hist = new Map<string, number>()
for (const v of verdicts) hist.set(v.fate, (hist.get(v.fate) ?? 0) + 1)
console.log('\n=== HISTOGRAM (all 60 GT corners) ===')
for (const [fate, n] of [...hist.entries()].sort()) console.log(`  ${fate.padEnd(28)} ${n}`)

// Where the survivors live.
const surv = verdicts.filter((v) => v.fate === 'RECOVERED')
console.log(`\nsurvivors by location: canvas ${surv.filter((v) => v.g.kind === 'canvas').length}, gear tips ${surv.filter((v) => v.g.kind === 'tip').length}, gear roots ${surv.filter((v) => v.g.kind === 'root').length}`)
const lostGear = verdicts.filter((v) => v.g.shape === 'polygon' && v.fate !== 'RECOVERED')
console.log(`lost gear corners by kind: tips ${lostGear.filter((v) => v.g.kind === 'tip').length}, roots ${lostGear.filter((v) => v.g.kind === 'root').length}`)

// Stage-by-stage survival on the gear only (independent of final attribution).
const gearV = verdicts.filter((v) => v.g.shape === 'polygon')
console.log(`\ngear-corner survival per stage (≤${DETECT_R}px evidence; C/F at scorer's ${CORNER_MATCH_R}px):`)
console.log(`  A raw detect:   ${pct(gearV.filter((v) => v.dA <= DETECT_R).length, gearV.length)}`)
console.log(`  B apex fuse:    ${pct(gearV.filter((v) => v.dB <= DETECT_R).length, gearV.length)}`)
console.log(`  C fit output:   ${pct(gearV.filter((v) => v.dC <= CORNER_MATCH_R).length, gearV.length)}`)
console.log(`  F final doc:    ${pct(gearV.filter((v) => v.dF <= CORNER_MATCH_R).length, gearV.length)}`)

// Detail dump of the lost corners (positions + per-stage distances).
console.log('\nlost corners detail (x,y kind | dA dB dC dF):')
for (const v of verdicts.filter((x) => x.fate !== 'RECOVERED')) {
  console.log(`  (${f(v.g.x, 1)},${f(v.g.y, 1)}) ${v.g.kind.padEnd(6)} | A ${f(v.dA, 1)}  B ${f(v.dB, 1)}  C ${f(v.dC, 1)}  F ${f(v.dF, 1)}  → ${v.fate}`)
}

// MEASURED window-turn at each GT corner: what the ±win cos test actually reads on
// the staircase at the vertex nearest each authored corner (detection's raw input).
{
  const n = pts.length
  const wrap = (i: number): number => ((i % n) + n) % n
  const measuredTurn = (i: number, win: number): number => {
    const a = pts[wrap(i - win)], b = pts[i], c = pts[wrap(i + win)]
    const inD = { x: b.x - a.x, y: b.y - a.y }
    const outD = { x: c.x - b.x, y: c.y - b.y }
    const li = Math.hypot(inD.x, inD.y), lo = Math.hypot(outD.x, outD.y)
    if (li < 1e-9 || lo < 1e-9) return 0
    const cos = (inD.x * outD.x + inD.y * outD.y) / (li * lo)
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
  }
  const nearestIdx = (g: { x: number; y: number }): number => {
    let bi = 0, bd = Infinity
    for (let i = 0; i < n; i++) {
      const d = dist(g, pts[i])
      if (d < bd) { bd = d; bi = i }
    }
    return bi
  }
  console.log('\nmeasured staircase turn at GT corners (max over vertex±1, by window):')
  console.log('  kind |   win=2          win=3          win=4          win=6')
  for (const kind of ['tip', 'root'] as const) {
    const rows: number[][] = [2, 3, 4, 6].map(() => [])
    for (const g of gearGt.filter((c) => c.kind === kind)) {
      const i0 = nearestIdx(g)
      ;[2, 3, 4, 6].forEach((win, k) => {
        // max over the 3 vertices nearest the apex (the detector NMS picks the local max)
        rows[k].push(Math.max(measuredTurn(wrap(i0 - 1), win), measuredTurn(i0, win), measuredTurn(wrap(i0 + 1), win)))
      })
    }
    const s = rows.map((r) => {
      r.sort((a, b) => a - b)
      return `${f(r[0], 0)}–${f(r[r.length >> 1], 0)}–${f(r[r.length - 1], 0)}°`
    })
    console.log(`  ${kind.padEnd(4)} | ${s.map((x) => x.padEnd(14)).join(' ')}   (min–median–max)`)
  }
}

// Stage-C loss anatomy: for detected-but-lost corners, is the apex MELTED (no sharp
// node anywhere near) or MISPLACED (sharp node exists, sits past the 2.5px scorer R)?
{
  const cLost = verdicts.filter((v) => v.fate === 'C:fit-melted')
  if (cLost.length > 0) {
    console.log('\nstage-C loss anatomy (dNode = nearest fitted anchor of ANY kind):')
    for (const v of cLost) {
      const dNode = nearest(v.g, fitNodes)
      console.log(`  (${f(v.g.x, 1)},${f(v.g.y, 1)}) ${v.g.kind}: apex evidence ${f(v.dB, 1)}px → sharp node ${f(v.dC, 1)}px, any node ${f(dNode, 1)}px  ⇒ ${v.dC < 6 ? 'MISPLACED (snap moved the apex)' : 'MELTED'}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 5. sensitivity: detector-only sweep win × mergeDist (no refit)
// ---------------------------------------------------------------------------
console.log('\n=== SENSITIVITY (detectLoopCorners only, gear loop) ===')
console.log('  win  merge | apexes  gtHit(≤3px)  spurious')
for (const win of [2, 3, 4]) {
  for (const md of [2, 3, 5]) {
    const idx = detectLoopCorners(pts, fitOpts.cornerTurnDeg, win, md)
    const aPts = idx.map((i) => pts[i])
    const hit = gearGt.filter((g) => nearest(g, aPts) <= DETECT_R).length
    // spurious = apexes not within DETECT_R of any GT gear corner
    const spur = aPts.filter((p) => nearest(p, gearGt) > DETECT_R).length
    console.log(`  ${String(win).padStart(3)}  ${String(md).padStart(5)} | ${String(idx.length).padStart(6)}  ${pct(hit, gearGt.length).padStart(13)}  ${String(spur).padStart(8)}`)
  }
}

// Same sweep for the raw detector (stage A) — is detection itself window-limited?
console.log('\n  raw detectCorners (stage A) by win:')
for (const win of [2, 3, 4]) {
  const s = detectCorners(pts, fitOpts.cornerTurnDeg, true, win)
  const sPts = [...s].map((i) => pts[i])
  const hit = gearGt.filter((g) => nearest(g, sPts) <= DETECT_R).length
  console.log(`    win=${win}: ${s.size} raw vertices, gtHit ${pct(hit, gearGt.length)}`)
}

// Disc control loop (smooth navy circle — the false-positive guard for any change).
let discPts: Vec[] = []
{
  let navyLabel = 0
  let best = Infinity
  fp.palette.forEach((c, i) => {
    const d = (c.r - 32) ** 2 + (c.g - 46) ** 2 + (c.b - 120) ** 2
    if (d < best) { best = d; navyLabel = i }
  })
  const discLoop = net.edges.filter((e) => e.closed && (e.left === navyLabel || e.right === navyLabel)).reduce((a, b) => (a.pts.length >= b.pts.length ? a : b), { pts: [] as Vec[] } as (typeof net.edges)[0])
  discPts = discLoop.pts
}

// THE decisive sweep — turn THRESHOLD × window: roots author at ~67° < the 70° gate,
// so the threshold, not just the window, may be the detection binding constraint.
// gtHit split by kind; disc = apexes on the smooth control circle (must stay 0).
console.log('\n=== SENSITIVITY 2 (threshold × window, detectLoopCorners, md=5) ===')
console.log('  turn°  win | apexes  tips(≤3px)  roots(≤3px)  spurious  discApex')
for (const turn of [55, 60, 65, 70]) {
  for (const win of [2, 3, 4, 5, 6]) {
    const idx = detectLoopCorners(pts, turn, win, 5)
    const aPts = idx.map((i) => pts[i])
    const tips = gearGt.filter((g) => g.kind === 'tip' && nearest(g, aPts) <= DETECT_R).length
    const roots = gearGt.filter((g) => g.kind === 'root' && nearest(g, aPts) <= DETECT_R).length
    const spur = aPts.filter((p) => nearest(p, gearGt) > DETECT_R).length
    const disc = discPts.length > 0 ? detectLoopCorners(discPts, turn, win, 5).length : -1
    console.log(`  ${String(turn).padStart(5)}  ${String(win).padStart(3)} | ${String(idx.length).padStart(6)}  ${String(tips).padStart(5)}/28    ${String(roots).padStart(5)}/28  ${String(spur).padStart(8)}  ${String(disc).padStart(8)}`)
  }
}
console.log(`\ndisc control: loop ${discPts.length} pts (smooth circle, r=124) — discApex column above must stay 0`)

// ---------------------------------------------------------------------------
// 6. end-to-end WHAT-IF: better detector settings fed into the UNCHANGED fit
//    (fitCorneredLoop takes the corner list as an argument — no lib change).
//    Answers: with detection fixed, does the snap/ε stage hold enough corners?
// ---------------------------------------------------------------------------
console.log('\n=== WHAT-IF: detector settings → unchanged fitCorneredLoop → scorer match ===')
console.log('  turn°  win | apexes  fitNodes  sharp  gearHit(2.5px)  tips  roots  gear+canvas')
for (const [turn, win] of [[70, 4], [60, 3], [60, 4], [55, 3], [60, 5]] as [number, number][]) {
  const idx = detectLoopCorners(pts, turn, win, 5)
  if (idx.length < 2) continue
  const nodes = fitCorneredLoop(pts, idx, fitOpts)
  const sharp = sharpCorners([[{ nodes, closed: true }]])
  const tips = gearGt.filter((g) => g.kind === 'tip' && nearest(g, sharp) <= CORNER_MATCH_R).length
  const roots = gearGt.filter((g) => g.kind === 'root' && nearest(g, sharp) <= CORNER_MATCH_R).length
  const hit = tips + roots
  const total = hit + 4 // canvas rect corners recovered by the bg region in the real pipeline
  console.log(`  ${String(turn).padStart(5)}  ${String(win).padStart(3)} | ${String(idx.length).padStart(6)}  ${String(nodes.length).padStart(8)}  ${String(sharp.length).padStart(5)}  ${pct(hit, 56).padStart(14)}  ${String(tips).padStart(4)}  ${String(roots).padStart(5)}  ${pct(total, 60).padStart(12)}${total >= 48 ? '  ← would PASS gate' : ''}`)
}

// Snap displacement stats under the best detector setting: how far does
// snapCornerToArms place each detected apex from its authored corner?
{
  const idx = detectLoopCorners(pts, 60, 3, 5)
  const nodes = fitCorneredLoop(pts, idx, fitOpts)
  const sharp = sharpCorners([[{ nodes, closed: true }]])
  const ds = gearGt
    .map((g) => ({ g, d: nearest(g, sharp) }))
    .filter((x) => x.d < 8)
    .map((x) => x.d)
    .sort((a, b) => a - b)
  console.log(`\nsnap displacement @60°/win3 (authored corner → nearest fitted sharp node, <8px):`)
  console.log(`  n=${ds.length}  min ${f(ds[0], 2)}  median ${f(ds[ds.length >> 1], 2)}  p90 ${f(ds[Math.floor(ds.length * 0.9)], 2)}  max ${f(ds[ds.length - 1], 2)}  (scorer R=${CORNER_MATCH_R})`)
}
