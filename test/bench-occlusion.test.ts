// The benchmark scores a STACKED output's visible boundary, not the outline it paints over.
// makeVisibleAt reads the render 2 px either side of a traced edge; hidden outline lying
// under a later shape but within 2 px of that shape's edge passed it and was scored as
// spurious boundary (logos-cc0: LogoLab stacked 0.22 px vs 0.09 px tiled for the same fit).
// geomScore makeHiddenAt resolves it by paint order; traceSvg.ts says which shapes paint solid.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../bench/nodeHarness.ts'
import { parseGroundTruth, toRasterSpace } from '../bench/svgGround.ts'
import { renderGround } from '../bench/compare/render.ts'
import { scoreTrace, type Truth } from '../bench/compare/score.ts'
import { parseTraceSvg } from '../bench/compare/traceSvg.ts'
import { makeHiddenAt, makeVisibleAt, tangentBreaks } from '../bench/geomScore.ts'
import type { CompareCase } from '../bench/compare/types.ts'
import type { SubPath } from '../src/lib/path/types.ts'

ensureImageData()

const RES = 100
const AUTHORED =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#ffffff"/><rect x="20" y="20" width="60" height="60" fill="#625df5"/></svg>'
const CASE: CompareCase = {
  id: 'test/square',
  corpus: 'truth0',
  name: 'square',
  svgPath: '',
  gradients: false,
  tier: 2,
  heldOut: false,
  license: 'test',
  source: 'test',
}
const truth = (): Truth => {
  const img = renderGround(AUTHORED, RES)
  return { img, shapes: toRasterSpace(parseGroundTruth(AUTHORED), img.width), refusal: null }
}
/** The page as one path with a square hole of side 100 - 2·`inset`, wound the other way. */
const page = (inset: number): string => {
  const a = inset,
    b = 100 - inset
  return `M0 0H100V100H0Z M${a} ${a}V${b}H${b}V${a}Z`
}
const SQUARE = 'M20 20H80V80H20Z'
const score = (svg: string) => scoreTrace(CASE, truth(), 'test', svg, 0, 'colour', { docVisible: true }).row

test('outline painted over by a later solid shape is not spurious', () => {
  const tiled = score(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#ffffff" d="${page(20)}"/><path fill="#625df5" d="${SQUARE}"/></svg>`,
  )
  // The page's hole stops 1.5 px inside the square: hidden, but inside makeVisibleAt's reach.
  const stacked = score(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#ffffff" d="${page(21.5)}"/><path fill="#625df5" d="${SQUARE}"/></svg>`,
  )
  assert.ok((tiled.spuriousMean ?? Number.NaN) < 0.1, `tiled spurious ${tiled.spuriousMean}`)
  assert.ok(Math.abs((stacked.chamfer ?? Number.NaN) - (tiled.chamfer ?? Number.NaN)) < 0.05, `${stacked.chamfer}`)
})

test('a see-through shape in front hides nothing', () => {
  for (const front of [
    `<path fill="#625df5" fill-opacity="0.5" d="${SQUARE}"/>`,
    `<g opacity="0.5"><path fill="#625df5" d="${SQUARE}"/></g>`,
    `<path fill="rgba(98,93,245,0.5)" d="${SQUARE}"/>`,
    `<path fill="#625df580" d="${SQUARE}"/>`,
  ]) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#ffffff" d="${page(21.5)}"/>${front}</svg>`
    const parsed = parseTraceSvg(svg, RES, RES)
    assert.deepEqual(
      parsed.shapes?.map((s) => s.occludes === true),
      [true, false],
      front,
    )
  }
})

test('paint order, margin and fill rule decide what is hidden', () => {
  const square = (a: number, b: number, cw = true): SubPath => ({
    closed: true,
    nodes: (cw
      ? [
          [a, a],
          [b, a],
          [b, b],
          [a, b],
        ]
      : [
          [a, a],
          [a, b],
          [b, b],
          [b, a],
        ]
    ).map(([x, y]) => ({ x, y, hIn: null, hOut: null, kind: 'corner' as const })),
  })
  const under: SubPath[] = [square(0, 100)]
  // Two nested squares wound the same way: a ring under evenodd, solid under nonzero.
  const ring: SubPath[] = [square(10, 90), square(30, 70)]
  const nonzero = makeHiddenAt([under, ring], ['nonzero', 'nonzero'], [true, true])
  const evenodd = makeHiddenAt([under, ring], ['nonzero', 'evenodd'], [true, true])
  assert.equal(nonzero({ x: 50, y: 50 }, 0), true)
  assert.equal(evenodd({ x: 50, y: 50 }, 0), false)
  assert.equal(evenodd({ x: 20, y: 50 }, 0), true)
  // The shape painted first hides nothing of the one after it.
  assert.equal(nonzero({ x: 20, y: 50 }, 1), false)
  // Within OCCLUDE_MARGIN of the front shape's edge is its anti-aliasing, not hidden.
  assert.equal(nonzero({ x: 10.3, y: 50 }, 0), false)
  assert.equal(nonzero({ x: 11, y: 50 }, 0), true)
  // An open subpath fills as if closed.
  const open = makeHiddenAt([under, [{ ...square(10, 90), closed: false }]], ['nonzero', 'nonzero'], [true, true])
  assert.equal(open({ x: 50, y: 50 }, 0), true)
})

test('an inherited evenodd reaches the shape', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g fill-rule="evenodd"><path fill="#000" d="${SQUARE}"/></g><path fill="#fff" d="${SQUARE}"/></svg>`
  assert.deepEqual(
    parseTraceSvg(svg, RES, RES).shapes?.map((s) => s.fillRule ?? 'nonzero'),
    ['evenodd', 'nonzero'],
  )
})

test('a kink under a shape painted later is not counted', () => {
  // The art: a disc on a white page. Traced STACKED, the page keeps a hole that is a 24-gon
  // 0.8 px inside the disc's rim, painted over by the disc: 24 corners of 15° nobody can see.
  // The corner counts read every path's nodes and counted them as kinks on a smooth edge
  // until they took the edge metric's occlusion rule (Trazor's emoji: median 18 → 11).
  const res = 200
  const disc = (r: number) => {
    const k = 0.5523 * r
    return `M${100 + r} 100C${100 + r} ${100 + k} ${100 + k} ${100 + r} 100 ${100 + r}C${100 - k} ${100 + r} ${100 - r} ${100 + k} ${100 - r} 100C${100 - r} ${100 - k} ${100 - k} ${100 - r} 100 ${100 - r}C${100 + k} ${100 - r} ${100 + r} ${100 - k} ${100 + r} 100Z`
  }
  const gon = (r: number, n: number) =>
    `M${Array.from({ length: n }, (_, i) => {
      const a = (-2 * Math.PI * i) / n
      return `${(100 + r * Math.cos(a)).toFixed(3)} ${(100 + r * Math.sin(a)).toFixed(3)}`
    }).join('L')}Z`
  const authored = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#ffffff"/><path fill="#625df5" d="${disc(60)}"/></svg>`
  const img = renderGround(authored, res)
  const t: Truth = { img, shapes: toRasterSpace(parseGroundTruth(authored), img.width), refusal: null }
  const run = (pageHole: string) =>
    scoreTrace(
      CASE,
      t,
      'test',
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#ffffff" fill-rule="evenodd" d="M0 0H200V200H0Z ${pageHole}"/><path fill="#625df5" d="${disc(60)}"/></svg>`,
      0,
      'colour',
      { docVisible: true },
    ).row
  const tiled = run(disc(60))
  const stacked = run(gon(59.2, 24))
  // The hidden 24-gon does have kinks on the smooth rim: counted without the rule.
  const parsed = parseTraceSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#ffffff" fill-rule="evenodd" d="M0 0H200V200H0Z ${gon(59.2, 24)}"/><path fill="#625df5" d="${disc(60)}"/></svg>`,
    res,
    res,
  )
  const sets = parsed.shapes?.map((s) => s.subPaths) ?? []
  const shapes = t.shapes ?? []
  assert.ok(tangentBreaks(shapes, sets, res, res, makeVisibleAt(img)).count >= 12, 'the hidden 24-gon has kinks')
  assert.equal(stacked.tangentBreaks, tiled.tangentBreaks)
  assert.equal(stacked.cornersInvented, tiled.cornersInvented)
})
