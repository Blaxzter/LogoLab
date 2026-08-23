// KINK DIAG — the PRECISION side of corner scoring, which the corpus has never had.
//
//   node --experimental-strip-types src/devtest/kinkDiag.ts                 # tier-0 fixtures
//   node --max-old-space-size=6144 ... kinkDiag.ts --logos                  # the whole gallery
//   node --experimental-strip-types src/devtest/kinkDiag.ts --case chupa-chups --list
//   --res N (default 512)   --fit k=v   --win P (authored window, px)   --list (per-site dump)
//   --compare   run BOTH arms of `cornerTurnEvidence` and diff the counts
//
// WHY. `cornersRecovered` counts AUTHORED corners the trace reproduced. It has no
// precision term at all, so INVENTING a corner is free by it — and a corner invented
// within CORNER_MATCH_R of a real one even scores as recovering that one. Chamfer and p95
// are nearly blind to a C⁰ kink on a short arc. §22 shipped a change that was green on
// every gate in this repo and put a visible kink in smooth boundary on ordinary art
// (chupa-chups' ellipse, instagram's ring, mastercard's `m`); the corpus could say a
// corner was LOST but never that one was INVENTED. This measures the missing half.
//
// WHAT COUNTS AS INVENTED. A traced sharp corner (the same `sharpCorners` reading the
// recall gate uses) that
//   • sits ON authored boundary (nearest authored sample within `NEAR` px — further out is
//     invented BOUNDARY, which is `spuriousMax`'s job, not this one);
//   • is VISIBLE in the source raster (an occluded seam is not the trace's fault);
//   • is not at a CROSSING of two authored subpaths — a union's silhouette corners exactly
//     where two smooth shapes cross, and `sharpCorners` on the authored side cannot see it
//     because it reads one subpath at a time;
//   • has no authored sharp corner within CORNER_MATCH_R (that is the recall case);
//   • and turns MORE than the authored boundary does over the same span.
//
// That last clause is the whole metric, and the first draft got it wrong in an instructive
// way. Asking only "is the authored boundary flat here" (authored window turn < K) is too
// blunt on curved art: an ellipse's end genuinely turns 30-60° over ±5px, so every kink
// ON a curve was exempted and the census could not see the very defect it was built for.
// The fair question is like-for-like — measure BOTH boundaries the same way at the same
// scale and take the difference:
//
//     excess = (the traced corner's own C⁰ kink)  −  (authored boundary's turn over ±win)
//
// The traced side needs no window: `sharpCorners` reads the kink straight off the node's
// handles, and that IS the turn the trace asserts at a point. (Measuring a WINDOW on the
// traced side instead was the second wrong draft — it re-adds the same arc curvature to
// both sides, and the difference cancels exactly the signal it is looking for.) A faithful
// trace concentrates only as much turn as the art has: a real corner gives excess ~0
// (kink 90°, authored ~90° over a short window), a tight 6px arc gives excess ~0 (kink
// ~38°, authored ~38° over ±2px), and a kink laid on a smooth curve gives the whole kink. No threshold is chosen
// here — this dumps the joint distribution so one can be.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from './svgGround.ts'
import { sharpCorners, makeVisibleAt, flattenSubPath, CORNER_MATCH_R, type Corner } from './geomScore.ts'
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
const WIN = Number(flag('--win') ?? 1)
const LIST = argv.includes('--list')
const LIST_MIN = Number(flag('--min') ?? 30)
/** `--probe x,y`: everything about the traced sharp corner nearest (x,y). */
const PROBE = (flag('--probe') ?? '').split(',').map(Number).filter(Number.isFinite)
/** The A/B view shows BOTH lanes and the reading moves both; `--gradients` scores the
 *  gradient lane, which is where the first reported kink was seen. */
const GRADIENTS = argv.includes('--gradients')
const f = (v: number, d = 1): string => v.toFixed(d)
const parseFit = (s: string): Record<string, number | boolean> => {
  const o: Record<string, number | boolean> = {}
  for (const kv of s.split(',').filter(Boolean)) {
    const [k, v] = kv.split('=')
    o[k] = v === 'true' ? true : v === 'false' ? false : Number(v)
  }
  return o
}

/** Arc-length step the authored boundary is resampled at. The window walk below is index
 *  arithmetic on this, so it is also the resolution of the window. */
const STEP = 0.5
/** A traced corner further than this from authored boundary is invented BOUNDARY. */
const NEAR = 2.0
/** Two authored subpaths this close are crossing; the silhouette may corner there. */
const CROSS = 1.6

interface Sample { x: number; y: number; tx: number; ty: number }
interface Chain { pts: Sample[]; closed: boolean; shape: number }

/** Uniform-arc-length resample of one authored subpath, with tangents. */
function chainOf(sp: SubPath, shape: number): Chain | null {
  const poly = flattenSubPath(sp)
  if (poly.length < 2) return null
  const closed = sp.closed !== false
  const pts = closed && (poly[0].x !== poly[poly.length - 1].x || poly[0].y !== poly[poly.length - 1].y)
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
  return out.length >= 3 ? { pts: out, closed, shape } : null
}

/** Total turn of the authored boundary over ±`win` px of arc length around `i`. */
function windowTurn(ch: Chain, i: number, win: number): number {
  const n = ch.pts.length
  const k = Math.max(1, Math.round(win / STEP))
  const idx = (j: number): number => (ch.closed ? ((j % n) + n) % n : Math.max(0, Math.min(n - 1, j)))
  const a = ch.pts[idx(i - k)]
  const b = ch.pts[idx(i + k)]
  const d = Math.max(-1, Math.min(1, a.tx * b.tx + a.ty * b.ty))
  return (Math.acos(d) * 180) / Math.PI
}

/** The framing edge, not the art — `collectBoundary` drops boundary samples here for the
 *  same reason. Every one of the 71 candidates the first run turned up on the tier-0
 *  fixtures was a band seam meeting the canvas edge at x=0/512 or y=0/512, where the trace
 *  corners because the FRAME corners. */
const BORDER_EPS = 1.5

/** How many distinct TRACED subpaths pass within this of a site. Two is an ordinary shared
 *  edge (one region each side); three or more is a JUNCTION, and a junction legitimately
 *  corners even where the authored boundary through it is smooth — §14/§17's whole subject,
 *  and on posterized art it is where every band seam lands. */
const JUNCTION_R = 1.6

type Verdict = 'invented' | 'explained' | 'crossing' | 'off-boundary' | 'occluded' | 'border' | 'junction' | 'curved'
interface Site { x: number; y: number; tracedTurn: number; dist: number; authored: number; traced: number; excess: number; verdict: Verdict }

async function analyse(name: string, text: string, fit: Record<string, number | boolean>): Promise<Site[] | null> {
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
  const gt = toRasterSpace(gtDoc, raster.width)
  const vis = makeVisibleAt(raster)
  const chains: Chain[] = []
  gt.forEach((s, si) => {
    for (const sp of s.subPaths) {
      const c = chainOf(sp, si)
      if (c) chains.push(c)
    }
  })
  if (!chains.length) return null
  // Authored sharp corners with NO minEdge: any authored kink explains a traced one.
  const gtCorners: Corner[] = sharpCorners(gt.map((s) => s.subPaths), 0)

  const doc = await traceImage(raster as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: GRADIENTS, planarFit: fit,
  })
  const docSets = doc.items.flatMap((it) => (it.kind === 'path' ? it.subPaths : [])) as SubPath[]
  const docPolys = docSets.map((sp) => flattenSubPath(sp))
  // The traced side gets the SAME arc-length treatment as the authored side, so the two
  // window turns are measured identically and their difference means something.
  const docChains: Chain[] = []
  docSets.forEach((sp, i) => {
    const c = chainOf(sp, i)
    if (c) docChains.push(c)
  })
  const nearestOn = (chs: Chain[], x: number, y: number): { ch: Chain; i: number; d: number } | null => {
    let bc: Chain | null = null
    let bi = -1
    let bd = Infinity
    for (const ch of chs) {
      for (let i = 0; i < ch.pts.length; i++) {
        const d = Math.hypot(ch.pts[i].x - x, ch.pts[i].y - y)
        if (d < bd) {
          bd = d
          bc = ch
          bi = i
        }
      }
    }
    return bc ? { ch: bc, i: bi, d: bd } : null
  }
  const tracedDegree = (x: number, y: number): number => {
    let n = 0
    for (const poly of docPolys) {
      for (const q of poly) {
        if (Math.abs(q.x - x) <= JUNCTION_R && Math.abs(q.y - y) <= JUNCTION_R && Math.hypot(q.x - x, q.y - y) <= JUNCTION_R) {
          n++
          break
        }
      }
    }
    return n
  }
  const traced = sharpCorners(docSets.map((sp) => [sp]), 0)
  // sharpCorners reports both sides of a shared edge; one physical corner, two records.
  const uniq: Corner[] = []
  for (const c of traced) if (!uniq.some((u) => Math.hypot(u.x - c.x, u.y - c.y) <= 0.35)) uniq.push(c)

  if (PROBE.length === 2) {
    let bc: Corner | null = null
    let bd = Infinity
    for (const c of uniq) {
      const d = Math.hypot(c.x - PROBE[0], c.y - PROBE[1])
      if (d < bd) { bd = d; bc = c }
    }
    if (bc) {
      const kink = (Math.acos(Math.max(-1, Math.min(1, bc.itx * bc.otx + bc.ity * bc.oty))) * 180) / Math.PI
      console.log(`
PROBE ${name}: nearest traced sharp corner to (${PROBE[0]},${PROBE[1]}) is (${f(bc.x, 2)}, ${f(bc.y, 2)}), ${f(bd, 2)}px away, kink ${f(kink)}deg`)
      const n2 = nearestOn(chains, bc.x, bc.y)
      if (n2) {
        console.log(`  nearest AUTHORED sample: (${f(n2.ch.pts[n2.i].x, 2)}, ${f(n2.ch.pts[n2.i].y, 2)}) on shape ${n2.ch.shape}, ${f(n2.d, 2)}px away, chain len ${n2.ch.pts.length} closed=${n2.ch.closed}`)
        for (const w of [1, 2, 3, 5, 8]) console.log(`    authored window turn +-${w}px: ${f(windowTurn(n2.ch, n2.i, w))}deg`)
      }
      const g = gtCorners.map((q) => Math.hypot(q.x - bc.x, q.y - bc.y)).sort((a, b) => a - b)[0]
      console.log(`  nearest AUTHORED sharp corner: ${g === undefined ? 'none' : f(g, 2) + 'px'}   traced degree ${tracedDegree(bc.x, bc.y)}`)
    }
    return null
  }
  const out: Site[] = []
  for (const c of uniq) {
    let best = { ci: -1, i: -1, d: Infinity }
    let secondShape = Infinity
    for (let ci = 0; ci < chains.length; ci++) {
      const ch = chains[ci]
      let localBest = Infinity
      let localIdx = -1
      for (let i = 0; i < ch.pts.length; i++) {
        const d = Math.hypot(ch.pts[i].x - c.x, ch.pts[i].y - c.y)
        if (d < localBest) {
          localBest = d
          localIdx = i
        }
      }
      if (localBest < best.d) {
        if (best.ci >= 0 && chains[best.ci].shape !== ch.shape) secondShape = Math.min(secondShape, best.d)
        best = { ci, i: localIdx, d: localBest }
      } else if (ch.shape !== (best.ci >= 0 ? chains[best.ci].shape : -1)) {
        secondShape = Math.min(secondShape, localBest)
      }
    }
    const tracedTurn = (Math.acos(Math.max(-1, Math.min(1, c.itx * c.otx + c.ity * c.oty))) * 180) / Math.PI
    const site: Site = {
      x: c.x, y: c.y, tracedTurn, dist: best.d,
      authored: NaN, traced: tracedTurn, excess: NaN,
      verdict: 'off-boundary',
    }
    if (c.x < BORDER_EPS || c.y < BORDER_EPS || c.x > raster.width - BORDER_EPS || c.y > raster.height - BORDER_EPS) {
      site.verdict = 'border'
      out.push(site)
      continue
    }
    if (best.d > NEAR) {
      out.push(site)
      continue
    }
    if (tracedDegree(c.x, c.y) >= 3) {
      site.verdict = 'junction'
      out.push(site)
      continue
    }
    const ch = chains[best.ci]
    const s = ch.pts[best.i]
    site.authored = windowTurn(ch, best.i, WIN)
    site.excess = tracedTurn - site.authored
    if (!vis({ x: s.x, y: s.y, tx: s.tx, ty: s.ty })) site.verdict = 'occluded'
    else if (secondShape <= CROSS) site.verdict = 'crossing'
    else if (gtCorners.some((g) => Math.hypot(g.x - c.x, g.y - c.y) <= CORNER_MATCH_R)) site.verdict = 'explained'
    else site.verdict = 'curved' // provisional; the caller's EXCESS threshold splits it
    out.push(site)
  }
  return out
}

// ---------------------------------------------------------------------------
// `--gate`: the SHIPPED metric (`geomScore.inventedCorners`, via scoreGeometry) over the
// gated corpus, each tier-0 case in ITS OWN lane, so the numbers are the ones CI will see.
// `--logos` scores the gallery flat instead. `--compare` runs both arms of a flag.
//   node --experimental-strip-types src/devtest/kinkDiag.ts --gate
//   node --max-old-space-size=6144 ... kinkDiag.ts --gate --logos --compare
// ---------------------------------------------------------------------------
if (argv.includes('--gate')) {
  const { scoreGeometry } = await import('./geomScore.ts')
  const { TRUTH_CORPUS } = await import('./truthCorpus.ts')
  interface Row { name: string; gradients: boolean; invented: number; worst: number }
  const arms: [string, Record<string, number | boolean>][] = argv.includes('--compare')
    ? [['OFF', { cornerTurnEvidence: false }], ['ON', { cornerTurnEvidence: true }]]
    : [['', parseFit(flag('--fit') ?? '')]]
  const targets: { name: string; svg: string; gradients: boolean }[] = argv.includes('--logos')
    ? readdirSync(join(root, 'examples', 'logos'))
        .filter((x) => x.endsWith('.svg'))
        .map((x) => ({ name: x.replace(/\.svg$/, ''), svg: `examples/logos/${x}`, gradients: false }))
    : TRUTH_CORPUS.filter((c) => c.tier === 0).map((c) => ({ name: c.name, svg: c.svg, gradients: c.gradients !== false }))
  const byArm = new Map<string, Row[]>()
  for (const [arm, fit] of arms) {
    const rows: Row[] = []
    for (const t of targets) {
      let text
      try { text = readFileSync(join(root, t.svg), 'utf8') } catch { continue }
      let gtDoc
      try { gtDoc = parseGroundTruth(text) } catch { continue }
      if (unscorable(gtDoc)) continue
      let img
      try {
        img = decodePng(new Resvg(text, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
      } catch { continue }
      const doc = await traceImage(img as unknown as ImageData, {
        ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: t.gradients, planarFit: fit,
      })
      const sc = scoreGeometry(toRasterSpace(gtDoc, img.width), doc, img.width, img.height, img)
      rows.push({ name: t.name, gradients: t.gradients, invented: sc.cornersInvented, worst: sc.worstInventedExcess })
    }
    byArm.set(arm, rows)
  }
  const base = byArm.get(arms[0][0])!
  const other = arms.length > 1 ? byArm.get(arms[1][0])! : null
  console.log(`\nINVENTED CORNERS @${RES} over ${base.length} cases  (excess ≥ ${40}°)`)
  console.log(`  ${'case'.padEnd(30)}${'lane'.padStart(6)}${arms.length > 1 ? '     OFF      ON     delta' : '  invented    worst'}`)
  let total = 0
  let totalOther = 0
  for (let i = 0; i < base.length; i++) {
    const r = base[i]
    total += r.invented
    if (other) {
      const o = other[i]
      totalOther += o.invented
      if (r.invented === 0 && o.invented === 0) continue
      const d = o.invented - r.invented
      console.log(`  ${r.name.padEnd(30)}${(r.gradients ? 'grad' : 'flat').padStart(6)}${String(r.invented).padStart(8)}${String(o.invented).padStart(8)}${((d > 0 ? '+' : '') + d).padStart(10)}`)
    } else if (r.invented > 0) {
      console.log(`  ${r.name.padEnd(30)}${(r.gradients ? 'grad' : 'flat').padStart(6)}${String(r.invented).padStart(10)}${f(r.worst).padStart(9)}`)
    }
  }
  const dirty = base.filter((r) => r.invented > 0).length
  console.log(`\n  total ${total} invented over ${dirty} of ${base.length} cases` + (other ? `  →  ${totalOther} over ${other.filter((r) => r.invented > 0).length}` : ''))
  const p90 = [...base.map((r) => r.invented)].sort((a, b) => a - b)[Math.floor(base.length * 0.9)]
  console.log(`  per-case invented: p50 ${[...base.map((r) => r.invented)].sort((a, b) => a - b)[base.length >> 1]}  p90 ${p90}  max ${Math.max(...base.map((r) => r.invented))}`)
  process.exit(0)
}

// --- corpus ------------------------------------------------------------------
const EDGE = join(root, 'public', 'examples', 'edge-cases')
const cases: [string, string][] = []
const CASE = flag('--case')
if (CASE) {
  const p = CASE.includes('/') ? `${CASE}.svg` : `examples/logos/${CASE}.svg`
  const alt = join(EDGE, `${CASE}.svg`)
  try {
    cases.push([CASE, readFileSync(join(root, p), 'utf8')])
  } catch {
    cases.push([CASE, readFileSync(alt, 'utf8')])
  }
} else if (argv.includes('--logos')) {
  for (const file of readdirSync(join(root, 'examples', 'logos')).filter((x) => x.endsWith('.svg')))
    cases.push([file.replace(/\.svg$/, ''), readFileSync(join(root, 'examples', 'logos', file), 'utf8')])
} else {
  for (const file of readdirSync(EDGE).filter((x) => x.endsWith('.svg')))
    cases.push([file.replace(/\.svg$/, ''), readFileSync(join(EDGE, file), 'utf8')])
}

const FITS: [string, Record<string, number | boolean>][] = argv.includes('--compare')
  ? [['reading OFF', { cornerTurnEvidence: false }], ['reading ON', { cornerTurnEvidence: true }]]
  : [['', parseFit(flag('--fit') ?? '')]]

const BANDS = [-180, -20, -10, 0, 10, 20, 30, 45, 60, 90, 181]

for (const [label, fit] of FITS) {
  const all: { mark: string; s: Site }[] = []
  for (const [name, text] of cases) {
    const sites = await analyse(name, text, fit)
    if (!sites) continue
    for (const s of sites) all.push({ mark: name, s })
  }
  const onBoundary = all.filter((r) => r.s.verdict !== 'off-boundary')
  const candidates = onBoundary.filter((r) => r.s.verdict === 'curved')
  console.log(`\n━━━ INVENTED-CORNER CENSUS @${RES} flat${label ? `  [${label}]` : ''} ━━━  ${cases.length} cases, ${all.length} traced sharp corners`)
  const by = (v: Verdict): number => all.filter((r) => r.s.verdict === v).length
  console.log(`  off authored boundary (>${NEAR}px, = spuriousMax's job) ${by('off-boundary')}`)
  console.log(`  on the canvas BORDER (framing, not art) ${by('border')}   occluded ${by('occluded')}`)
  console.log(`  at an authored CROSSING ${by('crossing')}   at a traced JUNCTION ${by('junction')}   explained by an authored corner ${by('explained')}`)
  console.log(`  ON smooth-or-curved authored boundary, unexplained: ${candidates.length}\n`)
  console.log(`  EXCESS turn (traced − authored) over ±${WIN}px      n`)
  for (let i = 0; i < BANDS.length - 1; i++) {
    const g = candidates.filter((r) => r.s.excess >= BANDS[i] && r.s.excess < BANDS[i + 1])
    if (!g.length) continue
    console.log(`  ${String(BANDS[i]).padStart(5)}..${String(BANDS[i + 1]).padEnd(5)} ${String(g.length).padStart(6)}   ${'█'.repeat(Math.min(60, g.length))}`)
  }
  for (const thr of [20, 30, 40, 50, 60]) {
    const hits = candidates.filter((r) => r.s.excess >= thr)
    const marks = new Set(hits.map((r) => r.mark))
    console.log(`    excess ≥ ${String(thr).padStart(2)}°: ${String(hits.length).padStart(5)} invented over ${marks.size} of ${cases.length} cases`)
  }
  if (LIST) {
    const worst = candidates.filter((r) => r.s.authored < 30).sort((a, b) => a.s.authored - b.s.authored)
    console.log(`\n  sites with authored window turn < 30°:`)
    for (const r of worst.slice(0, 40))
      console.log(`    ${r.mark.padEnd(24)} (${f(r.s.x)}, ${f(r.s.y)})  traced turn ${f(r.s.tracedTurn)}°  authored ${f(r.s.authored)}°  ${f(r.s.dist, 2)}px off`)
    const per = new Map<string, number>()
    for (const r of worst) per.set(r.mark, (per.get(r.mark) ?? 0) + 1)
    console.log(`\n  per case (<30°):  ` + [...per.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join('  '))
  }
}
