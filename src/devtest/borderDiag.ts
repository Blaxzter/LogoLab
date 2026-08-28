// BORDER DIAG — the one zone no gate in this repo has ever scored.
//
//   node --experimental-strip-types src/devtest/borderDiag.ts                 # tier-0 fixtures
//   node --max-old-space-size=6144 ... borderDiag.ts --logos                  # the whole gallery
//   node --experimental-strip-types src/devtest/borderDiag.ts --case mastercard --list
//   node --experimental-strip-types src/devtest/borderDiag.ts --gate --logos  # ranked table
//   --res N (default 512)   --band P (default 3)   --deg D (default 15)   --fit k=v
//   --gradients   --list (per-site dump)   --min P (list threshold, px)
//
// WHY. `geomScore.collectBoundary` drops every query point within BORDER_EPS (1.5px) of the
// canvas rectangle, from BOTH sides, deliberately: a traced doc always carries a background
// region whose outline runs the full canvas rect, and authored art usually does not, so
// admitting those points would have the reverse distance dominated by a boundary with no
// counterpart by construction. The consequence is that border-edge fidelity is excluded from
// chamfer / p95 / missed / spurious on every case, every tier, every resolution — issue #9.
// A defect there can only be seen by eye, which is the same "no red number to beat" hole
// that let the §12 low-res family and the §15 scale family live for months.
//
// THE DISCRIMINATOR, and why the naive lens does not work. You cannot simply re-admit the
// band: the frame is still there and still has no authored counterpart. Nor can you score
// FROM the authored side only — the frame runs along the entire rect, so every authored
// border sample finds traced boundary ~0px away (the frame itself) and the lens reads
// perfect while the art is visibly ragged.
//
// What separates them is DIRECTION. Inside the band, boundary is one of two things:
//   • PARALLEL to the near canvas edge — the background frame's run, or art cut flush by
//     the crop. Both are framing, not drawing; neither is evidence about the tracer. Held
//     out, exactly as today.
//   • TRANSVERSAL — a real boundary of the art descending INTO the canvas edge (mastercard's
//     glyph stems meeting y=h). This has authored truth, it is what #9's symptom is made of,
//     and it is scorable against that truth like any other boundary.
// So the lens keeps the exclusion's intent (the frame never enters) while recovering the
// only part of the band that carries a claim about the trace.
//
// WHAT IT REPORTS, and the number that matters. A raw px value in the band means little on
// its own — a mark whose art is busy at the edge will read worse than a calm one for
// reasons that are not defects. The headline is therefore the RATIO: border-band chamfer
// over the same mark's INTERIOR chamfer, measured the same way in the same run. "This
// mark's border zone is 3.1x its own interior" is a red number; "0.42px" is not.
//
// The second half of #9's symptom is "odd corners", which no distance metric sees well: a
// C0 kink on a short arc barely moves chamfer (§23's whole point). So the band also gets a
// corner census in the §23 form — a traced sharp corner's own kink minus the AUTHORED
// boundary's turn over the same span — restricted to the band and to transversal sites.
//
// PURELY DIAGNOSTIC. It builds no gate and changes no production code; it exists so that a
// gate CAN be built on a measured distribution rather than a guess (§0's rule: the
// instrument comes first, no fix without a red number).
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from './svgGround.ts'
import { sharpCorners, makeVisibleAt, flattenSubPath, CORNER_MATCH_R } from './geomScore.ts'
import type { SubPath } from '../lib/path/types.ts'

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
/** Half-width of the border band (px). Wider than BORDER_EPS 1.5 on purpose: the approach
 *  zone is where the ragged run starts, and 1.5 only covers the contact itself. */
const BAND = Number(flag('--band') ?? 3)
/** A sample whose tangent is within this of the near canvas edge counts as PARALLEL (frame
 *  or flush cut) and is held out. 15 deg admits a stem meeting the edge at 75 deg or steeper. */
const PAR_DEG = Number(flag('--deg') ?? 15)
const GRADIENTS = argv.includes('--gradients')
const LIST = argv.includes('--list')
const LIST_MIN = Number(flag('--min') ?? 1.0)
const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '  —  ')
const parseFit = (s: string): Record<string, number | boolean> => {
  const o: Record<string, number | boolean> = {}
  for (const kv of s.split(',').filter(Boolean)) {
    const [k, v] = kv.split('=')
    o[k] = v === 'true' ? true : v === 'false' ? false : Number(v)
  }
  return o
}

/** Arc-length step both boundaries are resampled at — the resolution of every window below. */
const STEP = 0.5
/** A traced corner further than this from authored boundary is invented BOUNDARY, which is
 *  spuriousMax's job rather than this lens's (kinkDiag's NEAR, same reason). */
const NEAR = 2.0
/** Authored window (px) the traced kink is compared against, in the §23 like-for-like form. */
const WIN = Number(flag('--win') ?? 1)
const PAR_SIN = Math.sin((PAR_DEG * Math.PI) / 180)

interface Sample { x: number; y: number; tx: number; ty: number }
interface Seg { ax: number; ay: number; bx: number; by: number }

/** Uniform-arc-length resample of one subpath, with tangents. */
function chainOf(sp: SubPath): Sample[] {
  const poly = flattenSubPath(sp)
  if (poly.length < 2) return []
  const pts = sp.closed !== false && (poly[0].x !== poly[poly.length - 1].x || poly[0].y !== poly[poly.length - 1].y)
    ? [...poly, poly[0]]
    : poly
  const out: Sample[] = []
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const seg = Math.hypot(b.x - a.x, b.y - a.y)
    if (seg <= 1e-9) continue
    const tx = (b.x - a.x) / seg
    const ty = (b.y - a.y) / seg
    let t = STEP - carry
    while (t <= seg) {
      const u = t / seg
      out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, tx, ty })
      t += STEP
    }
    carry = (carry + seg) % STEP
  }
  return out
}

function segsOf(sp: SubPath, out: Seg[]): void {
  const poly = flattenSubPath(sp)
  if (poly.length < 2) return
  const pts = sp.closed !== false && (poly[0].x !== poly[poly.length - 1].x || poly[0].y !== poly[poly.length - 1].y)
    ? [...poly, poly[0]]
    : poly
  for (let i = 1; i < pts.length; i++) out.push({ ax: pts[i - 1].x, ay: pts[i - 1].y, bx: pts[i].x, by: pts[i].y })
}

function distToSeg(px: number, py: number, s: Seg): number {
  const dx = s.bx - s.ax
  const dy = s.by - s.ay
  const l2 = dx * dx + dy * dy
  let t = l2 > 0 ? ((px - s.ax) * dx + (py - s.ay) * dy) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(px - (s.ax + t * dx), py - (s.ay + t * dy))
}

/**
 * Uniform-grid nearest-segment index. Brute force is O(queries x segments) and both run to
 * 10^5 on a busy mark — 10^10 distance evaluations, i.e. it never finishes. The grid buckets
 * every segment into the cells its bounding box touches, then a query walks rings outward
 * and stops once the ring's guaranteed-minimum distance exceeds the best found, which is
 * exact (not approximate) for the nearest-distance question this lens asks.
 */
class SegGrid {
  private cell: number
  private cols: number
  private rows: number
  private bins: number[][]
  private segs: Seg[]
  // No parameter properties: `node --experimental-strip-types` is strip-only and rejects them.
  constructor(segs: Seg[], w: number, h: number, cell = 8) {
    this.segs = segs
    this.cell = cell
    this.cols = Math.max(1, Math.ceil(w / cell))
    this.rows = Math.max(1, Math.ceil(h / cell))
    this.bins = Array.from({ length: this.cols * this.rows }, () => [] as number[])
    segs.forEach((s, i) => {
      const x0 = Math.max(0, Math.floor(Math.min(s.ax, s.bx) / cell))
      const x1 = Math.min(this.cols - 1, Math.floor(Math.max(s.ax, s.bx) / cell))
      const y0 = Math.max(0, Math.floor(Math.min(s.ay, s.by) / cell))
      const y1 = Math.min(this.rows - 1, Math.floor(Math.max(s.ay, s.by) / cell))
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.bins[y * this.cols + x].push(i)
    })
  }
  nearest(px: number, py: number): number {
    const cx = Math.max(0, Math.min(this.cols - 1, Math.floor(px / this.cell)))
    const cy = Math.max(0, Math.min(this.rows - 1, Math.floor(py / this.cell)))
    let best = Infinity
    const maxR = Math.max(this.cols, this.rows)
    for (let r = 0; r <= maxR; r++) {
      // Everything in rings beyond this one is at least (r-1)*cell away.
      if (best < (r - 1) * this.cell) break
      for (let y = cy - r; y <= cy + r; y++) {
        if (y < 0 || y >= this.rows) continue
        for (let x = cx - r; x <= cx + r; x++) {
          if (x < 0 || x >= this.cols) continue
          // Only the ring's shell — the interior was covered by smaller r.
          if (r > 0 && Math.abs(y - cy) !== r && Math.abs(x - cx) !== r) continue
          for (const i of this.bins[y * this.cols + x]) {
            const d = distToSeg(px, py, this.segs[i])
            if (d < best) best = d
          }
        }
      }
    }
    return best
  }
}

/** Distance to the canvas rectangle, and that edge's own direction. */
function edgeOf(p: Sample, w: number, h: number): { d: number; ex: number; ey: number } {
  const dl = p.x
  const dr = w - p.x
  const dt = p.y
  const db = h - p.y
  const m = Math.min(dl, dr, dt, db)
  // Left/right edges run vertically; top/bottom run horizontally.
  return m === dl || m === dr ? { d: m, ex: 0, ey: 1 } : { d: m, ex: 1, ey: 0 }
}

/** PARALLEL to the near canvas edge = the frame's run or a flush crop. Held out. */
const isParallel = (p: Sample, w: number, h: number): boolean => {
  const e = edgeOf(p, w, h)
  return Math.abs(p.tx * e.ey - p.ty * e.ex) < PAR_SIN
}
const inBand = (p: Sample, w: number, h: number): boolean => edgeOf(p, w, h).d <= BAND

/** The four canvas CORNERS are where the background frame turns 90 degrees, so one or two
 *  of its samples read transversal there and leak into the lane as a phantom site. Art that
 *  genuinely reaches a canvas corner is rare and would be indistinguishable from the frame
 *  anyway, so the corner neighbourhood is held out with the rest of the framing. */
const atCanvasCorner = (p: Sample, w: number, h: number): boolean =>
  Math.min(p.x, w - p.x) <= BAND && Math.min(p.y, h - p.y) <= BAND

/** Below this many transversal band samples a case has no border evidence, and its ratio is
 *  noise (annulus read 2197x off TWO samples). Reported as unscorable, never as a number —
 *  the `samples === 0` lesson in GeomScore, which this lens inherits wholesale. */
const MIN_BAND_N = Number(flag('--minband') ?? 20)

const mean = (a: number[]): number => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN)
/** Reduce, not `Math.max(...a)` — these arrays run to 10^5 samples and the spread overflows. */
const maxOf = (a: number[]): number => a.reduce((s, v) => (v > s ? v : s), 0)
const pct = (a: number[], p: number): number => {
  if (!a.length) return NaN
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

interface Lane { chamfer: number; p95: number; max: number; missed: number; spurious: number; n: number }
const laneOf = (missed: number[], spurious: number[]): Lane => ({
  chamfer: mean([...missed, ...spurious]),
  p95: pct([...missed, ...spurious], 0.95),
  max: Math.max(maxOf(missed), maxOf(spurious)),
  missed: mean(missed),
  spurious: mean(spurious),
  n: missed.length + spurious.length,
})

interface Site { x: number; y: number; kink: number; authored: number; excess: number }
export interface BorderReport {
  name: string
  band: Lane
  interior: Lane
  /** band chamfer / interior chamfer — the headline. */
  ratio: number
  /** In-band samples held out as frame/flush, both sides. */
  parallelHeld: number
  /** Traced sharp corners in the band whose kink exceeds the authored turn there. */
  sites: Site[]
}

async function analyse(name: string, text: string, fit: Record<string, number | boolean>): Promise<BorderReport | null> {
  let gtDoc
  try {
    gtDoc = parseGroundTruth(text)
  } catch {
    return null
  }
  if (unscorable(gtDoc)) return null
  let raster
  try {
    raster = decodePng(new Resvg(text, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
  } catch {
    return null
  }
  const w = raster.width
  const h = raster.height
  const gt = toRasterSpace(gtDoc, w)
  const vis = makeVisibleAt(raster)
  const doc = await traceImage(raster as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: GRADIENTS, planarFit: fit,
  })
  const docSets = doc.items.flatMap((it) => (it.kind === 'path' ? it.subPaths : [])) as SubPath[]
  const gtSets = gt.flatMap((s) => s.subPaths)

  const gtSegs: Seg[] = []
  const docSegs: Seg[] = []
  for (const sp of gtSets) segsOf(sp, gtSegs)
  for (const sp of docSets) segsOf(sp, docSegs)
  if (!gtSegs.length || !docSegs.length) return null
  const gtGrid = new SegGrid(gtSegs, w, h)
  const docGrid = new SegGrid(docSegs, w, h)

  const gtPts = gtSets.flatMap(chainOf)
  const docPts = docSets.flatMap(chainOf)

  // The two lanes. Targets are the FULL opposite segment set in both cases — only the
  // QUERY side is filtered, exactly as collectBoundary does with its own exclusions.
  const bandMissed: number[] = []
  const bandSpurious: number[] = []
  // The interior lane is only ever REPORTED as a mean, and storing its distances is what
  // put the 152-mark gallery sweep over an 8GB heap (both sides run to 10^5 samples per
  // mark). Accumulated as a running sum instead; the band arrays stay whole because they
  // are small and the p95/max are printed.
  let intSum = 0
  let intN = 0
  let parallelHeld = 0

  for (const p of gtPts) {
    // Authored boundary that the source raster does not show is occluded, not missed (§9.6).
    if (!vis({ x: p.x, y: p.y, tx: p.tx, ty: p.ty })) continue
    if (inBand(p, w, h)) {
      if (isParallel(p, w, h) || atCanvasCorner(p, w, h)) parallelHeld++
      else bandMissed.push(docGrid.nearest(p.x, p.y))
    } else { intSum += docGrid.nearest(p.x, p.y); intN++ }
  }
  for (const p of docPts) {
    if (inBand(p, w, h)) {
      if (isParallel(p, w, h) || atCanvasCorner(p, w, h)) parallelHeld++
      else bandSpurious.push(gtGrid.nearest(p.x, p.y))
    } else { intSum += gtGrid.nearest(p.x, p.y); intN++ }
  }

  const band = laneOf(bandMissed, bandSpurious)
  const interior: Lane = { chamfer: intN ? intSum / intN : NaN, p95: NaN, max: NaN, missed: NaN, spurious: NaN, n: intN }

  // --- the corner half (§23 form, restricted to the band) ---------------------
  const gtCorners = sharpCorners(gt.map((s) => s.subPaths), 0)
  const sites: Site[] = []
  for (const c of sharpCorners([docSets], 0)) {
    const s: Sample = { x: c.x, y: c.y, tx: c.otx, ty: c.oty }
    if (!inBand(s, w, h) || atCanvasCorner(s, w, h)) continue
    // BOTH arms must be transversal. Testing only the out-tangent re-admits the very
    // artifact the exclusion exists for: where art meets the canvas edge the traced region
    // legitimately turns to run ALONG the edge, which is a real ~90 degree corner in the
    // doc and no corner at all in the authored art (which simply continues off-canvas).
    // The first draft of this lens scored 11 such sites on mastercard at excess 87-120 and
    // they were all frame closures, not invented corners.
    if (isParallel(s, w, h)) continue
    if (isParallel({ x: c.x, y: c.y, tx: c.itx, ty: c.ity }, w, h)) continue
    if (gtGrid.nearest(c.x, c.y) > NEAR) continue // invented BOUNDARY, not an invented corner
    if (gtCorners.some((g) => Math.hypot(g.x - c.x, g.y - c.y) <= CORNER_MATCH_R)) continue // recall's case
    const dot = Math.max(-1, Math.min(1, c.itx * c.otx + c.ity * c.oty))
    const kink = (Math.acos(dot) * 180) / Math.PI
    // The authored turn over the same span, measured the same way — like for like.
    let bi = -1
    let bd = Infinity
    for (let i = 0; i < gtPts.length; i++) {
      const d = Math.hypot(gtPts[i].x - c.x, gtPts[i].y - c.y)
      if (d < bd) { bd = d; bi = i }
    }
    let authored = 0
    if (bi >= 0) {
      const k = Math.max(1, Math.round(WIN / STEP))
      const a = gtPts[Math.max(0, bi - k)]
      const b = gtPts[Math.min(gtPts.length - 1, bi + k)]
      authored = (Math.acos(Math.max(-1, Math.min(1, a.tx * b.tx + a.ty * b.ty))) * 180) / Math.PI
    }
    sites.push({ x: c.x, y: c.y, kink, authored, excess: kink - authored })
  }
  sites.sort((a, b) => b.excess - a.excess)

  return { name, band, interior, ratio: band.chamfer / interior.chamfer, parallelHeld, sites }
}

// --- corpus ------------------------------------------------------------------
const EDGE = join(root, 'public', 'examples', 'edge-cases')
const cases: [string, string][] = []
const CASE = flag('--case')
if (CASE) {
  const alt = join(EDGE, `${CASE}.svg`)
  const p = CASE.includes('/') ? `${CASE}.svg` : `examples/logos/${CASE}.svg`
  try {
    cases.push([CASE, readFileSync(alt, 'utf8')])
  } catch {
    cases.push([CASE, readFileSync(join(root, p), 'utf8')])
  }
} else if (argv.includes('--logos')) {
  for (const file of readdirSync(join(root, 'examples', 'logos')).filter((x) => x.endsWith('.svg')))
    cases.push([file.replace(/\.svg$/, ''), readFileSync(join(root, 'examples', 'logos', file), 'utf8')])
} else {
  for (const file of readdirSync(EDGE).filter((x) => x.endsWith('.svg')))
    cases.push([file.replace(/\.svg$/, ''), readFileSync(join(EDGE, file), 'utf8')])
}

// `--slice k/n` runs the k-th of n equal chunks of the case list. The 152-mark gallery
// sweep exceeds an 8GB heap in one process (lowresDiag records the same limit and solves it
// the same way) — the tracer retains per-mark state this script cannot reach, so the fix is
// to run fewer marks per process, not to free harder.
const SLICE = flag('--slice')
if (SLICE) {
  const [k, n] = SLICE.split('/').map(Number)
  const size = Math.ceil(cases.length / n)
  cases.splice(0, cases.length, ...cases.slice((k - 1) * size, k * size))
}

const fit = parseFit(flag('--fit') ?? '')
const reports: BorderReport[] = []
for (const [name, text] of cases) {
  const r = await analyse(name, text, fit)
  if (r) reports.push(r)
}

const lane = GRADIENTS ? 'grad' : 'flat'
console.log(
  `\n━━━ BORDER-BAND FIDELITY @${RES} ${lane} ━━━  ${reports.length} scorable of ${cases.length} cases` +
    `   band ≤${BAND}px, parallel held at <${PAR_DEG}°\n`,
)

// A case whose art never reaches the canvas edge has nothing to say here, and must not be
// reported as a perfect zero — the `samples === 0` lesson from GeomScore, same trap.
const scorable = reports.filter((r) => r.band.n >= MIN_BAND_N && Number.isFinite(r.interior.chamfer))
const silent = reports.filter((r) => r.band.n < MIN_BAND_N)

console.log(`  ${'case'.padEnd(28)}${'band n'.padStart(8)}${'chamfer'.padStart(9)}${'p95'.padStart(8)}${'max'.padStart(8)}${'interior'.padStart(10)}${'ratio'.padStart(8)}${'kinks'.padStart(7)}`)
for (const r of [...scorable].sort((a, b) => b.ratio - a.ratio)) {
  const bad = r.sites.filter((s) => s.excess >= 40).length
  console.log(
    `  ${r.name.padEnd(28)}${String(r.band.n).padStart(8)}${f(r.band.chamfer).padStart(9)}${f(r.band.p95).padStart(8)}` +
      `${f(r.band.max).padStart(8)}${f(r.interior.chamfer).padStart(10)}${(f(r.ratio, 2) + '×').padStart(8)}${String(bad).padStart(7)}`,
  )
}
if (silent.length) console.log(`\n  ${silent.length} case(s) never reach the canvas edge (no band samples): ${silent.map((r) => r.name).join(', ')}`)

if (scorable.length) {
  const ratios = scorable.map((r) => r.ratio).filter(Number.isFinite)
  const bandCh = scorable.map((r) => r.band.chamfer)
  const intCh = scorable.map((r) => r.interior.chamfer)
  console.log(`\n  THE HOLE: ${scorable.reduce((s, r) => s + r.band.n, 0)} transversal band samples carry authored truth and are scored by NOTHING in the repo today.`)
  console.log(`            (a further ${scorable.reduce((s, r) => s + r.parallelHeld, 0)} in-band samples are frame/flush and correctly held out)`)
  console.log(`\n  band chamfer     p50 ${f(pct(bandCh, 0.5))}  p90 ${f(pct(bandCh, 0.9))}  max ${f(maxOf(bandCh))}`)
  console.log(`  interior chamfer p50 ${f(pct(intCh, 0.5))}  p90 ${f(pct(intCh, 0.9))}  max ${f(maxOf(intCh))}`)
  console.log(`  ratio            p50 ${f(pct(ratios, 0.5))}×  p90 ${f(pct(ratios, 0.9))}×  max ${f(maxOf(ratios))}×`)
  const worseCount = scorable.filter((r) => r.ratio > 1).length
  console.log(`  ${worseCount} of ${scorable.length} cases are WORSE at the border than in their own interior.`)
  const kinks = scorable.reduce((s, r) => s + r.sites.filter((x) => x.excess >= 40).length, 0)
  console.log(`  ${kinks} traced corner(s) in the band turn ≥40° more than the authored boundary does (the "odd corners" half).`)
}

if (LIST) {
  console.log(`\n  PER-SITE (in-band traced corners, excess ≥ ${LIST_MIN}°)`)
  for (const r of scorable) {
    const hot = r.sites.filter((s) => s.excess >= LIST_MIN)
    if (!hot.length) continue
    console.log(`   ${r.name}`)
    for (const s of hot.slice(0, 12))
      console.log(`     (${f(s.x, 1)},${f(s.y, 1)})   kink ${f(s.kink, 1)}°   authored ${f(s.authored, 1)}°   excess ${f(s.excess, 1)}°`)
  }
}
console.log()
