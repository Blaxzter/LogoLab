// Headless line-art corpus for the evaluation harness (plan §5/§6 — "add the SVG
// corpus to the headless harness so the line-art cases gate `npm test`").
//
// The hand-made SVG corpus (summit, bloom, …) is normally measurable only in the
// browser, because rasterizing arbitrary SVG (strokes, rounded rects, gradients)
// needs canvas. But the cases whose paint the pure rasterizer (raster.ts) CAN
// reproduce — solid fills and per-shape opacity — can be rebuilt from the doc
// model and rasterized headlessly, giving a faithful, deterministic ground truth.
//
// `summit` is the Stage-A headline (a sharp-cornered mountain mark): the crisp
// tracer used to round its corners (browser seam 93). Building it here lets
// `npm test` and runBaseline gate the corner-preservation fix without a browser.

import type { EditableDoc, PathItem, SubPath } from '../lib/path/types.ts'
import { ellipseSubPaths } from '../lib/path/model.ts'
import { rasterizeDoc } from './raster.ts'

export interface SyntheticCase {
  name: string
  width: number
  height: number
  /** The ground-truth document (rasterized to produce the source pixels). */
  doc: EditableDoc
}

/** A closed polygon subpath (straight edges, sharp corners — null handles). */
function polygon(pts: [number, number][]): SubPath {
  return {
    closed: true,
    nodes: pts.map(([x, y]) => ({ x, y, hIn: null, hOut: null, kind: 'corner' as const })),
  }
}

/** summit.svg rebuilt from geometry: a dark circle + a sharp mountain polygon. */
function summitDoc(): EditableDoc {
  const fill = '#14161c'
  const circle = ellipseSubPaths(356, 150, 36, 36)![0]
  const mountain = polygon([
    [84, 400],
    [212, 176],
    [300, 320],
    [356, 236],
    [428, 400],
  ])
  const items: PathItem[] = [
    { kind: 'path', id: 'circle', fill, fillRule: 'nonzero', subPaths: [circle], visible: true },
    { kind: 'path', id: 'mountain', fill, fillRule: 'nonzero', subPaths: [mountain], visible: true },
  ]
  return { viewBox: [0, 0, 512, 512], items }
}

/** bloom.svg rebuilt: three overlapping translucent circles (per-shape opacity). */
function bloomDoc(): EditableDoc {
  const circle = (cx: number, cy: number, fill: string): PathItem => ({
    kind: 'path',
    id: `${fill}`,
    fill,
    fillRule: 'nonzero',
    fillOpacity: 0.85,
    subPaths: [ellipseSubPaths(cx, cy, 104, 104)![0]],
    visible: true,
  })
  return {
    viewBox: [0, 0, 512, 512],
    items: [circle(256, 172, '#6366f1'), circle(166, 330, '#ec4899'), circle(346, 330, '#0ea5e9')],
  }
}

export const SYNTHETIC_CORPUS: SyntheticCase[] = [
  { name: 'summit', width: 512, height: 512, doc: summitDoc() },
  { name: 'bloom', width: 512, height: 512, doc: bloomDoc() },
]

/** Rasterize a synthetic case's ground-truth doc into source pixels (over white). */
export function syntheticSource(c: SyntheticCase): { width: number; height: number; data: Uint8ClampedArray } {
  const data = rasterizeDoc(c.doc, c.width, c.height)
  return { width: c.width, height: c.height, data }
}
