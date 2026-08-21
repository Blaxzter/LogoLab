// §20 — a sub-floor component with FLAT-INTERIOR evidence is not despeckled away
// (src/lib/trace/paletteSegment.ts; issue #8, benchmarks §20).
//
// The flat lane assigns every pixel to a palette colour and then sweeps up the tiny
// connected components the assignment leaves along each boundary — anti-alias shrapnel
// that would otherwise each become their own traced loop. The sweep is a plain area
// floor (`minRegionArea`, 50px² at the default Despeckle dial), and it cannot tell that
// shrapnel from a SMALL REAL FEATURE that happens to be isolated: the ibm mark's ▼ (the
// peak of the m's middle stroke) is a 26px component of an accepted 11.7%-share ink
// entry, cut off from the rest of the mark by the art's own white stripes, and the floor
// ate it whole. Every palette COLOUR stage kept it — measured stage by stage with
// `lowresDiag --roi`, 24 → 32 → 32 → 26 → 26 px — and only this per-component floor
// killed it.
//
// WHAT SEPARATES THEM, and why it is this and not the obvious thing. A component with a
// full 3×3 SOURCE block of exactly its palette hex is nine adjacent pixels at full
// coverage of one authored colour: solid ink by definition, which a coverage ramp cannot
// produce (consecutive AA pixels differ — that is what makes them a ramp). Measured over
// 2,394 sub-floor components on 174 marks against a 4× supersampled truth, that fires on
// 46 of them and NONE is fringe. The intuitive axis — the share of the component's pixels
// that are exactly its palette hex — was measured and rejected: it resurrects 40–54
// fringe components at every threshold while still missing over half the real ones.
// paletteSegment.ts carries the table; §20 carries the derivation.
//
// WHY THE FIXTURE. The reporting mark is private-corpus and cannot gate CI, so
// `peak-drop` is authored for this: 20 downward peaks of 20/30/40/48/64 px² @512 (four
// below the default floor, one above it as the in-case control) in four rows at
// quarter-unit phase offsets and two palette colours, each isolated between two bars the
// ibm way. Every coordinate below is computed from genEdgeCases' own formulas, so this is
// geometry, not a blessed baseline.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { decodePng } from '../src/devtest/png.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { rasterizeDoc } from '../src/lib/render/raster.ts'
import { srgbToLab, deltaE76 } from '../src/devtest/color.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SVG = readFileSync(join(root, 'public', 'examples', 'edge-cases', 'peak-drop.svg'), 'utf8')
const RES = 512
/** The fixture is authored in a 256 viewBox; every authored coordinate scales by this. */
const S = RES / 256

const INK: [number, number, number] = [26, 26, 34]
const GOLD: [number, number, number] = [226, 170, 40]
/** genEdgeCases' own rack: areas (raster px² @512), and [yTop, fill, phase] per row. */
const AREAS = [20, 30, 40, 48, 64]
const ROWS: [number, [number, number, number], number][] = [
  [12, INK, 0], [56, GOLD, 0.25], [100, INK, 0.5], [144, GOLD, 0.75],
]
/** The floor at the default Despeckle dial — the line the rack is authored to straddle. */
const FLOOR = 50

interface Peak {
  /** Interior sample point, raster px: the triangle's centroid. */
  x: number
  y: number
  fill: [number, number, number]
  areaR: number
}
const PEAKS: Peak[] = []
for (const [yTop, fill, phase] of ROWS) {
  for (let i = 0; i < AREAS.length; i++) {
    const areaR = AREAS[i]
    // peak(): base/height at the reporting mark's ratio, authored in 256-space.
    const bR = Math.sqrt(2 * areaR * (7.15 / 9.1))
    const hU = bR / (7.15 / 9.1) / 2
    const cx = 8 + i * 49 + 14 + phase
    const y = yTop + 8 + phase
    // Centroid of a triangle with a flat top edge at `y` and its apex at `y + hU`.
    PEAKS.push({ x: cx * S, y: (y + hU / 3) * S, fill, areaR })
  }
}

const IMG = decodePng(new Resvg(SVG, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())

/** How many authored peaks does the trace actually PAINT? Asked at each peak's own
 *  interior point, in ΔE against its authored fill — scoreRegions' lens, per feature.
 *  (Boundary distance cannot answer this: a region that is simply absent has no traced
 *  boundary to be far from, and the corpus percentiles drown 20 small features in the
 *  rack's own bars.) */
async function paintedPeaks(over: Record<string, unknown>): Promise<boolean[]> {
  const doc = await traceImage(IMG as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, paletteSegment: over,
  })
  const render = rasterizeDoc(doc, IMG.width, IMG.height)
  return PEAKS.map((p) => {
    const o = ((Math.round(p.y) * IMG.width) + Math.round(p.x)) * 4
    const got = srgbToLab(render[o], render[o + 1], render[o + 2])
    return deltaE76(got, srgbToLab(p.fill[0], p.fill[1], p.fill[2])) <= 4
  })
}

const OFF = await paintedPeaks({ regionEvidence: false })
const ON = await paintedPeaks({})
const count = (xs: boolean[]): number => xs.filter(Boolean).length

/** The smallest peak the veto can reach. Below this the rule is not wrong, it is BLIND:
 *  a 3×3 block needs nine full-coverage pixels and a 20px² triangle (5.6 × 7.1 raster px)
 *  is too thin a wedge to contain one, so there is no evidence to read. Recorded as a
 *  bound rather than hidden in a count — this is the rule's resolution, and a future fix
 *  that reaches further should have to delete this line deliberately. */
const EVIDENCE_MIN_AREA = 30

test('peak: sub-floor features with flat-interior evidence survive the despeckle floor', () => {
  // Measured at authoring, @512, and it is a clean LADDER rather than a score: with the
  // veto off only the four above-floor controls are painted (4/20); with it on every peak
  // from 30px² up is painted and every 20px² one is not (16/20). Asserting the ladder
  // rather than the total is the point — a count of 16 could also be four sizes recovered
  // in two rows and a phase lottery in the other two, which is a different tracer.
  assert.equal(
    count(OFF), PEAKS.filter((p) => p.areaR > FLOOR).length,
    `precondition: the pre-§20 floor should paint the above-floor controls and nothing else (painted ${count(OFF)}/20)`,
  )
  for (let i = 0; i < PEAKS.length; i++) {
    const p = PEAKS[i]
    if (p.areaR < EVIDENCE_MIN_AREA) continue
    assert.ok(ON[i], `peak ${i} (${p.areaR}px², fill ${p.fill.join(',')}) is still unpainted under §20`)
  }
  assert.ok(
    count(ON) >= 16,
    `the evidence veto should recover the rack: painted ${count(ON)}/20 (was ${count(OFF)}/20)`,
  )
})

test('peak: the ABOVE-floor control is recovered either way', () => {
  // The rack is a sweep, not a target: its 64px² peaks clear the 50px floor on their own,
  // so a "fix" that merely lowered or removed the floor would be indistinguishable from
  // one that reads evidence. These must be painted with the veto OFF too — if they ever
  // are not, the case has stopped measuring the mechanism it is named for.
  for (let i = 0; i < PEAKS.length; i++) {
    if (PEAKS[i].areaR <= FLOOR) continue
    assert.ok(OFF[i], `above-floor control (${PEAKS[i].areaR}px²) is unpainted even before §20`)
    assert.ok(ON[i], `above-floor control (${PEAKS[i].areaR}px²) lost its paint under §20`)
  }
})

test('peak: the veto is ONE-SIDED — it never dissolves what the floor kept', () => {
  // §17's ARM_BOW shape, and the property that makes the rule safe to ship on evidence
  // this thin: the veto can only SPARE a component. Anything painted before must still be
  // painted after, feature by feature — a rule that traded one peak for another would
  // score the same in aggregate and be a different, worse change.
  for (let i = 0; i < PEAKS.length; i++)
    assert.ok(!OFF[i] || ON[i], `peak ${i} (${PEAKS[i].areaR}px²) was painted before §20 and is not after`)
})

test('peak: the AA seam control does not shatter into fringe loops', async () => {
  // The other side of the trade, and the reason the floor exists at all. The fixture's
  // bottom third is a ~1.8° seam whose staircase is exactly the shrapnel `minRegionArea`
  // is there to sweep up; a veto too loose to tell that from art would revive dozens of
  // one-pixel components and each would become its own traced loop. Node count is the
  // instrument that sees it (§12's pencil-flat measured 1.5× → 10.1× parsimony when an
  // 8-connected despeckle did exactly this). Measured: 352 → 436 nodes, and +84 is the
  // 16 recovered peaks' own outlines, not fringe.
  const nodesOf = async (over: Record<string, unknown>): Promise<number> => {
    const doc = await traceImage(IMG as unknown as ImageData, {
      ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, paletteSegment: over,
    })
    return doc.items.reduce(
      (s, it) => s + (it.kind === 'path' ? it.subPaths.reduce((t, sp) => t + sp.nodes.length, 0) : 0),
      0,
    )
  }
  const off = await nodesOf({ regionEvidence: false })
  const on = await nodesOf({})
  const recovered = count(ON) - count(OFF)
  // Each recovered peak is a triangle: 3 nodes of outline, and the seam it is cut out of
  // gains a matching hole. Allow 10 nodes per recovered feature — 3× the true cost, still
  // far under what a shattered seam would spend.
  assert.ok(
    on - off <= 10 * recovered,
    `node count grew ${off} → ${on} (+${on - off}) for ${recovered} recovered peaks — the seam is shattering`,
  )
})
