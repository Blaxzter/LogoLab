// §22 — a corner's macro TURN is read from its own arm evidence, not from a ±4-point
// chord on the lattice (src/lib/trace/planarFit.ts; issue #23, benchmarks §22).
//
// `detectCorners` (and the two cluster readers, and the cap resolver) decide "is this a
// corner" by measuring the angle between two CHORDS taken ±4 POINTS along the raw integer
// staircase. Each chord endpoint carries up to half a pixel of quantization, which is
// ~7° of direction error over a 4px chord — and on a steep diagonal, where a run of
// collinear staircase steps fills the whole window, the error is SYSTEMATIC: the chord
// snaps to the run's own direction. Measured on the reporting witness, a corner authored
// at exactly 60.0° reads 45.0° against a 60° bar, so it is never classified, never
// reaches the corner fit, and keeps a lattice-pinned node 1.54px out (§21.2). The corpus
// census behind §21 showed this is a THRESHOLD CLIFF and not one site: 96.3% of visible
// authored corners recovered at 90–105° of turn, 55.1% at 60–65°.
//
// WHAT SHIPS, and why in that shape. The chord reading is kept and a SECOND opinion is
// offered: the turn between two least-squares arm directions, each fitted over as many
// samples as stay straight to within the fit's own ε. The sharper of the two wins, so the
// reading is a one-sided PROMOTION — at the detector it can only make a vertex sharper,
// never smoother. That is not a stylistic choice, it is what the corpus measured: as a
// REPLACEMENT the evidence reading gains 85 authored corners and drops 13 the chord finds
// today; as a promotion it gains the same 85 and drops none (§22.2). Three guards ride
// with it, each measured in rather than assumed:
//   • the promotion is NON-MAX-SUPPRESSED before it is applied — both cluster readers emit
//     one apex per RUN of sharp vertices, so an unsuppressed promotion FUSES neighbouring
//     corners; un-suppressed it cost gear-teeth 53 → 50 of 60;
//   • a REACH gate — only a candidate the chord already reads within 25° of the bar is
//     re-read, so arm evidence alone can never mint a corner where the boundary is locally
//     straight; open past ~32° it costs gear-teeth 57 → 52;
//   • a CO-CIRCULAR veto — a promotion that would create a corner is refused when one
//     circle explains the same samples, because two straight arms always "explain" a small
//     enough circle. Without it the fixture's own 12px and 18px discs pick up 6 and 8
//     sharp corners each @256.
//
// WHY THE FIXTURE. The reporting witness (`affinity-designer.svg`'s Λ apex) is private
// corpus and cannot gate CI, and a single angle would gate a single draw of a threshold
// effect anyway. `corner-turns` is authored for this: circular sectors sweeping AUTHORED
// TURN across the cliff — 61 / 65 / 69 / 73 / 77 / 81 / 100° — eight bisector rotations
// per rung, each cell at its own quarter-unit AA phase. Exactly one corner per cell
// carries the swept angle (the apex); the two arm ends turn exactly 90° in every cell,
// which makes them the in-case control in the band that already recovers. Every
// coordinate below is recomputed from genEdgeCases' own formulas, so this is geometry,
// not a blessed baseline.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { decodePng } from '../src/devtest/png.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { sharpCorners, CORNER_MATCH_R } from '../src/devtest/geomScore.ts'
import type { SubPath } from '../src/lib/path/types.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SVG = readFileSync(join(root, 'public', 'examples', 'edge-cases', 'corner-turns.svg'), 'utf8')
const RES = 512
/** The fixture is authored in a 256 viewBox; every authored coordinate scales by this. */
const S = RES / 256

/** genEdgeCases' own rack. */
const TURNS = [61, 65, 69, 73, 77, 81, 100]
const ROTS = [0, 11, 23, 34, 45, 56, 68, 79]
const L = 13
const PITCH = 32
const ORIGIN = 16
const COLS = 8

interface Site {
  /** The AUTHORED turn at this corner, in degrees. */
  turn: number
  rot: number
  x: number
  y: number
  kind: 'apex' | 'arm'
}
const SITES: Site[] = []
for (let i = 0; i < TURNS.length * ROTS.length; i++) {
  const cx = ORIGIN + (i % COLS) * PITCH + ((i * 3) % 4) / 4
  const cy = ORIGIN + Math.floor(i / COLS) * PITCH + ((i * 5) % 4) / 4
  const turn = TURNS[Math.floor(i / ROTS.length)]
  const rot = ROTS[i % ROTS.length]
  const b = (rot * Math.PI) / 180
  const h = (((180 - turn) / 2) * Math.PI) / 180
  SITES.push({ turn, rot, x: cx * S, y: cy * S, kind: 'apex' })
  // The arm ends: a straight radius meeting the closing arc, exactly 90° in every cell.
  for (const sgn of [-1, 1] as const)
    SITES.push({
      turn: 90,
      rot,
      x: (cx + L * Math.cos(b + sgn * h)) * S,
      y: (cy + L * Math.sin(b + sgn * h)) * S,
      kind: 'arm',
    })
}
/** The four smooth controls along the bottom row (authored radii, in raster px). */
const DISCS = [4, 6, 9, 12].map((r, k) => ({
  x: (ORIGIN + (1 + 2 * k) * PITCH) * S,
  y: (ORIGIN + 7 * PITCH) * S,
  r: r * S,
}))

const IMG = decodePng(new Resvg(SVG, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())

interface Run {
  /** Per SITES entry: is there a traced SHARP corner within CORNER_MATCH_R of it? */
  hit: boolean[]
  nodes: number
  /** Per DISCS entry: traced sharp corners sitting on that disc. */
  discCorners: number[]
}
async function run(over: Record<string, unknown>): Promise<Run> {
  const doc = await traceImage(IMG as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, planarFit: over,
  })
  const sets = doc.items.flatMap((it) => (it.kind === 'path' ? it.subPaths : [])) as SubPath[]
  const cs = sharpCorners(sets.map((sp) => [sp]), 0)
  return {
    hit: SITES.map((s) => cs.some((p) => Math.hypot(p.x - s.x, p.y - s.y) <= CORNER_MATCH_R)),
    nodes: sets.reduce((t, sp) => t + sp.nodes.length, 0),
    discCorners: DISCS.map((d) => cs.filter((p) => Math.hypot(p.x - d.x, p.y - d.y) <= d.r + 2).length),
  }
}

const OFF = await run({ cornerTurnEvidence: false })
const ON = await run({})

const apexes = (turn: number): number[] =>
  SITES.map((s, i) => [s, i] as const).filter(([s]) => s.kind === 'apex' && s.turn === turn).map(([, i]) => i)
const armIdx = SITES.map((s, i) => [s, i] as const).filter(([s]) => s.kind === 'arm').map(([, i]) => i)
const got = (r: Run, idx: number[]): number => idx.filter((i) => r.hit[i]).length

/** The rung the reading still cannot clear, and why it is a bound rather than slack. A
 *  corner authored at 61° has one degree of headroom over the bar; the staircase itself
 *  carries about that much noise, so two of the eight phases stay under it even read from
 *  their arms. Recorded so a later reading that reaches further has to delete this line
 *  deliberately — and so the ladder below cannot be quietly weakened instead. */
const RESIDUAL_RUNG = 61
const RESIDUAL_RECOVERED = 6

test('turn: the authored-turn ladder — the cliff at the bar is climbed', () => {
  // Measured at authoring @512, and it is a LADDER rather than a score: the chord reading
  // loses corners only as the authored turn approaches the bar (3/8 at 61°, 7/8 at 65 and
  // 69, 8/8 from 73 up), which is the census's cliff reproduced in one case. Asserting the
  // ladder is the point — a total could also be a phase lottery redistributed.
  assert.equal(got(OFF, apexes(61)), 3, `precondition: the chord reading should lose most of the 61° rung (got ${got(OFF, apexes(61))}/8)`)
  assert.equal(got(OFF, apexes(65)), 7, `precondition: the chord reading should lose part of the 65° rung (got ${got(OFF, apexes(65))}/8)`)
  assert.equal(got(OFF, apexes(69)), 7, `precondition: the chord reading should lose part of the 69° rung (got ${got(OFF, apexes(69))}/8)`)

  for (const t of [65, 69, 73, 77, 81, 100])
    assert.equal(got(ON, apexes(t)), 8, `§22 should recover the whole ${t}° rung (got ${got(ON, apexes(t))}/8)`)
  assert.ok(
    got(ON, apexes(RESIDUAL_RUNG)) >= RESIDUAL_RECOVERED,
    `§22 should recover ≥${RESIDUAL_RECOVERED}/8 of the ${RESIDUAL_RUNG}° rung (got ${got(ON, apexes(RESIDUAL_RUNG))}/8, was ${got(OFF, apexes(RESIDUAL_RUNG))}/8)`,
  )
})

test('turn: the 90° arm-end control is recovered either way', () => {
  // The rack is a SWEEP, not a target. Its arm ends turn 90° in every cell — the band the
  // census already recovers at 96.3% — so they must be recovered before the change as well
  // as after. This is what stops "lower `cornerTurnDeg`" from passing the case: dropping
  // the bar mints corners the scorer does not count and shatters the easy ones, which
  // shows up here and not in the apex ladder. Measured 111/112 both ways.
  assert.ok(got(OFF, armIdx) >= 110, `precondition: the arm-end control should already recover (got ${got(OFF, armIdx)}/112)`)
  assert.ok(
    got(ON, armIdx) >= got(OFF, armIdx),
    `the 90° control lost corners under §22: ${got(OFF, armIdx)} → ${got(ON, armIdx)} of 112`,
  )
})

test('turn: the reading is ONE-SIDED — no corner recovered before is lost after', () => {
  // §17's ARM_BOW / §20's flat3 shape, and the property that makes a reading change safe
  // to ship at all: at the detector the promotion can only make a vertex SHARPER. Asserted
  // site by site, because a net count would hide a swap. (Downstream of the detector this
  // is a strong tendency and not a theorem — clustering, apex selection and the fit can
  // still shuffle; @1024 two of 172 sites do trade. This case pins the @512 draw, which is
  // where the mechanism is calibrated.)
  const lost = SITES.map((_, i) => i).filter((i) => OFF.hit[i] && !ON.hit[i])
  assert.deepEqual(
    lost.map((i) => `${SITES[i].kind}@turn${SITES[i].turn}/rot${SITES[i].rot}`), [],
    'sites recovered by the chord reading and lost by the evidence reading',
  )
})

test('turn: the smooth discs stay smooth, and the rack does not shatter', () => {
  // The FALSE-POSITIVE side, and the reason the co-circular veto exists. Reading the turn
  // over a longer span is exactly how a small circle starts reading as a corner: over a
  // span long enough to average the staircase away, a 6px-radius disc turns more than 60°.
  // `detectCorners` promises the opposite ("a smooth shape — even a tiny circle — returns
  // ∅"), and without the veto the 12px and 18px discs here pick up 6 and 8 sharp corners
  // @256. The 8px disc is a blob at any reading and carries corners before the change too,
  // so it is compared rather than required to be clean.
  for (let k = 0; k < DISCS.length; k++)
    assert.ok(
      ON.discCorners[k] <= OFF.discCorners[k],
      `disc r=${DISCS[k].r}px gained sharp corners under §22: ${OFF.discCorners[k]} → ${ON.discCorners[k]}`,
    )
  // Node count is the other half: a reading that minted corners along every staircase jog
  // would score the ladder well and shatter the rack. Measured 392 → 392, byte-stable.
  assert.ok(
    ON.nodes <= OFF.nodes + 8,
    `the rack shattered: ${OFF.nodes} → ${ON.nodes} nodes`,
  )
})
