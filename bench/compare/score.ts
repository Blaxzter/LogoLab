// Score one tool's SVG against one case — the SAME path for every tool.
//
//   render   resvg on white at the truth raster's w×h (render.ts)
//   paint    the shipped deltaEField / deltaEStats (src/lib/render/fidelity.ts) — the ΔE the
//            studio's status bar shows
//   geometry svgGround's reader on the trace string (traceSvg.ts) → scoreGeometry (chamfer,
//            p95, parsimony, corners recovered / invented, tangent breaks), circleRecovery,
//            scoreBorderBand — all of which read subpaths + the truth raster only
//   regions  scoreRegions on the resvg render (flat art)
//   gates    evaluateTruthGates with every per-case ALLOWANCE OFF (INVENTED_ALLOWED,
//            TANGENT_BREAKS_ALLOWED, CIRCLE_SPREAD_ALLOWED and KNOWN_DEFECTS are calibrated
//            on LogoLab's own output; no tool gets them), and the boundary limits TRUTH_TOL
//            (chamfer 1.0 / p95 2.5 / parsimony 3.0 px — tier 0's hand-set absolute bars)
//            for EVERY case. Not TIER_TOL[1|2]: those were fitted just above the p90 of
//            LogoLab's own traces (calibrateTier1/2.ts) and would measure distance from
//            LogoLab's history, not correctness. The tier still picks the LANE conventions
//            (paint gate on gradient tier 0 only).
//
// A render resvg refuses is scored as an all-white raster (status stays 'render-failed'):
// SVG-Bench's rasterize_svg does the same, and dropping the row would flatter the tool.
//
// shimDoc is BOUNDARY-ONLY: every item is fill-rule nonzero with the element's own fill
// attribute. Nothing rasterizes it (paint is always the resvg render); do not start to.
//
// LogoLab-only lenses (topology junctions, the paper rectangle convention) are not scored.
// The lane conventions of the truth gate are kept for every tool: region / corner / circle /
// border gates on flat art only, the paint gate on gradient tier-0 only.

import { deltaEField, deltaEStats } from '../../src/lib/render/fidelity.ts'
import { scoreGeometry, scoreRegions, circleRecovery, scoreBorderBand, makeVisibleAt } from '../geomScore.ts'
import { evaluateTruthGates, TRUTH_TOL } from '../truthCorpus.ts'
import type { GroundShape } from '../svgGround.ts'
import type { EditableDoc } from '../../src/lib/path/types.ts'
import { renderTrace, type Raster } from './render.ts'
import { parseTraceSvg } from './traceSvg.ts'
import type { CompareCase, ScoreRow } from './types.ts'

export interface Truth {
  img: Raster
  /** Pixel-space authored shapes, or null when the authored SVG is refused. */
  shapes: GroundShape[] | null
  refusal: string | null
}

const EMPTY: EditableDoc = { viewBox: [0, 0, 1, 1], items: [] }

export function scoreTrace(
  c: CompareCase,
  truth: Truth,
  tool: string,
  svg: string,
  ms: number,
  lane: 'colour' | 'mono',
  opts: { docVisible: boolean; notes?: string },
): { row: ScoreRow; render: Raster | null } {
  const { width: w, height: h } = truth.img
  const base: ScoreRow = {
    tool,
    caseId: c.id,
    corpus: c.corpus,
    heldOut: c.heldOut,
    res: w,
    flat: !c.gradients,
    lane,
    status: 'ok',
    ms,
    notes: opts.notes,
    geomRefusal: null,
    gtRefusal: truth.refusal,
  }
  const tok = tool.startsWith('starvector') ? /(\d+) tok/.exec(opts.notes ?? '') : null
  if (tok) base.genTokens = Number(tok[1])
  const parsed = parseTraceSvg(svg, w, h)
  Object.assign(base, {
    bytes: parsed.bytes,
    gzipBytes: parsed.gzipBytes,
    normBytes: parsed.normBytes ?? undefined,
    gradientDefs: parsed.gradientDefs,
  })

  let render: Raster
  try {
    render = renderTrace(svg, w, h)
  } catch (e) {
    // Scored as SVG-Bench scores it: a blank white image. Pixel metrics only; no geometry.
    base.status = 'render-failed'
    base.error = (e as Error).message
    render = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) }
  }
  const failed = base.status === 'render-failed'

  const { meanDeltaE, p95DeltaE } = deltaEStats(deltaEField(truth.img.data, render.data, w, h).de)
  const regions = scoreRegions(truth.img, EMPTY, { inkFamilies: c.inkFamilies, render: render.data })
  if (failed)
    return {
      row: {
        ...base,
        meanDeltaE,
        p95DeltaE,
        regionsTrue: regions.trueRegions,
        regionsRecovered: regions.recovered,
        worstInk: regions.worstInk,
      },
      render,
    }
  const row: ScoreRow = {
    ...base,
    meanDeltaE,
    p95DeltaE,
    regionsTrue: regions.trueRegions,
    regionsRecovered: regions.recovered,
    worstInk: regions.worstInk,
    geomRefusal: truth.refusal ? null : parsed.refusal,
  }
  const flat = !c.gradients
  // File cost is readable even where the answer sheet is refused (stroked authored art).
  if (parsed.shimDoc) {
    row.docPaths = parsed.shimDoc.items.length
    row.docNodes = parsed.shimDoc.items.reduce(
      (n, i) => n + (i.kind === 'path' ? i.subPaths.reduce((k, sp) => k + sp.nodes.length, 0) : 0),
      0,
    )
  }

  let geom: ReturnType<typeof scoreGeometry> | null = null
  let cr: ReturnType<typeof circleRecovery> | null = null
  let bb: ReturnType<typeof scoreBorderBand> | null = null
  if (truth.shapes && parsed.shimDoc) {
    geom = scoreGeometry(
      truth.shapes,
      parsed.shimDoc,
      w,
      h,
      truth.img,
      opts.docVisible
        ? { docVisibleAt: makeVisibleAt(render), docSegsVisibleOnly: true, parsimonyBorderFree: true }
        : {},
    )
    const docSets = parsed.shimDoc.items.map((i) => (i.kind === 'path' ? i.subPaths : []))
    if (flat) {
      cr = circleRecovery(truth.shapes, docSets, w, h)
      bb = scoreBorderBand(truth.shapes, docSets, w, h, makeVisibleAt(truth.img))
    }
    // samples === 0 means there was no interior boundary to compare (bg-ramp's only outline
    // is the canvas edge): the distances are then mean([]) = 0, a perfect score for having
    // measured nothing, so they are left undefined rather than reported.
    const measured = geom.samples > 0
    Object.assign(row, {
      samples: geom.samples,
      chamfer: measured ? geom.chamfer : undefined,
      p95: measured ? geom.p95 : undefined,
      hausdorff: measured ? geom.hausdorff : undefined,
      missedMean: measured ? geom.missedMean : undefined,
      spuriousMean: measured ? geom.spuriousMean : undefined,
      parsimony: measured ? geom.parsimony : undefined,
      gtNodes: geom.gtNodes,
      docNodes: geom.docNodes,
      docPaths: geom.docPaths,
      gtCorners: geom.gtCorners,
      cornersRecovered: geom.cornersRecovered,
      cornersInvented: geom.cornersInvented,
      tangentBreaks: geom.tangentBreaks,
      circles: cr?.circles,
      circleSpread: cr && cr.circles > 0 ? cr.spread : undefined,
      // Raw anchor ratio, no length normalisation and no border rule — next to parsimony.
      nodeRatio: geom.gtNodes > 0 ? geom.docNodes / geom.gtNodes : undefined,
    })
  }

  const gates = evaluateTruthGates({
    samples: geom?.samples ?? 0,
    chamfer: geom?.chamfer ?? 0,
    p95: geom?.p95 ?? 0,
    parsimony: geom?.parsimony ?? 0,
    trueRegions: regions.trueRegions,
    recovered: regions.recovered,
    ...(geom
      ? {
          gtCorners: geom.gtCorners,
          cornersRecovered: geom.cornersRecovered,
          cornersInvented: geom.cornersInvented,
          tangentBreaks: geom.tangentBreaks,
        }
      : {}),
    ...(cr ? { circles: cr.circles, circleSpread: cr.spread } : {}),
    paintMean: meanDeltaE,
    paintP95: p95DeltaE,
    borderChamfer: bb?.chamfer,
    borderInterior: bb?.interior,
    borderSamples: bb?.n,
    worstInk: regions.worstInk,
    flatArt: flat,
    tier: c.tier,
    // --gate-exact (docVisible off) reproduces the truth gate, tier limits and all.
    tol: opts.docVisible ? TRUTH_TOL : undefined,
  })
  const applicable = gates.filter((g) => g.applicable)
  row.gatesApplicable = applicable.length
  row.gatesPassed = applicable.filter((g) => g.pass).length
  row.failedGates = applicable.filter((g) => !g.pass).map((g) => g.key)
  return { row, render }
}
