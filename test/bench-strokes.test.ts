// The strokes-oss line corpus (bench/compare/strokesOss.ts): the answer sheet's reading of
// how the icon sets draw (bench/lineArtGround.ts closeCoincident / solidDot), the sampler's
// exclusions, the trace-side reader (compare/lineDoc.ts) and the line rows score.ts writes.
// The one that matters most is the oracle: the AUTHORED SVG handed back as a tool's output
// must score as a perfect centreline trace, or every number in the stroke table measures
// the scorer.
//
//   node --test test/bench-strokes.test.ts

import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../bench/nodeHarness.ts'
import { closeCoincident, parseLineArt, solidDot } from '../bench/lineArtGround.ts'
import { classifyStrokeIcon, drawingBody, rankKey, sampleStrokeIcons } from '../bench/compare/strokesOss.ts'
import { parseLineTrace, isPaperPaint } from '../bench/compare/lineDoc.ts'
import { renderGround } from '../bench/compare/render.ts'
import { scoreTrace, type Truth } from '../bench/compare/score.ts'
import { lineStats } from '../bench/compare/report.ts'
import { flattenSubPath } from '../bench/geomScore.ts'
import { corpusKind, type CompareCase, type ScoreRow } from '../bench/compare/types.ts'
import type { SubPath } from '../src/lib/path/types.ts'

ensureImageData()

const icon = (body: string, root = 'fill="none" stroke="currentColor"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ${root} stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

// Tabler's way: the bounding-box path, a circle as two open arcs back to the start, a dot as
// a small closed arc pair, a dot as a zero-length stroke.
const TABLER = icon(
  '<path stroke="none" d="M0 0h24v24H0z" fill="none"/>' +
    '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/>' +
    '<path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/>' +
    '<path d="M12 7l.01 0"/>',
)

test('a Tabler circle written as two open arcs reads as a closed ring', () => {
  const gt = parseLineArt(TABLER)
  assert.equal(gt.strokes.length, 1, 'only the ring is a stroke')
  assert.equal(gt.strokes[0].subPaths.length, 1)
  assert.equal(gt.strokes[0].subPaths[0].closed, true)
})

test('dots are fills: a closed r=1 arc pair at width 2, a zero-length round stroke', () => {
  const gt = parseLineArt(TABLER)
  assert.equal(gt.fills.length, 2, 'the bounding-box path paints nothing and is neither')
  // The arc-pair dot: radius r + w/2 = 2 about (12, 12).
  const xs = gt.fills[0].subPaths[0].nodes.map((n) => n.x)
  assert.ok(Math.abs(Math.max(...xs) - 14) < 0.05 && Math.abs(Math.min(...xs) - 10) < 0.05, `${xs}`)
  // The .01 stroke: a disc of radius w/2 at its point.
  const ys = gt.fills[1].subPaths[0].nodes.map((n) => n.y)
  assert.ok(Math.abs(Math.max(...ys) - 8) < 0.05 && Math.abs(Math.min(...ys) - 6) < 0.05, `${ys}`)
})

test("Feather's point-to-itself <line> is a dot; a real short stroke is not", () => {
  const gt = parseLineArt(icon('<line x1="12" y1="16" x2="12" y2="16"/><line x1="4" y1="4" x2="6" y2="4"/>'))
  assert.equal(gt.fills.length, 1)
  assert.equal(gt.strokes.length, 1, 'a 2-unit line at width 2 is a stroke (extent 1 w > DOT_EXTENT)')
})

const line = (pts: [number, number][], closed = false): SubPath => ({
  closed,
  nodes: pts.map(([x, y]) => ({ x, y, hIn: null, hOut: null, kind: 'corner' as const })),
})

test('closeCoincident: round caps only, and only a real meet', () => {
  const loop = line([
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 0],
  ])
  assert.equal(closeCoincident(loop, 2, 'round').closed, true)
  assert.equal(closeCoincident(loop, 2, 'round').nodes.length, 3)
  assert.equal(closeCoincident(loop, 2, 'butt').closed, false, 'a butt meet paints a notch: an end')
  const open = line([
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 1],
  ])
  assert.equal(closeCoincident(open, 2, 'round').closed, false)
})

test('solidDot: butt-capped zero-length strokes paint nothing; square caps paint a square', () => {
  const dot = line([
    [5, 5],
    [5.01, 5],
  ])
  assert.equal(solidDot(dot, 2, 'butt'), 'blank')
  const sq = solidDot(dot, 2, 'square')
  assert.ok(Array.isArray(sq) && sq[0].nodes.length === 4)
  assert.equal(
    solidDot(
      line([
        [0, 0],
        [3, 0],
      ]),
      2,
      'round',
    ),
    null,
  )
})

test('classifyStrokeIcon: what the ground truth cannot read is excluded with a reason', () => {
  assert.equal(classifyStrokeIcon(TABLER), null)
  assert.match(classifyStrokeIcon(icon('<path d="M3 3h18" opacity=".5"/>')) ?? '', /^unread: opacity/)
  assert.match(classifyStrokeIcon(icon('<path d="M3 3h18" stroke-dasharray="2 2"/>')) ?? '', /^unread: dashes/)
  assert.match(classifyStrokeIcon(icon('<circle cx="12" cy="12" r="4" fill="currentColor"/>')) ?? '', /^filled/)
  // A pure fill (stroke="none") is readable as a fill, beside a stroke.
  assert.equal(
    classifyStrokeIcon(icon('<path d="M3 3h18"/><path d="M5 5h4v4h-4z" fill="currentColor" stroke="none"/>')),
    null,
  )
  // Phosphor's regular weight: filled outlines, nothing stroked.
  const phosphor =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Z"/></svg>'
  assert.match(classifyStrokeIcon(phosphor) ?? '', /^no strokes/)
})

test('sampleStrokeIcons: deterministic rank, in-sample and duplicate exclusions, per-set balance', () => {
  let next = 0
  const mk = (set: 'lucide' | 'feather' | 'tabler', name: string, d = 100 + next++) => ({
    set,
    name,
    svg: icon(`<path d="M3 ${d}h18"/>`),
  })
  const cands = [
    ...['house', 'bell', 'a', 'bb', 'ccc', 'dddd', 'eeeee'].map((n) => mk('lucide', n)),
    mk('lucide', 'home-alias', 100), // the same drawing as `house` → an alias of an in-sample icon
    ...['home', 'x', 'yy', 'zzz'].map((n) => mk('feather', n)),
    ...['t1', 't2', 't3', 't4'].map((n, i) => mk('tabler', n, 10 + i)),
  ]
  const inSample = new Set(['house', 'bell'])
  const bodies = new Set(cands.filter((c) => c.set === 'lucide' && inSample.has(c.name)).map((c) => drawingBody(c.svg)))
  const a = sampleStrokeIcons(cands, 3, inSample, bodies)
  const b = sampleStrokeIcons([...cands].reverse(), 3, inSample, bodies)
  assert.deepEqual(
    a.picked.map((c) => `${c.set}/${c.name}`).sort(),
    b.picked.map((c) => `${c.set}/${c.name}`).sort(),
    'input order does not matter',
  )
  for (const set of ['lucide', 'feather', 'tabler']) assert.equal(a.picked.filter((c) => c.set === set).length, 3)
  const names = new Set(a.picked.map((c) => c.name))
  for (const n of ['house', 'bell', 'home-alias', 'home']) assert.ok(!names.has(n), `${n} must be excluded`)
  // Within a set the pick is the rank order of the eligible ones.
  const tabler = a.picked.filter((c) => c.set === 'tabler').map((c) => c.name)
  const want = ['t1', 't2', 't3', 't4']
    .sort((x, y) => (rankKey('tabler', x) < rankKey('tabler', y) ? -1 : 1))
    .slice(0, 3)
  assert.deepEqual(tabler, want)
  assert.equal(a.counts.lucide['in-sample'], 3)
})

test('lineDoc: AutoTrace-style output (style paint, no width, loop back to its start) reads as a 1-px ring', () => {
  const svg =
    '<svg width="100" height="100"><path style="stroke:#000000; fill:none;" d="M50 20C70 20 80 30 80 50C80 70 70 80 50 80C30 80 20 70 20 50C20 30 30 20 50 20"/></svg>'
  const t = parseLineTrace(svg, 200, 200)
  assert.ok(typeof t !== 'string')
  assert.equal(t.strokes, 1)
  const it = t.doc.items[0]
  assert.ok(it.kind === 'path' && it.stroke)
  assert.equal(it.stroke.width, 2, '1 unit of a 100-unit root at 200 px')
  assert.equal(it.subPaths[0].closed, true)
})

test('lineDoc: paper is not ink, but it is file cost', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048 2048"><path fill="#ffffff" d="M0 0L2048 0L2048 2048L0 2048Z"/><path fill="none" stroke="#000000" stroke-width="170" stroke-linecap="round" d="M200 200L1800 200"/></svg>'
  const t = parseLineTrace(svg, 512, 512)
  assert.ok(typeof t !== 'string')
  assert.equal(t.fills, 0)
  assert.equal(t.strokes, 1)
  assert.equal(t.paths, 2)
  assert.ok(isPaperPaint('#fff') && isPaperPaint('white') && !isPaperPaint('#1f2937') && !isPaperPaint('currentColor'))
  assert.equal(parseLineTrace('<svg><style>path{}</style></svg>', 10, 10), 'styled')
})

const lineCase: CompareCase = {
  id: 'strokes-oss/test',
  corpus: 'strokes-oss',
  name: 'test',
  svgPath: '',
  gradients: false,
  tier: 2,
  heldOut: true,
  license: 'test',
  source: 'test',
}

function lineRow(authored: string, output: string, res: number): ScoreRow {
  const img = renderGround(authored, res)
  const truth: Truth = { img, shapes: null, refusal: null, lineSvg: authored }
  return scoreTrace(lineCase, truth, 't', output, 0, 'mono', { docVisible: true }).row
}

// Feather-like, with every way a set draws: a polyline corner, a ring, a dot.
const ORACLE = icon(
  '<polyline points="4 18 12 6 20 18"/><circle cx="12" cy="15" r="3"/><line x1="12" y1="21" x2="12" y2="21"/>',
)

test('the oracle: the authored SVG as the output scores a perfect centreline trace', () => {
  assert.equal(corpusKind('strokes-oss'), 'line')
  const r = lineRow(ORACLE, ORACLE, 384)
  assert.equal(r.geomRefusal, null)
  assert.ok((r.clCentre ?? 1) < 0.05, `centre ${r.clCentre}`)
  assert.ok((r.clCentreP95 ?? 1) < 0.1, `p95 ${r.clCentreP95}`)
  assert.equal(r.clMissed, 0)
  assert.ok((r.clWidthErr ?? 1) < 1e-6, `width ${r.clWidthErr}`)
  assert.equal(r.clEndsDelta, 0)
  assert.equal(r.clPathsDelta, 0)
  assert.equal(r.clTurns, 0)
  assert.ok((r.meanDeltaE ?? 1) < 0.01, `ΔE ${r.meanDeltaE}`)
  assert.deepEqual(r.failedGates, [])
  assert.equal(r.gatesPassed, r.gatesApplicable)
})

test('two authored strokes drawn ON each other are not a turn (Feather book-open, scored as itself)', () => {
  const book = icon(
    '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  )
  const r = lineRow(book, book, 384)
  assert.equal(r.clTurns, 0)
  assert.equal(r.clMissed, 0)
})

test('a polygon closed back onto its start point (Feather) is one point there, not 2^20', () => {
  const sp: SubPath = {
    closed: true,
    nodes: [
      [13, 19],
      [22, 12],
      [13, 5],
      [13, 19],
    ].map(([x, y]) => ({ x, y, hIn: null, hOut: null, kind: 'corner' as const })),
  }
  assert.ok(flattenSubPath(sp).length < 10, `${flattenSubPath(sp).length} points`)
  // StarVector handed back Feather's own fast-forward: scored as itself in seconds, and perfect.
  const ff = icon('<polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/>')
  const r = lineRow(ff, ff, 384)
  assert.equal(r.clTurns, 0)
  assert.deepEqual(r.failedGates, [])
})

test('an outline-only output keeps its pixel metrics and gets "no strokes" for the centreline', () => {
  const outline =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 11h18v2H3z" fill="#000"/></svg>'
  const r = lineRow(icon('<path d="M3 12h18"/>'), outline, 192)
  assert.equal(r.geomRefusal, 'no strokes')
  assert.equal(r.clCentre, undefined)
  assert.ok(Number.isFinite(r.meanDeltaE))
  assert.ok((r.docNodes ?? 0) > 0)
})

test('a missing stroke reads on recall, a shifted one on precision', () => {
  const authored = icon('<path d="M3 6h18"/><path d="M3 18h18"/>')
  const r = lineRow(authored, icon('<path d="M3 6h18"/>'), 240)
  assert.ok((r.clMissed ?? 0) > 50, `missed ${r.clMissed}`)
  assert.ok((r.clCentre ?? 1) < 0.1)
  const s = lineRow(authored, icon('<path d="M3 7h18"/><path d="M3 18h18"/>'), 240)
  assert.ok(Math.abs((s.clCentre ?? 0) - 5) < 0.6, `centre ${s.clCentre} (1 unit = 10 px, half the samples moved)`)
})

test('lineStats: medians over the scored rows, |Δ| topology, all-pass counts', () => {
  const base = { caseId: 'strokes-oss/a', corpus: 'strokes-oss', heldOut: true, res: 2048, flat: true, lane: 'mono' }
  const rows = [
    { ...base, clCentre: 1, clEndsDelta: -2, clTurns: 0, gatesApplicable: 9, gatesPassed: 9, meanDeltaE: 0.1 },
    { ...base, clCentre: 3, clEndsDelta: 4, clTurns: 1, gatesApplicable: 9, gatesPassed: 7, meanDeltaE: 0.3 },
    { ...base, geomRefusal: 'no strokes', meanDeltaE: 0.2 },
  ].map((r) => ({ tool: 't', status: 'ok', ms: 1, gtRefusal: null, geomRefusal: null, ...r }) as ScoreRow)
  const s = lineStats('t', rows)
  assert.equal(s.scored, 2)
  assert.equal(s.centre, 2)
  assert.equal(s.ends, 3)
  assert.equal(s.noTurns, 1)
  assert.equal(s.allPass, 1)
  assert.equal(s.deltaE, 0.2)
})
