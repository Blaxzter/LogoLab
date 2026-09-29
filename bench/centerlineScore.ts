// Scoring a centreline trace against the authored line art (bench/lineArtGround.ts).
// Geometry-space, like geomScore.ts for outlines, and for the same reason: every number
// is an absolute distance from correct, so an improvement moves further inside a limit
// and nothing is ever re-blessed.
//
// What is measured, per case at one raster resolution:
//   centreMean / centreP95  traced centreline → nearest authored centreline (px):
//                           PRECISION — a stroke drawn where there is none, or off its
//                           middle, reads here.
//   missedMean              authored centreline → nearest traced centreline (px):
//                           RECALL — a stroke not drawn reads here. An authored point
//                           under the traced INK — inside a traced fill, or inside a
//                           traced stroke's own band — is not missed: where one stroke
//                           merges tangentially into another (git-branch's arc into its
//                           stem) the authored centreline runs inside ink no tracer can
//                           tell apart, exactly as occluded boundary is excluded from
//                           the outline scorer (geomScore.makeVisibleAt, §9.6). A stroke
//                           drawn off its centre still reads on the PRECISION side.
//   widthErr                mean |w_traced − w_authored| / w_authored over matched
//                           samples — the number the whole engine exists to produce.
//   endsDelta / pathsDelta  open-path endpoints and stroke subpaths, traced − authored:
//                           TOPOLOGY — +2 ends is a stroke broken in two, −2 two strokes
//                           fused; an X drawn as four arms reads +4. The authored side
//                           is counted after joining paths that meet end to end
//                           (`mergedTopology`): the ink cannot say whether a corner was
//                           one element or two, and the tracer joins it.
//   fillIoU                 authored fills vs traced fills, as rasters; NaN when neither.
//   deltaE                  the trace RENDERED (rasterizeDoc, strokes included) against
//                           the source raster — the one number blind to how the ink was
//                           represented, so a fill-for-stroke swap that looks right
//                           scores right.
//
// `CENTERLINE_TOL` are the gate limits test/centerline-gate.test.ts applies; `failures`
// names the ones a score exceeds, so the diag table and the test read the same verdict.

import type { EditableDoc, SubPath } from '../src/lib/path/types.ts'
import { fidelity } from '../src/lib/render/fidelity.ts'
import { rasterizeDoc } from '../src/lib/render/raster.ts'
import { flattenSubPath } from './geomScore.ts'
import { lineArtToRaster, parseLineArt, type LineArtGround } from './lineArtGround.ts'

export interface CenterlineScore {
  centreMean: number
  centreP95: number
  missedMean: number
  widthErr: number
  widthTraced: number
  widthAuthored: number
  endsDelta: number
  pathsDelta: number
  fillIoU: number
  deltaE: number
  /** Stroke samples on each side. */
  tracedSamples: number
  authoredSamples: number
  failures: string[]
  /** Where the score is lost, for a picture: authored samples the trace does not
   *  explain, and traced samples off their authored centreline by more than 1.5 px. */
  missedPts: { x: number; y: number; d: number }[]
  offPts: { x: number; y: number; d: number }[]
}

export interface CenterlineTol {
  centreMean: number
  centreP95: number
  missedMean: number
  widthErr: number
  endsDelta: number
  pathsDelta: number
  fillIoU: number
  deltaE: number
}

/** Gate limits at 512px. */
export const CENTERLINE_TOL: CenterlineTol = {
  centreMean: 0.75,
  centreP95: 3.0,
  missedMean: 1.0,
  widthErr: 0.15,
  endsDelta: 2,
  pathsDelta: 2,
  fillIoU: 0.8,
  deltaE: 3.0,
}

/** The raster width `CENTERLINE_TOL`'s pixel limits are stated at. */
export const CENTERLINE_TOL_RES = 512

/**
 * The limits for a trace at `res` px: the three PIXEL limits (centre mean / p95, missed)
 * scale with the raster, because the fixtures are authored in units and a 0.75 px error
 * on a 32 px Lucide stroke at 512 is the same 2.3% as a 3 px error on the 128 px stroke
 * the same icon has at 2048. Widths, topology, fill IoU and ΔE are already relative.
 */
export function centerlineTol(res: number, base: CenterlineTol = CENTERLINE_TOL): CenterlineTol {
  const k = res / CENTERLINE_TOL_RES
  return { ...base, centreMean: base.centreMean * k, centreP95: base.centreP95 * k, missedMean: base.missedMean * k }
}

interface Sample {
  x: number
  y: number
  w: number
}

/** Resample polylines at ~1px spacing, carrying a width. */
function sampleSubPaths(subPaths: SubPath[], width: number, out: Sample[]): void {
  for (const sp of subPaths) {
    const poly = flattenSubPath(sp)
    if (sp.closed && poly.length > 1) poly.push(poly[0])
    for (let i = 0; i + 1 < poly.length; i++) {
      const a = poly[i]
      const b = poly[i + 1]
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      const steps = Math.max(1, Math.ceil(len))
      for (let s = 0; s < steps; s++) {
        const t = s / steps
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: width })
      }
    }
    const last = poly[poly.length - 1]
    if (last && !sp.closed) out.push({ x: last.x, y: last.y, w: width })
  }
}

/**
 * The authored stroke topology as a centreline tracer sees it: open subpaths whose
 * endpoints coincide (within half the wider stroke) are one stroke that turns a
 * corner — a barline drawn as its own element still meets the staff's first line end
 * to end, and the tracer, which has only the ink, rightly joins them. Each endpoint
 * pairs with at most one other; a chain closing on itself is a ring.
 */
export function mergedTopology(gt: LineArtGround): { paths: number; ends: number } {
  interface EndPt {
    id: number
    x: number
    y: number
    w: number
  }
  const ends: EndPt[] = []
  let paths = 0
  let id = 0
  for (const st of gt.strokes) {
    for (const sp of st.subPaths) {
      paths++
      if (sp.closed) continue
      const a = sp.nodes[0]
      const b = sp.nodes[sp.nodes.length - 1]
      ends.push({ id, x: a.x, y: a.y, w: st.width }, { id, x: b.x, y: b.y, w: st.width })
      id++
    }
  }
  // Union-find over open paths; count joins.
  const parent = Array.from({ length: id }, (_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const taken = new Uint8Array(ends.length)
  let joins = 0
  let closed = 0
  for (let i = 0; i < ends.length; i++) {
    if (taken[i]) continue
    let best = -1
    let bd = Infinity
    for (let j = i + 1; j < ends.length; j++) {
      if (taken[j] || ends[j].id === ends[i].id) continue
      const d = Math.hypot(ends[i].x - ends[j].x, ends[i].y - ends[j].y)
      if (d <= 0.5 * Math.max(ends[i].w, ends[j].w) && d < bd) {
        bd = d
        best = j
      }
    }
    if (best < 0) continue
    taken[i] = taken[best] = 1
    const ra = find(ends[i].id)
    const rb = find(ends[best].id)
    if (ra === rb) closed++
    else parent[ra] = rb
    joins++
  }
  return { paths: paths - joins, ends: (id - joins) * 2 - closed * 2 }
}

/** Open subpaths with both ends pushed `by` px along their end tangents. */
function extendEnds(subPaths: SubPath[], by: number): SubPath[] {
  return subPaths.map((sp) => {
    if (sp.closed || sp.nodes.length < 2) return sp
    const nodes = sp.nodes.map((n) => ({ ...n }))
    const push = (i: number, j: number): void => {
      const a = nodes[i]
      const b = nodes[j]
      const dx = a.x - b.x
      const dy = a.y - b.y
      const l = Math.hypot(dx, dy) || 1
      nodes[i] = { ...a, x: a.x + (dx / l) * by, y: a.y + (dy / l) * by }
    }
    push(0, 1)
    push(nodes.length - 1, nodes.length - 2)
    return { ...sp, nodes }
  })
}

/** Nearest-sample lookup over a uniform grid. */
function nearest(samples: Sample[], cell = 8): (x: number, y: number) => { d: number; s: Sample | null } {
  const grid = new Map<string, Sample[]>()
  const key = (cx: number, cy: number): string => `${cx},${cy}`
  for (const s of samples) {
    const k = key(Math.floor(s.x / cell), Math.floor(s.y / cell))
    const list = grid.get(k)
    if (list) list.push(s)
    else grid.set(k, [s])
  }
  return (x, y) => {
    const cx = Math.floor(x / cell)
    const cy = Math.floor(y / cell)
    let best: Sample | null = null
    let bd = Infinity
    for (let ring = 0; ring < 64; ring++) {
      // Once the best found is closer than the ring's inner edge, it is the answer.
      if (best && bd <= (ring - 1) * cell) break
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
          const list = grid.get(key(cx + dx, cy + dy))
          if (!list) continue
          for (const s of list) {
            const d = Math.hypot(s.x - x, s.y - y)
            if (d < bd) {
              bd = d
              best = s
            }
          }
        }
      }
    }
    return { d: best ? bd : Infinity, s: best }
  }
}

const median = (v: number[]): number => {
  if (v.length === 0) return NaN
  const s = v.slice().sort((a, b) => a - b)
  return s[s.length >> 1]
}
const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN)
const p95 = (v: number[]): number => {
  if (v.length === 0) return NaN
  const s = v.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]
}

/** A doc holding only the given subpaths as black fills, for an IoU raster. */
const fillDoc = (sets: SubPath[][], w: number, h: number): EditableDoc => ({
  viewBox: [0, 0, w, h],
  items: sets.map((subPaths, i) => ({
    kind: 'path' as const,
    id: `f${i}`,
    fill: '#000000',
    fillRule: 'nonzero' as const,
    subPaths,
    visible: true,
  })),
})

function inkMask(px: Uint8ClampedArray, n: number): Uint8Array {
  const m = new Uint8Array(n)
  for (let i = 0; i < n; i++) m[i] = px[i * 4] < 128 ? 1 : 0
  return m
}

/**
 * Score a traced doc against the authored SVG it was rasterized from. `source` is the
 * raster the tracer saw (opaque, on white), and sets the scoring resolution.
 */
export function scoreCenterline(
  svg: string,
  doc: EditableDoc,
  source: { width: number; height: number; data: Uint8ClampedArray },
  tol: CenterlineTol = CENTERLINE_TOL,
): CenterlineScore {
  const W = source.width
  const H = source.height
  const gt: LineArtGround = lineArtToRaster(parseLineArt(svg), W)

  // A square cap paints half a width past the centreline's end, exactly as a butt cap
  // on a centreline that long would; the ink cannot tell them apart and the tracer
  // reads butt, so the answer sheet extends a square-capped end by w/2.
  const authored: Sample[] = []
  for (const st of gt.strokes)
    sampleSubPaths(st.cap === 'square' ? extendEnds(st.subPaths, st.width / 2) : st.subPaths, st.width, authored)
  const { paths: authoredPaths, ends: authoredEnds } = mergedTopology(gt)
  const traced: Sample[] = []
  let tracedEnds = 0
  let tracedPaths = 0
  const tracedFills: SubPath[][] = []
  const tracedWidths: number[] = []
  for (const it of doc.items) {
    if (it.kind !== 'path' || !it.visible) continue
    if (it.stroke && it.fill === 'none') {
      sampleSubPaths(it.subPaths, it.stroke.width, traced)
      tracedWidths.push(it.stroke.width)
      for (const sp of it.subPaths) {
        tracedPaths++
        if (!sp.closed) tracedEnds += 2
      }
    } else if (it.fill !== 'none') tracedFills.push(it.subPaths)
  }

  // Fill rasters (also the "explained by a fill" allowance for recall).
  const n = W * H
  const tracedFillMask = tracedFills.length ? inkMask(rasterizeDoc(fillDoc(tracedFills, W, H), W, H), n) : null
  const authoredFillMask = gt.fills.length
    ? inkMask(
        rasterizeDoc(
          fillDoc(
            gt.fills.map((f) => f.subPaths),
            W,
            H,
          ),
          W,
          H,
        ),
        n,
      )
    : null
  let fillIoU = NaN
  if (tracedFillMask || authoredFillMask) {
    let inter = 0
    let union = 0
    for (let i = 0; i < n; i++) {
      const a = authoredFillMask ? authoredFillMask[i] : 0
      const t = tracedFillMask ? tracedFillMask[i] : 0
      if (a && t) inter++
      if (a || t) union++
    }
    fillIoU = union ? inter / union : 1
  }

  const toAuthored = nearest(authored)
  const toTraced = nearest(traced)
  const centre: number[] = []
  const werr: number[] = []
  const offPts: CenterlineScore['offPts'] = []
  for (const s of traced) {
    const { d, s: a } = toAuthored(s.x, s.y)
    centre.push(d)
    if (d > 1.5) offPts.push({ x: s.x, y: s.y, d })
    if (a && d <= Math.max(2, 0.5 * a.w)) werr.push(Math.abs(s.w - a.w) / a.w)
  }
  // Render fidelity: the trace as pixels vs the source.
  const render = rasterizeDoc(doc, W, H)
  const fid = fidelity(source.data, render, W, H)
  const renderInk = inkMask(render, n)

  // Recall: authored points the trace's ink does not cover. Points the SOURCE itself
  // never painted (the apex of a miter past its limit lies outside the bevelled ink,
  // as does the last stretch of a butt-capped stroke drawn past its own end) are not
  // the tracer's to find either.
  const sourceInk = inkMask(source.data, n)
  const missed: number[] = []
  const missedPts: CenterlineScore['missedPts'] = []
  for (const s of authored) {
    const px = Math.floor(s.x)
    const py = Math.floor(s.y)
    if (px < 0 || py < 0 || px >= W || py >= H || !sourceInk[py * W + px]) continue
    if (renderInk[py * W + px]) continue
    const d = toTraced(s.x, s.y).d
    missed.push(d)
    missedPts.push({ x: s.x, y: s.y, d })
  }

  const score: CenterlineScore = {
    centreMean: mean(centre),
    centreP95: p95(centre),
    missedMean: authored.length ? (missed.length ? mean(missed) : 0) : NaN,
    widthErr: mean(werr),
    widthTraced: median(tracedWidths),
    widthAuthored: median(gt.strokes.map((s) => s.width)),
    endsDelta: tracedEnds - authoredEnds,
    pathsDelta: tracedPaths - authoredPaths,
    fillIoU,
    deltaE: fid.meanDeltaE,
    tracedSamples: traced.length,
    authoredSamples: authored.length,
    failures: [],
    missedPts,
    offPts,
  }
  const f: string[] = []
  if (authored.length > 0 && !(score.centreMean <= tol.centreMean)) f.push('centre')
  if (authored.length > 0 && !(score.centreP95 <= tol.centreP95)) f.push('p95')
  if (authored.length > 0 && !(score.missedMean <= tol.missedMean)) f.push('missed')
  if (werr.length > 0 && !(score.widthErr <= tol.widthErr)) f.push('width')
  if (Math.abs(score.endsDelta) > tol.endsDelta) f.push('ends')
  if (Math.abs(score.pathsDelta) > tol.pathsDelta) f.push('paths')
  if (Number.isFinite(fillIoU) && fillIoU < tol.fillIoU) f.push('fills')
  if (!(score.deltaE <= tol.deltaE)) f.push('ΔE')
  score.failures = f
  return score
}
