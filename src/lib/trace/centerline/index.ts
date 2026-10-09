// Centreline tracing: one-ink line art as STROKED paths with a measured width, plus
// filled paths for the ink no stroke explains. `mode: 'mono'` + `centerline: true`.
//
// The outline tracer answers "where is the boundary of the ink"; this answers "where is
// the middle of the stroke, and how wide is it" — the question a monoline icon, a
// diagram or a sheet of music actually poses, and the one whose answer can be
// re-weighted afterwards. The stages, each its own module:
//
//   distance.ts   exact EDT of the ink mask — the local half-width, and the radius every
//                 "short compared to the stroke" rule below is measured in;
//   thin.ts       Zhang–Suen skeleton + staircase removal — where the centre is, ±1px;
//   graph.ts      the skeleton as nodes and chains; spurs pruned, split crossings welded;
//   profile.ts    each chain re-centred on the coverage profile's iso-0.5 edges and
//                 given a sub-pixel width — the raster, not the skeleton, has the answer;
//   blobs.ts      the ink the strokes do not explain becomes fills (through the planar
//                 tracer, so a note head is beautified like any region);
//   ends.ts       free ends walked out to the ink's end, caps read (butt / round);
//   holes.ts      the round holes rings enclose — a ring's evidence where the skeleton
//                 between the junctions on it has gone straight;
//   assemble.ts   arms paired through junctions by rank, junctions placed at the arm
//                 lines' meet, paths stitched, fitted (fit.ts) and given one width each;
//   confidence.ts a whole ink component the strokes read badly (a QR block, a caption,
//                 a mangled mark) goes to the fills.
//
// Everything scales with the measured stroke width, never with a constant in px, so a
// 2px staff line and a 40px icon stroke go through the same rules.

import type { EditableDoc, PathItem, Topology } from '../../path/types'
import type { PlanarFitOptions } from '../planarFit/options.ts'
import { MONO_INK, MONO_PAPER, type MonoSegmentation } from '../mono.ts'
import { assembleStrokes, strokeItems, type JunctionDiag, type StrokePath } from './assemble.ts'
import type { FitContext } from './fit.ts'
import { splitBlobs, strokeRuns, type BlobSplit, type StrokeRun } from './blobs.ts'
import { pathComponents, readComponents, type ComponentReading } from './confidence.ts'
import { distanceTransform } from './distance.ts'
import { roundHoles } from './holes.ts'
import { contractClusterLinks, pruneSpurs, skeletonGraph, weldCrossings, type SkeletonGraph } from './graph.ts'
import { coverageField, refineChain, type Centreline } from './profile.ts'
import { thinZhangSuen } from './thin.ts'

export interface CenterlineReport {
  /** The picture's stroke width (px at trace resolution). */
  strokeWidth: number
  strokes: number
  fills: number
  junctions: number
  /** Share of the ink painted as fills. */
  fillShare: number
  /** Ink components sent to the fills whole (confidence.ts). */
  routed: number
}

export interface CenterlineInput {
  seg: MonoSegmentation
  width: number
  height: number
  fitOpts: PlanarFitOptions
  /** Beautify tolerance (px); 0 disables the circle snap on rings. */
  fidelity: number
  /** Trace a two-label map (MONO_INK / MONO_PAPER) of the fills through the planar tracer. */
  traceFills: (labels: Int32Array) => { items: PathItem[]; topology?: Topology }
  onProgress?: (fraction: number, label: string) => void
  /** Diagnostic sink for every corner candidate the fitter weighs (never changes output). */
  onCorner?: FitContext['onCorner']
  /** Diagnostic sink for every junction's arms and pairing (never changes output). */
  onJunction?: (r: JunctionDiag) => void
  /** Diagnostic sink for the intermediate stages — the skeleton graph, the refined
   *  centrelines, the stroke/fill split, the runs and the assembly (never changes output). */
  onStages?: (s: CenterlineStages) => void
}

/** What `onStages` receives: every stage's output, for bench/centerlineSheetDiag.ts. */
export interface CenterlineStages {
  graph: SkeletonGraph
  lines: Centreline[]
  split: BlobSplit
  runs: StrokeRun[]
  paths: StrokePath[]
  /** Ink components sent to the fills, and why. */
  routed: ComponentReading['routed']
}

/** The stroke colour a centreline trace comes back in — repainted by the caller, like mono. */
export const CENTERLINE_INK = '#000000'

export function traceCenterline(input: CenterlineInput): { doc: EditableDoc; report: CenterlineReport } {
  const { seg, width, height, fitOpts, fidelity, traceFills, onProgress, onCorner, onJunction, onStages } = input
  const n = width * height
  const ink = new Uint8Array(n)
  let inkPixels = 0
  for (let i = 0; i < n; i++)
    if (seg.labels[i] === MONO_INK) {
      ink[i] = 1
      inkPixels++
    }
  const empty = { viewBox: [0, 0, width, height] as [number, number, number, number], items: [] }
  const none: CenterlineReport = { strokeWidth: 0, strokes: 0, fills: 0, junctions: 0, fillShare: 0, routed: 0 }
  if (inkPixels === 0) return { doc: empty, report: none }

  onProgress?.(0.35, 'Finding the stroke centres')
  const dt = distanceTransform(ink, width, height)
  const skel = thinZhangSuen(ink, width, height)
  const g = skeletonGraph(skel, dt, width, height)
  contractClusterLinks(g, dt)
  pruneSpurs(g, dt)
  weldCrossings(g, dt)
  pruneSpurs(g, dt)

  onProgress?.(0.55, 'Reading the stroke widths')
  const f = coverageField(seg.image, seg.labels, MONO_INK)
  const nodeRadius = (id: number): number => g.nodes[id].r
  const lines: Centreline[] = []
  for (const c of g.chains) {
    if (!c.alive || c.pixels.length === 0) continue
    lines.push(refineChain(g, c, f, dt, nodeRadius))
  }
  const split = splitBlobs(lines, ink, dt, width, height)
  const runs = strokeRuns(lines, split, width)

  onProgress?.(0.75, 'Fitting the strokes')
  const holes = roundHoles(ink, width, height)
  const asm = assembleStrokes(g, runs, split.W, f, split.blobMask, dt, holes, fitOpts, fidelity, onCorner, onJunction)
  // Strokes where the reading is confident, fills for the rest (confidence.ts): a QR
  // block, a caption, a mark the strokes mangle goes to the fills whole.
  const reading = readComponents(ink, width, height, g, lines, asm.paths, split.blobMask)
  let paths = asm.paths
  let blobMask = split.blobMask
  let blobPixels = split.blobPixels
  if (reading.routed.size > 0) {
    blobMask = blobMask ? blobMask.slice() : new Uint8Array(n)
    for (let i = 0; i < n; i++)
      if (ink[i] && !blobMask[i] && reading.routed.has(reading.comp[i])) {
        blobMask[i] = 1
        blobPixels++
      }
    const owner = pathComponents(asm.paths, reading.comp, width, height)
    paths = asm.paths.filter((_, k) => !reading.routed.has(owner[k]))
  }
  const strokes = strokeItems(paths, CENTERLINE_INK)
  onStages?.({ graph: g, lines, split, runs, paths, routed: reading.routed })

  let fills: PathItem[] = []
  let topology: Topology | undefined
  if (blobMask) {
    onProgress?.(0.85, 'Tracing the fills')
    const labels = new Int32Array(n)
    for (let i = 0; i < n; i++) labels[i] = blobMask[i] ? MONO_INK : MONO_PAPER
    const traced = traceFills(labels)
    fills = traced.items.map((it, i) => ({ ...it, id: `fill-${i}` }))
    topology = traced.topology
  }
  // Strokes first, fills over them: a stroke that runs through a fill (a staff line
  // through a note head) is bridged straight underneath it, and a stroke that ends
  // in one overlaps it by half a width — both hidden by the fill's own paint.
  const doc: EditableDoc = { viewBox: [0, 0, width, height], items: [...strokes, ...fills] }
  if (topology) doc.topology = topology
  return {
    doc,
    report: {
      strokeWidth: Math.round(split.W * 100) / 100,
      strokes: strokes.length,
      fills: fills.length,
      junctions: asm.junctions,
      fillShare: blobPixels / inkPixels,
      routed: reading.routed.size,
    },
  }
}
