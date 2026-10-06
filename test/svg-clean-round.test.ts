// cleanSvg rounds coordinates by READING them (src/lib/export/svgClean.ts
// `roundCoordinates`), not by a find-and-replace over float-looking text. Minified
// path data (SVGO) ends a number with the next one's '.', so a token rounded to an
// integer used to fuse with its neighbour — `M10 1.004.5` became `M10 10.5` — and
// the arc flags of `0 01.5.5` were read as the number `01.5`.
//
//   node --test test/svg-clean-round.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roundCoordinates } from '../src/lib/export/svgClean.ts'
import { parsePathD } from '../src/lib/path/model.ts'

const nodesOf = (d: string) => parsePathD(d).flatMap((sp) => sp.nodes.map((n) => [n.x, n.y]))

test('a number rounded to an integer does not fuse with the next', () => {
  assert.equal(roundCoordinates('M10 1.004.5h2', 2, true), 'M10 1 0.5h2')
  assert.equal(roundCoordinates('l.999.25', 2, true), 'l1 0.25')
  assert.equal(roundCoordinates('M.001.5', 2, true), 'M0 0.5')
  assert.equal(roundCoordinates('1.004.5 2.5,3.333', 2), '1 0.5 2.5,3.33')
})

test("arc flags are single characters, not a number's first digits", () => {
  assert.equal(roundCoordinates('M0 0a5 5 0 01.5.5z', 2, true), 'M0 0a5 5 0 0 1 0.5 0.5z')
  // Repeated (implicit) arcs keep counting their seven arguments.
  assert.equal(
    roundCoordinates('M0 0a1 1 0 00.5.5 1 1 0 11.25.25', 1, true),
    'M0 0a1 1 0 0 0 0.5 0.5 1 1 0 1 1 0.3 0.3',
  )
})

test('the rounded path still parses to the same geometry (within the precision)', () => {
  const d = 'M10 1.004.5.999l.999.25a5 5 0 01.5.5c-1.001-2.002.003.004 1.2.2z'
  const before = nodesOf(d)
  const after = nodesOf(roundCoordinates(d, 2, true))
  assert.equal(after.length, before.length)
  for (let i = 0; i < before.length; i++) {
    assert.ok(Math.abs(after[i][0] - before[i][0]) < 0.02 && Math.abs(after[i][1] - before[i][1]) < 0.02, `node ${i}`)
  }
})

test('separators and signs are kept as written', () => {
  assert.equal(roundCoordinates('M1.234,5.678 L-1.999-2.001', 2, true), 'M1.23,5.68 L-2-2')
  assert.equal(roundCoordinates('10.567', 2), '10.57')
  assert.equal(roundCoordinates('M 10 20 L 30 40', 2, true), 'M 10 20 L 30 40')
})
