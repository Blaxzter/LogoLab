// paintStrokes / inkRuns on a CLOSED stroke whose seam falls inside a short ink run.
// The short run is folded into a neighbour; across the seam that neighbour is the run
// at the far end of the list, and a plain index assignment inverted it (to < from), so
// the run emitted zero nodes and its whole stretch of the loop vanished from the SVG.
//
//   node --test test/audit-tracer-2.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paintStrokes } from '../src/lib/trace/centerline/colour.ts'
import type { PathItem, PathNode } from '../src/lib/path/types.ts'

const W = 100
const H = 60
const HEX = ['#aa0000', '#00bb00', '#0000cc']

/** Ink labels: row y=10 is A up to `aEnd`, B up to x=89; everything else is C. */
function inkMap(aEnd: number): Int32Array {
  const inkOf = new Int32Array(W * H).fill(2)
  for (let x = 0; x < 90; x++) inkOf[10 * W + x] = x <= aEnd ? 0 : 1
  return inkOf
}

const node = (x: number, y: number): PathNode => ({ x, y, hIn: null, hOut: null, kind: 'corner' })

function loop(pts: [number, number][]): PathItem {
  return {
    kind: 'path',
    id: 's',
    fill: 'none',
    subPaths: [{ nodes: pts.map(([x, y]) => node(x, y)), closed: true }],
    stroke: { color: '#000000', width: 4 },
  } as unknown as PathItem
}

function check(item: PathItem, inkOf: Int32Array) {
  const out = paintStrokes(
    [item],
    inkOf,
    () => true,
    W,
    H,
    (l) => HEX[l],
    0,
  )
  for (const it of out) for (const sp of it.subPaths) assert.ok(sp.nodes.length >= 2, `${it.id} came back empty`)
  // Every one of the loop's six segments is drawn once.
  const segs = out.reduce((n, it) => n + it.subPaths.reduce((m, sp) => m + sp.nodes.length - 1, 0), 0)
  assert.equal(segs, 6)
  const colours = new Set(out.map((it) => it.stroke!.color))
  assert.ok(colours.has(HEX[1]) && colours.has(HEX[2]), `both long inks drawn: ${[...colours]}`)
}

test('short first run folded into the LAST run across the seam keeps that run', () => {
  // seg 0 is a 2px A run with no B/C votes → tie goes to prev = runs[last] (C).
  check(
    loop([
      [10, 10],
      [12, 10],
      [50, 10],
      [90, 10],
      [90, 50],
      [10, 50],
    ]),
    inkMap(12),
  )
})

test('short last run folded into the FIRST run across the seam keeps that run', () => {
  // seg 5 is a 2px A run that sees one B vote → it folds into next = runs[0] (B).
  check(
    loop([
      [12, 10],
      [50, 10],
      [90, 10],
      [90, 50],
      [10, 50],
      [10, 10],
    ]),
    inkMap(11),
  )
})
