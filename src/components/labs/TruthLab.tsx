// Ground-truth review — the tracer scored against THE ART THAT MADE THE PIXELS.
//
// The sibling lab (Golden corpus) compares the tracer to its own previous output. That
// answers "did anything change". It cannot answer "is this correct", and its ±12% count
// bands actively forbid large improvements. This one answers "is this correct": every case
// is an authored SVG, which we rasterize, trace, and score against the art. Every number has
// a known optimum (0px boundary error, parsimony 1.0, every region recovered), so an
// improvement is visibly an improvement and nothing ever needs re-blessing.
//
// Why the pictures and not just the numbers: a boundary score of "26px Hausdorff" is
// unfalsifiable until you can SEE which arc it is. The miss-heat and dropped-region panels
// exist so every number here can be located on the image and argued with.
//
// TRUST PROPERTIES — the reason this view is worth looking at:
//   • the case list, trace options and gates come from ./truthCorpus.ts — the SAME module
//     the Node runner (src/devtest/groundTruthRun.ts) imports, so it cannot silently score
//     something else;
//   • the metrics come from ./geomScore.ts — the SAME functions the Node runner calls.
//     Nothing is re-implemented here; this file only DRAWS what those modules return.
//   • the ONE difference is the rasterizer: the browser rasterizes the SVG with canvas, the
//     Node runner uses resvg. Anti-aliasing differs slightly, so numbers here can differ
//     from the CLI in the last decimal. It is stated in the header, not hidden.

import { useMemo } from 'react'
import { getImageData } from '../../lib/image'
import { DEFAULT_VECTORIZE_OPTIONS } from '../../lib/trace'
import { serializeDoc } from '../../lib/path/model'
import type { EditableDoc, SubPath } from '../../lib/path/types'
import { parseGroundTruth, toRasterSpace, unscorable } from '../../devtest/svgGround'
import {
  scoreGeometry,
  scoreRegions,
  flattenSubPath,
  type GeomScore,
  type RegionScore,
  type DistPoint,
} from '../../devtest/geomScore'
import {
  TRUTH_CORPUS,
  TRUTH_RESOLUTIONS,
  TIER_TOL,
  evaluateTruthGates,
  truthUrl,
  type TruthCase,
} from '../../devtest/truthCorpus'
import { LabPage, LabSelect, LabCheck, LabField } from './LabPage'
import { Panel, RawArt } from './Panel'
import { Badge, CaseRow, NoteBox, PendingRow } from './CaseRow'
import { GatePanel, GateTable, type GateBarRow } from './GateTable'
import { useLabState } from './useLabState'
import { useLabRun } from './useLabRun'
import { labTrace } from './labTrace'
import { heatCss, HEAT_BG } from './heat'
import { rgbaToUrl } from './raster'

const HEAT_SCALES = [1, 2, 5, 10, 25]

/**
 * PAGING, and why the page is not just a long list.
 *
 * Tracing is 1–3 seconds per case ON TOP of scoring, and the corpus is now 231 cases (16
 * handcrafted + 109 Fluent Emoji Color + 106 Fluent flat twins). Rendering them as one flat
 * list would mean a wall of spinners before the page settled — the old 16-case list already
 * took 1–2 minutes.
 *
 * Row-level lazy tracing (trace when the row scrolls into view) was the obvious alternative
 * and is worse here: it makes scrolling itself expensive and unpredictable, and you still pay
 * for every row you scroll past. A page bounds the work EXPLICITLY — you choose how much you
 * are asking for, and `useLabRun` still yields between cases so finished rows paint as they
 * land.
 */
const PAGE_SIZES = [4, 8, 16, 32]

/** Which slice of the corpus to run. Anything but "all" keeps a page cheap. */
type Scope = 'tier0' | 'tier1' | 'tier2' | 'gated' | 'all'
const SCOPES: { value: Scope; label: string }[] = [
  { value: 'tier0', label: 'Tier 0 — handcrafted' },
  { value: 'tier1', label: 'Tier 1 — Fluent gradients' },
  { value: 'tier2', label: 'Tier 2 — Fluent flat twins' },
  { value: 'gated', label: 'Gated (what CI runs)' },
  { value: 'all', label: 'All tiers' },
]

const scopeCases = (s: Scope): TruthCase[] =>
  s === 'tier0' ? TRUTH_CORPUS.filter((c) => c.tier === 0)
  : s === 'tier1' ? TRUTH_CORPUS.filter((c) => c.tier === 1)
  : s === 'tier2' ? TRUTH_CORPUS.filter((c) => c.tier === 2)
  : s === 'gated' ? TRUTH_CORPUS.filter((c) => c.gated ?? c.tier === 0)
  : TRUTH_CORPUS

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

interface Analysis {
  img: ImageData
  doc: EditableDoc
  geom: GeomScore & { diagnostics: { gtPoints: DistPoint[]; docPoints: DistPoint[] } }
  regions: RegionScore
  gtPolys: string[]
  docPolys: string[]
  rasterUrl: string
  traceSvgText: string
  dropUrl: string
  /** The SAME glyph authored FLAT, scored the same way — the A/B control. Tier 1 only. */
  flat?: { geom: GeomScore; rasterUrl: string; traceSvgText: string; url: string }
}

/** `blocked` = the CASE cannot be scored (no valid ground truth) — NOT a tracer failure, and
 *  not a crash either, so it is a result and not an error. */
type TruthResult = Analysis | { blocked: string }

interface Scored {
  img: ImageData
  doc: EditableDoc
  shapes: { subPaths: SubPath[] }[]
  geom: GeomScore & { diagnostics: { gtPoints: DistPoint[]; docPoints: DistPoint[] } }
  regions: RegionScore
}

/**
 * Flatten onto WHITE, in place.
 *
 * The Node runner rasterizes with resvg `background: 'white'`; the browser's canvas draws an
 * SVG onto a TRANSPARENT bitmap. Most corpus art has no background rect of its own (bloom does
 * not; every Fluent Emoji glyph does not), so without this the two consumers hand the tracer
 * genuinely different pixels — transparent-black where the other has white — and then compare
 * the results as if they were the same experiment.
 *
 * It is not a rounding difference. It moves the SEGMENTATION: browser-bloom recovered 3 of its
 * 7 regions where the CLI recovered 5, and that gap was mistaken for a real (and much worse)
 * tracer defect. The lab's whole claim is "what you see is what CI measures", so the raster has
 * to match first.
 */
function flattenOnWhite(img: ImageData): ImageData {
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]
    if (a === 255) continue
    const k = a / 255
    d[i] = Math.round(d[i] * k + 255 * (1 - k))
    d[i + 1] = Math.round(d[i + 1] * k + 255 * (1 - k))
    d[i + 2] = Math.round(d[i + 2] * k + 255 * (1 - k))
    d[i + 3] = 255
  }
  return img
}

/** Fetch → rasterize → trace → score one authored SVG against itself. */
async function scoreOne(
  url: string,
  res: number,
  gradients: boolean,
): Promise<{ ok: true; v: Scored } | { ok: false; blocked: string }> {
  const resp = await fetch(url)
  if (!resp.ok) return { ok: false, blocked: `source not served (HTTP ${resp.status} for ${url})` }
  const svgText = await resp.text()
  const gt = parseGroundTruth(svgText)
  const why = unscorable(gt)
  if (why) return { ok: false, blocked: why }

  const img = flattenOnWhite(await getImageData(url, res, svgText))
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

async function analyze(c: TruthCase, res: number, ab: boolean): Promise<TruthResult> {
  let main: Awaited<ReturnType<typeof scoreOne>>
  try {
    main = await scoreOne(truthUrl(c), res, c.gradients)
  } catch (e) {
    return { blocked: `source not served (${String(e)})` }
  }
  if (!main.ok) return { blocked: main.blocked }

  const { img, doc, shapes, geom, regions } = main.v
  const docSubPaths: SubPath[][] = doc.items.flatMap((i) => (i.kind === 'path' ? [i.subPaths] : []))

  // The A/B control: the same glyph, authored flat, traced with gradients OFF (each variant
  // gets the setting its own art calls for). Doubles the cost of the row, so it is opt-in.
  let flat: Analysis['flat']
  if (ab && c.flatSvg) {
    const url = `/${c.flatSvg.replace(/^public\//, '')}`
    try {
      const f = await scoreOne(url, res, false)
      if (f.ok) {
        flat = {
          geom: f.v.geom,
          rasterUrl: rgbaToUrl(f.v.img.data, f.v.img.width, f.v.img.height),
          traceSvgText: serializeDoc(f.v.doc),
          url,
        }
      }
    } catch {
      // A missing flat twin is not a scoring failure — the case still stands on its own.
    }
  }

  return {
    img,
    doc,
    geom,
    regions,
    gtPolys: polysOf(shapes.map((s) => s.subPaths)),
    docPolys: polysOf(docSubPaths),
    rasterUrl: rgbaToUrl(img.data, img.width, img.height),
    traceSvgText: serializeDoc(doc),
    dropUrl: c.gradients ? '' : dropOverlay(img, regions.dropMask),
    flat,
  }
}

/** The gates, as bar rows. `applicable: false` ⇒ tone 'na' — never a pass. */
function gateRows(c: TruthCase, geom: GeomScore, regions: RegionScore): GateBarRow[] {
  const flatArt = !c.gradients
  return evaluateTruthGates({
    samples: geom.samples,
    chamfer: geom.chamfer,
    p95: geom.p95,
    parsimony: geom.parsimony,
    trueRegions: regions.trueRegions,
    recovered: regions.recovered,
    flatArt,
    // Per-tier tolerances: tier 1 is soft-edged gradient art and is NOT gradeable at the
    // thresholds tier 0's crisp flat art was calibrated on. The limit shown in the table is
    // whichever one actually applied, so a green bar can never mean "we quietly widened it".
    tier: c.tier,
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
            : "no interior boundary to compare (the art's whole outline is the canvas border)",
      }
    }
    const tone = !g.pass ? 'fail' : g.headroom < 0.25 ? 'tight' : g.headroom < 0.5 ? 'warn' : 'ok'
    const left = clamp01(g.headroom)
    const shown =
      g.key === 'regions'
        ? `${regions.recovered}/${regions.trueRegions}`
        : g.value.toFixed(g.digits) + (g.key === 'parsimony' ? '×' : 'px')
    const unit = g.key === 'parsimony' ? '×' : g.key === 'regions' ? '' : 'px'
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

function TruthCasePanels({
  c,
  a,
  heat,
}: {
  c: TruthCase
  a: Analysis
  heat: number
}) {
  const side = a.img.width
  const flatArt = !c.gradients
  const { geom, regions } = a
  // The heat panels are pure rendering of `geom.diagnostics` — changing the scale
  // recolours them, it does not re-trace. (The vanilla page re-traced the corpus.)
  const missHeat = useMemo(
    () => (geom.samples > 0 ? heatSvg(geom.diagnostics.gtPoints, side, heat) : ''),
    [geom, side, heat],
  )
  const inventedHeat = useMemo(
    () => (geom.samples > 0 ? heatSvg(geom.diagnostics.docPoints, side, heat) : ''),
    [geom, side, heat],
  )
  const overlay = useMemo(() => overlaySvg(a.gtPolys, a.docPolys, side), [a.gtPolys, a.docPolys, side])
  // The raster is square by construction (the corpus rasterizes at res × res), but take the
  // shape from the pixels rather than assuming it.
  const aspect = a.img.width / a.img.height

  return (
    <>
      <Panel
        label="truth"
        note="the authored SVG — the answer sheet"
        aspect={aspect}
      >
        <img src={truthUrl(c)} alt="" />
      </Panel>
      <Panel
        label="raster input"
        note={`what the tracer is handed @ ${side}px`}
        aspect={aspect}
        pixelated
      >
        <img src={a.rasterUrl} alt="" />
      </Panel>
      <Panel
        label="current trace"
        note={`${geom.docPaths} paths · ${geom.docNodes} nodes`}
        aspect={aspect}
      >
        <RawArt html={a.traceSvgText} />
      </Panel>
      <Panel label="boundary overlay" note="green = authored · magenta = traced" aspect={aspect} dark>
        <RawArt html={overlay} />
      </Panel>
      {/* Boundary heat is meaningless when there was no interior boundary to sample. */}
      {geom.samples > 0 && (
        <>
          <Panel
            label="miss heat"
            note={`authored boundary, hot = tracer MISSED it (0→${heat}px)`}
            aspect={aspect}
            dark
          >
            <RawArt html={missHeat} />
          </Panel>
          <Panel
            label="invented heat"
            note={`traced boundary, hot = tracer INVENTED it (0→${heat}px)`}
            aspect={aspect}
            dark
          >
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
      {/* The A/B control: the same glyph the artist drew FLAT. Put the two traces side by side
          and the gradient-banding defect is visible without reading a single number. */}
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

export default function TruthLab() {
  const [ui, setUi] = useLabState('lab:truth', {
    box: 260,
    res: 512,
    heat: 5,
    scope: 'tier0' as Scope,
    page: 0,
    pageSize: 8,
    ab: false,
  })

  const all = useMemo(() => scopeCases(ui.scope), [ui.scope])
  const pages = Math.max(1, Math.ceil(all.length / ui.pageSize))
  // Changing the scope or the page size can strand you past the end.
  const page = Math.min(ui.page, pages - 1)
  const cases = useMemo(
    () => all.slice(page * ui.pageSize, page * ui.pageSize + ui.pageSize),
    [all, page, ui.pageSize],
  )

  const run = useLabRun(cases, (c) => analyze(c, ui.res, ui.ab), {
    label: (c) => `Tracing ${c.name} @ ${ui.res}px`,
    done: () =>
      `${cases.length} of ${all.length} cases · page ${page + 1}/${pages} @ ${ui.res}px. ` +
      `Nothing here reads or writes trace-baseline.json — every number is measured against the authored SVG.`,
    deps: [ui.res, ui.scope, page, ui.pageSize, ui.ab],
  })

  return (
    <LabPage
      storageKey="lab:truth"
      title="Ground truth"
      subtitle="Scored against the authored SVG: boundary error, node economy, dropped regions"
      status={run.status}
      running={run.running}
      box={ui.box}
      onBox={(box) => setUi({ box })}
      controls={
        <>
          <LabSelect
            label="Set"
            value={ui.scope}
            onChange={(scope) => setUi({ scope, page: 0 })}
            options={SCOPES}
          />
          <LabField label="Page">
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                className="btn btn-ghost h-7 px-2 text-xs disabled:opacity-40"
                disabled={page <= 0}
                onClick={() => setUi({ page: page - 1 })}
              >
                ‹
              </button>
              <span className="tabular-nums whitespace-nowrap text-[0.7rem] text-ink">
                {page + 1}/{pages}
              </span>
              <button
                type="button"
                className="btn btn-ghost h-7 px-2 text-xs disabled:opacity-40"
                disabled={page >= pages - 1}
                onClick={() => setUi({ page: page + 1 })}
              >
                ›
              </button>
            </div>
          </LabField>
          <LabSelect
            label="Per page"
            value={ui.pageSize}
            onChange={(pageSize) => setUi({ pageSize, page: 0 })}
            options={PAGE_SIZES.map((n) => ({ value: n, label: String(n) }))}
          />
          <LabSelect
            label="Raster"
            value={ui.res}
            onChange={(res) => setUi({ res })}
            options={TRUTH_RESOLUTIONS.map((r) => ({ value: r, label: `${r}px` }))}
          />
          <LabSelect
            label="Heat"
            value={ui.heat}
            onChange={(heat) => setUi({ heat })}
            options={HEAT_SCALES.map((s) => ({ value: s, label: `0 → ${s}px` }))}
          />
          <LabCheck label="flat A/B" checked={ui.ab} onChange={(ab) => setUi({ ab })} />
        </>
      }
      about={<TruthAbout />}
    >
      {run.results.map(({ case: c, value: a, error }, i) => {
        if (!a || 'blocked' in a) {
          const why = a ? a.blocked : `failed to render — ${error}`
          return (
            <CaseRow key={c.name} title={c.name} note={c.note}>
              <NoteBox tone="bad">
                <b>Not scorable — no valid ground truth.</b> {why}.
                <br />
                The tracer is not at fault here; the CASE cannot currently be scored. Re-author it with
                filled shapes (see <code>src/devtest/genEdgeCases.ts</code>) to bring it into the gate.
              </NoteBox>
            </CaseRow>
          )
        }
        const rows = gateRows(c, a.geom, a.regions)
        const failing = rows.filter((r) => r.tone === 'fail')
        return (
          <CaseRow
            key={c.name}
            title={c.name}
            note={c.note}
            badges={
              <>
                <Badge tone={c.tier === 0 ? 'neutral' : 'accent'}>
                  tier {c.tier} · limits {TIER_TOL[c.tier].chamfer}/{TIER_TOL[c.tier].p95}px
                </Badge>
                {failing.length > 0 && (
                  <Badge tone="bad">{failing.map((r) => r.label).join(', ')}</Badge>
                )}
              </>
            }
            footer={
              <GatePanel>
                <GateTable columns={['limit', 'value']} barLabel="headroom" rows={rows} />
                <AbDelta a={a} />
                <Drops c={c} regions={a.regions} />
                <Ungated geom={a.geom} />
              </GatePanel>
            }
          >
            <TruthCasePanels c={c} a={a} heat={ui.heat} />
          </CaseRow>
        )
      })}
      {run.pending && <PendingRow title={run.pending.name} note={run.pending.note} />}
    </LabPage>
  )
}

/**
 * The tier-1 experiment, per row: the SAME glyph authored flat, scored the same way.
 *
 * Across all 106 matched pairs the tracer INVENTS 10.8× more boundary on gradient art than on
 * flat art (2.26px vs 0.21px) while MISSING only 1.4× more. It finds the authored silhouette
 * fine — it hallucinates edges inside the gradient. This row is where you can see that happen
 * on one glyph instead of taking the corpus mean on faith.
 */
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
        simpler ({f.gtShapes} shapes vs {g.gtShapes}). A matched pair, not an ablation: the
        direction is solid, the magnitude is an upper bound.
      </span>
    </NoteBox>
  )
}

function Drops({ c, regions }: { c: TruthCase; regions: RegionScore }) {
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

function TruthAbout() {
  return (
    <>
      <p className="mb-2 max-w-[96ch]">
        The sibling lab (<b>Golden corpus</b>) compares the tracer to its own previous output. That
        catches drift, but it has no notion of <em>correct</em> — and its ±12% count bands actively
        forbid big improvements. This page scores against the{' '}
        <b>authored SVG that produced the pixels</b>: each case is rasterized, traced, and the
        recovered vectors are compared to the art itself. Every gate is an absolute distance from
        correct (<b>0px boundary error, parsimony 1.0, every region recovered</b>), so improvements
        move numbers down and nothing ever needs re-blessing. Nothing here reads or writes{' '}
        <code>test/golden/trace-baseline.json</code>.
      </p>
      <p className="mb-2 max-w-[96ch]">
        <b>Three tiers, three sets of limits.</b> <b>Tier 0</b> is our 16 handcrafted cases, each
        isolating a named failure mode of this tracer. <b>Tier 1</b> is 109 Microsoft{' '}
        <b>Fluent Emoji "Color"</b> glyphs (MIT) — authored multi-stop gradient art, the only
        ground truth of its kind that exists. <b>Tier 2</b> is the same glyphs' 106 <b>Flat</b>{' '}
        variants scored in their own right — flat multi-region art is what the product traces, and
        it is where the zero-tolerance <b>regions recovered</b> gate actually runs (it is
        inapplicable on every gradient case). The tiers are <em>not</em> graded at the same
        thresholds: tier 0's limits (chamfer {TIER_TOL[0].chamfer}px / p95 {TIER_TOL[0].p95}px)
        were calibrated on crisp flat art, soft-edged gradient art is not gradeable there, and each
        tier's limits are measured on its own population (tier 1: {TIER_TOL[1].chamfer}px /{' '}
        {TIER_TOL[1].p95}px; tier 2: {TIER_TOL[2].chamfer}px / {TIER_TOL[2].p95}px). Each row's
        badge says which limit it was actually held to — a green bar here can never mean "we
        quietly widened tier 0".
      </p>
      <p className="mb-2 max-w-[96ch]">
        Tier 1's limits are <b>"do not get worse" numbers, not "this is correct" numbers</b>. The
        tracer finds the authored silhouette on gradient art well (sub-pixel on 45 of 109 cases) but{' '}
        <b>invents interior boundary</b> that the art does not contain — it bands a smooth stack of
        translucent gradients into regions. Turn on <b>flat A/B</b> to see it: the same glyph
        authored flat, traced and scored identically. Across all 106 matched pairs the tracer
        invents <b>10.8× more</b> boundary on the gradient variant (2.26px vs 0.21px) while missing
        only 1.4× more. That is the tier-1 work item.
      </p>
      <p className="mb-2 max-w-[96ch]">
        The corpus is 231 cases and each takes seconds to trace, so the page runs <b>one page at a
        time</b> — pick the <b>Set</b> and the page size. "Gated" is the subset CI actually runs
        (<code>test/truth-gate.test.ts</code>).
      </p>
      <p className="mb-2 max-w-[96ch]">
        Drag any box to <b>pan</b>, wheel (or pinch) to <b>zoom</b>; every box moves together, so you
        can pin one detail across the truth, the trace and the error maps at once.
      </p>
      <div className="mt-2 flex flex-wrap gap-4 border-t border-dashed border-line pt-2 text-[0.68rem]">
        <div className="max-w-[32ch]">
          <b className="text-ink">truth</b> — the authored SVG. The answer sheet, not another guess.
        </div>
        <div className="max-w-[32ch]">
          <b className="text-ink">raster input</b> — the SVG rasterized at the chosen size; the only
          thing the tracer sees. Changing the raster size and watching the numbers stay flat is the{' '}
          <b>scale-stability</b> check.
        </div>
        <div className="max-w-[32ch]">
          <b className="text-ink">boundary overlay</b> — authored boundary in{' '}
          <span className="font-bold text-[#16a34a]">green</span>, traced in{' '}
          <span className="font-bold text-[#c026d3]">magenta</span>. Where the tracer is right they
          overprint; where it is wrong you see one colour alone.
        </div>
        <div className="max-w-[32ch]">
          <b className="text-ink">miss heat</b> — the VISIBLE authored boundary, coloured by how
          far the nearest traced boundary is. <span className="lab-ramp" /> Hot = the tracer{' '}
          <b>missed</b> that arc. Authored outline occluded behind later-painted shapes is
          excluded — no tracer can recover an edge that made no pixels (§9.6).
        </div>
        <div className="max-w-[32ch]">
          <b className="text-ink">invented heat</b> — the traced boundary, coloured by distance to
          the nearest authored boundary. Hot = the tracer <b>invented</b> an edge the art does not
          have.
        </div>
        <div className="max-w-[32ch]">
          <b className="text-ink">dropped regions</b> — red marks a flat region the composited art
          contains and the trace does not. This is the failure raster fidelity is blind to: merging a
          small low-contrast region into its neighbour barely moves ΔE or SSIM while destroying the
          topology.
        </div>
      </div>
      <div className="mt-2 max-w-[96ch] rounded-md border border-warn/30 bg-warn/8 px-2.5 py-1.5 text-warn">
        <b>Rasterizer note.</b> This page rasterizes the SVG with the <em>browser canvas</em>; the
        Node runner (<code>src/devtest/groundTruthRun.ts</code>) uses <em>resvg</em>. Anti-aliasing
        differs slightly between them, so numbers here can differ from the CLI in the last decimal.
        The corpus, the trace options, the gates and the scoring functions are the same modules in
        both (<code>truthCorpus.ts</code>, <code>geomScore.ts</code>).
        <br />
        Both now rasterize onto <b>white</b>. They did not always: resvg composited on white while
        the canvas drew onto transparency, and since most of the corpus carries no background rect
        of its own (bloom does not; no Fluent glyph does), the two were tracing different pixels.
        That is not a last-decimal difference — it moved the segmentation, and this page reported
        bloom at <b>3 of 7</b> regions where the CLI said <b>5 of 7</b>.
      </div>
    </>
  )
}
