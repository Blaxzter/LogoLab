// THE analysis — the tracer scored against the art that made the pixels.
//
// Every case is an authored SVG: rasterize it (resvg — byte-identical to CI), trace it, and
// compare the recovered vectors to the art itself. Every number has a known optimum (0px boundary
// error, parsimony 1.0, every region recovered), so an improvement is visibly an improvement and
// nothing ever needs re-blessing.
//
// Why the pictures and not just the numbers: a boundary score of "26px Hausdorff" is unfalsifiable
// until you can SEE which arc it is. The miss/invented heat and dropped-region panels exist so
// every number here can be located on the image and argued with.
//
// TRUST PROPERTIES — the reason this view is worth looking at:
//   • the case lists, trace options and gates come from ../../../devtest/truthCorpus.ts — the SAME
//     module the Node runner (groundTruthRun.ts) imports;
//   • the metrics come from ../../../devtest/geomScore.ts — the SAME functions that runner calls;
//   • the rasterizer is the SAME: @resvg/resvg-wasm, the WASM build of the exact Rust engine the
//     Node runner uses via @resvg/resvg-js. Verified byte-identical (0 differing pixels).
// Nothing is re-implemented here; this file only DRAWS what those modules return.

import { useMemo } from 'react'
import { DEFAULT_VECTORIZE_OPTIONS } from '../../../lib/trace'
import { serializeDoc } from '../../../lib/path/model'
import type { EditableDoc, SubPath } from '../../../lib/path/types'
import { parseGroundTruth, toRasterSpace, unscorable } from '../../../devtest/svgGround'
import {
  scoreGeometry,
  scoreRegions,
  flattenSubPath,
  type GeomScore,
  type RegionScore,
  type DistPoint,
} from '../../../devtest/geomScore'
import { scoreDoc } from '../../../devtest/scoreboard'
import { TIER_TOL, evaluateTruthGates, inventedMaxFor } from '../../../devtest/truthCorpus'
import { Panel, RawArt } from '../Panel'
import { traceSvg, subPathsWire } from '../wire'
import { Badge, CaseRow, NoteBox } from '../CaseRow'
import { GatePanel, GateTable, type GateBarRow } from '../GateTable'
import { labImageData } from '../resvgRaster'
import { labTrace } from '../labTrace'
import { heatCss, HEAT_BG } from '../heat'
import { rgbaToUrl } from '../raster'
import type { AnalysisRowProps, WbCase } from './types'

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

/** Raster with DROPPED regions burned in red — the picture behind "5/7 recovered". */
function dropOverlay(img: ImageData, mask: Uint8Array): string {
  const px = new Uint8ClampedArray(img.data)
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4
    if (mask[i]) {
      px[o] = 240
      px[o + 1] = 20
      px[o + 2] = 40
    } else {
      px[o] = 255 - (255 - px[o]) * 0.18
      px[o + 1] = 255 - (255 - px[o + 1]) * 0.18
      px[o + 2] = 255 - (255 - px[o + 2]) * 0.18
    }
  }
  return rgbaToUrl(px, img.width, img.height)
}

/** Boundary samples as coloured dots: hot = far from the other side's boundary. */
function heatSvg(pts: DistPoint[], side: number, scale: number): string {
  const dots = pts
    .map(
      (p) =>
        `<rect x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" width="1.6" height="1.6" fill="${heatCss(p.d / scale)}"/>`,
    )
    .join('')
  return `<svg viewBox="0 0 ${side} ${side}" xmlns="http://www.w3.org/2000/svg"><rect width="${side}" height="${side}" fill="${HEAT_BG}"/>${dots}</svg>`
}

/** Authored boundary (green) over traced boundary (magenta). Where the tracer agrees they
 *  overprint; where it does not, you see one colour alone. */
function overlaySvg(gtPolys: string[], docPolys: string[], side: number): string {
  return `<svg viewBox="0 0 ${side} ${side}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${side}" height="${side}" fill="${HEAT_BG}"/>
    <g fill="none" stroke="#22c55e" stroke-width="2.4" vector-effect="non-scaling-stroke" opacity="0.95">${gtPolys.join('')}</g>
    <g fill="none" stroke="#e879f9" stroke-width="1.1" vector-effect="non-scaling-stroke" opacity="0.95">${docPolys.join('')}</g>
  </svg>`
}

const polysOf = (sets: SubPath[][]): string[] => {
  const out: string[] = []
  for (const set of sets) {
    for (const sp of set) {
      const pts = flattenSubPath(sp)
      if (pts.length < 2) continue
      const d =
        pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('') +
        (sp.closed ? 'Z' : '')
      out.push(`<path d="${d}"/>`)
    }
  }
  return out
}

export interface Analysis {
  img: ImageData
  doc: EditableDoc
  geom: GeomScore & { diagnostics: { gtPoints: DistPoint[]; docPoints: DistPoint[] } }
  regions: RegionScore
  /** Render-vs-source paint fidelity (scoreDoc), computed for gradient cases — the
   *  input of the paint gates (gradient tier 0; §10.3's radial-glow blind spot). */
  paint?: { mean: number; p95: number }
  gtPolys: string[]
  docPolys: string[]
  /** The authored SVG, as shown in the "truth" panel. */
  truthUrl: string
  /** The authored ground-truth anchors as a `.lab-wire` group — overlaid on the truth panel. */
  gtWire: string
  rasterUrl: string
  /** The traced doc as panel art: fill + baked-in nodes wireframe, revealed by `.wires`. */
  traceArt: string
  dropUrl: string
  /** The SAME glyph authored FLAT, scored the same way — the A/B control. Tier 1 only. */
  flat?: { geom: GeomScore; rasterUrl: string; traceSvgText: string; url: string }
}

/** `blocked` = the CASE cannot be scored (no valid ground truth) — NOT a tracer failure, and not
 *  a crash either, so it is a result and not an error. */
export type AnalysisResult = Analysis | { blocked: string }

interface Scored {
  img: ImageData
  doc: EditableDoc
  shapes: { subPaths: SubPath[] }[]
  geom: GeomScore & { diagnostics: { gtPoints: DistPoint[]; docPoints: DistPoint[] } }
  regions: RegionScore
}

/** Rasterize → trace → score one authored SVG against itself. Takes the MARKUP, not a URL, so it
 *  serves both the served corpora (fetched) and the bundled Logo corpus (inline). */
async function scoreSvg(
  svgText: string,
  res: number,
  gradients: boolean,
): Promise<{ ok: true; v: Scored } | { ok: false; blocked: string }> {
  const gt = parseGroundTruth(svgText)
  const why = unscorable(gt)
  if (why) return { ok: false, blocked: why }

  // resvg-wasm with background:'white' — byte-identical to the Node gate's raster, so the pixels
  // the tracer sees here ARE the pixels CI scores. No post-hoc white flatten: resvg composites
  // onto white during render, exactly as the gate does.
  const img = await labImageData('', res, svgText, { background: 'white' })
  const doc = await labTrace(img, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients })
  const shapes = toRasterSpace(gt, img.width)
  return {
    ok: true,
    v: {
      img,
      doc,
      shapes,
      geom: scoreGeometry(shapes, doc, img.width, img.height, img),
      regions: scoreRegions(img, doc),
    },
  }
}

export async function analyze(c: WbCase, res: number, ab: boolean): Promise<AnalysisResult> {
  let src
  let main: Awaited<ReturnType<typeof scoreSvg>>
  try {
    src = await c.load()
    main = await scoreSvg(src.svgText, res, c.gradients)
  } catch (e) {
    return { blocked: `source not readable (${String(e)})` }
  }
  if (!main.ok) return { blocked: main.blocked }

  const { img, doc, shapes, geom, regions } = main.v
  const docSubPaths: SubPath[][] = doc.items.flatMap((i) => (i.kind === 'path' ? [i.subPaths] : []))

  // The A/B control: the same glyph, authored flat, traced with gradients OFF (each variant gets
  // the setting its own art calls for). Doubles the cost of the row, so it is opt-in.
  let flat: Analysis['flat']
  if (ab && c.flatSvg) {
    const url = `/${c.flatSvg.replace(/^public\//, '')}`
    try {
      const resp = await fetch(url)
      if (resp.ok) {
        const f = await scoreSvg(await resp.text(), res, false)
        if (f.ok) {
          flat = {
            geom: f.v.geom,
            rasterUrl: rgbaToUrl(f.v.img.data, f.v.img.width, f.v.img.height),
            traceSvgText: serializeDoc(f.v.doc),
            url,
          }
        }
      }
    } catch {
      // A missing flat twin is not a scoring failure — the case still stands on its own.
    }
  }

  // Paint fidelity for gradient cases: render the trace and score the pixels. The
  // SAME scoreDoc the Node gate uses — the lab must show the number CI gates on.
  let paint: Analysis['paint']
  if (c.gradients) {
    const p = scoreDoc(img, doc)
    paint = { mean: p.meanDeltaE, p95: p.p95DeltaE }
  }

  return {
    img,
    doc,
    geom,
    regions,
    paint,
    gtPolys: polysOf(shapes.map((s) => s.subPaths)),
    docPolys: polysOf(docSubPaths),
    truthUrl: src.displayUrl,
    gtWire: subPathsWire(shapes.map((s) => s.subPaths)),
    rasterUrl: rgbaToUrl(img.data, img.width, img.height),
    traceArt: traceSvg(doc, img.width, img.height),
    dropUrl: c.gradients ? '' : dropOverlay(img, regions.dropMask),
    flat,
  }
}

/** The gates, as bar rows. `applicable: false` ⇒ tone 'na' — never a pass. Only ever called for a
 *  case with a calibrated tier; an untiered case has no honest limit to draw. */
function gateRows(name: string, tier: 0 | 1 | 2, gradients: boolean, geom: GeomScore, regions: RegionScore, paint?: { mean: number; p95: number }): GateBarRow[] {
  return evaluateTruthGates({
    samples: geom.samples,
    chamfer: geom.chamfer,
    p95: geom.p95,
    parsimony: geom.parsimony,
    trueRegions: regions.trueRegions,
    recovered: regions.recovered,
    gtCorners: geom.gtCorners,
    cornersRecovered: geom.cornersRecovered,
    // §23's precision term. Recall alone made INVENTING a corner free — see the gate's own
    // note in truthCorpus. Passed here so the view shows the same number CI gates on.
    cornersInvented: geom.cornersInvented,
    inventedMax: inventedMaxFor(name),
    paintMean: paint?.mean,
    paintP95: paint?.p95,
    worstInk: regions.worstInk,
    flatArt: !gradients,
    // Per-tier tolerances: tier 1 is soft-edged gradient art and is NOT gradeable at the
    // thresholds tier 0's crisp flat art was calibrated on. The limit shown is whichever one
    // actually applied, so a green bar can never mean "we quietly widened it".
    tier,
  }).map((g): GateBarRow => {
    if (!g.applicable) {
      return {
        key: g.key,
        label: g.label,
        tone: 'na',
        cells: [g.rule, 'n/a'],
        fill: null,
        emptyLabel: 'nothing to measure',
        head: 'n/a',
        why:
          g.key === 'regions'
            ? 'gradient art — a flat-region count here is a quantisation artifact, not a region count'
            : g.key === 'ink'
              ? 'gradient art — ink area per flat region is meaningless where the art has no flat regions'
              : g.key === 'corners'
              ? 'too few authored corners to grade (mostly-round art), or gradient art'
              : g.key === 'invented'
              ? 'gradient art — its traced corners belong to the posterization banding, not to the authored outline'
              : g.key === 'paintMean' || g.key === 'paintP95'
                ? 'flat art (regions + boundary already pin the paint), or tier-1 paint not yet calibrated'
                : "no interior boundary to compare (the art's whole outline is the canvas border)",
      }
    }
    const tone = !g.pass ? 'fail' : g.headroom < 0.25 ? 'tight' : g.headroom < 0.5 ? 'warn' : 'ok'
    const left = clamp01(g.headroom)
    const isPaint = g.key === 'paintMean' || g.key === 'paintP95'
    const shown =
      g.key === 'regions'
        ? `${regions.recovered}/${regions.trueRegions}`
        : g.key === 'corners'
          ? `${geom.cornersRecovered}/${geom.gtCorners}`
          : g.key === 'invented'
            ? `${geom.cornersInvented}`
          : g.key === 'ink'
            ? `${(g.value * 100).toFixed(0)}%`
            : g.value.toFixed(g.digits) + (g.key === 'parsimony' ? '×' : isPaint ? 'ΔE' : 'px')
    const unit =
      g.key === 'parsimony'
        ? '×'
        : g.key === 'regions' || g.key === 'corners' || g.key === 'ink' || g.key === 'invented'
          ? ''
          : isPaint
            ? 'ΔE'
            : 'px'
    return {
      key: g.key,
      label: g.label,
      tone,
      cells: [`${g.rule}${unit}`, shown],
      fill: left,
      head: g.pass ? `${Math.round(left * 100)}% left` : 'FAIL',
    }
  })
}

function Swatch({ hex }: { hex: string }) {
  return (
    <code
      className="rounded px-1.5 py-px text-white [text-shadow:0_0_2px_#000]"
      style={{ background: hex }}
    >
      {hex}
    </code>
  )
}

function CasePanels({ c, a, heat }: { c: WbCase; a: Analysis; heat: number }) {
  const side = a.img.width
  const flatArt = !c.gradients
  const { geom, regions } = a
  // The heat panels are pure rendering of `geom.diagnostics` — changing the scale recolours them,
  // it does not re-trace.
  const missHeat = useMemo(
    () => (geom.samples > 0 ? heatSvg(geom.diagnostics.gtPoints, side, heat) : ''),
    [geom, side, heat],
  )
  const inventedHeat = useMemo(
    () => (geom.samples > 0 ? heatSvg(geom.diagnostics.docPoints, side, heat) : ''),
    [geom, side, heat],
  )
  const overlay = useMemo(() => overlaySvg(a.gtPolys, a.docPolys, side), [a.gtPolys, a.docPolys, side])
  const aspect = a.img.width / a.img.height
  const sideH = a.img.height
  // The truth panel is a raster (an <img>), so its wireframe can't be baked into it the way the
  // trace's is. Instead compose one SVG that embeds the authored art and lays the `.lab-wire`
  // group over it — same viewBox, so the anchors sit exactly on the drawing. `.lab-fill` dims the
  // art (not the wires) under `.wires`, matching the trace panel; with the toggle off it renders
  // exactly like the plain <img> did.
  const truthArt = useMemo(
    () =>
      `<svg viewBox="0 0 ${side} ${sideH}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">` +
      `<g class="lab-fill"><image href="${a.truthUrl}" x="0" y="0" width="${side}" height="${sideH}" preserveAspectRatio="xMidYMid meet"/></g>` +
      `${a.gtWire}</svg>`,
    [a.truthUrl, a.gtWire, side, sideH],
  )

  return (
    <>
      <Panel label="truth" note="the authored SVG — the answer sheet" aspect={aspect}>
        <RawArt html={truthArt} />
      </Panel>
      <Panel label="raster input" note={`what the tracer is handed @ ${side}px`} aspect={aspect} pixelated>
        <img src={a.rasterUrl} alt="" />
      </Panel>
      <Panel label="current trace" note={`${geom.docPaths} paths · ${geom.docNodes} nodes`} aspect={aspect}>
        <RawArt html={a.traceArt} />
      </Panel>
      <Panel label="boundary overlay" note="green = authored · magenta = traced" aspect={aspect} dark>
        <RawArt html={overlay} />
      </Panel>
      {/* Boundary heat is meaningless when there was no interior boundary to sample. */}
      {geom.samples > 0 && (
        <>
          <Panel label="miss heat" note={`authored boundary, hot = tracer MISSED it (0→${heat}px)`} aspect={aspect} dark>
            <RawArt html={missHeat} />
          </Panel>
          <Panel label="invented heat" note={`traced boundary, hot = tracer INVENTED it (0→${heat}px)`} aspect={aspect} dark>
            <RawArt html={inventedHeat} />
          </Panel>
        </>
      )}
      {/* Region recovery is flat-art-only — on a gradient the "regions" are quantisation bands. */}
      {flatArt && (
        <Panel
          label="dropped regions"
          note={`${regions.recovered}/${regions.trueRegions} recovered · red = a region the art has and the trace does not`}
          aspect={aspect}
          pixelated
        >
          <img src={a.dropUrl} alt="" />
        </Panel>
      )}
      {a.flat && (
        <>
          <Panel label="flat twin — truth" note="the same glyph, authored flat" aspect={aspect}>
            <img src={a.flat.url} alt="" />
          </Panel>
          <Panel
            label="flat twin — trace"
            note={`${a.flat.geom.docPaths} paths · invented ${a.flat.geom.spuriousMean.toFixed(2)}px (vs ${geom.spuriousMean.toFixed(2)}px on the gradient)`}
            aspect={aspect}
          >
            <RawArt html={a.flat.traceSvgText} />
          </Panel>
        </>
      )}
    </>
  )
}

/** Tier-1 flat↔gradient A/B: the same glyph authored flat, scored identically. */
function AbDelta({ a }: { a: Analysis }) {
  if (!a.flat) return null
  const g = a.geom
  const f = a.flat.geom
  const d = (x: number, y: number) => {
    const v = x - y
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}px`
  }
  return (
    <NoteBox tone="info">
      <b>flat ↔ gradient A/B.</b> The same glyph, authored flat and scored identically:
      <br />
      boundary <b>{g.chamfer.toFixed(2)}px</b> gradient vs <b>{f.chamfer.toFixed(2)}px</b> flat (
      {d(g.chamfer, f.chamfer)}) · missed {g.missedMean.toFixed(2)} vs {f.missedMean.toFixed(2)} (
      {d(g.missedMean, f.missedMean)}) · <b>invented</b> {g.spuriousMean.toFixed(2)} vs{' '}
      {f.spuriousMean.toFixed(2)} ({d(g.spuriousMean, f.spuriousMean)})
      <br />
      <span className="text-faint">
        Flat is a separately AUTHORED drawing, not this art with the gradients deleted — usually
        simpler ({f.gtShapes} shapes vs {g.gtShapes}). A matched pair, not an ablation: the direction
        is solid, the magnitude is an upper bound.
      </span>
    </NoteBox>
  )
}

function Drops({ c, regions }: { c: WbCase; regions: RegionScore }) {
  if (c.gradients || regions.missing.length === 0) return null
  return (
    <NoteBox tone="bad">
      {regions.missing.map((m) => (
        <div key={m.hex + m.areaPx}>
          ✗ the art has <Swatch hex={m.hex} /> ({m.areaPx}px) — the trace paints{' '}
          {m.paintedHex === '—' ? <b>nothing</b> : <Swatch hex={m.paintedHex} />} there instead, ΔE{' '}
          {m.deltaE.toFixed(1)}
        </div>
      ))}
    </NoteBox>
  )
}

function Ungated({ geom }: { geom: GeomScore }) {
  return (
    <NoteBox tone="info">
      authored {geom.gtShapes} shapes / {geom.gtNodes} nodes · traced {geom.docPaths} paths /{' '}
      {geom.docNodes} nodes · boundary {geom.gtLength.toFixed(0)}px vs {geom.docLength.toFixed(0)}px ·
      missed {geom.missedMean.toFixed(2)}px (max {geom.missedMax.toFixed(1)}) · invented{' '}
      {geom.spuriousMean.toFixed(2)}px (max {geom.spuriousMax.toFixed(1)}) · hausdorff{' '}
      {geom.hausdorff.toFixed(1)}px
      <br />
      <span className="text-faint">
        Shape and path counts need not match: compositing splits one authored shape into several
        visible regions, and regions sharing a fill merge into one path. That is why the gates score
        boundary geometry and region recovery, not counts.
      </span>
    </NoteBox>
  )
}

/** One case, analysed. Gates render only for a case with a calibrated tier. */
export function AnalysisCaseRow({ c, value, error, heat }: AnalysisRowProps) {
  const a = value as AnalysisResult | undefined
  if (!a || 'blocked' in a) {
    const why = a ? a.blocked : `failed to render — ${error}`
    return (
      <CaseRow title={c.title} note={c.note}>
        <NoteBox tone="bad">
          <b>Not scorable — no valid ground truth.</b> {why}.
          <br />
          The tracer is not at fault here; the CASE cannot be scored against its own art.
        </NoteBox>
      </CaseRow>
    )
  }
  const rows = c.tier !== undefined ? gateRows(c.key, c.tier, c.gradients, a.geom, a.regions, a.paint) : null
  const failing = rows?.filter((r) => r.tone === 'fail') ?? []
  return (
    <CaseRow
      title={c.title}
      note={c.note}
      badges={
        <>
          {c.tier !== undefined ? (
            <Badge tone={c.tier === 0 ? 'neutral' : 'accent'}>
              tier {c.tier} · limits {TIER_TOL[c.tier].chamfer}/{TIER_TOL[c.tier].p95}px
            </Badge>
          ) : (
            // No calibrated population ⇒ no honest pass/fail. Say so rather than borrowing
            // another tier's limits and printing a green bar that means nothing.
            <Badge tone="neutral">uncalibrated · no tier limits</Badge>
          )}
          {failing.length > 0 && <Badge tone="bad">{failing.map((r) => r.label).join(', ')}</Badge>}
        </>
      }
      footer={
        <GatePanel>
          {rows ? (
            <GateTable columns={['limit', 'value']} barLabel="headroom" rows={rows} />
          ) : (
            <NoteBox tone="info">
              <b>No gates on this corpus.</b> The tier limits are calibrated per population (see{' '}
              <code>calibrateTier1.ts</code> / <code>calibrateTier2.ts</code>); this case belongs to
              none of them, so it gets the measurements below and no pass/fail — a bar borrowed from
              another tier would be a number pretending to be a verdict.
            </NoteBox>
          )}
          <AbDelta a={a} />
          <Drops c={c} regions={a.regions} />
          <Ungated geom={a.geom} />
        </GatePanel>
      }
    >
      <CasePanels c={c} a={a} heat={heat} />
    </CaseRow>
  )
}
