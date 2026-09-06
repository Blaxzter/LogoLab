// CORNER SCALE DIAG — the PAIRED per-corner census issue #36 asks for before any fix.
//
//   node --experimental-strip-types src/devtest/cornerScaleDiag.ts                      # gear-teeth
//   node --experimental-strip-types src/devtest/cornerScaleDiag.ts --case bar-caps --verbose
//   node --experimental-strip-types src/devtest/cornerScaleDiag.ts --logo chupa-chups --res 512,1024
//   node --experimental-strip-types src/devtest/cornerScaleDiag.ts --logos --res 512,1024      # §15.7's witness hunt
//   node --experimental-strip-types src/devtest/cornerScaleDiag.ts --logos all --res 512,1024
//   node --experimental-strip-types src/devtest/cornerScaleDiag.ts --case gear-teeth --fit cornerMerge=2
//
// WHY. The audit (docs/absolute-px-audit.md) classifies the corner-snap window family —
// SNAP_SPAN 14 / CORNER_WINDOW 4 / CORNER_MERGE 3 / armGap / SNAP_GAP — as ART or UNCLEAR,
// and every one of its UNRESOLVED recipes 2–6 asks the same question in a different
// column: what does the SAME authored corner do across rasters? `scaleScore` reports
// corner RECALL per lane but not placement; `gearDiag`/`capDiag` read one raster. §28.1's
// lesson (issue #14) is that the paired census is what separates the estimator from the
// selector — an oracle over the existing estimators could not beat the window there —
// so the instrument comes before any constant moves.
//
// WHAT IT DOES. For one authored case, every AUTHORED sharp corner (the scorer's own
// reader, `geomScore.sharpCorners` at CORNER_MIN_EDGE, visibility-filtered at the lab's
// 512 raster) is the key — unlike band seams (§28.1), authored corners exist at every
// raster, so real marks pair too. At each raster the production flat path runs with
// three observers, none of which changes the trace:
//   • the FINAL label map (`onPlanarLabels`) → the crack lattice the detector reads, so
//     the ±CORNER_WINDOW chord turn at the vertex nearest each authored corner is the
//     detector's own reading (recipe 2);
//   • the apex sink (`planarFit.apexDiag`) → per snapped corner: outcome, arm spans,
//     the SNAP_SPAN branch and its `allow`, the per-side `armGap`, the move (recipes 5, 6);
//   • the traced doc → the nearest traced SHARP corner (the scorer's reader again).
// Every distance is reported in 512-px ARTWORK units so the lanes compare; the scorer's
// own native-2.5px verdict rides alongside so the watchlist numbers are reproduced.
//
// WHAT TO READ. The per-raster fold (does placement error track the lattice, i.e. halve
// per doubling, or stay flat?), the FLIPS (corners recovered at one raster and not
// another — §15.7's named residue), and the three recipe tables. `--fit k=v` overrides
// PlanarFitOptions so a counterfactual runs on the SAME census (the `tune` idiom).
//
// PURELY DIAGNOSTIC — no gate, no fix; every hook is undefined in production.

import { readFileSync, readdirSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { buildPlanarNetwork } from '../lib/trace/planarNetwork.ts'
import type { ApexDiagRecord } from '../lib/trace/planarFit.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from './svgGround.ts'
import { sharpCorners, makeVisibleAt, scoreGeometry, CORNER_MIN_EDGE, CORNER_MATCH_R, type Corner } from './geomScore.ts'
import type { SubPath, Vec, EditableDoc } from '../lib/path/types.ts'

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
const VERBOSE = argv.includes('--verbose')
const TOP = Number(flag('--top') || 12)
/** `--crop x,y[,half]` (artwork px): print the final label map + source luma around a point
 *  at every raster, with the traced nodes inside it — the autopsy view for one corner. */
const CROP = (flag('--crop') || '').split(',').map(Number).filter(Number.isFinite)
/** `--jsonl path`: append one JSON line per case (the per-raster fold + every corner's
 *  cells) so a corpus run can be driven ONE PROCESS PER MARK from a shell loop — a mark
 *  that takes the scorer past the heap (microsoft-office @512, geomScore's own cost, not
 *  the tracer's) then loses only itself. `--fold path` prints the gallery summary from
 *  such a file instead of tracing anything. */
const JSONL = flag('--jsonl')
const FOLD = flag('--fold')
/** The reference (artwork) space every lane is compared in — the lab's own raster. */
const REF = 512
/** Join radius, NATIVE px: an apex record belongs to the authored corner nearest its
 *  detected vertex within this. Erosion is ~1–3 native px at any raster (it is AA
 *  physics), so the radius does not scale. */
const JOIN_R = Number(flag('--join') || 6)
/** The detector's window, for the recipe-2 reading (planarFit's CORNER_WINDOW). */
const WIN = 4
const SHARP_DEG = 60
const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '—')

/** `--fit cornerMerge=2,subpixelEdges=false` → PlanarFitOptions override. */
const parseFit = (s: string): Record<string, number | boolean> => {
  const o: Record<string, number | boolean> = {}
  for (const kv of s.split(',').filter(Boolean)) {
    const [k, v] = kv.split('=')
    o[k] = v === 'true' ? true : v === 'false' ? false : Number(v)
  }
  return o
}
const FIT = parseFit(flag('--fit') ?? '')

// --- the case list -----------------------------------------------------------------------

interface Case {
  name: string
  svg: string
}
/** The §15.7 / §18 / §19 witness marks — the letterform marks whose corners have a history. */
const WITNESSES = ['chupa-chups', 'instagram', 'coca-cola', 'mastercard', 'ibm', 'fedex', 'ahrefs-wordmark', 'cnn', 'bluetooth', 'nike']
const cases = ((): Case[] => {
  const logo = flag('--logo')
  if (logo) return [{ name: logo.replace(/\.svg$/, ''), svg: join(root, 'examples', 'logos', `${logo.replace(/\.svg$/, '')}.svg`) }]
  if (argv.includes('--logos')) {
    const dir = join(root, 'examples', 'logos')
    let onDisk: string[]
    try {
      onDisk = readdirSync(dir).filter((x) => x.endsWith('.svg')).map((x) => x.replace(/\.svg$/, ''))
    } catch {
      console.log('  (examples/logos/ is absent — `npm run fetch:logos` rehydrates it)')
      return []
    }
    const arg = flag('--logos')
    const wanted = arg === 'all' ? onDisk : arg ? arg.split(',').map((s) => s.trim()) : WITNESSES
    return wanted.filter((w) => onDisk.includes(w)).map((w) => ({ name: w, svg: join(dir, `${w}.svg`) }))
  }
  const c = flag('--case') || 'gear-teeth'
  return [{ name: c, svg: join(root, 'public', 'examples', 'edge-cases', `${c}.svg`) }]
})()

// --- ground truth: the authored corners, keyed in artwork space -----------------------------

interface GtCorner extends Corner {
  id: number
  /** Authored turn at the corner, deg. */
  turn: number
  /** Shorter incident authored chord, REF px — the feature size the corner sits on. */
  edge: number
}

function authoredCorners(shapes: { subPaths: SubPath[] }[], visible: (q: { x: number; y: number; tx: number; ty: number }) => boolean): GtCorner[] {
  const sets = shapes.map((s) => s.subPaths)
  const raw = sharpCorners(sets, CORNER_MIN_EDGE).filter(
    (c) => visible({ x: c.x, y: c.y, tx: c.itx, ty: c.ity }) || visible({ x: c.x, y: c.y, tx: c.otx, ty: c.oty }),
  )
  // The shorter incident chord, looked up on the authored nodes (sharpCorners gates on it
  // but does not return it).
  const edgeAt = new Map<string, number>()
  for (const sp of sets.flat()) {
    const n = sp.nodes.length
    for (let i = 0; i < n; i++) {
      const cur = sp.nodes[i]
      const prev = sp.nodes[(i - 1 + n) % n]
      const next = sp.nodes[(i + 1) % n]
      const e = Math.min(Math.hypot(cur.x - prev.x, cur.y - prev.y), Math.hypot(next.x - cur.x, next.y - cur.y))
      const k = `${cur.x.toFixed(3)},${cur.y.toFixed(3)}`
      edgeAt.set(k, Math.min(edgeAt.get(k) ?? Infinity, e))
    }
  }
  return raw.map((c, id) => ({
    ...c,
    id,
    turn: (Math.acos(Math.max(-1, Math.min(1, c.itx * c.otx + c.ity * c.oty))) * 180) / Math.PI,
    edge: edgeAt.get(`${c.x.toFixed(3)},${c.y.toFixed(3)}`) ?? NaN,
  }))
}

// --- one lane -------------------------------------------------------------------------------

interface Cell {
  res: number
  /** The detector's own reading at the lattice vertex nearest the corner (max over ±1
   *  vertices, as the NMS picks the local max), deg. NaN when no vertex is within reach. */
  latTurn: number
  /** The lattice vertex's own distance off the authored corner, artwork px. */
  latErr: number
  /** The apex record joined to this corner (nearest detected vertex within JOIN_R). */
  rec: ApexDiagRecord | null
  /** dist(apex, authored) in artwork px; NaN without a record. */
  apexErr: number
  /** dist(raw arm intersection, authored) in artwork px — the ESTIMATOR before any
   *  selector; NaN where no intersection was formed. */
  hitErr: number
  /** Nearest traced SHARP corner, artwork px, and the scorer's native verdict. */
  finalErr: number
  recovered: boolean
}

interface Lane {
  res: number
  cells: Cell[]
  /** The scorer's own numbers for this lane, native (the watchlist cross-check). */
  gtCorners: number
  cornersRecovered: number
  cornersInvented: number
  chamfer: number
  p95: number
}

async function lane(svgText: string, gtCorners: GtCorner[], res: number): Promise<Lane> {
  const img = decodePng(new Resvg(svgText, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng())
  const s = res / REF
  const recs: ApexDiagRecord[] = []
  let raw: { labels: Int32Array; width: number; height: number } | null = null
  const doc: EditableDoc = await traceImage(
    img as unknown as ImageData,
    { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, planarFit: { ...FIT, apexDiag: (r: ApexDiagRecord) => { recs.push(r) } } },
    undefined, undefined, undefined, undefined,
    (l) => { raw = l },
  )
  const docSets: SubPath[][] = []
  for (const it of doc.items) if (it.kind === 'path' && it.visible !== false) docSets.push(it.subPaths)
  const docCorners = sharpCorners(docSets)

  // The lattice the detector reads: every edge's crack points.
  const rr = raw as { labels: Int32Array; width: number; height: number } | null
  const net = rr ? buildPlanarNetwork(rr.labels, rr.width, rr.height) : null

  if (CROP.length >= 2 && rr) {
    const half = CROP[2] ?? 8
    const X = Math.round(CROP[0] * s)
    const Y = Math.round(CROP[1] * s)
    console.log(`\n    CROP @${res} around native (${X},${Y}) — labels | source luma/16 (0 dark … ? light):`)
    for (let y = Y - half; y <= Y + half; y++) {
      let a = ''
      let b = ''
      for (let x = X - half; x <= X + half; x++) {
        const inside = x >= 0 && y >= 0 && x < rr.width && y < rr.height
        const l = inside ? rr.labels[y * rr.width + x] : -1
        a += l < 0 ? '.' : String.fromCharCode(65 + (l % 26))
        const o = (y * img.width + x) * 4
        const lum = inside ? (img.data[o] * 0.299 + img.data[o + 1] * 0.587 + img.data[o + 2] * 0.114) / 16 : 0
        b += String.fromCharCode(48 + Math.min(15, lum | 0))
      }
      console.log(`      ${a}   ${b}`)
    }
    for (const set of docSets) for (const sp of set) for (const nd of sp.nodes) {
      if (Math.abs(nd.x - X) > half || Math.abs(nd.y - Y) > half) continue
      const h = (p: Vec | null | undefined): string => (p ? `(${f(p.x, 1)},${f(p.y, 1)})` : '-')
      console.log(`      node (${f(nd.x)},${f(nd.y)}) hIn ${h(nd.hIn)} hOut ${h(nd.hOut)} ${nd.kind ?? ''}`)
    }
    const near = docCorners.filter((c) => Math.abs(c.x - X) <= 2 * half && Math.abs(c.y - Y) <= 2 * half).map((c) => `(${f(c.x, 1)},${f(c.y, 1)})`)
    console.log(`      traced SHARP corners within ${2 * half}px: ${near.join(' ') || 'none'}`)
  }
  const turnAt = (pts: Vec[], i: number, closed: boolean): number => {
    const n = pts.length
    const wrap = (k: number): number => ((k % n) + n) % n
    if (!closed && (i - WIN < 0 || i + WIN > n - 1)) return NaN
    const a = pts[wrap(i - WIN)]
    const b = pts[i]
    const c = pts[wrap(i + WIN)]
    const ix = b.x - a.x, iy = b.y - a.y, ox = c.x - b.x, oy = c.y - b.y
    const li = Math.hypot(ix, iy), lo = Math.hypot(ox, oy)
    if (li < 1e-9 || lo < 1e-9) return 0
    return (Math.acos(Math.max(-1, Math.min(1, (ix * ox + iy * oy) / (li * lo)))) * 180) / Math.PI
  }

  // EXCLUSIVE join: each record belongs to the authored corner nearest its DETECTED vertex
  // (within JOIN_R), and a corner keeps the nearest of the records that chose it — so a
  // fused pair shows ONE corner with the record and its twin as `lost-apex`, instead of
  // both borrowing the same record.
  const owner = new Map<number, ApexDiagRecord>()
  const ownerD = new Map<number, number>()
  for (const r of recs) {
    let best = -1
    let bd = JOIN_R
    for (const g of gtCorners) {
      const d = Math.hypot(r.cx - g.x * s, r.cy - g.y * s)
      if (d < bd) {
        bd = d
        best = g.id
      }
    }
    if (best < 0) continue
    if (!owner.has(best) || bd < ownerD.get(best)!) {
      owner.set(best, r)
      ownerD.set(best, bd)
    }
  }

  const cells: Cell[] = gtCorners.map((g) => {
    const gx = g.x * s
    const gy = g.y * s
    // Nearest lattice vertex over the whole network.
    let latD = Infinity
    let latTurn = NaN
    if (net) {
      for (const e of net.edges) {
        const pts = e.pts
        for (let i = 0; i < pts.length; i++) {
          const d = Math.hypot(pts[i].x - gx, pts[i].y - gy)
          if (d < latD) {
            latD = d
            const n = pts.length
            const t0 = turnAt(pts, i, e.closed)
            const t1 = turnAt(pts, e.closed ? (i - 1 + n) % n : Math.max(0, i - 1), e.closed)
            const t2 = turnAt(pts, e.closed ? (i + 1) % n : Math.min(n - 1, i + 1), e.closed)
            latTurn = Math.max(t0, Number.isFinite(t1) ? t1 : -1, Number.isFinite(t2) ? t2 : -1)
          }
        }
      }
    }
    const rec = owner.get(g.id) ?? null
    let finalD = Infinity
    for (const c of docCorners) finalD = Math.min(finalD, Math.hypot(c.x - gx, c.y - gy))
    return {
      res,
      latTurn,
      latErr: latD / s,
      rec,
      apexErr: rec ? Math.hypot(rec.ax - gx, rec.ay - gy) / s : NaN,
      hitErr: rec && Number.isFinite(rec.hx) ? Math.hypot(rec.hx - gx, rec.hy - gy) / s : NaN,
      finalErr: finalD / s,
      recovered: finalD <= CORNER_MATCH_R,
    }
  })

  // The scorer's own lane numbers (native), so the watchlist is reproduced verbatim.
  const gtNative = toRasterSpace(parseGroundTruth(svgText), img.width)
  const g = scoreGeometry(gtNative, doc, img.width, img.height, img)
  return { res, cells, gtCorners: g.gtCorners, cornersRecovered: g.cornersRecovered, cornersInvented: g.cornersInvented, chamfer: g.chamfer, p95: g.p95 }
}

// --- reporting ------------------------------------------------------------------------------

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const pctl = (xs: number[], p: number): number => {
  if (!xs.length) return NaN
  const s = xs.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}
const max = (xs: number[]): number => (xs.length ? Math.max(...xs) : NaN)
const hist = (keys: string[]): string => {
  const m = new Map<string, number>()
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ')
}
const outcomeOf = (c: Cell): string => (c.rec ? c.rec.outcome : Number.isFinite(c.latTurn) && c.latTurn >= SHARP_DEG ? 'lost-apex' : 'undetected')
const branchOf = (r: ApexDiagRecord): string => (Math.min(r.inSpan, r.outSpan) >= 14 ? 'full' : 'short')

interface Witness {
  mark: string
  g: GtCorner
  cells: Map<number, Cell>
}
const witnesses: Witness[] = []

async function census(cs: Case): Promise<void> {
  const svgText = readFileSync(cs.svg, 'utf8')
  const gt = parseGroundTruth(svgText)
  const why = unscorable(gt)
  if (why) {
    console.log(`\n━━━ ${cs.name}: unscorable (${why}) — skipped ━━━`)
    return
  }
  const refImg = decodePng(new Resvg(svgText, { fitTo: { mode: 'width', value: REF }, background: 'white' }).render().asPng())
  const gtCorners = authoredCorners(toRasterSpace(gt, refImg.width), makeVisibleAt(refImg))
  if (cases.length > 1) console.error(`  … ${cs.name} (${gtCorners.length} corners)`)
  const lanes: Lane[] = []
  for (const res of RESOLUTIONS) lanes.push(await lane(svgText, gtCorners, res))

  console.log(`\n━━━ PAIRED CORNER CENSUS — ${cs.name} @ ${RESOLUTIONS.join('/')}  (${gtCorners.length} authored corners; errors in ${REF}-px artwork units)${Object.keys(FIT).length ? `  fit ${JSON.stringify(FIT)}` : ''} ━━━`)
  {
    const turns = gtCorners.map((g) => g.turn)
    const edges = gtCorners.map((g) => g.edge)
    console.log(`    authored turn: ${f(pctl(turns, 0), 1)}–${f(pctl(turns, 0.5), 1)}–${f(max(turns), 1)}°   shorter incident edge: ${f(pctl(edges, 0), 1)}–${f(pctl(edges, 0.5), 1)}–${f(max(edges), 1)} artwork px`)
  }

  // --- per-raster fold ---
  console.log(`\n    ${'res'.padStart(5)}  ${'scorer'.padStart(9)}  ${'census'.padStart(7)}  ${'inv'.padStart(3)}  ${'chamfer'.padStart(7)}  ${'lat err'.padStart(8)}  ${'apex err'.padStart(9)}  ${'final err (recovered) mean/p90/max'.padStart(34)}  ${'final err (all) mean/max'.padStart(24)}   outcomes`)
  for (const L of lanes) {
    const rec = L.cells.filter((c) => c.recovered)
    console.log(
      `    ${String(L.res).padStart(5)}  ${`${L.cornersRecovered}/${L.gtCorners}`.padStart(9)}  ${`${rec.length}/${L.cells.length}`.padStart(7)}  ${String(L.cornersInvented).padStart(3)}  ${f(L.chamfer, 3).padStart(7)}` +
        `  ${f(mean(L.cells.map((c) => c.latErr)), 3).padStart(8)}  ${f(mean(L.cells.filter((c) => c.rec).map((c) => c.apexErr)), 3).padStart(9)}` +
        `  ${`${f(mean(rec.map((c) => c.finalErr)), 3)} / ${f(pctl(rec.map((c) => c.finalErr), 0.9), 3)} / ${f(max(rec.map((c) => c.finalErr)), 3)}`.padStart(34)}` +
        `  ${`${f(mean(L.cells.map((c) => Math.min(c.finalErr, 50))), 3)} / ${f(max(L.cells.map((c) => c.finalErr)), 2)}`.padStart(24)}   ${hist(L.cells.map(outcomeOf))}`,
    )
  }
  console.log(`    (scorer = geomScore's native-2.5px recall for the lane, the watchlist number; census = the same rule on the ${REF}-keyed corner set; inv = corners invented; 'lost-apex' = the lattice reads ≥ ${SHARP_DEG}° at the corner but no apex record of its own — its cluster fused with a neighbour's; 'undetected' = the lattice reads < ${SHARP_DEG}°)`)

  // --- the estimator in NATIVE px: is its error a function of the raster or of the art? ---
  console.log(`\n    ESTIMATOR IN NATIVE PX (records with an arm intersection) — lattice vertex / raw intersection / chosen apex, mean · p90 · max off the authored corner:`)
  console.log(`    ${'res'.padStart(5)}  ${'n'.padStart(4)}  ${'lattice'.padStart(20)}  ${'raw intersection'.padStart(20)}  ${'chosen apex'.padStart(20)}`)
  for (const L of lanes) {
    const s = L.res / REF
    const cs = L.cells.filter((c) => c.rec && Number.isFinite(c.hitErr))
    const stat = (xs: number[]): string => `${f(mean(xs) * s)} · ${f(pctl(xs, 0.9) * s)} · ${f(max(xs) * s)}`
    console.log(`    ${String(L.res).padStart(5)}  ${String(cs.length).padStart(4)}  ${stat(cs.map((c) => c.latErr)).padStart(20)}  ${stat(cs.map((c) => c.hitErr)).padStart(20)}  ${stat(cs.map((c) => c.apexErr)).padStart(20)}`)
  }

  // --- the SELECTOR: per outcome, would the raw intersection have beaten what was kept? ---
  console.log(`\n    SELECTOR — per outcome and raster: what the rule kept vs what the raw intersection offered (artwork px). 'hit better' = the refused/clamped intersection was ≥ 0.25 px closer to the authored corner than the kept apex; 'kept better' the reverse; else 'same'.`)
  console.log(`    ${'res'.padStart(5)}  ${'outcome'.padEnd(14)}  ${'n'.padStart(4)}  ${'kept err mean/max'.padStart(18)}  ${'hit err mean/max'.padStart(18)}  ${'hit better'.padStart(10)}  ${'kept better'.padStart(11)}  ${'same'.padStart(5)}`)
  for (const L of lanes) {
    const by = new Map<string, Cell[]>()
    for (const c of L.cells) {
      if (!c.rec || !Number.isFinite(c.hitErr)) continue
      const k = c.rec.outcome
      if (!by.has(k)) by.set(k, [])
      by.get(k)!.push(c)
    }
    for (const [k, cs] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const hb = cs.filter((c) => c.hitErr < c.apexErr - 0.25).length
      const kb = cs.filter((c) => c.apexErr < c.hitErr - 0.25).length
      console.log(
        `    ${String(L.res).padStart(5)}  ${k.padEnd(14)}  ${String(cs.length).padStart(4)}  ${`${f(mean(cs.map((c) => c.apexErr)))} / ${f(max(cs.map((c) => c.apexErr)))}`.padStart(18)}  ${`${f(mean(cs.map((c) => c.hitErr)))} / ${f(max(cs.map((c) => c.hitErr)))}`.padStart(18)}  ${String(hb).padStart(10)}  ${String(kb).padStart(11)}  ${String(cs.length - hb - kb).padStart(5)}`,
      )
    }
  }

  // --- recipe 2: the detector's reading, per raster, by authored turn class ---
  console.log(`\n    RECIPE 2 — the ±${WIN} chord turn the detector reads at each authored corner (min–median–max, and how many read ≥ ${SHARP_DEG}°), by authored turn:`)
  const classes = [...new Set(gtCorners.map((g) => Math.round(g.turn)))].sort((a, b) => a - b)
  const classOf = (g: GtCorner): number => Math.round(g.turn)
  console.log(`    ${'authored'.padStart(9)}  ${'n'.padStart(3)}  ${RESOLUTIONS.map((r) => `@${r}`.padStart(22)).join('')}`)
  for (const cl of classes) {
    const ids = gtCorners.filter((g) => classOf(g) === cl).map((g) => g.id)
    if (ids.length === 0) continue
    const cols = lanes.map((L) => {
      const ts = ids.map((id) => L.cells[id].latTurn).filter(Number.isFinite)
      return `${f(pctl(ts, 0), 0)}–${f(pctl(ts, 0.5), 0)}–${f(max(ts), 0)}° (${ts.filter((t) => t >= SHARP_DEG).length}/${ids.length})`.padStart(22)
    })
    console.log(`    ${`${cl}°`.padStart(9)}  ${String(ids.length).padStart(3)}  ${cols.join('')}`)
  }

  // --- recipe 6: SNAP_SPAN branch + allow ---
  console.log(`\n    RECIPE 6 — the snap's evidence window per raster (records joined to an authored corner): shortSpan = min(inSpan,outSpan), branch full ⇔ shortSpan ≥ 14, allow reached ⇔ moved ≥ 0.9·allow`)
  console.log(`    ${'res'.padStart(5)}  ${'recs'.padStart(4)}  ${'shortSpan max'.padStart(13)}  ${'shortSpan hist'.padStart(40)}  ${'branch'.padStart(16)}  ${'moved (reconstructed) mean/p90/max'.padStart(34)}  ${'allow reached'.padStart(13)}  ${'over-cap'.padStart(8)}`)
  for (const L of lanes) {
    const rs = L.cells.filter((c) => c.rec).map((c) => c.rec!)
    const spans = rs.map((r) => Math.min(r.inSpan, r.outSpan))
    const spanHist = (() => {
      const m = new Map<number, number>()
      for (const sp of spans) m.set(sp, (m.get(sp) ?? 0) + 1)
      return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}:${n}`).join(' ')
    })()
    const recon = rs.filter((r) => r.outcome === 'reconstructed' || r.outcome === 'past-evidence')
    const reached = recon.filter((r) => r.allow > 0 && r.moved >= 0.9 * r.allow).length
    console.log(
      `    ${String(L.res).padStart(5)}  ${String(rs.length).padStart(4)}  ${f(max(spans), 0).padStart(13)}  ${spanHist.padStart(40)}  ${hist(rs.map(branchOf)).padStart(16)}` +
        `  ${`${f(mean(recon.map((r) => r.moved)), 2)} / ${f(pctl(recon.map((r) => r.moved), 0.9), 2)} / ${f(max(recon.map((r) => r.moved)), 2)} px`.padStart(34)}  ${String(reached).padStart(13)}  ${String(rs.filter((r) => r.outcome === 'over-cap').length).padStart(8)}`,
    )
  }

  // --- recipe 5: armGap per corner across rasters ---
  console.log(`\n    RECIPE 5 — armGap per corner (the smaller of the two sides), paired: does the SAME corner get a different gap at a different raster?`)
  console.log(`    ${'res'.padStart(5)}  ${'gap hist (min side)'.padStart(24)}  ${'gap hist (max side)'.padStart(24)}`)
  for (const L of lanes) {
    const rs = L.cells.filter((c) => c.rec).map((c) => c.rec!)
    console.log(`    ${String(L.res).padStart(5)}  ${hist(rs.map((r) => `g${Math.min(r.inGap, r.outGap)}`)).padStart(24)}  ${hist(rs.map((r) => `g${Math.max(r.inGap, r.outGap)}`)).padStart(24)}`)
  }
  if (lanes.length >= 2) {
    const pairs: string[] = []
    for (const g of gtCorners) {
      const gaps = lanes.map((L) => (L.cells[g.id].rec ? Math.min(L.cells[g.id].rec!.inGap, L.cells[g.id].rec!.outGap) : -1))
      if (gaps.some((x) => x < 0)) continue
      pairs.push(gaps.join('→'))
    }
    console.log(`    corners with a record at EVERY raster: ${pairs.length} — gap trajectories ${RESOLUTIONS.join('→')}: ${hist(pairs)}`)
  }

  // --- flips: recovered at some rasters and not others ---
  console.log(`\n    FLIPS — corners the scorer recovers at some rasters and not others (outcome · final err in artwork px per raster):`)
  let flips = 0
  const rows = gtCorners
    .map((g) => ({ g, cells: lanes.map((L) => L.cells[g.id]) }))
    .filter((r) => new Set(r.cells.map((c) => c.recovered)).size > 1)
  for (const r of rows) {
    flips++
    if (flips > TOP && !VERBOSE) continue
    console.log(`      #${String(r.g.id).padStart(3)} @(${f(r.g.x, 0)},${f(r.g.y, 0)}) turn ${f(r.g.turn, 0)}° edge ${f(r.g.edge, 1)}  ${r.cells.map((c) => `${c.res}:${c.recovered ? '✓' : '✗'} ${outcomeOf(c).padEnd(13)} ${f(c.finalErr)}`).join('   ')}`)
  }
  console.log(`    ${flips} of ${gtCorners.length} corners flip across rasters${flips > TOP && !VERBOSE ? ` (first ${TOP} shown; --verbose for all)` : ''}`)
  for (const r of rows) witnesses.push({ mark: cs.name, g: r.g, cells: new Map(r.cells.map((c) => [c.res, c])) })

  // --- worst placements at the lab raster ---
  const lab = lanes.find((L) => L.res === REF) ?? lanes[0]
  console.log(`\n    WORST final placements @${lab.res} among recovered corners (artwork px), with the paired numbers at the other rasters:`)
  const worst = gtCorners
    .map((g) => ({ g, c: lab.cells[g.id] }))
    .filter((x) => x.c.recovered)
    .sort((a, b) => b.c.finalErr - a.c.finalErr)
    .slice(0, VERBOSE ? gtCorners.length : Math.min(TOP, 8))
  for (const w of worst) {
    console.log(`      #${String(w.g.id).padStart(3)} @(${f(w.g.x, 0)},${f(w.g.y, 0)}) turn ${f(w.g.turn, 0)}° edge ${f(w.g.edge, 1)}  ${lanes.map((L) => { const c = L.cells[w.g.id]; return `${L.res}: ${outcomeOf(c).padEnd(13)} lat ${f(c.latErr)} apex ${f(c.apexErr)} final ${f(c.finalErr)}${c.rec ? ` sp${c.rec.inSpan}/${c.rec.outSpan} g${c.rec.inGap}/${c.rec.outGap} mv${f(c.rec.moved, 1)}/${f(c.rec.allow, 1)}` : ''}` }).join('  |  ')}`)
  }

  if (JSONL) {
    const line = {
      name: cs.name,
      corners: gtCorners.map((g) => ({ id: g.id, x: g.x, y: g.y, turn: g.turn, edge: g.edge })),
      lanes: lanes.map((L) => ({
        res: L.res, gtCorners: L.gtCorners, cornersRecovered: L.cornersRecovered, cornersInvented: L.cornersInvented, chamfer: L.chamfer, p95: L.p95,
        cells: L.cells.map((c) => ({
          outcome: outcomeOf(c), latTurn: c.latTurn, latErr: c.latErr, apexErr: c.apexErr, hitErr: c.hitErr, finalErr: c.finalErr, recovered: c.recovered,
          inSpan: c.rec?.inSpan ?? -1, outSpan: c.rec?.outSpan ?? -1, inGap: c.rec?.inGap ?? -1, outGap: c.rec?.outGap ?? -1, moved: c.rec?.moved ?? NaN, allow: c.rec?.allow ?? NaN,
        })),
      })),
    }
    appendFileSync(JSONL, JSON.stringify(line) + '\n')
  }

  if (VERBOSE) {
    console.log(`\n    EVERY corner:`)
    for (const g of gtCorners) {
      console.log(`      #${String(g.id).padStart(3)} @(${f(g.x, 0)},${f(g.y, 0)}) turn ${f(g.turn, 0)}° edge ${f(g.edge, 1)}  ${lanes.map((L) => { const c = L.cells[g.id]; return `${L.res}: ${c.recovered ? '✓' : '✗'} ${outcomeOf(c).padEnd(13)} turn ${f(c.latTurn, 0)}° lat ${f(c.latErr)} apex ${f(c.apexErr)} final ${f(c.finalErr)}${c.rec ? ` sp${c.rec.inSpan}/${c.rec.outSpan} g${c.rec.inGap}/${c.rec.outGap} mv${f(c.rec.moved, 1)}/${f(c.rec.allow, 1)}` : ''}` }).join('  |  ')}`)
    }
  }
}

// --- `--fold file.jsonl`: the corpus summary from per-mark lines (one process per mark) ----
if (FOLD) {
  type Line = { name: string; corners: { id: number; x: number; y: number; turn: number; edge: number }[]; lanes: { res: number; gtCorners: number; cornersRecovered: number; cornersInvented: number; chamfer: number; cells: { outcome: string; latErr: number; apexErr: number; hitErr: number; finalErr: number; recovered: boolean; inSpan: number; outSpan: number }[] }[] }
  const lines: Line[] = readFileSync(FOLD, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const RES = lines[0]?.lanes.map((L) => L.res) ?? []
  console.log(`\n━━━ CORPUS FOLD — ${lines.length} marks from ${FOLD} @ ${RES.join('/')} ━━━`)
  console.log(`    ${'res'.padStart(5)}  ${'scorer recall'.padStart(14)}  ${'invented'.padStart(8)}  ${'chamfer mean'.padStart(12)}  ${'final err (recovered) mean/p90'.padStart(30)}   outcomes`)
  for (const [i, res] of RES.entries()) {
    const Ls = lines.map((l) => l.lanes[i]).filter(Boolean)
    const cells = Ls.flatMap((L) => L.cells)
    const rec = cells.filter((c) => c.recovered)
    console.log(
      `    ${String(res).padStart(5)}  ${`${Ls.reduce((a, L) => a + L.cornersRecovered, 0)}/${Ls.reduce((a, L) => a + L.gtCorners, 0)}`.padStart(14)}  ${String(Ls.reduce((a, L) => a + L.cornersInvented, 0)).padStart(8)}  ${f(mean(Ls.map((L) => L.chamfer)), 3).padStart(12)}` +
        `  ${`${f(mean(rec.map((c) => c.finalErr)), 3)} / ${f(pctl(rec.map((c) => c.finalErr), 0.9), 3)}`.padStart(30)}   ${hist(cells.map((c) => c.outcome))}`,
    )
  }
  console.log(`\n    SELECTOR (short-arm records, corpus-wide): n · hit better · kept better · same (±0.25 artwork px)`)
  for (const [i, res] of RES.entries()) {
    const cs = lines.flatMap((l) => l.lanes[i]?.cells ?? []).filter((c) => c.outcome === 'short-arm' && Number.isFinite(c.hitErr))
    const hb = cs.filter((c) => c.hitErr < c.apexErr - 0.25).length
    const kb = cs.filter((c) => c.apexErr < c.hitErr - 0.25).length
    console.log(`    ${String(res).padStart(5)}  ${cs.length} · ${hb} · ${kb} · ${cs.length - hb - kb}`)
  }
  const lab = RES.includes(REF) ? RES.indexOf(REF) : 0
  const fine = RES.length - 1
  const flips = lines.flatMap((l) => l.corners.map((g) => ({ mark: l.name, g, cells: l.lanes.map((L) => L.cells[g.id]) }))).filter((r) => new Set(r.cells.map((c) => c?.recovered)).size > 1)
  const pat = new Map<string, number>()
  for (const r of flips) {
    const k = r.cells.map((c) => (c?.recovered ? '✓' : '✗')).join('')
    pat.set(k, (pat.get(k) ?? 0) + 1)
  }
  console.log(`\n    FLIPS: ${flips.length} corners recovered at some rasters and not others — pattern ${RES.join('/')}: ${[...pat.entries()].map(([k, n]) => `${k} ${n}`).join(' · ')}`)
  const pop = flips.filter((r) => !r.cells[lab]?.recovered && r.cells[fine]?.recovered)
  const turnBucket = (t: number): string => (t < 75 ? '60–75°' : t < 100 ? '75–100°' : '>100°')
  console.log(`    recovered @${RES[fine]}, MISSED @${RES[lab]} (${pop.length}) — by outcome @${RES[lab]}: ${hist(pop.map((r) => r.cells[lab].outcome))}`)
  console.log(`    …by authored turn: ${hist(pop.map((r) => turnBucket(r.g.turn)))}   …by shorter incident edge: ${hist(pop.map((r) => (r.g.edge < 10 ? '<10px' : r.g.edge < 20 ? '10–20px' : '≥20px')))}`)
  for (const r of pop.sort((a, b) => a.cells[lab].finalErr - b.cells[lab].finalErr).slice(0, VERBOSE ? pop.length : TOP)) {
    console.log(`      ${r.mark.padEnd(18)} #${String(r.g.id).padStart(3)} @(${f(r.g.x, 0)},${f(r.g.y, 0)}) turn ${f(r.g.turn, 0)}° edge ${f(r.g.edge, 1).padStart(5)}  ${RES.map((res, i) => { const c = r.cells[i]; return `${res}: ${c.recovered ? '✓' : '✗'} ${c.outcome.padEnd(13)} final ${f(c.finalErr)}` }).join('  |  ')}`)
  }
  console.log()
  process.exit(0)
}

for (const cs of cases) await census(cs)

// --- the gallery fold: §15.7's witness population -------------------------------------------
if (cases.length > 1) {
  console.log(`\n━━━ GALLERY WITNESSES — authored corners recovered at one raster and not another (${cases.length} marks @ ${RESOLUTIONS.join('/')}) ━━━`)
  const byPattern = new Map<string, number>()
  for (const w of witnesses) {
    const pat = RESOLUTIONS.map((r) => (w.cells.get(r)?.recovered ? '✓' : '✗')).join('')
    byPattern.set(pat, (byPattern.get(pat) ?? 0) + 1)
  }
  console.log(`    ${witnesses.length} flipping corners; recovery pattern ${RESOLUTIONS.join('/')}: ${[...byPattern.entries()].map(([k, n]) => `${k} ${n}`).join(' · ')}`)
  const lab = RESOLUTIONS.includes(REF) ? REF : RESOLUTIONS[0]
  const fine = RESOLUTIONS[RESOLUTIONS.length - 1]
  const missLab = witnesses.filter((w) => !w.cells.get(lab)?.recovered && w.cells.get(fine)?.recovered)
  console.log(`\n    recovered @${fine}, MISSED @${lab} — the §15.7 population (${missLab.length}), by how far the @${lab} trace's nearest sharp corner sits (artwork px):`)
  for (const w of missLab.sort((a, b) => a.cells.get(lab)!.finalErr - b.cells.get(lab)!.finalErr).slice(0, VERBOSE ? missLab.length : 40)) {
    console.log(`      ${w.mark.padEnd(18)} #${String(w.g.id).padStart(3)} @(${f(w.g.x, 0)},${f(w.g.y, 0)}) turn ${f(w.g.turn, 0)}° edge ${f(w.g.edge, 1).padStart(5)}  ${RESOLUTIONS.map((r) => { const c = w.cells.get(r)!; return `${r}: ${c.recovered ? '✓' : '✗'} ${outcomeOf(c).padEnd(13)} final ${f(c.finalErr)}${c.rec ? ` sp${c.rec.inSpan}/${c.rec.outSpan} mv${f(c.rec.moved, 1)}` : ''}` }).join('  |  ')}`)
  }
}
console.log()
