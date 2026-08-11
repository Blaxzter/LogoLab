// §19 — a corner's arm model must match what the arm measurably is
// (src/lib/trace/planarFit.ts; issue #7, benchmarks §19).
//
// `snapCornerToArms` fits a straight LINE to each arm and intersects. On a CURVED arm
// that line is a chord — offset by the sagitta, rotated by the chord-to-tangent angle —
// and the intersection slides ALONG the other arm: mastercard's 'e' grows a ~2px white
// needle into its stems (the issue's witness), and a crotch apex lands off the bisector.
// §18 is structurally blind to both faces: the move sits under its 2.5px overshoot
// floor, or the reconstruction ray runs ALONG a real edge whose AA fringe reads as
// coverage (reach ≈ moved). §19 upgrades a measurably-bent arm (bow > 0.5px) to its
// ANCHORED TANGENT — the local parabola's tangent line at the tip end of the window,
// no radius estimate involved — and re-checks conditioning on the final tangents.
//
// The witness is `letter-joins`, authored for this issue (genEdgeCases.ts documents the
// rack; its anatomy was verified to reproduce BEFORE being authored — §18.2's lesson).
// Every corner below is computed from genEdgeCases' own formulas: geometry, not a
// blessed baseline.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { decodePng } from '../src/devtest/png.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import type { Vec } from '../src/lib/path/types.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SVG = readFileSync(join(root, 'public', 'examples', 'edge-cases', 'letter-joins.svg'), 'utf8')
const RES = 512
/** The fixture is authored in a 256 viewBox; every authored coordinate scales by this. */
const S = RES / 256

const rot = (x: number, y: number, cx: number, cy: number, deg: number): Vec => {
  const a = (deg * Math.PI) / 180
  return { x: (cx + x * Math.cos(a) - y * Math.sin(a)) * S, y: (cy + x * Math.sin(a) + y * Math.cos(a)) * S }
}

/** The 12 curved-arm join corners: D-counter chord ends (arc × line) and disc-union
 *  crossings (arc × arc) — genEdgeCases' own cell parameters. */
const JOINS: Vec[] = []
for (const [cx, cy, c, , r] of [[50, 52, 26, 9, 0], [136, 52, 34, 12, 9], [216, 52, 20, 8, 31]] as const)
  for (const sx of [-1, 1]) JOINS.push(rot((sx * c) / 2, 0, cx, cy, r))
const CROTCHES: Vec[] = []
for (const [cx, cy, r, dc, rt] of [[52, 130, 30, 22, 0], [140, 130, 24, 15, 17], [216, 130, 20, 14, 43]] as const) {
  const yc = Math.sqrt(r * r - dc * dc)
  for (const sy of [-1, 1]) CROTCHES.push(rot(0, sy * yc, cx, cy, rt))
}

/** Straight-arm controls the fix must NOT move: the square notch's inner corners (the
 *  line model is exact there) and the eroded spike's apex (reconstruction must keep
 *  outrunning the lattice — sharp-star's regime). */
const NOTCH: Vec[] = [{ x: 145 * S, y: 214 * S }, { x: 157 * S, y: 214 * S }]
const SPIKE: Vec = { x: 24 * S, y: 236 * S }

const IMG = decodePng(new Resvg(SVG, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())

async function cornersOf(over: Record<string, unknown>): Promise<Vec[]> {
  const doc = await traceImage(IMG as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, planarFit: over,
  })
  const out: Vec[] = []
  for (const e of doc.topology?.edges ?? []) for (const n of e.nodes) if (n.kind === 'corner') out.push({ x: n.x, y: n.y })
  return out
}
const nearest = (cs: Vec[], p: Vec): number => {
  let best = Infinity
  for (const c of cs) best = Math.min(best, Math.hypot(c.x - p.x, c.y - p.y))
  return best
}
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

const OFF = await cornersOf({ arcArms: false })
const ON = await cornersOf({})

test('needle: curved-arm join corners land on their authored positions', () => {
  const off = [...JOINS, ...CROTCHES].map((p) => nearest(OFF, p))
  const on = [...JOINS, ...CROTCHES].map((p) => nearest(ON, p))
  // Measured at authoring, @512: Σ 14.07 → 8.84px over the 12 joins, worst (a D-join)
  // 1.84 → 1.22px. Bounds sit clear of both so ordinary fit drift cannot flip the gate.
  assert.ok(sum(off) > 12, `precondition: the chords-only tracer should be far off (Σ was ${sum(off).toFixed(1)}px)`)
  assert.ok(Math.max(...off) > 1.6, `precondition: the chords-only worst join should read the chord displacement (was ${Math.max(...off).toFixed(2)}px)`)
  assert.ok(sum(on) < 11, `Σ over the 12 authored join corners is ${sum(on).toFixed(1)}px (chords-only: ${sum(off).toFixed(1)})`)
  assert.ok(Math.max(...on) < 1.5, `the worst join corner is ${Math.max(...on).toFixed(2)}px off (chords-only: ${Math.max(...off).toFixed(2)})`)
})

test('needle: crotch apexes come back onto the bisector', () => {
  // The arc×arc face (mastercard's 'm' crotch): under chords the intersection leaves
  // the bisector — measured Σ 5.91 → 3.64px over the six crotch vertices. (Cell 2's
  // pair still READS < 60° sharp to the truth-gate scorer under either model — that
  // residue is §19's, named in the docs — so this gates PLACEMENT, which is what the
  // model changes.)
  const off = CROTCHES.map((p) => nearest(OFF, p))
  const on = CROTCHES.map((p) => nearest(ON, p))
  assert.ok(sum(off) > 5, `precondition: chords-only crotch Σ should be off the bisector (was ${sum(off).toFixed(2)}px)`)
  assert.ok(sum(on) < 4.6, `Σ over the 6 crotch vertices is ${sum(on).toFixed(2)}px (chords-only: ${sum(off).toFixed(2)})`)
  assert.ok(sum(on) < sum(off) - 1.5, `the model must beat the chords by a clear margin (${sum(on).toFixed(2)} vs ${sum(off).toFixed(2)})`)
})

test('needle: straight-arm geometry is byte-identical', () => {
  // The square notch's corners have straight arms — the line model is exact, §19 must
  // not touch them. Byte-equality, not tolerance: the arc path never fires on bow ≤ min.
  for (const p of NOTCH) {
    const dOff = nearest(OFF, p)
    const dOn = nearest(ON, p)
    assert.ok(Math.abs(dOff - dOn) < 1e-9, `notch corner (${p.x}, ${p.y}) moved: ${dOff.toFixed(4)} → ${dOn.toFixed(4)}px`)
  }
})

test('needle: the eroded spike keeps its reconstruction', () => {
  const b = nearest(OFF, SPIKE)
  const a = nearest(ON, SPIKE)
  assert.ok(a <= b + 0.25, `the spike lost its reconstruction: ${b.toFixed(2)}px → ${a.toFixed(2)}px off its authored apex`)
})

test('needle: arcArms off restores the pre-§19 fit, and the rule does fire', async () => {
  const again = JSON.stringify(await cornersOf({ arcArms: false }))
  assert.equal(again, JSON.stringify(OFF), 'arcArms:false is not deterministic')
  assert.notEqual(JSON.stringify(ON), again, 'the rule never fired on the fixture — it is not being reached')
})
