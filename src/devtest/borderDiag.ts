// BORDER DIAG — the one zone no gate in this repo has ever scored.
//
//   node --experimental-strip-types src/devtest/borderDiag.ts                 # tier-0 fixtures
//   node --max-old-space-size=6144 ... borderDiag.ts --logos                  # the whole gallery
//   node --experimental-strip-types src/devtest/borderDiag.ts --case mastercard --list
//   node --experimental-strip-types src/devtest/borderDiag.ts --gate --logos  # ranked table
//   --res N (default 512)   --fit k=v   --gradients
//   --list (per-corner dump)   --min P (list threshold, deg)   --worst N (per-sample dump)
//   --keepoff (counterfactual: score off-canvas authored art too)   --outcomes (mechanism census)
//
// The band's own constants — its half-width, the PARALLEL cut and the sample floor — are no
// longer flags here: they live in geomScore (BAND / BAND_PARALLEL_DEG / BAND_MIN_N) because
// the GATE reads the same lane, and a lens whose thresholds can be dialled from the command
// line is not the same measurement as the one CI runs.
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
import {
  sharpCorners, makeVisibleAt, flattenSubPath, CORNER_MATCH_R,
  scoreBorderBand, nearestTo, BAND, BAND_PARALLEL_DEG, BAND_MIN_N,
  type BandSample, type BorderBand,
} from './geomScore.ts'
import { buildPlanarNetwork } from '../lib/trace/planarNetwork.ts'
import { subpixelEdgeChains, type SubpixelDiagRecord } from '../lib/trace/planarSubpixel.ts'
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
const GRADIENTS = argv.includes('--gradients')
const LIST = argv.includes('--list')
const LIST_MIN = Number(flag('--min') ?? 1.0)
/** `--worst N` dumps the N worst band SAMPLES (not corners) per case, with the side they
 *  were queried from. A ratio says a case is bad; this says WHERE, which is what a fix
 *  needs — the ragged run turned out to be one localised family, not a spread. */
const WORST = Number(flag('--worst') ?? 0)
/** `--keepoff` restores the first draft's behaviour: score authored samples that lie OUTSIDE
 *  the canvas rectangle too. The counterfactual for §34.1: it takes `wedge-counter` from
 *  0.19px to 0.39px of band chamfer (1.23x to 2.53x), and it is half of why that case
 *  ranked WORST in the corpus before the artifact was named. */
const KEEP_OFF = argv.includes('--keepoff')
/** `--outcomes` runs the §15 sub-pixel pass's own observational hook and bins every chain
 *  point's verdict by its distance to the canvas edge — the mechanism census. */
const OUTCOMES = argv.includes('--outcomes')
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

interface Sample { x: number; y: number; tx: number; ty: number }

/** Uniform-arc-length resample of one subpath, with tangents. The corner census needs the
 *  TANGENT at each authored sample to read the authored turn over a window; the distance
 *  lanes take their samples from the shared scorer instead. */
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

/** The band predicates the CORNER census needs. Distances and thresholds come from the
 *  shared constants, so a change there moves both halves of the lens at once. */
const PAR_SIN = Math.sin((BAND_PARALLEL_DEG * Math.PI) / 180)
let W = 0
let H = 0
const edgeOf = (p: Sample): { d: number; ex: number; ey: number } => {
  const dl = p.x, dr = W - p.x, dt = p.y, db = H - p.y
  const m = Math.min(dl, dr, dt, db)
  return m === dl || m === dr ? { d: m, ex: 0, ey: 1 } : { d: m, ex: 1, ey: 0 }
}
const inBand = (p: Sample): boolean => Math.abs(edgeOf(p).d) <= BAND
const isParallel = (p: Sample): boolean => {
  const e = edgeOf(p)
  return Math.abs(p.tx * e.ey - p.ty * e.ex) < PAR_SIN
}
const atCanvasCorner = (p: Sample): boolean =>
  Math.min(p.x, W - p.x) <= BAND && Math.min(p.y, H - p.y) <= BAND

// The band's rules — the transversal cut, the canvas-corner hold-out, the off-canvas
// hold-out and the sample floor — live in geomScore.scoreBorderBand, which the GATE calls
// too. One implementation, so the instrument and the gate cannot drift apart, and so a bug
// in either is a bug in both (the first draft carried its own copy of the spatial index and
// its own copy was wrong — see nearestTo).

/** Reduce, not `Math.max(...a)` — these arrays run to 10^5 samples and the spread overflows. */
const maxOf = (a: number[]): number => a.reduce((s, v) => (v > s ? v : s), 0)
const pct = (a: number[], p: number): number => {
  if (!a.length) return NaN
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

interface Site { x: number; y: number; kink: number; authored: number; excess: number }
export interface BorderReport {
  name: string
  band: BorderBand
  /** Traced sharp corners in the band whose kink exceeds the authored turn there. */
  sites: Site[]
  /** Every scored band sample, for `--worst`. */
  pts: BandSample[]
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
  W = w
  H = h
  const vis = makeVisibleAt(raster)
  const doc = await traceImage(raster as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: GRADIENTS, planarFit: fit,
  })
  const docSets = doc.items.flatMap((it) => (it.kind === 'path' ? it.subPaths : [])) as SubPath[]
  const gtSets = gt.flatMap((s) => s.subPaths)

  const bandPts: BandSample[] = []
  const band = scoreBorderBand(gt, [docSets], w, h, vis, (q) => bandPts.push(q), KEEP_OFF)

  // The corner census keeps its own resampled authored chain (it needs the TANGENT at each
  // sample to read the authored turn over a window) and the nearest-authored test, both over
  // the shared index.
  const gtPts = gt.flatMap((g) => g.subPaths).flatMap(chainOf)
  const nearestGt = nearestTo(gt.map((g) => g.subPaths))

  // --- the corner half (§23 form, restricted to the band) ---------------------
  const gtCorners = sharpCorners(gt.map((s) => s.subPaths), 0)
  const sites: Site[] = []
  for (const c of sharpCorners([docSets], 0)) {
    const s: Sample = { x: c.x, y: c.y, tx: c.otx, ty: c.oty }
    if (!inBand(s) || atCanvasCorner(s)) continue
    // BOTH arms must be transversal. Testing only the out-tangent re-admits the very
    // artifact the exclusion exists for: where art meets the canvas edge the traced region
    // legitimately turns to run ALONG the edge, which is a real ~90 degree corner in the
    // doc and no corner at all in the authored art (which simply continues off-canvas).
    // The first draft of this lens scored 11 such sites on mastercard at excess 87-120 and
    // they were all frame closures, not invented corners.
    if (isParallel(s)) continue
    if (isParallel({ x: c.x, y: c.y, tx: c.itx, ty: c.ity })) continue
    if (nearestGt(c.x, c.y) > NEAR) continue // invented BOUNDARY, not an invented corner
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

  return { name, band, sites, pts: bandPts }
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
    `   band ≤${BAND}px, parallel held at <${BAND_PARALLEL_DEG}°\n`,
)

// A case whose art never reaches the canvas edge has nothing to say here, and must not be
// reported as a perfect zero — the `samples === 0` lesson from GeomScore, same trap.
const scorable = reports.filter((r) => r.band.n >= BAND_MIN_N && Number.isFinite(r.band.interior))
const silent = reports.filter((r) => r.band.n < BAND_MIN_N)

// The MISSED side is the like-for-like lane across a counterfactual: its queries are the
// AUTHORED samples, a population fixed by the art and the visibility mask, so it does not
// move when the trace does. The spurious side's queries are the trace's own boundary and do
// move, so a shift there can be a change of sample SET rather than of accuracy.
console.log(`  ${'case'.padEnd(24)}${'band n'.padStart(8)}${'chamfer'.padStart(9)}${'missed'.padStart(8)}${'spur'.padStart(7)}${'p95'.padStart(7)}${'max'.padStart(7)}${'interior'.padStart(10)}${'ratio'.padStart(8)}${'kinks'.padStart(7)}`)
for (const r of [...scorable].sort((a, b) => b.band.ratio - a.band.ratio)) {
  const bad = r.sites.filter((s) => s.excess >= 40).length
  console.log(
    `  ${r.name.padEnd(24)}${String(r.band.n).padStart(8)}${f(r.band.chamfer).padStart(9)}${f(r.band.missed).padStart(8)}${f(r.band.spurious).padStart(7)}${f(r.band.p95).padStart(7)}` +
      `${f(r.band.max).padStart(7)}${f(r.band.interior).padStart(10)}${(f(r.band.ratio, 2) + '×').padStart(8)}${String(bad).padStart(7)}`,
  )
}
if (silent.length) console.log(`\n  ${silent.length} case(s) never reach the canvas edge (no band samples): ${silent.map((r) => r.name).join(', ')}`)

if (scorable.length) {
  const ratios = scorable.map((r) => r.band.ratio).filter(Number.isFinite)
  const bandCh = scorable.map((r) => r.band.chamfer)
  const intCh = scorable.map((r) => r.band.interior)
  console.log(`\n  THE HOLE: ${scorable.reduce((s, r) => s + r.band.n, 0)} transversal band samples carry authored truth and are scored by NOTHING in the repo today.`)
  console.log(`            (a further ${scorable.reduce((s, r) => s + r.band.parallelHeld, 0)} in-band samples are frame/flush and correctly held out)`)
  const off = reports.reduce((s, r) => s + r.band.offCanvasHeld, 0)
  if (off) console.log(`            (${off} authored samples lie OUTSIDE the canvas and are unscorable by construction${KEEP_OFF ? ' — SCORED ANYWAY, --keepoff' : ''})`)
  console.log(`\n  band chamfer     p50 ${f(pct(bandCh, 0.5))}  p90 ${f(pct(bandCh, 0.9))}  max ${f(maxOf(bandCh))}`)
  console.log(`  interior chamfer p50 ${f(pct(intCh, 0.5))}  p90 ${f(pct(intCh, 0.9))}  max ${f(maxOf(intCh))}`)
  console.log(`  ratio            p50 ${f(pct(ratios, 0.5))}×  p90 ${f(pct(ratios, 0.9))}×  max ${f(maxOf(ratios))}×`)
  const worseCount = scorable.filter((r) => r.band.ratio > 1).length
  console.log(`  ${worseCount} of ${scorable.length} cases are WORSE at the border than in their own interior.`)
  const kinks = scorable.reduce((s, r) => s + r.sites.filter((x) => x.excess >= 40).length, 0)
  console.log(`  ${kinks} traced corner(s) in the band turn ≥40° more than the authored boundary does (the "odd corners" half).`)
}

if (WORST > 0) {
  console.log(`
  WORST BAND SAMPLES (query side → distance to the other boundary)`)
  for (const r of scorable.sort((a, b) => b.band.ratio - a.band.ratio)) {
    const hot = [...r.pts].sort((a, b) => b.d - a.d).slice(0, WORST)
    if (!hot.length || hot[0].d < 0.25) continue
    console.log(`   ${r.name}`)
    for (const s of hot) console.log(`     ${s.side.padEnd(9)} (${f(s.x, 1)},${f(s.y, 1)})   ${f(s.d)}px`)
  }
}

if (OUTCOMES) {
  // MECHANISM CENSUS. The documented border rule in planarSubpixel is "EXT-sided chains stay
  // on the lattice — there is no second colour to read a crossing from". That rule is about
  // whole CHAINS. This bins every INTERIOR chain point by its distance to the canvas edge,
  // because the pass has a second, undocumented border behaviour: its two far anchors sit at
  // ±FAR (1.75px) along the normal and must each land in their own region's pixels, and
  // outside the raster `labelAt` returns EXT. A point closer than FAR to the edge therefore
  // fails `label-left`/`label-right` on geometry alone, whatever the art is doing.
  const BINS = [1, 2, 3, 6, Infinity]
  const label = ['≤1px', '1–2px', '2–3px', '3–6px', 'interior']
  const tally = BINS.map(() => new Map<string, number>())
  for (const [name, text] of cases) {
    let raster
    try {
      raster = decodePng(new Resvg(text, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
    } catch { continue }
    const w = raster.width
    const h = raster.height
    let raw: { labels: Int32Array; width: number; height: number } | null = null
    await traceImage(raster as unknown as ImageData,
      { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: GRADIENTS, planarFit: fit },
      undefined, undefined, undefined, undefined, (l) => { raw = l })
    if (!raw) continue
    const rr = raw as { labels: Int32Array; width: number; height: number }
    const net = buildPlanarNetwork(rr.labels, w, h)
    const recs: SubpixelDiagRecord[] = []
    subpixelEdgeChains(net, rr.labels, { data: raster.data, width: w, height: h }, (r) => recs.push(r))
    // One row per point; the revert windows overlap so the raw stream repeats indices.
    const byPoint = new Map<string, { x: number; y: number; outcome: string }>()
    for (const r of recs) {
      const k = `${r.edgeId}:${r.index}`
      if (r.outcome === 'corner-revert') { if (!byPoint.has(k)) byPoint.set(k, { x: r.x, y: r.y, outcome: 'corner-revert' }); continue }
      byPoint.set(k, { x: r.x, y: r.y, outcome: r.outcome })
    }
    for (const r of byPoint.values()) {
      const d = Math.min(r.x, w - r.x, r.y, h - r.y)
      const b = BINS.findIndex((t) => d <= t)
      const m = tally[b < 0 ? BINS.length - 1 : b]
      m.set(r.outcome, (m.get(r.outcome) ?? 0) + 1)
    }
    void name
  }
  const kinds = [...new Set(tally.flatMap((m) => [...m.keys()]))].sort()
  console.log(`
  SUB-PIXEL OUTCOME BY DISTANCE TO THE CANVAS EDGE (interior chains only; EXT-sided chains never enter the pass)`)
  console.log(`  ${'outcome'.padEnd(20)}${label.map((l) => l.padStart(11)).join('')}`)
  const totals = tally.map((m) => [...m.values()].reduce((s, v) => s + v, 0))
  for (const k of kinds)
    console.log(`  ${k.padEnd(20)}${tally.map((m, i) => `${(m.get(k) ?? 0)} (${totals[i] ? ((100 * (m.get(k) ?? 0)) / totals[i]).toFixed(0) : '0'}%)`.padStart(11)).join('')}`)
  console.log(`  ${'— total —'.padEnd(20)}${totals.map((t) => String(t).padStart(11)).join('')}`)
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
