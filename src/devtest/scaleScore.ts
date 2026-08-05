// CROSS-RESOLUTION SCORING — the measurement behind `scaleDiag.ts` (the CLI) and
// `test/scale-invariance.test.ts` (the gate), in ONE place.
//
// Same reason truthCorpus.ts exists: a gate that re-declares how it measures can silently
// drift from what the lab reports, and the first number anybody quotes from the wrong one
// is a wasted day. The CLI prints; the gate asserts; neither owns the arithmetic.
//
// ---------------------------------------------------------------------------
// WHAT IS MEASURED, AND WHY IT NEEDED A NEW SCORER
//
// Every existing gate scores ONE resolution independently — truth-gate @512, the LOWRES
// lane @256 — each against tolerances calibrated at THAT raster. So nothing anywhere
// forces the same artwork to produce the same GEOMETRY at two sizes, and a tracer whose
// output is a function of the raster rather than of the art passes all of them while
// being, in the product's terms, wrong.
//
// The trick that makes cross-resolution numbers comparable at all: every lane's traced doc
// is affine-scaled into ONE reference space (the finest lane's), and scored there against
// the authored SVG mapped into that same space, with the reference raster driving the §9.6
// visibility filter. An affine on Bézier control points is exact — nothing is resampled or
// re-fitted — so the only thing that differs between lanes is the resolution the TRACER
// saw. Scoring each lane in its own pixels instead would report a 4× improvement for a
// tracer that changed nothing (truth-gate.test.ts's RES comment: black-circle is 7.8px at
// 256 and 33.1px at 1024 for one trace).
//
// ⚠ NEVER RENDER A SCALED DOC TO CHECK THIS. rasterizeDoc(doc, w, h) draws one viewBox
// unit per output pixel and does not fit the viewBox to the buffer, so an enlarged doc in
// a native-size buffer is silently CROPPED. This module is geometry-only end to end.

import { readFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { parseGroundTruth, toRasterSpace, unscorable, type GroundShape } from './svgGround.ts'
import { scoreGeometry, scoreRegions } from './geomScore.ts'
import { transformSubPaths } from '../lib/path/geometry.ts'
import { buildPlanarNetwork } from '../lib/trace/planarNetwork.ts'
import type { EditableDoc, SubPath } from '../lib/path/types.ts'

/** The resolutions the CLI and the gate sweep by default. LAST = the reference space. */
export const SCALE_RESOLUTIONS = [256, 512, 1024]

export interface ScaleLane {
  res: number
  /** vs the AUTHORED SVG, in reference px — comparable across lanes by construction. */
  chamfer: number
  p95: number
  worst: number
  missedMean: number
  spuriousMean: number
  parsimony: number
  docNodes: number
  samples: number
  /** The RAW crack chains vs the authored SVG, same space. NaN unless `lattice` was set. */
  latChamfer: number
  latP95: number
  /** Scored at the lane's OWN native raster (a question about those pixels). */
  gtCorners: number
  cornersRecovered: number
  trueRegions: number
  recovered: number
  missing: { hex: string; areaPx: number; paintedHex: string; deltaE: number }[]
  ms: number
}

export interface ScaleResult {
  name: string
  /** Set when svgGround refuses the file — GT columns are NaN, self-consistency is not. */
  noAnswerSheet?: string
  ref: number
  lanes: ScaleLane[]
  /**
   * chamfer(coarsest) / chamfer(finest), both in reference px. THE number:
   *   1.0  the trace is a function of the ARTWORK — the goal
   *   ~R   the trace is a function of the LATTICE (R = the resolution ratio)
   * NaN when the finest lane has no measurable error (an axis-aligned case the lattice
   * represents exactly, e.g. `checker`) — a ratio of two zeroes ranks nothing.
   */
  drift: number
  p95Drift: number
  /** Coarsest geometry vs finest geometry, directly, in reference px. Needs no answer
   *  sheet, so it also grades art whose SVG svgGround refuses (`<use>`, clips, strokes). */
  selfChamfer: number
  selfP95: number
  /** The resolution ratio the drift spans (4 for 256→1024). */
  ratio: number
}

/**
 * Scale a traced doc into the reference space. Geometry only: `loops`/`topology` are
 * dropped because they index a graph whose coordinates are NOT rewritten here, and the
 * scorer reads the materialized `subPaths` alone — leaving a stale topology beside scaled
 * subPaths would be a live foot-gun for the next caller.
 */
export function scaleDoc(doc: EditableDoc, s: number): EditableDoc {
  if (s === 1) return doc
  return {
    viewBox: [doc.viewBox[0] * s, doc.viewBox[1] * s, doc.viewBox[2] * s, doc.viewBox[3] * s],
    items: doc.items.map((it) =>
      it.kind === 'path' ? { ...it, loops: undefined, subPaths: transformSubPaths(it.subPaths, [s, 0, 0, s, 0, 0]) } : it,
    ),
  }
}

/**
 * The RAW crack chains as a doc — the ATTRIBUTION measurement.
 *
 * Drift confirms the CONSEQUENCE ("output is a function of resolution") but not the CAUSE.
 * Two candidates predict identical drift: boundary samples quantized to the integer crack
 * lattice BEFORE any fitting, or fit tolerances that are absolute px and so mean different
 * things at different sizes. §12's lesson is that the written cause loses to the
 * instrument, so this separates them instead of assuming:
 *
 *   latticeChamfer ≈ fittedChamfer  ⇒ the error is already IN THE SAMPLES. The fit is
 *                                     faithfully reproducing a quantized input and no
 *                                     tolerance change can help.
 *   latticeChamfer ≪ fittedChamfer  ⇒ the samples are fine and the FIT loses it; the lever
 *                                     is downstream.
 *
 * `net.edges[].pts` is exactly what the fitter is handed (planarAssemble pins only junction
 * endpoints on top of it). Node counts are meaningless here by construction — every lattice
 * step is an anchor — so only the distance columns are read.
 */
export function latticeDoc(labels: Int32Array, width: number, height: number): EditableDoc {
  const net = buildPlanarNetwork(labels, width, height)
  const subPaths: SubPath[] = net.edges.map((e) => ({
    closed: e.closed,
    nodes: e.pts.map((p) => ({ x: p.x, y: p.y, hIn: null, hOut: null, kind: 'corner' as const })),
  }))
  return {
    viewBox: [0, 0, width, height],
    items: [{ kind: 'path', id: 'lattice', fill: '#000000', fillRule: 'nonzero', subPaths, visible: true }],
  }
}

/** A doc viewed as ground-truth shapes — so two TRACES can be scored against each other. */
const docAsShapes = (doc: EditableDoc): GroundShape[] =>
  doc.items
    .filter((it) => it.kind === 'path' && it.visible !== false)
    .map((it) => ({ tag: 'path', subPaths: (it as { subPaths: SubPath[] }).subPaths }))

/**
 * Trace one authored SVG at every resolution and score the lot in the finest lane's space.
 * `svgPath` is absolute. Pure measurement: no console output, no assertions.
 */
export async function measureScale(
  name: string,
  svgPath: string,
  opts: { gradients: boolean; resolutions?: number[]; lattice?: boolean },
): Promise<ScaleResult> {
  const RES = (opts.resolutions ?? SCALE_RESOLUTIONS).slice().sort((a, b) => a - b)
  const REF = RES[RES.length - 1]
  const svg = readFileSync(svgPath, 'utf8')
  const gt = parseGroundTruth(svg)
  const why = unscorable(gt)

  const refImg = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: REF }, background: 'white' }).render().asPng())
  const gtRef = why ? [] : toRasterSpace(gt, refImg.width)

  const lanes: ScaleLane[] = []
  const scaled: EditableDoc[] = []
  for (const res of RES) {
    const img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng())
    let raw: { labels: Int32Array; width: number; height: number } | null = null
    const t0 = process.hrtime.bigint()
    const doc = await traceImage(
      img as unknown as ImageData,
      { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: opts.gradients },
      undefined, undefined, undefined, undefined,
      opts.lattice ? (l) => { raw = l } : undefined,
    )
    const ms = Number(process.hrtime.bigint() - t0) / 1e6

    const s = refImg.width / img.width
    const docRef = scaleDoc(doc, s)
    scaled.push(docRef)

    const g = why ? null : scoreGeometry(gtRef, docRef, refImg.width, refImg.height, refImg)
    const gNative = why ? null : scoreGeometry(toRasterSpace(gt, img.width), doc, img.width, img.height, img)
    const r = opts.gradients ? null : scoreRegions(img, doc)

    let lat: { chamfer: number; p95: number } | null = null
    if (raw && !why) {
      const rr = raw as { labels: Int32Array; width: number; height: number }
      const lg = scoreGeometry(gtRef, scaleDoc(latticeDoc(rr.labels, rr.width, rr.height), s), refImg.width, refImg.height, refImg)
      lat = { chamfer: lg.chamfer, p95: lg.p95 }
    }

    let docNodes = 0
    for (const it of docRef.items) if (it.kind === 'path') for (const sp of it.subPaths) docNodes += sp.nodes.length

    lanes.push({
      res,
      chamfer: g?.chamfer ?? NaN, p95: g?.p95 ?? NaN, worst: g?.hausdorff ?? NaN,
      missedMean: g?.missedMean ?? NaN, spuriousMean: g?.spuriousMean ?? NaN,
      parsimony: g?.parsimony ?? NaN, docNodes: g?.docNodes ?? docNodes, samples: g?.samples ?? 0,
      latChamfer: lat?.chamfer ?? NaN, latP95: lat?.p95 ?? NaN,
      gtCorners: gNative?.gtCorners ?? 0, cornersRecovered: gNative?.cornersRecovered ?? 0,
      trueRegions: r?.trueRegions ?? 0, recovered: r?.recovered ?? 0, missing: r?.missing ?? [],
      ms,
    })
  }

  // Coarsest vs finest, geometry against geometry — no answer sheet involved.
  const self = scoreGeometry(docAsShapes(scaled[scaled.length - 1]), scaled[0], refImg.width, refImg.height, refImg)
  const first = lanes[0]
  const last = lanes[lanes.length - 1]

  return {
    name,
    noAnswerSheet: why ?? undefined,
    ref: REF,
    lanes,
    drift: last.chamfer > 0 ? first.chamfer / last.chamfer : NaN,
    p95Drift: last.p95 > 0 ? first.p95 / last.p95 : NaN,
    selfChamfer: self.chamfer,
    selfP95: self.p95,
    ratio: last.res / first.res,
  }
}

// ---------------------------------------------------------------------------
// The gate's lane and its limit
// ---------------------------------------------------------------------------

/**
 * What `test/scale-invariance.test.ts` runs. A small fixed subset, for the reason
 * truthCorpus states plainly: a gate slow enough to be annoying gets switched off, and a
 * gate that is off is not a gate. Three lanes per case is already 3× the truth gate's
 * tracing cost, so the lane is chosen for SIGNAL rather than coverage — every case here
 * carries curved or diagonal boundary, which is where lattice quantization bites. Art that
 * is entirely axis-aligned (`checker`) is deliberately excluded: the integer lattice
 * represents it EXACTLY, its error is ~0.000px at every size, and the drift ratio there is
 * a quotient of two zeroes that ranks nothing.
 *
 * `annulus` is the CONTROL, and it earns its place: at 1.69 it is the least
 * resolution-dependent case in tier 0, because its boundary is fitted to a resolution-FREE
 * primitive (the circle snap) instead of to lattice samples. It is the existence proof that
 * drift falls toward 1 when the representation stops being the lattice — so it must not get
 * WORSE, whatever a fix does elsewhere.
 */
export const SCALE_CORPUS: { name: string; svg: string; gradients: boolean }[] = [
  { name: 'concentric', svg: 'public/examples/edge-cases/concentric.svg', gradients: false },
  { name: 'sharp-star', svg: 'public/examples/edge-cases/sharp-star.svg', gradients: false },
  { name: 'aa-seam', svg: 'public/examples/edge-cases/aa-seam.svg', gradients: false },
  { name: 'overlap', svg: 'public/examples/edge-cases/overlap.svg', gradients: false },
  { name: 'band-cross', svg: 'public/examples/edge-cases/band-cross.svg', gradients: false },
  { name: 'petals', svg: 'public/examples/petals.svg', gradients: false },
  { name: 'annulus', svg: 'public/examples/edge-cases/annulus.svg', gradients: false },
]

/**
 * The limit, and why it is 2.0.
 *
 * Drift is a RATIO over a 4× resolution span, so the two ends are fixed by the physics
 * rather than by taste: 1.00 is a trace that is purely a function of the artwork, 4.00 is
 * one that is purely a function of the lattice. Measured at HEAD (2026-08-04, scaleDiag
 * --lattice over tier 0), the median is 4.69 and every curved case sits in 3.7–7.2. So the
 * corpus is at or past the pure-lattice line and there is no healthy population to read a
 * limit off — the §9.6/§10.3/§12.1 calibration recipe does not apply, because nothing here
 * is healthy.
 *
 * 2.0 is therefore derived, not fitted: it is the statement "boundary error must improve
 * LESS than proportionally to the raster", i.e. the trace must be at least half a function
 * of the artwork. It sits below the whole current population (so the gate is honestly RED
 * on the day it lands, with every case enumerated — the truth-gate contract) and above the
 * best value today's engine already reaches on the one case where a resolution-free
 * primitive does the work (`annulus`, 1.69), so it is demonstrably not unreachable.
 *
 * ⚠ This limit is NOT to be widened to make a case pass. §0's rules exist because that is
 * the failure mode that killed earlier benchmarks. It comes DOWN as the fix lands.
 */
export const SCALE_DRIFT_MAX = 2.0

/**
 * The drift ratio's denominator is REGULARIZED: a case passes when
 *
 *   chamfer(coarsest) ≤ SCALE_DRIFT_MAX · max(chamfer(finest), SCALE_SIGNAL_FLOOR)
 *
 * because below the floor the fine-end number measures the REPRESSENTATION, not the
 * lattice, and a raw quotient of two sub-floor numbers grades nothing (`checker` read
 * 62× on an absolute error of 0.003px). The floor is derived, not tuned: a 4-node
 * kappa-Bézier circle deviates from a true circle by ~2.7·10⁻⁴·r radially, so annulus'
 * outer ring (r = 440 reference px) carries ~0.12px of pure representation error — a
 * fine-end chamfer at that magnitude is the Bézier approximation's, and no lattice
 * conclusion can be drawn from its ratio. (Found the honest way: sub-pixel placement
 * pushed annulus' fine end from 0.101 to 0.051 ref-px — THROUGH the old 0.05 floor —
 * while its @256 end sat at kappa-floor scale too, and the raw ratio exploded on a case
 * whose absolute errors were 5× inside every gate.)
 */
export const SCALE_SIGNAL_FLOOR = 0.15
