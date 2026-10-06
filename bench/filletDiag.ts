// FILLET DIAG (§42) — what the rounded-polygon fit (src/lib/trace/planarFit/fillet.ts) reads.
//
//   node --experimental-strip-types bench/filletDiag.ts                      # the fixtures @512
//   node --max-old-space-size=6144 ... filletDiag.ts --logos --res 1024      # the gallery
//   node --experimental-strip-types bench/filletDiag.ts --case round-polys --list
//   node --experimental-strip-types bench/filletDiag.ts --breaks             # the gate's number, fit off vs on
//   --res N (default 512)   --mono   --upscale S (bilinear, the mono path's enlargement)
//
// THREE QUESTIONS, one per mode.
//
// The CENSUS (default) asks where the fit fires and whether it should have. Per case it
// lists every loop emitted — `12.1/90°` is an arc of radius 12.1px turning 90°, `∠90°` a
// corner left sharp — and checks each arc against the AUTHORED geometry: an arc whose apex
// (the corner it rounds) sits on a vertex the artist drew sharp rounded something it had no
// business rounding. That count is the fit's false-positive number and it has to be zero.
// The footer is the calibration the two floors rest on: the radius the fit READS at corners
// it leaves sharp (what anti-aliasing does to a real corner), and how far the arcs it does
// emit stand off theirs.
//
// `--list` is the per-loop autopsy: every loop the fit weighed on one case, the verdict,
// each gap's turn / radius / excess over tolerance, and each side's certified length
// against what its two tangent points leave of it. `gap-unexplained` with an excess of a
// few hundredths is an outlier problem; with an excess over a pixel it is the wrong model.
//
// `--breaks` is the gate's own number (`geomScore.tangentBreaks`) over the tier-0 corpus
// with the fit off and on, next to everything else that could have moved — the table the
// allowances in truthCorpus.ts were read from. With `--list` it adds where each remaining
// break sits, which is the first thing to ask when the gate goes red.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from '../src/lib/png/decode.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { upscaleImageData } from '../src/lib/sheet/crop.ts'
import type { FilletDiagRecord } from '../src/lib/trace/planarFit.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from './svgGround.ts'
import { sharpCorners, scoreGeometry, tangentBreaks, makeVisibleAt, CORNER_MATCH_R } from './geomScore.ts'
import type { SubPath } from '../src/lib/path/types.ts'
import { TRUTH_CORPUS } from './truthCorpus.ts'

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
const UP = Number(flag('--upscale') ?? 1)
const MONO = argv.includes('--mono')
const ONLY = flag('--case')
const f = (v: number, d = 1): string => v.toFixed(d)

const render = (text: string): ReturnType<typeof decodePng> =>
  decodePng(new Resvg(text, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
const options = (planarFit: Record<string, unknown>, gradients = false): never =>
  ({
    ...DEFAULT_VECTORIZE_OPTIONS,
    engine: 'planar',
    gradients,
    ...(MONO ? { mode: 'mono' } : {}),
    planarFit,
  }) as never

// ---------------------------------------------------------------------------
// --breaks: the gate's number, fit off vs on
// ---------------------------------------------------------------------------
if (argv.includes('--breaks')) {
  console.log(
    `\nTANGENT BREAKS @${RES}, rounded-polygon fit off → on\n  ${'case'.padEnd(26)}lane   breaks (worst)    invented   chamfer          nodes       corners`,
  )
  let off = 0
  let on = 0
  for (const c of TRUTH_CORPUS.filter((t) => t.tier === 0 && (!ONLY || t.name === ONLY))) {
    const text = readFileSync(join(root, c.svg), 'utf8')
    const gd = parseGroundTruth(text)
    if (unscorable(gd)) continue
    const img = render(text)
    const gt = toRasterSpace(gd, img.width)
    const gradients = c.gradients !== false
    const s: ReturnType<typeof scoreGeometry>[] = []
    let sites: ReturnType<typeof tangentBreaks>['sites'] = []
    for (const fillets of [false, true]) {
      const doc = await traceImage(img as unknown as ImageData, options({ fillets }, gradients))
      s.push(scoreGeometry(gt, doc, img.width, img.height, img))
      if (fillets && argv.includes('--list')) {
        const sets = doc.items
          .filter((i) => i.kind === 'path' && i.visible !== false)
          .map((i) => (i as unknown as { subPaths: SubPath[] }).subPaths)
        sites = tangentBreaks(gt, sets, img.width, img.height, makeVisibleAt(img)).sites
      }
    }
    const [a, b] = s
    if (!gradients) {
      off += a.tangentBreaks
      on += b.tangentBreaks
    }
    console.log(
      `  ${c.name.padEnd(26)}${gradients ? 'grad' : 'flat'}  ${String(a.tangentBreaks).padStart(3)} → ${String(b.tangentBreaks).padStart(3)} (${f(b.worstTangentBreak, 0).padStart(3)}°)   ${a.cornersInvented} → ${b.cornersInvented}     ${f(a.chamfer, 3)} → ${f(b.chamfer, 3)}   ${String(a.docNodes).padStart(4)} → ${String(b.docNodes).padStart(4)}   ${a.cornersRecovered} → ${b.cornersRecovered} / ${a.gtCorners}`,
    )
    // `--list`: where the breaks that are left sit (px at this raster), worst first.
    for (const site of sites) console.log(`      (${f(site.x)}, ${f(site.y)})  ${f(site.kink)}°`)
  }
  console.log(`\n  flat total ${off} → ${on}`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// The census, and --list
// ---------------------------------------------------------------------------
const dir = argv.includes('--logos') ? join(root, 'examples', 'logos') : join(root, 'public', 'examples', 'edge-cases')
const files = readdirSync(dir).filter((x) => x.endsWith('.svg') && (!ONLY || x === `${ONLY}.svg`))
if (ONLY && !files.length && existsSync(ONLY)) files.push(ONLY)
const cornerR: number[] = []
const cuts: number[] = []
let loops = 0
let emitted = 0
let arcs = 0
let checked = 0
let onCorner = 0
for (const file of files) {
  let text: string
  let img: ReturnType<typeof decodePng>
  try {
    text = readFileSync(existsSync(file) ? file : join(dir, file), 'utf8')
    img = render(text)
  } catch {
    continue
  }
  let src = img as unknown as ImageData
  if (UP > 1) src = upscaleImageData(src, UP) as ImageData
  const recs: FilletDiagRecord[] = []
  try {
    await traceImage(src, options({ filletDiag: (r: FilletDiagRecord) => recs.push(r) }))
  } catch (e) {
    console.log(`${file}: ${(e as Error).message}`)
    continue
  }
  const name = file.replace(/^.*[\\/]/, '').replace(/\.svg$/, '')
  loops += recs.length
  const em = recs.filter((r) => r.verdict === 'emitted')
  emitted += em.length
  // `smooth-radii` and `round-polys` author corners UNDER the radius floor on purpose;
  // what the fit reads there is not what it reads at a sharp one.
  if (name !== 'smooth-radii' && name !== 'round-polys')
    for (const r of recs)
      for (const g of r.gaps) if (g.kind === 'corner' && g.turn >= 30 && g.turn <= 150) cornerR.push(g.r / UP)

  if (argv.includes('--list')) {
    const tally = new Map<string, number>()
    for (const r of recs) {
      tally.set(r.verdict, (tally.get(r.verdict) ?? 0) + 1)
      const g0 = r.gaps[0]
      console.log(`loop n=${r.n} runs ${r.runs} → ${r.verdict}${g0 ? `  near (${f(g0.x)}, ${f(g0.y)})` : ''}`)
      r.gaps.forEach((g, i) =>
        console.log(
          `     ${r.sides ? `side ${f(r.sides[i].len).padStart(6)}px (straight ${f(r.sides[i].straight).padStart(6)})  ` : ''}${g.kind.padEnd(11)} turn ${f(g.turn).padStart(5)}°  r ${f(g.r, 2).padStart(7)}px  excess ${f(g.res, 2)}`,
        ),
      )
    }
    console.log(`${name} @${img.width}: ${[...tally].map(([a, b]) => `${a} ${b}`).join(' · ')}\n`)
  } else if (em.length) {
    console.log(
      `${name.padEnd(28)} ${String(em.length).padStart(3)} of ${String(recs.length).padStart(4)} loops  ` +
        em
          .slice(0, 5)
          .map(
            (r) =>
              `[${r.gaps.map((g) => (g.kind === 'fillet' ? `${f(g.r)}/${f(g.turn, 0)}°` : `∠${f(g.turn, 0)}°`)).join(' ')}]`,
          )
          .join(' ') +
        (em.length > 5 ? ' …' : ''),
    )
  }

  // Against the AUTHORED art: an arc whose apex is a vertex the artist drew sharp.
  let gtCorners: { x: number; y: number }[] | null = null
  try {
    const gd = parseGroundTruth(text)
    if (!unscorable(gd))
      gtCorners = sharpCorners(
        toRasterSpace(gd, img.width).map((s) => s.subPaths),
        0,
      )
  } catch {
    gtCorners = null
  }
  for (const r of em)
    for (const g of r.gaps) {
      if (g.kind !== 'fillet') continue
      arcs++
      if (g.turn >= 179) continue // a U-turn or the long way round rounds no corner
      const cut = g.r * (1 / Math.cos((g.turn * Math.PI) / 360) - 1)
      cuts.push(cut / UP)
      if (!gtCorners) continue
      checked++
      const mx = (g.t1.x + g.t2.x) / 2 - g.x
      const my = (g.t1.y + g.t2.y) / 2 - g.y
      const ml = Math.hypot(mx, my) || 1
      const ax = g.x + ((g.r + cut) * mx) / ml
      const ay = g.y + ((g.r + cut) * my) / ml
      if (gtCorners.some((c) => Math.hypot(c.x * UP - ax, c.y * UP - ay) <= CORNER_MATCH_R * UP)) {
        onCorner++
        console.log(
          `   ✗ ${name}: arc r ${f(g.r)} turn ${f(g.turn, 0)}° rounds an AUTHORED sharp corner at (${f(ax, 0)}, ${f(ay, 0)})`,
        )
      }
    }
}
cornerR.sort((a, b) => a - b)
cuts.sort((a, b) => a - b)
const q = (v: number[], p: number): string =>
  v.length ? f(v[Math.min(v.length - 1, Math.floor(v.length * p))], 2) : '—'
console.log(
  `\n${files.length} files @${RES}${UP > 1 ? ` ×${UP}` : ''}${MONO ? ' mono' : ''}: ${loops} loops weighed, ${emitted} emitted — ${arcs} arcs, ${checked} checked against the authored art, ${onCorner} on an authored sharp corner`,
)
console.log(
  `radius read at ${cornerR.length} corners left sharp (source px): p50 ${q(cornerR, 0.5)}  p90 ${q(cornerR, 0.9)}  p99 ${q(cornerR, 0.99)}  max ${q(cornerR, 1)}`,
)
console.log(
  `stand-off of the emitted arcs from their corner (source px): min ${q(cuts, 0)}  p10 ${q(cuts, 0.1)}  p50 ${q(cuts, 0.5)}`,
)
