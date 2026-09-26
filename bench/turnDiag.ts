// TURN DIAG (issue #23) — how the corner detector READS a turn, measured against the
// AUTHORED turn, for every candidate reader at once.
//
//   node --experimental-strip-types bench/turnDiag.ts                  # the reader census on corner-turns
//   node --experimental-strip-types bench/turnDiag.ts --case sharp-star
//   node --experimental-strip-types bench/turnDiag.ts --all            # rack + the whole corner watchlist
//   node --experimental-strip-types bench/turnDiag.ts --logos 40       # + N gallery marks (false-positive side)
//   node --experimental-strip-types bench/turnDiag.ts --at X,Y          # every reader's value at one site
//   --res N (default 512)   --thr D (the bar a reading is judged against, default 60)
//   --case NAME  (an edge-case fixture, or `examples/logos/NAME` for a gallery mark)
//
// WHY. §21 measured the mechanism — `detectCorners` reads the turn as the angle between
// two CHORDS taken ±4 POINTS along the RAW integer lattice, and a steep-diagonal corner
// authored at 60.0° reads 45.0° there, so it is never classified. §21.4 named the SHAPE a
// fix would take (turn from FITTED arm directions over a longer, evidence-bounded span)
// but explicitly did not build it, because the reading has TWO sides and only one of them
// is the defect:
//   • the TRUE side  — does the reader recover the authored turn at an authored corner?
//   • the FALSE side — does it stay BELOW the bar everywhere else? A longer span reads a
//     large turn on any small circle, and "a smooth shape — even a tiny circle — returns ∅"
//     is a documented property of `detectCorners`.
// So this dumps the JOINT distribution: authored turn vs reading, per reader, plus the
// count of sites each reader would MINT that no authored corner explains. No fix is
// chosen here; the numbers choose it.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from '../src/lib/png/decode.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { buildPlanarNetwork } from '../src/lib/trace/planarNetwork.ts'
import { armLine } from '../src/lib/trace/planarFit.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from './svgGround.ts'
import { sharpCorners, makeVisibleAt, CORNER_MIN_EDGE, type Corner } from './geomScore.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n: string): string | null => {
  const i = argv.indexOf(n)
  if (i < 0) return null
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? '' : v
}
const RES = Number(flag('--res') ?? 512)
const THR = Number(flag('--thr') ?? 60)
const LOGOS = Number(flag('--logos') ?? 0)
/** `--at x,y`: dump every reader's value at the lattice point nearest (x,y) — the
 *  single-site autopsy a named witness needs (§21's Λ apex). */
const AT = (flag('--at') ?? '').split(',').map(Number).filter(Number.isFinite)
const f = (v: number, d = 1): string => v.toFixed(d)

interface Vec { x: number; y: number }
const deg = (c: number): number => (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI

// --- the candidate readers -------------------------------------------------
// Every reader answers ONE question at index `i` of a lattice chain: how much does the
// boundary turn here, in degrees. They differ only in what evidence they read it from.
interface Reader {
  name: string
  /** null ⇒ the reader has no opinion here (too near a chain end). */
  read: (pts: Vec[], i: number, closed: boolean) => number | null
}

const at = (pts: Vec[], i: number, closed: boolean): Vec | null => {
  const n = pts.length
  if (closed) return pts[((i % n) + n) % n]
  return i < 0 || i >= n ? null : pts[i]
}
const unit = (a: Vec): Vec => {
  const l = Math.hypot(a.x, a.y) || 1
  return { x: a.x / l, y: a.y / l }
}
const turnOf = (inDir: Vec, outDir: Vec): number => deg(inDir.x * outDir.x + inDir.y * outDir.y)

/** The SHIPPED reader: the angle between two ±win-POINT chords. */
const chord = (win: number): Reader => ({
  name: `chord${win}`,
  read: (pts, i, closed) => {
    const b = at(pts, i - win, closed)
    const a = at(pts, i + win, closed)
    if (!a || !b) return null
    return turnOf(unit({ x: pts[i].x - b.x, y: pts[i].y - b.y }), unit({ x: a.x - pts[i].x, y: a.y - pts[i].y }))
  },
})

const sideWindow = (pts: Vec[], i: number, k: number, sign: -1 | 1, closed: boolean, gap = 0): Vec[] | null => {
  const out: Vec[] = []
  for (let o = gap; o <= gap + k; o++) {
    const p = at(pts, i + sign * o, closed)
    if (!p) return null
    out.push(p)
  }
  return out
}
/** Least-squares direction of one side's window, oriented along the chain's travel.
 *  `w[0]` is the apex; the fitted line is un-oriented, so it is first aimed apex-outward
 *  and then flipped on the INCOMING side. */
const sideDir = (w: Vec[], sign: -1 | 1): Vec => {
  const d = armLine(w).d
  const ref = { x: w[w.length - 1].x - w[0].x, y: w[w.length - 1].y - w[0].y }
  const s = d.x * ref.x + d.y * ref.y >= 0 ? 1 : -1
  return sign > 0 ? { x: d.x * s, y: d.y * s } : { x: -d.x * s, y: -d.y * s }
}

/** FIXED-span least-squares: same window as chord(k), but the direction is fitted to all
 *  k+1 samples instead of taken from the two endpoints. Isolates "the chord's endpoint
 *  quantization" from "the window is too short". */
const ls = (k: number): Reader => ({
  name: `ls${k}`,
  read: (pts, i, closed) => {
    const lo = sideWindow(pts, i, k, -1, closed)
    const hi = sideWindow(pts, i, k, 1, closed)
    if (!lo || !hi) return null
    return turnOf(sideDir(lo, -1), sideDir(hi, 1))
  },
})

/** Max perpendicular deviation of `w` from its own least-squares line. */
const bowOf = (w: Vec[]): number => {
  const { c, d } = armLine(w)
  let m = 0
  for (const p of w) m = Math.max(m, Math.abs((p.x - c.x) * d.y - (p.y - c.y) * d.x))
  return m
}

/** EVIDENCE-BOUNDED: grow each side while its own samples stay within `eps` of a straight
 *  line, up to `maxK`; read the turn from the two fitted directions at the span the
 *  evidence actually supports. On a straight arm that reaches far and averages the
 *  staircase away; on a curve it stops early, which is what keeps a small circle from
 *  reading as a corner. `minK` is the shortest span that may be trusted at all. */
const evid = (minK: number, maxK: number, eps: number, gap = 0): Reader => ({
  name: `evid${gap ? `g${gap}` : ''}${minK}-${maxK}/${eps}`,
  read: (pts, i, closed) => {
    const grow = (sign: -1 | 1): Vec[] | null => {
      let best: Vec[] | null = null
      for (let k = minK; k <= maxK; k++) {
        const w = sideWindow(pts, i, k, sign, closed, gap)
        if (!w) break
        if (k > minK && bowOf(w) > eps) break
        best = w
      }
      return best
    }
    const lo = grow(-1)
    const hi = grow(1)
    if (!lo || !hi) return null
    return turnOf(sideDir(lo, -1), sideDir(hi, 1))
  },
})

/** The ONE-SIDED shape (§17's ARM_BOW / §20's flat3): keep the shipped chord reading and
 *  let the evidence reading only ever make a vertex SHARPER. Cannot lose a corner the
 *  detector finds today; the price is that it inherits every site the chord over-reads. */
const promote = (a: Reader, b: Reader): Reader => ({
  name: `max(${a.name},${b.name})`,
  read: (pts, i, closed) => {
    const x = a.read(pts, i, closed)
    const y = b.read(pts, i, closed)
    if (x === null) return y
    if (y === null) return x
    return Math.max(x, y)
  },
})

const READERS: Reader[] = [
  chord(4),
  chord(6),
  chord(8),
  ls(4),
  ls(6),
  ls(8),
  ls(12),
  evid(4, 12, 0.75),
  evid(4, 16, 0.75),
  evid(4, 24, 0.75),
  evid(4, 16, 0.5),
  evid(4, 16, 0.9),
  evid(4, 16, 1.0),
  evid(4, 16, 1.25),
  evid(4, 16, 1.5),
  evid(4, 12, 1.0),
  evid(4, 20, 1.0),
  evid(4, 24, 1.0),
  evid(6, 16, 1.0),
  promote(chord(4), evid(4, 16, 0.9)),
  promote(chord(4), evid(4, 16, 1.0)),
  promote(chord(4), evid(4, 16, 1.25)),
  promote(chord(4), evid(4, 16, 1.5)),
  promote(chord(4), evid(4, 12, 1.0)),
  promote(chord(4), evid(4, 24, 1.0)),
  evid(4, 16, 1.0, 2),
  evid(4, 16, 1.0, 3),
  promote(chord(4), evid(4, 16, 1.0, 1)),
  promote(chord(4), evid(4, 16, 1.0, 2)),
  promote(chord(4), evid(4, 16, 1.0, 3)),
  promote(chord(4), evid(4, 12, 1.0, 2)),
  promote(chord(4), evid(4, 24, 1.0, 2)),
  promote(chord(4), evid(4, 16, 0.75, 2)),
  promote(chord(4), evid(4, 16, 1.25, 2)),
]

// --- one case ---------------------------------------------------------------
interface TrueRec { mark: string; authored: number; reads: (number | null)[] }

const trueRecs: TrueRec[] = []
/** Per reader: how many NMS'd sites ≥ THR are NOT explained by an authored corner. */
const minted = READERS.map(() => 0)
let sites = 0

const MATCH_R = 2.2 // lattice point <-> authored corner
const EXPLAIN_R = 3.5 // a minted site this close to an authored corner is explained

async function runCase(mark: string, text: string): Promise<void> {
  let gtDoc
  try {
    gtDoc = parseGroundTruth(text)
  } catch {
    return
  }
  if (unscorable(gtDoc)) return
  let raster
  try {
    raster = decodePng(new Resvg(text, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
  } catch {
    return
  }
  const gt = toRasterSpace(gtDoc, raster.width)
  const vis = makeVisibleAt(raster)
  const gtc: Corner[] = sharpCorners(
    gt.map((s) => s.subPaths),
    CORNER_MIN_EDGE,
  ).filter((c) => vis({ x: c.x, y: c.y, tx: c.itx, ty: c.ity }) || vis({ x: c.x, y: c.y, tx: c.otx, ty: c.oty }))

  // The EXACT label map the tracer hands tracePlanar (heal / remove / bg union applied).
  let lab: { labels: Int32Array; width: number; height: number } | null = null
  await traceImage(
    raster as unknown as ImageData,
    { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false },
    undefined,
    undefined,
    undefined,
    undefined,
    (l) => {
      lab = l
    },
  )
  const labels = lab as { labels: Int32Array; width: number; height: number } | null
  if (!labels) return
  const net = buildPlanarNetwork(labels.labels, labels.width, labels.height)

  if (AT.length === 2) {
    let bE = -1
    let bI = -1
    let bD = Infinity
    net.edges.forEach((e, ei) => {
      e.pts.forEach((q, pi) => {
        const d = Math.hypot(q.x - AT[0], q.y - AT[1])
        if (d < bD) {
          bD = d
          bE = ei
          bI = pi
        }
      })
    })
    const e = net.edges[bE]
    console.log(`
${mark} @${RES}: nearest lattice point to (${AT[0]},${AT[1]}) is edge ${bE} index ${bI} of ${e.pts.length} (closed=${e.closed}), ${f(bD, 2)}px away`)
    const near = gtc
      .map((c) => ({ c, d: Math.hypot(c.x - AT[0], c.y - AT[1]) }))
      .sort((a, b) => a.d - b.d)[0]
    if (near) console.log(`  nearest authored corner: (${f(near.c.x, 2)},${f(near.c.y, 2)}) turn ${f(deg(near.c.itx * near.c.otx + near.c.ity * near.c.oty), 1)} deg, ${f(near.d, 2)}px away`)
    for (let o = -3; o <= 3; o++) {
      const i = e.closed ? ((bI + o) % e.pts.length + e.pts.length) % e.pts.length : bI + o
      if (i < 0 || i >= e.pts.length) continue
      const vals = READERS.map((r) => r.read(e.pts as Vec[], i, e.closed))
      console.log(`  i${o >= 0 ? '+' : ''}${o} (${e.pts[i].x},${e.pts[i].y})  ` + READERS.map((r, k) => `${r.name}=${vals[k] === null ? '--' : f(vals[k] as number, 1)}`).join('  '))
    }
    return
  }

  // TRUE side — the reading at the lattice point nearest each authored corner.
  for (const c of gtc) {
    let bestE = -1
    let bestI = -1
    let bestD = MATCH_R
    net.edges.forEach((e, ei) => {
      e.pts.forEach((p, pi) => {
        const d = Math.hypot(p.x - c.x, p.y - c.y)
        if (d < bestD) {
          bestD = d
          bestE = ei
          bestI = pi
        }
      })
    })
    if (bestE < 0) continue
    const e = net.edges[bestE]
    sites++
    trueRecs.push({
      mark,
      authored: deg(c.itx * c.otx + c.ity * c.oty),
      reads: READERS.map((r) => r.read(e.pts as Vec[], bestI, e.closed)),
    })
  }

  // FALSE side — every NMS'd site each reader would classify, minus the authored ones.
  READERS.forEach((r, ri) => {
    for (const e of net.edges) {
      const pts = e.pts as Vec[]
      const n = pts.length
      if (n < 12) continue
      const vals = new Float64Array(n)
      for (let i = 0; i < n; i++) vals[i] = r.read(pts, i, e.closed) ?? 0
      for (let i = 0; i < n; i++) {
        if (vals[i] < THR) continue
        let isMax = true
        for (let j = i - 4; j <= i + 4 && isMax; j++) {
          const k = e.closed ? ((j % n) + n) % n : j
          if (k === i || k < 0 || k >= n) continue
          if (vals[k] > vals[i]) isMax = false
        }
        if (!isMax) continue
        const near = gtc.some((c) => Math.hypot(pts[i].x - c.x, pts[i].y - c.y) <= EXPLAIN_R)
        if (!near) minted[ri]++
      }
    }
  })
}

// --- corpus -----------------------------------------------------------------
const WATCHLIST = ['sharp-star', 'gear-teeth', 'bar-caps', 'checker', 'band-cross', 'letter-joins', 'acute-counter', 'peak-drop', 'seam-corner', 'wedge-counter']
const cases: [string, string][] = []
const CASE = flag('--case')
if (argv.includes('--all')) {
  for (const n of ['corner-turns', ...WATCHLIST])
    cases.push([n, readFileSync(join(root, 'public/examples/edge-cases', `${n}.svg`), 'utf8')])
} else {
  const n = CASE || 'corner-turns'
  const rel = n.includes('/') ? `${n}.svg` : `public/examples/edge-cases/${n}.svg`
  cases.push([n.split('/').pop()!, readFileSync(join(root, rel), 'utf8')])
}
if (LOGOS > 0) {
  const dir = join(root, 'examples', 'logos')
  for (const file of readdirSync(dir).filter((x) => x.endsWith('.svg')).slice(0, LOGOS))
    cases.push([file.replace(/\.svg$/, ''), readFileSync(join(dir, file), 'utf8')])
}
for (const [n, t] of cases) await runCase(n, t)

// --- report -----------------------------------------------------------------
console.log(`\nTURN READERS @${RES} flat  —  ${sites} authored corners located on the lattice, over ${cases.length} case(s)`)
console.log(`  bar = ${THR} deg. cell = (reader reads >= bar) / (authored corners in the band).\n`)
const BANDS: [number, number][] = [[60, 65], [65, 70], [70, 75], [75, 80], [80, 90], [90, 105], [105, 120], [120, 180]]
const head = `  ${'reader'.padEnd(16)}` + BANDS.map(([lo, hi]) => `${lo}-${hi}`.padStart(9)).join('') + `${'all'.padStart(9)}${'minted'.padStart(9)}`
console.log(head)
console.log('  ' + '-'.repeat(head.length))
READERS.forEach((r, ri) => {
  const cells = BANDS.map(([lo, hi]) => {
    const g = trueRecs.filter((t) => t.authored >= lo && t.authored < hi && t.reads[ri] !== null)
    if (!g.length) return '.'.padStart(9)
    const k = g.filter((t) => (t.reads[ri] as number) >= THR).length
    return `${k}/${g.length}`.padStart(9)
  })
  const all = trueRecs.filter((t) => t.authored >= THR && t.reads[ri] !== null)
  const allK = all.filter((t) => (t.reads[ri] as number) >= THR).length
  console.log(`  ${r.name.padEnd(16)}${cells.join('')}${`${allK}/${all.length}`.padStart(9)}${String(minted[ri]).padStart(9)}`)
})

// The SET DIFFERENCE against the shipped reader — a replacement is only safe if what it
// gains dwarfs what it drops, and a net count hides a swap.
console.log(`\n  vs the shipped reader (chord4), on authored corners >= ${THR} deg:`)
console.log(`  ${'reader'.padEnd(16)}${'gained'.padStart(9)}${'LOST'.padStart(9)}${'net'.padStart(9)}${'d-minted'.padStart(10)}`)
READERS.forEach((r, ri) => {
  if (ri === 0) return
  let gained = 0
  let lost = 0
  for (const t of trueRecs) {
    if (t.authored < THR) continue
    const a = t.reads[0]
    const b = t.reads[ri]
    if (a === null || b === null) continue
    if (b >= THR && a < THR) gained++
    if (a >= THR && b < THR) lost++
  }
  console.log(`  ${r.name.padEnd(16)}${String(gained).padStart(9)}${String(lost).padStart(9)}${String(gained - lost).padStart(9)}${String(minted[ri] - minted[0]).padStart(10)}`)
})

console.log(`\n  reading error (measured - authored, deg) at authored corners >= ${THR} deg:`)
console.log(`  ${'reader'.padEnd(16)}${'mean'.padStart(9)}${'p50'.padStart(9)}${'p10'.padStart(9)}${'p90'.padStart(9)}${'worst under'.padStart(13)}`)
READERS.forEach((r, ri) => {
  const errs = trueRecs
    .filter((t) => t.authored >= THR && t.reads[ri] !== null)
    .map((t) => (t.reads[ri] as number) - t.authored)
    .sort((a, b) => a - b)
  if (!errs.length) return
  const q = (p: number): number => errs[Math.min(errs.length - 1, Math.floor(p * errs.length))]
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length
  console.log(`  ${r.name.padEnd(16)}${f(mean).padStart(9)}${f(q(0.5)).padStart(9)}${f(q(0.1)).padStart(9)}${f(q(0.9)).padStart(9)}${f(errs[0]).padStart(13)}`)
})
