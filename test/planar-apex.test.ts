// §18 — an apex reconstruction may not outrun the raster's own evidence
// (src/lib/trace/planarFit.ts; issue #17, benchmarks §18).
//
// `snapCornerToArms` places a corner at the INTERSECTION of the two lines fitted to its
// arms. On a raster-ERODED tip that is the whole point: a shallow star point genuinely
// sits px past the last labelled pixel, and reconstructing it is what §10.2 measured as
// sharp-star's 11/11 corner recall. On an ACUTE CURVED counter the same arithmetic
// misfires — each "arm line" is a CHORD leaning into the lens, and the two chords cross
// px past the real tip. The reported witness (logo-instagram's script 'a', @512) put the
// counter's apex 3.4px above its own tip, in pixels whose luminance is 57: solid ink.
//
// The two are indistinguishable by geometry — same code, same spans, and §17.1 already
// measured `bow` as NOT separable (≤ 0.79 holds 51 authored-straight arms and 100 bent
// ones). What separates them is the RASTER, so that is what the fit now consults.
//
// WHY THIS GATES THE FIXTURE RATHER THAN A HAND-BUILT CHAIN. Two cheaper fixtures were
// tried first and neither reproduces, which is worth recording because both look right:
//   • a chain-only anatomy (test/planar-pin.test.ts's shape) cannot exercise the rule at
//     all — its whole input is the source raster;
//   • a hand-rendered two-colour lens UNDER-reconstructs instead (3.21px short of its
//     authored tip, unchanged by the rule): below ~6px of width a lens's tips erode faster
//     than its arms converge, and the overshoot never happens.
// So the witness is `acute-counter` itself — authored for this issue, measured across
// three resolutions (docs/vectorization-benchmarks.md §18) — and every tip below is
// computed from genEdgeCases' own formulas, so this is geometry, not a blessed baseline.

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
const SVG = readFileSync(join(root, 'public', 'examples', 'edge-cases', 'acute-counter.svg'), 'utf8')
const RES = 512
/** The fixture is authored in a 256 viewBox; every authored coordinate scales by this. */
const S = RES / 256

/** acute-counter's lens cells: [cx, cy, R, tipDeg, rotDeg] — genEdgeCases' own numbers. */
const UNITS: [number, number, number, number, number][] = [
  [46, 46, 48, 32, 0], [128, 46, 40, 38, 23], [210, 46, 34, 44, 47],
  [46.5, 128.5, 30, 38, 11], [128.5, 128.5, 24, 44, 67], [210.5, 128.5, 20, 56, 90],
  [210, 210, 30, 96, 31],
]
/** …and its eroded ink spikes, whose apexes are authored exactly. */
const SPIKES: [number, number][] = [[24, 200], [24, 232]]

/** h = 2R·sin(tip/2); the two tips sit ±h/2 along the cell's rotated local y axis. */
const LENS_TIPS: Vec[] = []
for (const [cx, cy, R, tip, rot] of UNITS) {
  const h = 2 * R * Math.sin((tip * Math.PI) / 360)
  const a = (rot * Math.PI) / 180
  for (const sy of [-h / 2, h / 2]) LENS_TIPS.push({ x: (cx - sy * Math.sin(a)) * S, y: (cy + sy * Math.cos(a)) * S })
}
const SPIKE_TIPS: Vec[] = SPIKES.map(([x, y]) => ({ x: x * S, y: y * S }))

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

const OFF = await cornersOf({ apexEvidence: false })
const ON = await cornersOf({})

test('apex: acute counter tips stop overshooting into their own ink', async () => {
  const off = LENS_TIPS.map((t) => nearest(OFF, t))
  const on = LENS_TIPS.map((t) => nearest(ON, t))
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)
  // Measured at authoring, @512: Σ 53.7 → 19.5px, worst 6.87 → 2.64px. The bounds below
  // sit well clear of those so ordinary fit drift cannot flip the gate, while the
  // pre-§18 tracer misses both by a wide margin.
  assert.ok(sum(off) > 40, `precondition: the pre-§18 tracer should be far off (Σ was ${sum(off).toFixed(1)}px)`)
  assert.ok(Math.max(...off) > 5, `precondition: the pre-§18 worst tip should be > 5px (was ${Math.max(...off).toFixed(2)}px)`)
  assert.ok(sum(on) < 30, `Σ over the 14 authored lens tips is ${sum(on).toFixed(1)}px (was ${sum(off).toFixed(1)})`)
  assert.ok(Math.max(...on) < 3.5, `the worst lens tip is ${Math.max(...on).toFixed(2)}px off (was ${Math.max(...off).toFixed(2)})`)
})

test('apex: an ERODED spike keeps its reconstruction', async () => {
  // The control, and the reason the rule has two terms rather than one. The spike's true
  // apex is px beyond the last labelled pixel and the fit must still put a corner there.
  // With a reach-fraction of 0.70 instead of 0.60 this reads 7.07px instead of 2.01.
  for (let i = 0; i < SPIKE_TIPS.length; i++) {
    const b = nearest(OFF, SPIKE_TIPS[i])
    const a = nearest(ON, SPIKE_TIPS[i])
    assert.ok(a <= b + 0.25, `spike ${i} lost its reconstruction: ${b.toFixed(2)}px → ${a.toFixed(2)}px off its authored apex`)
  }
})

test('apex: the error is no longer an OVERSHOOT past the tip', async () => {
  // Distance alone cannot tell this defect from its opposite — a tip fitted 3px SHORT
  // scores the same as one fitted 3px past, and only the second is issue #17. (Nor can
  // "does the apex sit in ink": at an acute counter's tip the counter has zero width, so
  // the source there is nearly solid ink even when the placement is perfect. That reading
  // was tried and is wrong.) So this measures the SIGNED component along each tip's
  // outward axis, which is the direction the chord intersection runs away in.
  // A tip is the cell's local (0, ±h/2) rotated by `rot`; its outward axis is the local
  // (0, ±1) under the same rotation — built in the SAME order as LENS_TIPS.
  const outward: Vec[] = []
  for (const [, , , , rot] of UNITS) {
    const a = (rot * Math.PI) / 180
    for (const s of [-1, 1]) outward.push({ x: -s * Math.sin(a), y: s * Math.cos(a) })
  }
  const over = (cs: Vec[]): number[] =>
    LENS_TIPS.map((t, i) => {
      let best = cs[0]
      let bd = Infinity
      for (const c of cs) {
        const d = Math.hypot(c.x - t.x, c.y - t.y)
        if (d < bd) {
          bd = d
          best = c
        }
      }
      return (best.x - t.x) * outward[i].x + (best.y - t.y) * outward[i].y
    })
  const worstOff = Math.max(...over(OFF))
  const worstOn = Math.max(...over(ON))
  // Measured @512: worst overshoot 6.85 → 2.63px. A residual of that order is the rule's
  // own resolution, not slack in it — the bound is on the overshoot past the RASTER's
  // evidence (2.5px), and the evidence itself stops a little inside the authored tip,
  // since the last sub-pixel sliver of an acute counter carries no measurable coverage.
  assert.ok(worstOff > 4, `precondition: the pre-§18 tracer overshoots a tip by > 4px (worst was ${worstOff.toFixed(2)}px)`)
  assert.ok(
    worstOn < 3.0,
    `a counter tip is still fitted ${worstOn.toFixed(2)}px PAST its authored apex (pre-§18: ${worstOff.toFixed(2)}px)`,
  )
})

test('apex: apexEvidence off restores the pre-§18 fit, and the rule does fire', async () => {
  // The A/B contract every gated mechanism in this tracer carries — and the assertion that
  // catches the probe silently never being attached, which would make every test above
  // pass for the wrong reason.
  const a = JSON.stringify(await cornersOf({ apexEvidence: false }))
  assert.equal(a, JSON.stringify(OFF), 'apexEvidence:false is not deterministic')
  assert.notEqual(JSON.stringify(ON), a, 'the rule never fired on the fixture — it is not being reached')
})

test('apex: a caller-supplied apexReach is ignored (the raster is the only evidence)', async () => {
  // planarAssemble builds the probe from the source raster and the palette; an option
  // reaching in from outside must not be able to steer the fit.
  const spoofed = await cornersOf({ apexReach: () => 0 })
  assert.equal(JSON.stringify(spoofed), JSON.stringify(ON), 'a caller-supplied apexReach changed the fit')
})
