// "Find best settings" in the vectorize studio: the candidates it traces, the rule
// that picks the winner, and the scoreboard's words. The search itself (workers,
// progress, cancel) is plumbing in useBestSettings.ts; this is the part that
// decides.
//
//   node --test test/best-settings.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCandidates,
  CANDIDATE_ORDER,
  forceColorDoc,
  pickWinner,
  poolWallMs,
  TRACE_ORDER,
  scoreLine,
  SIMPLER_WINS_DE,
  winnerNote,
  withCandidate,
  type CandidateScore,
} from '../src/components/vectorize/studio/bestSettings.ts'
import { freshSettings, sameSettings } from '../src/components/vectorize/studio/freshSettings.ts'
import { DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import type { EditableDoc } from '../src/lib/path/types.ts'
import type { VectorizeOptions } from '../src/types.ts'

type RGBA = [number, number, number, number]

/** A `w`×`h` image on `bg` with one filled rect of `ink`, typed as the probe's raster. */
function art(w: number, h: number, bg: RGBA, ink: RGBA, second?: RGBA): ImageData {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set(bg, i * 4)
  for (let y = h >> 2; y < h - (h >> 2); y++) {
    for (let x = w >> 2; x < w - (w >> 2); x++) data.set(second && x > w / 2 ? second : ink, (y * w + x) * 4)
  }
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData
}

const BASE = DEFAULT_VECTORIZE_OPTIONS
const WHITE: RGBA = [255, 255, 255, 255]

/* ------------------------------------------------------------ candidates */

test('before any pixels, only the colour candidates can be built (mono needs a measured cut)', () => {
  const ids = buildCandidates(BASE, null).map((c) => c.id)
  assert.ok(!ids.includes('mono') && !ids.includes('strokes'))
  assert.ok(ids.includes('flat') && ids.includes('gradients'))
})

test('candidates come simplest first, and each one is the mode it says it is', () => {
  const cands = buildCandidates(BASE, art(64, 64, WHITE, [20, 20, 20, 255]))
  const ids = cands.map((c) => c.id)
  assert.deepEqual(
    ids,
    CANDIDATE_ORDER.filter((id) => ids.includes(id)),
  )
  for (const c of cands) {
    assert.equal(c.opts.mode, c.colorMode)
    if (c.id === 'strokes') assert.equal(c.opts.centerline, true)
    if (c.id === 'mono') assert.equal(c.opts.centerline, undefined)
    if (c.id === 'flat') assert.equal(c.opts.gradients, false)
    if (c.id === 'gradients') assert.equal(c.opts.gradients, true)
  }
})

test('mono uses the measured cut and invert: white ink on navy is inverted and painted white', () => {
  const mono = buildCandidates(BASE, art(64, 64, [20, 30, 90, 255], [250, 250, 250, 255])).find((c) => c.id === 'mono')
  assert.ok(mono)
  assert.equal(mono.opts.invert, true)
  assert.notEqual(mono.opts.threshold, BASE.threshold, 'the cut is measured, not the 128 default')
  assert.equal(mono.forceColorOn, true)
  assert.equal(mono.forceColor?.toLowerCase(), '#fafafa')
})

test('a near-black ink is painted in its own colour, pure black is left alone', () => {
  const grey = buildCandidates(BASE, art(64, 64, WHITE, [20, 22, 28, 255])).find((c) => c.id === 'mono')
  assert.equal(grey?.forceColorOn, true, '#14161c scored as #000 would lose ~1.5 ΔE to Flat for nothing')
  const black = buildCandidates(BASE, art(64, 64, WHITE, [0, 0, 0, 255])).find((c) => c.id === 'mono')
  assert.equal(black?.forceColorOn, false)
})

test("the user's own settings ride into every candidate; Strokes does not leak into colour", () => {
  const current: VectorizeOptions = {
    ...BASE,
    mode: 'mono',
    centerline: true,
    invert: true,
    smoothing: 80,
    despeckle: 5,
    fidelity: 0.5,
    markers: [{ x: 0.5, y: 0.5, flat: true }],
  }
  for (const c of buildCandidates(current, art(64, 64, WHITE, [20, 20, 20, 255]))) {
    assert.equal(c.opts.smoothing, 80)
    assert.equal(c.opts.despeckle, 5)
    assert.equal(c.opts.fidelity, 0.5)
    assert.deepEqual(c.opts.markers, current.markers)
    if (c.colorMode === 'color') {
      // A later flip back to Mono would otherwise come back as strokes.
      assert.equal('centerline' in c.opts, false, `${c.id} must not inherit Strokes`)
    }
  }
})

test('withCandidate applies only the mode decisions onto the current options', () => {
  const cands = buildCandidates(BASE, art(64, 64, WHITE, [20, 20, 20, 255]))
  const backplate = cands.find((c) => c.id === 'backplate')
  const flat = cands.find((c) => c.id === 'flat')
  assert.ok(backplate && flat)
  // The user moved a slider after the search: a runner-up keeps it.
  const moved = { ...withCandidate(BASE, backplate), smoothing: 10 }
  assert.equal(moved.backgroundGradient, true)
  const next = withCandidate(moved, flat)
  assert.equal(next.smoothing, 10)
  assert.equal(next.gradients, false)
  assert.equal('backgroundGradient' in next, false, 'switching away from the backdrop clears it')
})

test('on one-ink art the Mono winner IS what a fresh upload gets, so Reset has nothing to undo', () => {
  const img = art(64, 64, WHITE, [0, 0, 0, 255])
  const fresh = freshSettings(BASE, 'auto', img, true)
  const mono = buildCandidates(fresh.opts, img).find((c) => c.id === 'mono')
  assert.ok(mono)
  assert.ok(sameSettings(withCandidate(fresh.opts, mono), fresh.opts))
  assert.equal(mono.forceColorOn, fresh.forceColorOn)
})

/* ---------------------------------------------------------------- winner */

const s = (id: CandidateScore['id'], meanDeltaE: number, nodes: number): CandidateScore => ({ id, meanDeltaE, nodes })

test('the closest match wins when nothing simpler is within the margin', () => {
  const ranked = pickWinner([s('mono', 3, 10), s('flat', 1.2, 40), s('gradients', 0.8, 90)])
  assert.deepEqual(
    ranked.map((r) => r.id),
    ['gradients', 'flat', 'mono'],
  )
})

test(`a simpler candidate within ${SIMPLER_WINS_DE} ΔE of the best wins`, () => {
  const ranked = pickWinner([s('gradients', 1.0, 90), s('flat', 1.1, 40), s('mono', 1.25, 12)])
  assert.equal(ranked[0].id, 'mono')
  // The rest stay in ΔE order.
  assert.deepEqual(
    ranked.slice(1).map((r) => r.id),
    ['gradients', 'flat'],
  )
})

test('just outside the margin, simpler does not win', () => {
  const ranked = pickWinner([s('gradients', 1.0, 90), s('mono', 1.0 + SIMPLER_WINS_DE + 0.01, 12)])
  assert.equal(ranked[0].id, 'gradients')
})

test('the margin is a parameter, and 0 means ΔE alone (ties to fewer nodes)', () => {
  assert.equal(pickWinner([s('gradients', 1.0, 90), s('mono', 1.1, 12)], 0)[0].id, 'gradients')
  assert.equal(pickWinner([s('flat', 1.0, 90), s('flat', 1.0, 30)], 0)[0].nodes, 30)
})

test('a failed candidate (non-finite ΔE) never wins, and no scores means no winner', () => {
  assert.equal(pickWinner([s('mono', Number.NaN, 1), s('flat', 4, 40)])[0].id, 'flat')
  assert.deepEqual(pickWinner([]), [])
})

/* ------------------------------------------------------------ scoreboard */

test('scoreLine quotes ΔE to one decimal and the node count', () => {
  assert.equal(scoreLine({ meanDeltaE: 1.84, nodes: 44 }), 'ΔE 1.8 · 44 nodes')
  assert.equal(scoreLine({ meanDeltaE: 0.04, nodes: 1 }), 'ΔE 0.0 · 1 node')
})

test('winnerNote explains a simpler win, and says nothing when the closest match won', () => {
  assert.equal(
    winnerNote(pickWinner([s('gradients', 1.0, 90), s('mono', 1.2, 12)])),
    `Mono is within ${SIMPLER_WINS_DE} ΔE of the closest match, and simpler.`,
  )
  assert.equal(winnerNote(pickWinner([s('gradients', 1.0, 90), s('mono', 3, 12)])), null)
  assert.equal(winnerNote(pickWinner([s('flat', 1.0, 90)])), null)
})

test('forceColorDoc repaints fills, and a centreline stroke on its stroke', () => {
  const doc: EditableDoc = {
    viewBox: [0, 0, 10, 10],
    items: [
      { kind: 'path', id: 'a', fill: '#000000', subPaths: [] },
      { kind: 'path', id: 'b', fill: 'none', stroke: { color: '#000000', width: 2 }, subPaths: [] },
    ],
  } as unknown as EditableDoc
  const out = forceColorDoc(doc, '#ff0000')
  const [a, b] = out.items as { fill: string; stroke?: { color: string } }[]
  assert.equal(a.fill, '#ff0000')
  assert.equal(b.fill, 'none')
  assert.equal(b.stroke?.color, '#ff0000')
})

/* ------------------------------------------------------------------ pool */

test('the pool starts the slowest candidate first, and every candidate exactly once', () => {
  assert.equal(TRACE_ORDER[0], 'gradients')
  assert.deepEqual([...TRACE_ORDER].sort(), [...CANDIDATE_ORDER].sort())
})

test('poolWallMs: the long pole overlaps the rest on two workers', () => {
  // gradients 900 ms, then four cheap ones: they fit beside it on the second worker.
  assert.equal(poolWallMs([900, 100, 80, 70, 80], 2), 900)
  // Queued last instead, it would trail them.
  assert.equal(poolWallMs([100, 80, 70, 80, 900], 2), 1050)
  assert.equal(poolWallMs([100, 200], 1), 300)
})
