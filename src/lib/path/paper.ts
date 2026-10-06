// The PAPER: the opaque ground a one-ink or line-art trace was cut from, emitted as one
// rectangle under everything else. Mono and colour strokes trace the ink and nothing
// else, so without it a mark on a white page came back on transparency — "the trace
// removed my background" — while the colour path kept its background as a region.
//
// It is the one item a repaint must NOT touch: force colour / the sheet's recolour paint
// every shape in the ink's colour, and a paper painted in the ink is a solid square.
// `removeBackground` drops it like the colour path's background region.

import type { PathItem } from './types'

/** The id the paper rectangle carries; repaints recognise it by this. A STACKED mono
 *  trace adds the paper's islands on top of the ink (`paper-d<layer>`, the counter of an
 *  O): paper too, and skipped the same way, or a repaint fills every counter with ink. */
export const PAPER_ID = 'paper'

export const isPaper = (item: { id: string }): boolean => item.id === PAPER_ID || item.id.startsWith(`${PAPER_ID}-d`)

/** A `width`×`height` rectangle at the origin, filled with `fill`. */
export function paperItem(width: number, height: number, fill: string): PathItem {
  const corner = (x: number, y: number) => ({ x, y, hIn: null, hOut: null, kind: 'corner' as const })
  return {
    kind: 'path',
    id: PAPER_ID,
    fill,
    fillRule: 'nonzero',
    subPaths: [{ nodes: [corner(0, 0), corner(width, 0), corner(width, height), corner(0, height)], closed: true }],
    visible: true,
  }
}

/**
 * The paper's colour: the per-channel MEDIAN of the pixels labelled paper. Not the mean —
 * the anti-aliasing along every ink edge is labelled paper too and pulls a white page to
 * #fefefe, which is a different colour (and moves every edge pixel across a 128 cut).
 */
export function paperColor(
  img: { data: Uint8ClampedArray },
  labels: Int32Array,
  paperLabel: number,
): { r: number; g: number; b: number } {
  const h = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
  let n = 0
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== paperLabel) continue
    h[0][img.data[i * 4]]++
    h[1][img.data[i * 4 + 1]]++
    h[2][img.data[i * 4 + 2]]++
    n++
  }
  const median = (c: Uint32Array) => {
    let acc = 0
    for (let v = 0; v < 256; v++) if ((acc += c[v]) * 2 >= n) return v
    return 255
  }
  return n === 0 ? { r: 255, g: 255, b: 255 } : { r: median(h[0]), g: median(h[1]), b: median(h[2]) }
}

/**
 * Whether the art sits on an OPAQUE ground: at least half the border ring is visible.
 * The same test the colour path's background rule uses, so the two agree on what
 * "has a background" means.
 */
export function hasOpaqueBorder(
  img: { width: number; height: number; data: Uint8ClampedArray },
  minAlpha = 128,
): boolean {
  const { width, height, data } = img
  let ring = 0
  let opaque = 0
  const visit = (i: number) => {
    ring++
    if (data[i * 4 + 3] >= minAlpha) opaque++
  }
  for (let x = 0; x < width; x++) {
    visit(x)
    if (height > 1) visit((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y++) {
    visit(y * width)
    if (width > 1) visit(y * width + width - 1)
  }
  return ring > 0 && opaque / ring >= 0.5
}
