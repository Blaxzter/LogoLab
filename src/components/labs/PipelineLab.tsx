// Pipeline debug — the INTERMEDIATE stages of the structure-first tracer.
//
// Where the Eval harness scores the FINAL output, this lab exposes what happens on the way
// there, so you can see WHY a trace looks the way it does — e.g. that three translucent
// overlapping circles collapse into a handful of opaque macro-regions (the overlap blends
// merged away), which is why the overlaps don't render. Per case, left to right:
//
//   source → Mumford–Shah smoothed → discontinuity map 𝒟 → segmentation (false-coloured, then
//   the actual region fills) → per-region paint models → the final crisp & potrace traces.

import { getImageData } from '../../lib/image'
import { segmentImage, DEFAULT_SEGMENT_OPTIONS } from '../../lib/trace/segment'
import { fitPaintLadder } from '../../lib/trace/gradient'
import { DEFAULT_VECTORIZE_OPTIONS } from '../../lib/trace'
import { serializeDoc } from '../../lib/path/model'
import {
  smoothedToRgba,
  discontinuityToRgba,
  segmentsToRgba,
  regionFillsToRgba,
} from '../../lib/trace/stageViz'
import { LabPage } from './LabPage'
import { Panel, RawArt } from './Panel'
import { CaseRow, NoteBox, PendingRow } from './CaseRow'
import { useLabState } from './useLabState'
import { useLabRun } from './useLabRun'
import { labTrace } from './labTrace'
import { rgbaToUrl } from './raster'

const MAX_DIM = 512

interface Case {
  name: string
  kind: 'png' | 'svg'
  src: string
}

const CASES: Case[] = [
  { name: 'petals', kind: 'png', src: '/examples/petals.png' },
  { name: 'nebula', kind: 'png', src: '/examples/nebula.png' },
  { name: 'bloom', kind: 'svg', src: '/examples/bloom.svg' },
  { name: 'aurora', kind: 'svg', src: '/examples/aurora.svg' },
  { name: 'orbit', kind: 'svg', src: '/examples/orbit.svg' },
  { name: 'outline', kind: 'svg', src: '/examples/outline.svg' },
  { name: 'summit', kind: 'svg', src: '/examples/summit.svg' },
]

interface Paint {
  hex: string
  model: string
  px: number
  residual: number
}

interface Stages {
  width: number
  height: number
  regions: number
  fineSegments: number
  smoothed: string
  discontinuity: string
  segments: string
  fills: string
  paints: Paint[]
  crisp: string
  potrace: string
}

const hex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

async function analyze(c: Case): Promise<Stages> {
  const svgText = c.kind === 'svg' ? await (await fetch(c.src)).text() : undefined
  const image = await getImageData(c.src, MAX_DIM, svgText)
  const w = image.width
  const h = image.height
  const rgba = image as unknown as { width: number; height: number; data: Uint8ClampedArray }

  // Stage 1 — segmentation into macro-regions (it carries the Mumford–Shah smoothing and the
  // discontinuity map by-products in `seg.ms`).
  const seg = segmentImage(rgba, DEFAULT_SEGMENT_OPTIONS)
  // Stage 2 — paint-model ladder per region.
  const paints = seg.regionSamples.map((s, label): Paint => {
    const p = fitPaintLadder(s)
    const [r, g, b] = p.solid
    return { hex: hex(r, g, b), model: p.model, px: seg.counts[label] ?? 0, residual: p.residualOklab }
  })
  // Stages 3–4 — the final traces. Crisp goes to a worker; potrace can't (DOMParser + WASM).
  // The stage panels above stay on the main thread: they need segmentImage's intermediate
  // by-products, which the worker protocol doesn't hand back.
  const crisp = serializeDoc(
    await labTrace(image, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'crisp', gradients: true }),
    2,
  )
  const potrace = serializeDoc(
    await labTrace(image, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'potrace', gradients: true }),
    2,
  )

  return {
    width: w,
    height: h,
    regions: seg.palette.length,
    fineSegments: seg.fineSegments,
    smoothed: rgbaToUrl(smoothedToRgba(seg.ms), w, h),
    discontinuity: rgbaToUrl(discontinuityToRgba(seg.ms), w, h),
    segments: rgbaToUrl(segmentsToRgba(seg.labels, w, h), w, h),
    fills: rgbaToUrl(regionFillsToRgba(seg.labels, seg.palette, w, h), w, h),
    paints,
    crisp,
    potrace,
  }
}

export default function PipelineLab() {
  const [ui, setUi] = useLabState('lab:pipeline', { box: 260 })

  const run = useLabRun(CASES, analyze, {
    label: (c) => `Analysing ${c.name}`,
    done: (n) => `Done — ${n} cases @ ${MAX_DIM}px. Each row's panels share a camera; rows zoom independently.`,
    deps: [],
  })

  return (
    <LabPage
      storageKey="lab:pipeline"
      title="Pipeline debug"
      subtitle="Every intermediate stage: smoothing, discontinuity, regions, paint models"
      status={run.status}
      running={run.running}
      box={ui.box}
      onBox={(box) => setUi({ box })}
      about={<PipelineAbout />}
    >
      {run.results.map(({ case: c, value: s, error }, i) => {
        if (!s) {
          return (
            <CaseRow key={c.name} title={c.name}>
              <NoteBox tone="bad">Failed: {error}</NoteBox>
            </CaseRow>
          )
        }
        const aspect = s.width / s.height
        return (
          <CaseRow
            key={c.name}
            title={c.name}
            note={`${s.width}×${s.height} · ${s.regions} regions (S₀ ${s.fineSegments} before merge)`}
          >
            <Panel label="1 · source" note={c.kind} aspect={aspect}>
              <img src={c.src} alt="" />
            </Panel>
            <Panel label="2 · MS smoothed" note="denoised u" aspect={aspect} pixelated>
              <img src={s.smoothed} alt="" />
            </Panel>
            <Panel label="3 · discontinuity 𝒟" note="edge by-product" aspect={aspect} pixelated>
              <img src={s.discontinuity} alt="" />
            </Panel>
            <Panel label="4 · regions (false)" note={`${s.regions} macro`} aspect={aspect} pixelated>
              <img src={s.segments} alt="" />
            </Panel>
            <Panel label="4 · region fills" note="actual colours" aspect={aspect} pixelated>
              <img src={s.fills} alt="" />
            </Panel>
            <PaintModels paints={s.paints} />
            <Panel label="6 · crisp" note="final" aspect={aspect}>
              <RawArt html={s.crisp} />
            </Panel>
            <Panel label="6 · potrace" note="final" aspect={aspect}>
              <RawArt html={s.potrace} />
            </Panel>
          </CaseRow>
        )
      })}
      {run.pending && <PendingRow title={run.pending.name} />}
    </LabPage>
  )
}

/** Stage-5 summary: a swatch + model + pixel count + residual per region. Not a camera panel —
 *  it's a list, and it should stay readable when the boxes are zoomed. */
function PaintModels({ paints }: { paints: Paint[] }) {
  return (
    // Same [caption flex-1, box] shape as Panel, so this cell lines up with the art panels
    // either side of it (label to the top, box to the bottom) — it just isn't zoomable.
    <div className="lab-cell flex flex-col">
      <div className="mb-1.5 flex min-h-[3.4em] flex-1 flex-col text-[0.68rem] leading-snug text-muted">
        <b className="font-semibold text-ink">5 · paint models</b>
        <span>{paints.length} regions · the ladder each region's fill was fitted with</span>
      </div>
      <div className="lab-box overflow-y-auto rounded-lg border border-line-strong bg-surface p-1.5">
        {paints.map((p, i) => (
          <div key={i} className="flex items-center gap-1.5 py-0.5 text-[0.65rem]">
            <span
              className="h-3 w-3 shrink-0 rounded-sm border border-line"
              style={{ background: p.hex }}
            />
            <span className="w-16 shrink-0 font-mono text-ink">{p.model}</span>
            <span className="shrink-0 font-mono tabular-nums text-muted">
              {p.px.toLocaleString()}px
            </span>
            <span className="ml-auto shrink-0 font-mono tabular-nums text-faint">
              {p.residual.toFixed(3)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PipelineAbout() {
  return (
    <>
      <p className="mb-2 max-w-[96ch]">
        The tracer is <b>structure-first</b>: it does not follow colour boundaries pixel by pixel. It
        first smooths the image (Mumford–Shah), reads the discontinuities that survive, segments the
        result into macro-regions, and only then fits a paint model and a curve to each region. Each
        panel is one of those steps, in order.
      </p>
      <p className="mb-2 max-w-[96ch]">
        This is where surprises get explained. Three translucent overlapping circles collapse into a
        handful of opaque macro-regions — the overlap blends were merged away at the segmentation
        step — which is why the overlaps don't appear in the final trace. The region count in the
        heading (<code>S₀ … before merge</code>) is the fine segmentation the merge started from.
      </p>
      <p className="max-w-[96ch]">
        The last two panels are the final traces from the other two engines, for reference — the app
        itself defaults to the planar engine.
      </p>
    </>
  )
}
