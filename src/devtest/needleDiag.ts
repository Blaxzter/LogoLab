// NEEDLE DIAG (issue #7) — locate and ATTRIBUTE the flat-lane needle at mastercard's
// 's' bottom join, before designing anything (§18.1's Phase-0 shape).
//
//   node --experimental-strip-types src/devtest/needleDiag.ts                       # score + hot clusters + unmatched corners
//   node --experimental-strip-types src/devtest/needleDiag.ts --roi x0,y0,x1,y1     # ROI autopsy: per-point dists, doc nodes, corners
//   node --experimental-strip-types src/devtest/needleDiag.ts --matrix --roi ...    # fit-flag bisect scored on the ROI
//   node --experimental-strip-types src/devtest/needleDiag.ts --png out.png --roi ...  # source | trace crop sheet (zoomed)
//   --case NAME   (default mastercard — any examples/logos/*.svg or public/examples/edge-cases/*.svg)
//   --res N       (default 512)   --gradients   --fit k=v,k2=v2   --hot D (cluster floor, default 1.0)
//
// WHY. The issue reports a needle/notch at the 's' bottom join in the FLAT trace only.
// Its Phase-0 comment already inverted the framing (flat beats gradient on every gate;
// the defect is one local needle), and flat recovers 48/49 authored corners. This CLI
// answers the three questions a fix needs first:
//   1. WHERE — cluster the hot boundary samples (both directions: invented + missed)
//      instead of trusting a screenshot's circle;
//   2. WHAT — the traced anatomy inside the hot ROI (nodes, handles, sharp turns,
//      which subpath/item), plus which authored corner goes unrecovered;
//   3. WHO — a fit-flag matrix (§16's lowresDiag --fit pattern) scored on the ROI,
//      so the pass that manufactures the needle is measured, not guessed.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { encodePng } from './pngEncode.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { rasterizeDoc } from '../lib/render/raster.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from './svgGround.ts'
import {
  scoreGeometry,
  sharpCorners,
  makeVisibleAt,
  CORNER_MIN_EDGE,
  CORNER_MATCH_R,
  type Corner,
  type DistPoint,
} from './geomScore.ts'
import type { SubPath, EditableDoc } from '../lib/path/types.ts'
import type { ApexDiagRecord } from '../lib/trace/planarFit.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const flag = (name: string): string | null => {
  if (!argv.includes(name)) return null
  const v = argv[argv.indexOf(name) + 1]
  return v === undefined || v.startsWith('--') ? '' : v
}

const CASE = flag('--case') ?? 'mastercard'
const RES = Number(flag('--res') ?? 512)
const GRADIENTS = argv.includes('--gradients')
const HOT = Number(flag('--hot') ?? 1.0)
const ROI = (flag('--roi') ?? '').split(',').map(Number).filter(Number.isFinite)
const PNG = flag('--png')

/** `--fit subpixelEdges=false,junctionReseat=false` → PlanarFitOptions override. */
const parseFit = (s: string): Record<string, number | boolean> => {
  const o: Record<string, number | boolean> = {}
  for (const kv of s.split(',').filter(Boolean)) {
    const [k, v] = kv.split('=')
    o[k] = v === 'true' ? true : v === 'false' ? false : Number(v)
  }
  return o
}
const FIT = parseFit(flag('--fit') ?? '')

const f = (v: number, d = 3): string => v.toFixed(d)

// ---------------------------------------------------------------------------
// `--census`: every svgGround-scorable gallery mark @RES flat — join each apex record
// to its nearest VISIBLE authored corner and ask whether arm BOW separates the good
// reconstructions from the bad (the §18.1 census shape, aimed at issue #7's needle).
// ---------------------------------------------------------------------------
if (argv.includes('--census')) {
  const { readdirSync } = await import('node:fs')
  const dir = join(root, 'examples', 'logos')
  const marks = readdirSync(dir).filter((f) => f.endsWith('.svg'))
  interface Joined {
    mark: string
    r: ApexDiagRecord
    /** Distance lattice-vertex → authored corner, and apex → the same corner. */
    errLattice: number
    errApex: number
  }
  const joined: Joined[] = []
  const unjoined: Record<string, number> = {}
  let scorable = 0
  const R_JOIN = 4
  for (const file of marks) {
    const text = readFileSync(join(dir, file), 'utf8')
    let g
    try { g = parseGroundTruth(text) } catch { continue }
    if (unscorable(g)) continue
    let raster
    try {
      raster = decodePng(new Resvg(text, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
    } catch { continue }
    scorable++
    const sh = toRasterSpace(g, raster.width)
    const vis = makeVisibleAt(raster)
    const corners = sharpCorners(sh.map((s) => s.subPaths), CORNER_MIN_EDGE).filter(
      (c) => vis({ x: c.x, y: c.y, tx: c.itx, ty: c.ity }) || vis({ x: c.x, y: c.y, tx: c.otx, ty: c.oty }),
    )
    const recs: ApexDiagRecord[] = []
    await traceImage(
      raster as unknown as ImageData,
      { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, planarFit: { apexDiag: (r: ApexDiagRecord) => { recs.push(r) } } },
    )
    for (const r of recs) {
      let best: Corner | null = null
      let bd = R_JOIN
      for (const c of corners) {
        const d = Math.hypot(c.x - r.cx, c.y - r.cy)
        if (d < bd) { bd = d; best = c }
      }
      if (!best) { unjoined[r.outcome] = (unjoined[r.outcome] ?? 0) + 1; continue }
      joined.push({
        mark: file.replace(/\.svg$/, ''),
        r,
        errLattice: Math.hypot(best.x - r.cx, best.y - r.cy),
        errApex: Math.hypot(best.x - r.ax, best.y - r.ay),
      })
    }
  }
  console.log(`\n━━━ census @${RES} flat: ${scorable}/${marks.length} marks scorable, ${joined.length} apex records joined to an authored corner (≤${R_JOIN}px) ━━━`)
  console.log(`unjoined (no authored corner within ${R_JOIN}px): ${JSON.stringify(unjoined)}`)

  const rec = joined.filter((j) => j.r.outcome === 'reconstructed')
  const buckets: Array<[string, (b: number) => boolean]> = [
    ['bow < 0.3   ', (b) => b < 0.3],
    ['0.3 ≤ b < 0.6', (b) => b >= 0.3 && b < 0.6],
    ['0.6 ≤ b < 1.0', (b) => b >= 0.6 && b < 1.0],
    ['bow ≥ 1.0   ', (b) => b >= 1.0],
  ]
  console.log(`\nRECONSTRUCTED apexes by max arm bow — errApex vs errLattice (px to authored corner):`)
  console.log(`bucket        |    n | mean apex | mean lattice | mean Δ(apex−lattice) | worse-than-lattice`)
  for (const [name, test] of buckets) {
    const g = rec.filter((j) => test(Math.max(j.r.inBow, j.r.outBow)))
    if (!g.length) { console.log(`${name} |    0 |`); continue }
    const ma = g.reduce((s, j) => s + j.errApex, 0) / g.length
    const ml = g.reduce((s, j) => s + j.errLattice, 0) / g.length
    const worse = g.filter((j) => j.errApex > j.errLattice + 0.25).length
    console.log(
      `${name} | ${String(g.length).padStart(4)} |   ${f(ma)}   |    ${f(ml)}     |       ${f(ma - ml)}         | ${worse} (${f((100 * worse) / g.length, 0)}%)`,
    )
  }
  console.log(`\nworst 15 reconstructed (by errApex):`)
  for (const j of [...rec].sort((a, b) => b.errApex - a.errApex).slice(0, 15))
    console.log(
      `  ${j.mark.padEnd(22)} (${f(j.r.cx, 1)},${f(j.r.cy, 1)}) → (${f(j.r.ax, 1)},${f(j.r.ay, 1)})  errA ${f(j.errApex, 2)}  errL ${f(j.errLattice, 2)}  bows ${f(j.r.inBow, 2)}/${f(j.r.outBow, 2)}  tip ${f(j.r.tipDeg, 0)}°  moved ${f(j.r.moved, 2)}  reach ${f(j.r.reach, 2)}`,
    )

  const refusals = joined.filter((j) => j.r.outcome !== 'reconstructed')
  const byOutcome = new Map<string, Joined[]>()
  for (const j of refusals) {
    const a = byOutcome.get(j.r.outcome)
    if (a) a.push(j); else byOutcome.set(j.r.outcome, [j])
  }
  console.log(`\nREFUSALS holding a lattice vertex at an authored corner (errLattice = the cost of not reconstructing):`)
  for (const [o, g] of byOutcome) {
    const ml = g.reduce((s, j) => s + j.errLattice, 0) / g.length
    const far = g.filter((j) => j.errLattice > 1.5).length
    console.log(`  ${o.padEnd(13)} n ${String(g.length).padStart(4)}  mean errLattice ${f(ml)}  >1.5px: ${far}`)
  }
  console.log(`\nworst 10 short-arm refusals (by errLattice):`)
  for (const j of refusals.filter((j) => j.r.outcome === 'short-arm').sort((a, b) => b.errLattice - a.errLattice).slice(0, 10))
    console.log(`  ${j.mark.padEnd(22)} (${f(j.r.cx, 1)},${f(j.r.cy, 1)})  errL ${f(j.errLattice, 2)}  spans ${j.r.inSpan}/${j.r.outSpan}`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// `--sweep`: the §18.3 protocol for issue #7 — every candidate arm model judged on
// BOTH sides at once: the defect metrics (letter-joins authored join corners,
// mastercard's needle sites and corner recall) AND every control the snap currently
// buys (acute-counter's §18 numbers, the corner watchlist), in one table.
// ---------------------------------------------------------------------------
if (argv.includes('--sweep')) {
  interface Variant { label: string; fit: Record<string, unknown> }
  const VARIANTS: Variant[] = [
    { label: 'baseline (arcArms off)', fit: { arcArms: false } },
    { label: 'tangent (defaults)', fit: {} },
    { label: 'no tip floor', fit: { arcTipMinDeg: 0 } },
    { label: 'no tip floor, pin=chord', fit: { arcTipMinDeg: 0, arcPin: false } },
    { label: 'no tip floor, pinTurn 80', fit: { arcTipMinDeg: 0, arcPinTurnMinDeg: 80 } },
    { label: 'tip floor 40', fit: { arcTipMinDeg: 40 } },
    { label: 'no pinTurn gate', fit: { arcPinTurnMinDeg: 0 } },
    { label: 'phi 8', fit: { arcPhiMinDeg: 8 } },
    { label: 'phi 14', fit: { arcPhiMinDeg: 14 } },
  ]

  // letter-joins' authored join corners, from genEdgeCases' own formulas (×2 @512).
  const S = RES / 256
  const JOINS: Vec2[] = []
  const rotP = (x: number, y: number, cx: number, cy: number, rot: number): Vec2 => {
    const a = (rot * Math.PI) / 180
    return { x: (cx + x * Math.cos(a) - y * Math.sin(a)) * S, y: (cy + x * Math.sin(a) + y * Math.cos(a)) * S }
  }
  for (const [cx, cy, c2, , rot] of [[50, 52, 26, 9, 0], [136, 52, 34, 12, 9], [216, 52, 20, 8, 31]] as const)
    for (const sx of [-1, 1]) JOINS.push(rotP((sx * c2) / 2, 0, cx, cy, rot))
  for (const [cx, cy, r2, dc, rot] of [[52, 130, 30, 22, 0], [140, 130, 24, 15, 17], [216, 130, 20, 14, 43]] as const) {
    const yc = Math.sqrt(r2 * r2 - dc * dc)
    for (const sy of [-1, 1]) JOINS.push(rotP(0, sy * yc, cx, cy, rot))
  }
  // The straight-arm controls that must not move: spike apex + square-notch inner corners.
  const CONTROL_PTS: Vec2[] = [{ x: 24 * S, y: 236 * S }, { x: 145 * S, y: 214 * S }, { x: 157 * S, y: 214 * S }]

  interface Vec2 { x: number; y: number }
  const rasterFor = (name: string): ReturnType<typeof decodePng> => {
    const p = name.includes('/') ? name : `public/examples/edge-cases/${name}.svg`
    const t = readFileSync(join(root, p.endsWith('.svg') ? p : `${p}.svg`), 'utf8')
    return decodePng(new Resvg(t, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
  }
  const rasters = new Map<string, ReturnType<typeof decodePng>>()
  const CONTROLS = ['sharp-star', 'gear-teeth', 'bar-caps', 'cross-bars', 'band-cross', 'checker']
  for (const n of ['letter-joins', 'acute-counter', ...CONTROLS]) rasters.set(n, rasterFor(n))
  // The @256 lane: acute-counter is gated there and the parabola draft regressed it
  // (p95 2.13 → 3.44) — every variant reports it.
  const AC256 = decodePng(new Resvg(readFileSync(join(root, 'public/examples/edge-cases/acute-counter.svg'), 'utf8'), { fitTo: { mode: 'width', value: 256 }, background: 'white' }).render().asPng())
  rasters.set('mastercard', decodePng(new Resvg(readFileSync(join(root, 'examples/logos/mastercard.svg'), 'utf8'), { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng()))

  const gtFor = (p: string): ReturnType<typeof toRasterSpace> => {
    const t = readFileSync(join(root, p), 'utf8')
    return toRasterSpace(parseGroundTruth(t), rasters.get(p.includes('logos') ? 'mastercard' : p.replace(/^public\/examples\/edge-cases\//, '').replace(/\.svg$/, ''))!.width)
  }

  const traceWith = async (name: string, fit: Record<string, unknown>): Promise<EditableDoc> => {
    const img2 = rasters.get(name)!
    return traceImage(img2 as unknown as ImageData, {
      ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false,
      planarFit: fit,
    })
  }
  const cornerNodes = (doc2: EditableDoc): Vec2[] => {
    const out: Vec2[] = []
    for (const e of (doc2 as unknown as { topology?: { edges: { nodes: { kind: string; x: number; y: number }[] }[] } }).topology?.edges ?? [])
      for (const nd of e.nodes) if (nd.kind === 'corner') out.push({ x: nd.x, y: nd.y })
    return out
  }
  const nearest = (cs: Vec2[], p: Vec2): number => {
    let best = Infinity
    for (const q of cs) best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y))
    return best
  }

  console.log(`\n━━━ §19 sweep @${RES} ━━━`)
  for (const v of VARIANTS) {
    // letter-joins: Σ/worst apex error over the 12 authored join corners + control pts.
    const ljDoc = await traceWith('letter-joins', v.fit)
    const ljCorners = cornerNodes(ljDoc)
    const errs = JOINS.map((p) => nearest(ljCorners, p))
    const ctl = CONTROL_PTS.map((p) => nearest(ljCorners, p))
    const ljScore = scoreGeometry(gtFor('public/examples/edge-cases/letter-joins.svg'), ljDoc, rasters.get('letter-joins')!.width, rasters.get('letter-joins')!.height, rasters.get('letter-joins')!)

    // mastercard: corner recall + the three needle-site ROI maxima.
    const mcDoc = await traceWith('mastercard', v.fit)
    const mcImg = rasters.get('mastercard')!
    const mcScore = scoreGeometry(gtFor('examples/logos/mastercard.svg'), mcDoc, mcImg.width, mcImg.height, mcImg)
    const roiMax = (x0: number, y0: number, x1: number, y1: number, side: 'docPoints' | 'gtPoints'): number => {
      let m = 0
      for (const p of mcScore.diagnostics[side]) if (p.x >= x0 && p.y >= y0 && p.x <= x1 && p.y <= y1 && p.d > m) m = p.d
      return m
    }

    // acute-counter §18 defect metric: Σ authored lens-tip error (apexSweep's TIPS).
    const acDoc = await traceWith('acute-counter', v.fit)
    const acCorners = cornerNodes(acDoc)
    const acUnits: [number, number, number, number, number][] = [
      [46, 46, 48, 32, 0], [128, 46, 40, 38, 23], [210, 46, 34, 44, 47],
      [46.5, 128.5, 30, 38, 11], [128.5, 128.5, 24, 44, 67], [210.5, 128.5, 20, 56, 90], [210, 210, 30, 96, 31],
    ]
    let acSum = 0
    let acWorst = 0
    let spikeWorst = 0
    for (const [cx, cy, R, tip, rot] of acUnits) {
      const h = 2 * R * Math.sin((tip * Math.PI) / 360)
      const ang = (rot * Math.PI) / 180
      for (const sy of [-h / 2, h / 2]) {
        const d = nearest(acCorners, { x: (cx - sy * Math.sin(ang)) * S, y: (cy + sy * Math.cos(ang)) * S })
        if (d > 40) continue
        acSum += d
        acWorst = Math.max(acWorst, d)
      }
    }
    for (const [sx2, sy2] of [[24, 200], [24, 232]] as const) spikeWorst = Math.max(spikeWorst, nearest(acCorners, { x: sx2 * S, y: sy2 * S }))

    // acute-counter @256: boundary p95 + corner recall (the gated lane).
    const ac256Doc = await traceImage(AC256 as unknown as ImageData, {
      ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, planarFit: v.fit,
    })
    const ac256Gt = toRasterSpace(parseGroundTruth(readFileSync(join(root, 'public/examples/edge-cases/acute-counter.svg'), 'utf8')), AC256.width)
    const ac256 = scoreGeometry(ac256Gt, ac256Doc, AC256.width, AC256.height, AC256)

    // Watchlist recall — must match baseline exactly.
    const recalls: string[] = []
    for (const cn of CONTROLS) {
      const cd = await traceWith(cn, v.fit)
      const ci = rasters.get(cn)!
      const cs = scoreGeometry(gtFor(`public/examples/edge-cases/${cn}.svg`), cd, ci.width, ci.height, ci)
      recalls.push(`${cn.slice(0, 5)} ${cs.cornersRecovered}/${cs.gtCorners}`)
    }

    console.log(`\n■ ${v.label}`)
    console.log(
      `  letter-joins: Σjoin ${f(errs.reduce((s2, e) => s2 + e, 0), 2)} worst ${f(Math.max(...errs), 2)}  ctrlWorst ${f(Math.max(...ctl), 2)}  corners ${ljScore.cornersRecovered}/${ljScore.gtCorners}  chamfer ${f(ljScore.chamfer, 4)} p95 ${f(ljScore.p95, 3)} missedMax ${f(ljScore.missedMax, 2)}`,
    )
    console.log(
      `  mastercard:   corners ${mcScore.cornersRecovered}/${mcScore.gtCorners}  chamfer ${f(mcScore.chamfer, 4)} p95 ${f(mcScore.p95, 3)}  eNeedle ${f(roiMax(240, 366, 275, 376, 'docPoints'), 2)}  mCrotch ${f(roiMax(55, 352, 68, 365, 'gtPoints'), 2)}  spurMax ${f(mcScore.spuriousMax, 2)}`,
    )
    console.log(`  acute-counter: Σtip ${f(acSum, 1)} worst ${f(acWorst, 2)} spikeWorst ${f(spikeWorst, 2)}  | @256 p95 ${f(ac256.p95, 3)} corners ${ac256.cornersRecovered}/${ac256.gtCorners}`)
    console.log(`  watchlist: ${recalls.join('  ')}`)
  }
  process.exit(0)
}

const svgPath = CASE.includes('/')
  ? CASE
  : [`examples/logos/${CASE}.svg`, `public/examples/edge-cases/${CASE}.svg`].find((p) => {
      try { readFileSync(join(root, p)); return true } catch { return false }
    }) ?? `examples/logos/${CASE}.svg`

const svgText = readFileSync(join(root, svgPath), 'utf8')
const gt = parseGroundTruth(svgText)
const why = unscorable(gt)
if (why) throw new Error(`${CASE} is not svgGround-scorable: ${why}`)

const png = new Resvg(svgText, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng()
const img = decodePng(png)
const shapes = toRasterSpace(gt, img.width)

let LABELS: { labels: Int32Array; width: number; height: number } | null = null
const APEX: ApexDiagRecord[] = []
async function trace(fitOver: Record<string, number | boolean>): Promise<EditableDoc> {
  APEX.length = 0
  return traceImage(
    img as unknown as ImageData,
    {
      ...DEFAULT_VECTORIZE_OPTIONS,
      engine: 'planar',
      gradients: GRADIENTS,
      planarFit: {
        ...(argv.includes('--apex') ? { apexDiag: (r: ApexDiagRecord) => { APEX.push(r) } } : {}),
        ...fitOver,
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    (l) => { LABELS = l },
  )
}

// ---------------------------------------------------------------------------
// Hot-sample clustering: union points within LINK px, report per cluster.
// ---------------------------------------------------------------------------
interface Cluster { n: number; maxd: number; sumd: number; x0: number; y0: number; x1: number; y1: number }
const LINK = 4
function clusters(pts: DistPoint[], floor: number): Cluster[] {
  const hot = pts.filter((p) => p.d >= floor)
  const parent = hot.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const grid = new Map<string, number[]>()
  hot.forEach((p, i) => {
    const k = `${Math.floor(p.x / LINK)},${Math.floor(p.y / LINK)}`
    const a = grid.get(k)
    if (a) a.push(i); else grid.set(k, [i])
  })
  hot.forEach((p, i) => {
    const gx = Math.floor(p.x / LINK), gy = Math.floor(p.y / LINK)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (j <= i) continue
          const q = hot[j]
          if ((p.x - q.x) ** 2 + (p.y - q.y) ** 2 <= LINK * LINK) parent[find(i)] = find(j)
        }
  })
  const by = new Map<number, Cluster>()
  hot.forEach((p, i) => {
    const r = find(i)
    const c = by.get(r)
    if (!c) by.set(r, { n: 1, maxd: p.d, sumd: p.d, x0: p.x, y0: p.y, x1: p.x, y1: p.y })
    else {
      c.n++; c.maxd = Math.max(c.maxd, p.d); c.sumd += p.d
      c.x0 = Math.min(c.x0, p.x); c.y0 = Math.min(c.y0, p.y)
      c.x1 = Math.max(c.x1, p.x); c.y1 = Math.max(c.y1, p.y)
    }
  })
  return [...by.values()].sort((a, b) => b.maxd - a.maxd)
}
const box = (c: Cluster): string =>
  `[${f(c.x0, 1)},${f(c.y0, 1)} → ${f(c.x1, 1)},${f(c.y1, 1)}]`

// ---------------------------------------------------------------------------
// The default run: score, clusters, unmatched corners.
// ---------------------------------------------------------------------------
const doc = await trace(FIT)
const score = scoreGeometry(shapes, doc, img.width, img.height, img)
const fitNote = Object.keys(FIT).length ? `  [fit ${flag('--fit')}]` : ''
console.log(`\n━━━ ${CASE} @${RES} ${GRADIENTS ? 'gradients' : 'flat'}${fitNote} ━━━`)
console.log(
  `chamfer ${f(score.chamfer, 4)}  p95 ${f(score.p95)}  spuriousMax ${f(score.spuriousMax)}  missedMax ${f(score.missedMax)}` +
  `  corners ${score.cornersRecovered}/${score.gtCorners}  nodes ${score.docNodes}  paths ${score.docPaths}`,
)

// Unmatched authored corners — the 48/49 lead.
const visible = makeVisibleAt(img)
const gtCornerVis = sharpCorners(shapes.map((s) => s.subPaths), CORNER_MIN_EDGE).filter(
  (c) => visible({ x: c.x, y: c.y, tx: c.itx, ty: c.ity }) || visible({ x: c.x, y: c.y, tx: c.otx, ty: c.oty }),
)
const docSets: SubPath[][] = doc.items.flatMap((it) => (it.kind === 'path' && it.visible !== false ? [it.subPaths] : []))
const docCorners = sharpCorners(docSets)
const unmatched = gtCornerVis.filter(
  (g) => !docCorners.some((p) => (p.x - g.x) ** 2 + (p.y - g.y) ** 2 <= CORNER_MATCH_R * CORNER_MATCH_R),
)
console.log(`\nunmatched authored corners (${unmatched.length}/${gtCornerVis.length}):`)
for (const c of unmatched) {
  const turn = (Math.acos(Math.max(-1, Math.min(1, c.itx * c.otx + c.ity * c.oty))) * 180) / Math.PI
  console.log(`  (${f(c.x, 2)}, ${f(c.y, 2)})  turn ${f(turn, 1)}°`)
}

console.log(`\nhot clusters ≥ ${HOT}px — INVENTED (trace boundary with no authored counterpart):`)
for (const c of clusters(score.diagnostics.docPoints, HOT).slice(0, 10))
  console.log(`  max ${f(c.maxd)}  mean ${f(c.sumd / c.n)}  n ${String(c.n).padStart(3)}  ${box(c)}`)
console.log(`hot clusters ≥ ${HOT}px — MISSED (authored boundary the trace fails to reach):`)
for (const c of clusters(score.diagnostics.gtPoints, HOT).slice(0, 10))
  console.log(`  max ${f(c.maxd)}  mean ${f(c.sumd / c.n)}  n ${String(c.n).padStart(3)}  ${box(c)}`)

// ---------------------------------------------------------------------------
// ROI autopsy
// ---------------------------------------------------------------------------
const inRoi = (x: number, y: number): boolean =>
  ROI.length === 4 && x >= ROI[0] && y >= ROI[1] && x <= ROI[2] && y <= ROI[3]

if (ROI.length === 4 && !argv.includes('--matrix')) {
  console.log(`\n━━━ ROI ${ROI.join(',')} ━━━`)
  const sp = score.diagnostics.docPoints.filter((p) => inRoi(p.x, p.y))
  const mp = score.diagnostics.gtPoints.filter((p) => inRoi(p.x, p.y))
  const mx = (a: DistPoint[]): number => a.reduce((m, p) => Math.max(m, p.d), 0)
  const mean = (a: DistPoint[]): number => (a.length ? a.reduce((s, p) => s + p.d, 0) / a.length : 0)
  console.log(`invented: n ${sp.length}  max ${f(mx(sp))}  mean ${f(mean(sp))}`)
  console.log(`missed:   n ${mp.length}  max ${f(mx(mp))}  mean ${f(mean(mp))}`)

  console.log(`\nauthored corners in ROI (✓ recovered / ✗ not):`)
  for (const c of gtCornerVis.filter((c) => inRoi(c.x, c.y))) {
    const hit = docCorners.some((p) => (p.x - c.x) ** 2 + (p.y - c.y) ** 2 <= CORNER_MATCH_R * CORNER_MATCH_R)
    console.log(`  ${hit ? '✓' : '✗'} (${f(c.x, 2)}, ${f(c.y, 2)})`)
  }
  console.log(`traced sharp corners in ROI:`)
  for (const c of docCorners.filter((c) => inRoi(c.x, c.y))) {
    const turn = (Math.acos(Math.max(-1, Math.min(1, c.itx * c.otx + c.ity * c.oty))) * 180) / Math.PI
    console.log(`  (${f(c.x, 2)}, ${f(c.y, 2)})  turn ${f(turn, 1)}°`)
  }

  console.log(`\ntraced nodes in ROI (item/subpath/node, anchor, handles):`)
  doc.items.forEach((it, ii) => {
    if (it.kind !== 'path' || it.visible === false) return
    it.subPaths.forEach((sp2, si) => {
      sp2.nodes.forEach((n, ni) => {
        if (!inRoi(n.x, n.y)) return
        const h = (p: { x: number; y: number } | null | undefined): string =>
          p ? `(${f(p.x, 1)},${f(p.y, 1)})` : '—'
        console.log(
          `  i${ii}/s${si}/n${ni}  (${f(n.x, 2)}, ${f(n.y, 2)})  hIn ${h(n.hIn)}  hOut ${h(n.hOut)}  fill ${String((it as { fill?: unknown }).fill ?? '?')}`,
        )
      })
    })
  })
}

// Every apex the corner snap CONSIDERED inside the ROI — did it fire at the notch tip,
// and which refusal kept it on the lattice if not?
if (argv.includes('--apex') && ROI.length === 4) {
  console.log(`\napex records in ROI (chain vertex cx,cy → apex ax,ay):`)
  for (const r of APEX.filter((r) => inRoi(r.cx, r.cy) || inRoi(r.ax, r.ay))) {
    console.log(
      `  (${f(r.cx, 2)},${f(r.cy, 2)}) → (${f(r.ax, 2)},${f(r.ay, 2)})  ${r.outcome.padEnd(13)}` +
      ` moved ${f(r.moved, 2)}  allow ${f(r.allow, 2)}  tip ${f(r.tipDeg, 1)}°  spans ${r.inSpan}/${r.outSpan}` +
      `  bows ${f(r.inBow, 2)}/${f(r.outBow, 2)}  chords ${f(r.inChord, 1)}/${f(r.outChord, 1)}  n ${r.inN}/${r.outN}  reach ${f(r.reach, 2)}` +
      `  kinds ${r.inKind ?? '?'}/${r.outKind ?? '?'}`,
    )
  }
}

// ---------------------------------------------------------------------------
// The matrix: which pass manufactures the needle?
// ---------------------------------------------------------------------------
if (argv.includes('--matrix')) {
  if (ROI.length !== 4) throw new Error('--matrix needs --roi x0,y0,x1,y1 (take the worst cluster box + margin)')
  const PRESETS: Array<[string, Record<string, number | boolean>]> = [
    ['default', {}],
    ['subpixelEdges=off', { subpixelEdges: false }],
    ['junctionReseat=off', { junctionReseat: false }],
    ['apexEvidence=off', { apexEvidence: false }],
    ['arcSnap=off', { arcSnap: false }],
    ['smoothPasses=0', { smoothPasses: 0 }],
    ['reseat+subpix off', { subpixelEdges: false, junctionReseat: false }],
  ]
  console.log(`\n━━━ fit-flag matrix on ROI ${ROI.join(',')} ━━━`)
  console.log(`preset               | ROI inv max/mean | ROI miss max/mean | chamfer  | corners`)
  for (const [name, over] of PRESETS) {
    const d2 = await trace({ ...FIT, ...over })
    const s2 = scoreGeometry(shapes, d2, img.width, img.height, img)
    const sp = s2.diagnostics.docPoints.filter((p) => inRoi(p.x, p.y))
    const mp = s2.diagnostics.gtPoints.filter((p) => inRoi(p.x, p.y))
    const mx = (a: DistPoint[]): number => a.reduce((m, p) => Math.max(m, p.d), 0)
    const mean = (a: DistPoint[]): number => (a.length ? a.reduce((s, p) => s + p.d, 0) / a.length : 0)
    console.log(
      `${name.padEnd(20)} | ${f(mx(sp))} / ${f(mean(sp))}  | ${f(mx(mp))} / ${f(mean(mp))}   | ${f(s2.chamfer, 4)}  | ${s2.cornersRecovered}/${s2.gtCorners}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Crop sheet: source | traced render, zoomed — the needle made visible headlessly.
// ---------------------------------------------------------------------------
if (PNG) {
  if (ROI.length !== 4) throw new Error('--png needs --roi x0,y0,x1,y1')
  const X0 = Math.max(0, Math.floor(ROI[0])), Y0 = Math.max(0, Math.floor(ROI[1]))
  const CW = Math.min(img.width, Math.ceil(ROI[2])) - X0
  const CH = Math.min(img.height, Math.ceil(ROI[3])) - Y0
  const Z = Math.max(2, Math.min(16, Math.floor(560 / Math.max(CW, CH))))
  const crop = (rgba: Uint8ClampedArray | Uint8Array, w: number): Uint8ClampedArray => {
    const o = new Uint8ClampedArray(CW * Z * CH * Z * 4)
    for (let y = 0; y < CH * Z; y++)
      for (let x = 0; x < CW * Z; x++) {
        const s = ((Y0 + Math.floor(y / Z)) * w + X0 + Math.floor(x / Z)) * 4
        const d = (y * CW * Z + x) * 4
        o[d] = rgba[s]; o[d + 1] = rgba[s + 1]; o[d + 2] = rgba[s + 2]; o[d + 3] = 255
      }
    return o
  }
  const panels = [crop(img.data, img.width), crop(rasterizeDoc(doc, img.width, img.height, { background: [255, 255, 255] }), img.width)]
  // `--labels`: insert the LABEL MAP between source and trace — is the notch already
  // gone before anything is fitted, or did the fit lose it?
  if (argv.includes('--labels') && LABELS) {
    const L = LABELS as { labels: Int32Array; width: number; height: number }
    const lab = new Uint8ClampedArray(L.width * L.height * 4)
    for (let i = 0; i < L.width * L.height; i++) {
      const v = L.labels[i]
      // Hash the label id into a stable, distinguishable colour.
      const h = ((v * 2654435761) >>> 0)
      lab[i * 4] = 64 + (h & 0x7f); lab[i * 4 + 1] = 64 + ((h >> 7) & 0x7f); lab[i * 4 + 2] = 64 + ((h >> 14) & 0x7f); lab[i * 4 + 3] = 255
    }
    panels.splice(1, 0, crop(lab, L.width))
  }
  const GAP = 8
  const W = panels.length * CW * Z + (panels.length - 1) * GAP
  const H = CH * Z
  const sheet = new Uint8ClampedArray(W * H * 4).fill(255)
  panels.forEach((p, i) => {
    const ox = i * (CW * Z + GAP)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < CW * Z; x++) {
        const s = (y * CW * Z + x) * 4
        const d = (y * W + ox + x) * 4
        sheet[d] = p[s]; sheet[d + 1] = p[s + 1]; sheet[d + 2] = p[s + 2]; sheet[d + 3] = 255
      }
  })
  writeFileSync(PNG, encodePng(sheet, W, H))
  console.log(`\nwrote ${PNG}  (source | trace), crop ${X0},${Y0} ${CW}×${CH} @${Z}×`)
}
