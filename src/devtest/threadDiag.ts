// §14 thread census — what the contrast rank actually SEES at every junction.
//
//   node --experimental-strip-types src/devtest/threadDiag.ts [logo.svg] [--res 512]
//                                                             [--case band-cross] [--all]
//
// bandPullDiag measures the DAMAGE post-hoc from the doc's topology; this prints the
// tracer's own decision, from inside: per junction the incident boundaries' ΔE, the
// arm lengths, the through-fit residual against ONE line and ONE circle, and the
// verdict `surveyJunctions` reaches. It is how the gates (STRONG_DE / WEAK_DE /
// THROUGH_DEV) were picked — the histogram at the bottom is the thing that could
// have killed them: a clean bimodal ΔE split and a clean residual split, or no fix.
//
// PURELY DIAGNOSTIC (gearDiag / capDiag / bandPullDiag precedent).
//
// CAVEAT: it reproduces the FLAT-PALETTE segmentation (traceImage's flat path). Art
// that falls through to the Mumford–Shah segmenter instead — low flat coverage, or
// more than 14 dominant colours, e.g. `gradient-flat` — reaches the tracer with a
// different label map, so this census is about the palette-first map, not that one.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { segmentFlatPalette } from '../lib/trace/paletteSegment.ts'
import { buildPlanarNetwork } from '../lib/trace/planarNetwork.ts'
import { edgeContrast, surveyJunctions } from '../lib/trace/planarThread.ts'
import { healColorSpikes } from '../lib/trace/index.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const RES = Number(argv[argv.indexOf('--res') + 1]) || 512
const CASE = argv.indexOf('--case') >= 0 ? argv[argv.indexOf('--case') + 1] : null
// A corpus case (--case checker), a repo-relative path (public/examples/nebula.png),
// or a bare name from the private logo corpus (the default).
const FILE = argv.find((a) => a.endsWith('.svg') || a.endsWith('.png')) ?? 'affinity-designer.svg'
const path = CASE
  ? join(root, 'public', 'examples', 'edge-cases', `${CASE}.svg`)
  : FILE.includes('/')
    ? join(root, FILE)
    : join(root, 'examples', 'logos', FILE)
const img = decodePng(
  path.endsWith('.png')
    ? readFileSync(path)
    : new Resvg(readFileSync(path, 'utf8'), { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng(),
)

// The gallery's flat config up to (not including) the fit — traceImage's flat path
// verbatim: paletteOptionsFor(DEFAULTS + gradients:false) is detail 0, despeckle 25.
const paletteOpts = {
  maxColors: 16,
  minShare: Math.max(0.0006, 0.006 - 0 * 0.0052 + 0.25 * 0.004),
  modePasses: 2,
  minRegionArea: Math.max(24, Math.round(0.25 * 0.25 * 800)),
  regionEvidence: true,
}
const fp = segmentFlatPalette(img as unknown as { width: number; height: number; data: Uint8ClampedArray }, paletteOpts, undefined)
const labels = healColorSpikes(fp.labels, img.data as unknown as Uint8ClampedArray, img.width, img.height, fp.palette)
const q = { palette: fp.palette }
const net = buildPlanarNetwork(labels, img.width, img.height)
const contrast = edgeContrast(net, q.palette)
const verdicts = surveyJunctions(net, contrast)

console.log(`\n━━━ ${CASE ?? FILE} @ ${RES}px ━━━ ${net.edges.length} edges, ${net.junctions.length} junctions, ${q.palette.length} colours\n`)

// 1. The contrast spectrum — the fact the whole fix rests on. If this is not
//    bimodal on the art in front of you, the rank is meaningless and the gates are
//    arbitrary; print it before anything else.
const des = [...contrast].filter((d) => Number.isFinite(d)).sort((a, b) => a - b)
console.log('  EDGE CONTRAST SPECTRUM (ΔE76 across each shared edge, ∞/border omitted):')
{
  const bins = [0, 2, 4, 6, 8, 10, 12, 16, 20, 25, 30, 40, 60, 80, 1e9]
  for (let i = 0; i + 1 < bins.length; i++) {
    const n = des.filter((d) => d >= bins[i] && d < bins[i + 1]).length
    if (!n) continue
    const tag = `${bins[i]}–${bins[i + 1] > 1e8 ? '∞' : bins[i + 1]}`
    console.log(`    ${tag.padStart(7)}  ${'█'.repeat(Math.min(60, n))} ${n}`)
  }
  const gap = { lo: 0, hi: 0, size: 0 }
  for (let i = 1; i < des.length; i++) {
    if (des[i] - des[i - 1] > gap.size) {
      gap.size = des[i] - des[i - 1]
      gap.lo = des[i - 1]
      gap.hi = des[i]
    }
  }
  console.log(`    widest gap: ${gap.lo.toFixed(1)} → ${gap.hi.toFixed(1)}  (${gap.size.toFixed(1)} wide) — the gates sit at 12 / 25\n`)
}

// 2. Every junction the rank looked at, and what it decided. `bow` is the §17 arm gate:
//    the max deviation of each strong arm's samples from its own fitted line. It only
//    matters on the CORNER branch, where a bowed arm's line is a chord across the bend
//    and may not be intersected against (ARM_BOW 0.8, one-sided — see planarThread.ts).
console.log('  JUNCTIONS (only degree ≥3 with at least one weak arm are candidates)')
console.log('     at            deg  ΔE of arms                  arm px   line   circ   turn    bow A/B   verdict')
const showAll = argv.includes('--all')
for (const v of verdicts) {
  const weakish = v.ends.some((e) => e.de <= 12)
  if (!showAll && !weakish && !v.linked) continue
  const des2 = v.ends
    .slice()
    .sort((a, b) => b.de - a.de)
    .map((e) => (Number.isFinite(e.de) ? e.de.toFixed(1) : '∞'))
    .join(' ')
  const arms = v.ends.map((e) => e.arm.toFixed(0)).join('/')
  const f = (x: number | null) => (x == null ? '  —  ' : x.toFixed(2).padStart(5))
  const bow = v.armBow ? `${v.armBow[0].toFixed(2)}/${v.armBow[1].toFixed(2)}` : '  —  '
  const mark = v.linked ? (v.kind === 'thread' ? (v.extK != null ? `★ THREAD (circle ×${v.extK})` : '★ THREAD') : '◆ APEX') : v.reason
  console.log(
    `  (${v.x.toString().padStart(3)},${v.y.toString().padStart(3)})   ${String(v.ends.length).padStart(2)}   ${des2.padEnd(26)} ${arms.padStart(8)}  ${f(v.lineDev)}  ${f(v.circleDev)}  ${v.turnDeg == null ? '  —  ' : v.turnDeg.toFixed(1).padStart(5)}  ${bow.padStart(9)}   ${mark}`,
  )
}

// 3. The residual split — the second gate. A continuation and a real corner have to
//    live on opposite sides of THROUGH_DEV or the test is a coin flip.
const scored = verdicts.filter((v) => v.lineDev != null)
if (scored.length) {
  console.log('\n  THROUGH-FIT RESIDUAL, best of line/circle (the THROUGH_DEV = 1.2 gate):')
  for (const v of scored.slice().sort((a, b) => bestDev(a) - bestDev(b))) {
    const d = bestDev(v)
    console.log(
      `    (${v.x.toString().padStart(3)},${v.y.toString().padStart(3)})  ${d.toFixed(2).padStart(6)}  ${'█'.repeat(Math.min(50, Math.round(d * 10)))}${d <= 1.2 ? '' : '   ← rejected'}`,
    )
  }
}
function bestDev(v: (typeof verdicts)[number]): number {
  return Math.min(v.lineDev ?? Infinity, v.circleDev ?? Infinity)
}

// 4. What the tracer will actually do: the moves, largest first. A move is a SUB-PIXEL
//    placement — anything approaching MAX_MOVE (2px) means the through fit and the
//    label map disagree, and that junction is dropped rather than dragged.
const moved = verdicts.filter((v) => v.linked)
const byKind = (k: string): number => moved.filter((v) => v.kind === k).length
console.log(
  `\n  MOVED: ${moved.length} of ${verdicts.length} junctions — off the lattice corner, onto what:` +
    `   (§14 thread ${byKind('thread')} · §17 apex ${byKind('apex')})`,
)
for (const v of moved.slice().sort((a, b) => (b.move ?? 0) - (a.move ?? 0))) {
  const how = v.kind === 'thread' ? (v.extK != null ? `through-circle ×${v.extK}` : bestDev(v) === v.circleDev ? 'through-circle' : 'through-line') : 'arm∩arm'
  console.log(
    `    (${v.x.toString().padStart(3)},${v.y.toString().padStart(3)})  ${(v.move ?? 0).toFixed(2)}px` +
      `  → (${v.moveTo!.x.toFixed(2)},${v.moveTo!.y.toFixed(2)})   ${how}`,
  )
}
console.log()
