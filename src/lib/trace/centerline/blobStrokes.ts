// Strokes only: the ink the strokes do not explain, drawn as strokes too. The engine
// normally sends a note head, a dot or a solid shape to the planar tracer as a FILL; with
// `strokesOnly` the output must be stroked paths and nothing else, so each such region is
// read on its own — its own distance transform and skeleton, never the line drawing's — and
// every chain of that skeleton becomes a round-capped stroke as wide as the region is
// there. A region whose skeleton has no chain (a disc thins to a point) is one dot: a
// zero-length round-capped stroke of its inscribed diameter. Nothing is dropped.
//
// The width is the region's inscribed diameter along the chain at its 80th percentile, not
// its maximum: a note head is widest at its middle and tapers to its ends, and the round
// caps already round the ends off. It is a reading of a shape as strokes, so a square
// comes back as a stroke with round ends — that is what "strokes only" asks for.

import type { PathNode, Vec } from '../../path/types'
import type { PlanarFitOptions } from '../planarFit/options.ts'
import type { StrokePath } from './assemble.ts'
import { distanceTransform } from './distance.ts'
import { fitClosedCentreline, fitOpenCentreline } from './fit.ts'
import { pruneSpurs, skeletonGraph } from './graph.ts'
import { thinZhangSuen } from './thin.ts'

/** Share of a chain's inscribed diameters its stroke width is read at. */
const WIDTH_QUANTILE = 0.8

/** Strokes that paint the regions of `mask` (1 = ink). */
export function blobStrokes(
  mask: Uint8Array,
  width: number,
  height: number,
  fitOpts: PlanarFitOptions,
  fidelity: number,
): StrokePath[] {
  const dt = distanceTransform(mask, width, height)
  const g = skeletonGraph(thinZhangSuen(mask, width, height), dt, width, height)
  pruneSpurs(g, dt)
  const comp = components(mask, width, height)
  const drawn = new Set<number>()
  const out: StrokePath[] = []
  const centre = (p: number): Vec => ({ x: (p % width) + 0.5, y: ((p / width) | 0) + 0.5 })
  // The stroke's half-width at a skeleton pixel is dt − 0.5 (distance.ts).
  const diameter = (pixels: number[]): number => {
    const ds = pixels.map((p) => 2 * Math.max(0.5, dt[p] - 0.5)).sort((a, b) => a - b)
    return ds[Math.min(ds.length - 1, Math.floor(WIDTH_QUANTILE * ds.length))]
  }
  for (const c of g.chains) {
    if (!c.alive || c.pixels.length === 0) continue
    const w = Math.round(diameter(c.pixels) * 100) / 100
    const pts = c.pixels.map(centre)
    if (c.closed) {
      const sp = fitClosedCentreline(pts, w, fitOpts, null, fidelity)
      if (sp) out.push({ subPath: sp, width: w, cap: 'round', polyline: pts })
    } else {
      const ends = [c.a >= 0 ? g.nodes[c.a] : null, c.b >= 0 ? g.nodes[c.b] : null]
      if (ends[0]) pts.unshift({ x: ends[0].x + 0.5, y: ends[0].y + 0.5 })
      if (ends[1]) pts.push({ x: ends[1].x + 0.5, y: ends[1].y + 0.5 })
      const nodes = fitOpenCentreline(pts, w, fitOpts, null)
      if (nodes.length >= 2) out.push({ subPath: { nodes, closed: false }, width: w, cap: 'round', polyline: pts })
      else out.push(dot(pts[0], w))
    }
    drawn.add(comp[c.pixels[0]])
  }
  // Regions with no chain: one dot each, at their deepest pixel.
  const deepest = new Map<number, number>()
  for (let i = 0; i < mask.length; i++) {
    const k = comp[i]
    if (!k || drawn.has(k)) continue
    const best = deepest.get(k)
    if (best === undefined || dt[i] > dt[best]) deepest.set(k, i)
  }
  for (const [, i] of deepest) out.push(dot(centre(i), Math.round(2 * Math.max(0.5, dt[i] - 0.5) * 100) / 100))
  return out
}

/** A zero-length round-capped stroke: a disc of diameter `w`. */
function dot(p: Vec, w: number): StrokePath {
  const node = (): PathNode => ({ x: p.x, y: p.y, hIn: null, hOut: null, kind: 'corner' })
  return { subPath: { nodes: [node(), node()], closed: false }, width: w, cap: 'round', polyline: [p] }
}

/** 4-connected components of `mask`, labelled from 1. */
function components(mask: Uint8Array, width: number, height: number): Int32Array {
  const comp = new Int32Array(mask.length)
  const stack: number[] = []
  let next = 0
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || comp[s]) continue
    comp[s] = ++next
    stack.push(s)
    while (stack.length) {
      const p = stack.pop()!
      const x = p % width
      const y = (p / width) | 0
      const visit = (q: number): void => {
        if (!mask[q] || comp[q]) return
        comp[q] = next
        stack.push(q)
      }
      if (x > 0) visit(p - 1)
      if (x < width - 1) visit(p + 1)
      if (y > 0) visit(p - width)
      if (y < height - 1) visit(p + width)
    }
  }
  return comp
}
