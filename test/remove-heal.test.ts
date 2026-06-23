// "Remove & heal" markers (planar engine): a marked section is dissolved and its
// bordering colours grow into the freed area by a nearest-neighbour grassfire —
// the gap heals instead of leaving a hole. These assertions are on the relabeled
// LABEL MAP that feeds tracePlanar (applyRemoveMarkers), the smallest surface that
// proves the split: the removed label must vanish and every freed pixel must land
// on a real neighbour (or transparent only when there is no opaque neighbour).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyRemoveMarkers, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import type { VectorizeOptions } from '../src/types.ts'

const opts = (markers: VectorizeOptions['markers']): VectorizeOptions => ({
  ...DEFAULT_VECTORIZE_OPTIONS,
  markers,
})

/** Build an Int32 label map from a row-major grid of small ints (-1 = transparent). */
function grid(rows: number[][]): { labels: Int32Array; width: number; height: number } {
  const height = rows.length
  const width = rows[0].length
  const labels = new Int32Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) labels[y * width + x] = rows[y][x]
  return { labels, width, height }
}
const at = (l: Int32Array, w: number, x: number, y: number): number => l[y * w + x]

test('no remove markers ⇒ same reference (byte-identical)', () => {
  const { labels, width, height } = grid([
    [0, 0, 1, 1],
    [0, 0, 1, 1],
  ])
  assert.equal(applyRemoveMarkers(opts(undefined), labels, width, height, -1), labels)
  assert.equal(applyRemoveMarkers(opts([{ x: 0.5, y: 0.5 }]), labels, width, height, -1), labels)
})

test('a section between two colours splits along the middle (medial), removed label gone', () => {
  // x0..1 = colour 0, x2..4 = section 2 (3 wide), x5..6 = colour 1.
  const { labels, width, height } = grid([
    [0, 0, 2, 2, 2, 1, 1],
    [0, 0, 2, 2, 2, 1, 1],
    [0, 0, 2, 2, 2, 1, 1],
  ])
  // Seed lands on the section's centre column (round(0.45*7) = 3).
  const out = applyRemoveMarkers(opts([{ x: 0.45, y: 0.5, remove: true }]), labels, width, height, -1)

  assert.ok(!out.includes(2), 'the removed label must not survive anywhere')
  // Untouched neighbours stay put.
  for (let y = 0; y < height; y++) {
    assert.equal(at(out, width, 0, y), 0)
    assert.equal(at(out, width, 1, y), 0)
    assert.equal(at(out, width, 5, y), 1)
    assert.equal(at(out, width, 6, y), 1)
  }
  // Freed columns: the side nearest each neighbour goes to that neighbour; the
  // centre column is claimed by one real neighbour (never transparent, never 2).
  for (let y = 0; y < height; y++) {
    assert.equal(at(out, width, 2, y), 0, 'left edge of the gap heals to the left colour')
    assert.equal(at(out, width, 4, y), 1, 'right edge of the gap heals to the right colour')
    assert.ok([0, 1].includes(at(out, width, 3, y)), 'the medial column lands on a real neighbour')
  }
})

test('a section touching only transparency dissolves to transparent (plain delete)', () => {
  const { labels, width, height } = grid([
    [-1, -1, -1, -1, -1],
    [-1, 2, 2, 2, -1],
    [-1, -1, -1, -1, -1],
  ])
  // Seed on the blob: round(0.4*5)=2, round(0.4*3)=1 → the middle row.
  const out = applyRemoveMarkers(opts([{ x: 0.4, y: 0.4, remove: true }]), labels, width, height, -1)
  assert.ok(!out.includes(2), 'no opaque neighbour ⇒ the section is removed')
  assert.ok(out.every((v) => v === -1), 'everything is transparent')
})

test('the background colour is excluded as a fill source (heals to the real neighbour)', () => {
  // Section 2 borders colour 0 (left) and background colour 9 (right). With bg = 9,
  // the freed area must go to 0, not back into the backplate that gets dropped.
  const { labels, width, height } = grid([
    [0, 2, 9],
    [0, 2, 9],
    [0, 2, 9],
  ])
  // round(0.4*3) = 1 → the section column.
  const out = applyRemoveMarkers(opts([{ x: 0.4, y: 0.5, remove: true }]), labels, width, height, 9)
  for (let y = 0; y < height; y++) assert.equal(at(out, width, 1, y), 0, 'gap heals to the opaque neighbour, not bg')
})

test('other same-colour blobs are untouched — only the clicked component dissolves', () => {
  // Two separate blobs of colour 2; the marker only hits the right one.
  const { labels, width, height } = grid([
    [2, 0, 0, 2],
    [2, 0, 0, 2],
  ])
  // round(0.95*4) = 4 → clamped to x=3 (the right blob).
  const out = applyRemoveMarkers(opts([{ x: 0.95, y: 0.5, remove: true }]), labels, width, height, -1)
  for (let y = 0; y < height; y++) {
    assert.equal(at(out, width, 0, y), 2, 'the far blob of the same colour survives')
    assert.equal(at(out, width, 3, y), 0, 'the clicked blob heals into its neighbour')
  }
})
