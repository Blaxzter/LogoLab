// Feature A/B — trace variants side by side on real logos.
//
// The corpus metrics tell you a number moved. They cannot tell you whether the picture got
// better. This lab traces every case with the planar engine under each VARIANT, side by side,
// under one shared camera — so a change can be JUDGED VISUALLY (a band↔ring junction, a wedge
// crossing) at the same framing across every variant at once.
//
// Meant to STAY in the tree and grow with future features. To A/B a new feature: add a VARIANT
// with its `planarFit` override (index.ts merges it last), or add a CASE — or just drop an
// image onto the page.

import { useMemo, useState } from 'react'
import { Upload, X } from 'lucide-react'
import { getImageData } from '../../lib/image'
import { DEFAULT_VECTORIZE_OPTIONS } from '../../lib/trace'
import type { VectorizeOptions } from '../../types'
import type { EditableDoc } from '../../lib/path/types'
import type { PlanarFitOptions } from '../../lib/trace/planarFit'
import { LabPage, LabCheck, LabSelect } from './LabPage'
import { Panel, RawArt } from './Panel'
import { CaseRow, PendingRow, NoteBox } from './CaseRow'
import { useLabState } from './useLabState'
import { useLabRun } from './useLabRun'
import { labTrace } from './labTrace'
import { docStats, traceSvg } from './wire'

/** One trace configuration rendered per case. `planarFit` overrides the fit tunables;
 *  `opts` overrides any other VectorizeOptions (e.g. backgroundGradient). */
interface Variant {
  name: string
  tone?: 'base' | 'shipped' | 'refine'
  planarFit?: Partial<PlanarFitOptions>
  opts?: Partial<VectorizeOptions>
}

const VARIANTS: Variant[] = [
  { name: 'Baseline', tone: 'base', planarFit: { arcSnap: false, refineJunctions: false } },
  { name: 'Arc-snap (shipped)', tone: 'shipped', planarFit: { arcSnap: true, refineJunctions: false } },
  { name: 'Sub-pixel + G¹', tone: 'refine', planarFit: { arcSnap: false, refineJunctions: true } },
  { name: 'Weld ≤3px', tone: 'refine', planarFit: { arcSnap: false, refineJunctions: false, weldJunctions: 3 } },
  { name: 'Weld + snap + G¹', planarFit: { arcSnap: true, refineJunctions: true, weldJunctions: 3 } },
  {
    name: 'BG gradient + weld',
    tone: 'refine',
    opts: { backgroundGradient: true },
    planarFit: { arcSnap: true, refineJunctions: false, weldJunctions: 3 },
  },
]

const TONE: Record<string, string> = {
  base: 'text-muted',
  shipped: 'text-good',
  refine: 'text-warn',
}

interface AbCase {
  name: string
  src: string
  kind: 'png' | 'svg'
  /** Session-dropped images carry their File so they can be re-rasterized at a new size. */
  file?: File
}

const CASES: AbCase[] = [
  { name: 'orbit (ring)', kind: 'svg', src: '/examples/orbit.svg' },
  { name: 'bloom (crossings)', kind: 'svg', src: '/examples/bloom.svg' },
  { name: 'outline', kind: 'svg', src: '/examples/outline.svg' },
  { name: 'summit', kind: 'svg', src: '/examples/summit.svg' },
  { name: 'aurora', kind: 'svg', src: '/examples/aurora.svg' },
  { name: 'nebula', kind: 'png', src: '/examples/nebula.png' },
  { name: 'petals', kind: 'png', src: '/examples/petals.png' },
  // Handcrafted "difficult case" corpus — authored as SVG (src/devtest/genEdgeCases.ts), so the
  // raster switch re-rasterizes each at any size: same vector content, varying resolution. Each
  // isolates one hard problem; flip gradients on and compare Weld / BG-gradient.
  { name: '⟐ bg-ramp — posterization bands', kind: 'svg', src: '/examples/edge-cases/bg-ramp.svg' },
  { name: '⟐ bg-ramp-twin — colour-class DELETE risk', kind: 'svg', src: '/examples/edge-cases/bg-ramp-twin.svg' },
  { name: '⟐ cross-bars — junction cluster (weld)', kind: 'svg', src: '/examples/edge-cases/cross-bars.svg' },
  { name: '⟐ concentric — circle/concentric snap', kind: 'svg', src: '/examples/edge-cases/concentric.svg' },
  { name: '⟐ hairlines — sub-pixel strokes', kind: 'svg', src: '/examples/edge-cases/hairlines.svg' },
  { name: '⟐ aa-seam — nearest-colour crispness', kind: 'svg', src: '/examples/edge-cases/aa-seam.svg' },
  { name: '⟐ checker — high-frequency aliasing', kind: 'svg', src: '/examples/edge-cases/checker.svg' },
  { name: '⟐ radial-glow — 2-D gradient field', kind: 'svg', src: '/examples/edge-cases/radial-glow.svg' },
  { name: '⟐ gradient-flat — render gate', kind: 'svg', src: '/examples/edge-cases/gradient-flat.svg' },
  { name: '⟐ sharp-star — corner detection', kind: 'svg', src: '/examples/edge-cases/sharp-star.svg' },
  { name: '⟐ annulus — hole winding + alpha', kind: 'svg', src: '/examples/edge-cases/annulus.svg' },
  { name: '⟐ overlap — layer decomposition', kind: 'svg', src: '/examples/edge-cases/overlap.svg' },
]

/** Rasterization sizes offered by the raster switch (SVG cases re-render at each; raster
 *  cases only downscale, so they cap at their native size). */
const RASTER_SIZES = [128, 256, 512, 768, 1024]

interface AbAnalysis {
  width: number
  height: number
  variants: { name: string; tone?: string; svg: string; stats: ReturnType<typeof docStats> }[]
}

async function analyze(c: AbCase, raster: number, gradients: boolean): Promise<AbAnalysis> {
  const svgText = c.kind === 'svg' ? await (c.file ? c.file.text() : (await fetch(c.src)).text()) : undefined
  const image = await getImageData(c.src, raster, svgText)
  const w = image.width
  const h = image.height

  const variants: AbAnalysis['variants'] = []
  for (const v of VARIANTS) {
    const doc: EditableDoc = await labTrace(image, {
      ...DEFAULT_VECTORIZE_OPTIONS,
      engine: 'planar',
      gradients,
      ...v.opts,
      planarFit: v.planarFit,
    })
    variants.push({ name: v.name, tone: v.tone, svg: traceSvg(doc, w, h), stats: docStats(doc) })
  }
  return { width: w, height: h, variants }
}

export default function AbLab() {
  const [ui, setUi] = useLabState('lab:ab', { box: 300, gradients: false, raster: 512, wire: false })
  // Dropped images live for the session only — their object URLs die on reload.
  const [extras, setExtras] = useState<AbCase[]>([])
  const [over, setOver] = useState(false)

  const cases = useMemo(() => [...CASES, ...extras], [extras])

  const run = useLabRun(cases, (c) => analyze(c, ui.raster, ui.gradients), {
    label: (c) => `Tracing ${c.name} × ${VARIANTS.length} variants`,
    done: (n) =>
      `Done — ${n} cases × ${VARIANTS.length} variants · gradients ${ui.gradients ? 'on' : 'off'} @ ${ui.raster}px. Drop an image anywhere to add it.`,
    deps: [ui.raster, ui.gradients, cases],
  })

  const addFile = (f: File) => {
    if (!f.type.startsWith('image/')) return
    setExtras((prev) => [
      ...prev,
      { name: f.name, src: URL.createObjectURL(f), kind: f.type.includes('svg') ? 'svg' : 'png', file: f },
    ])
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const f = e.dataTransfer.files?.[0]
        if (f) addFile(f)
      }}
      className={over ? 'ring-2 ring-inset ring-accent' : ''}
    >
      <LabPage
        storageKey="lab:ab"
        title="Feature A/B"
        subtitle="Trace variants side by side, one shared camera, nodes/edges overlay"
        status={run.status}
        running={run.running}
        box={ui.box}
        onBox={(box) => setUi({ box })}
        wires={ui.wire}
        controls={
          <>
            <LabCheck
              label="Gradients"
              checked={ui.gradients}
              onChange={(gradients) => setUi({ gradients })}
            />
            <LabSelect
              label="Input px"
              value={ui.raster}
              onChange={(raster) => setUi({ raster })}
              options={RASTER_SIZES.map((s) => ({ value: s, label: `${s}px` }))}
            />
            <LabCheck label="Nodes/edges" checked={ui.wire} onChange={(wire) => setUi({ wire })} />
            <label className="btn btn-secondary h-7 cursor-pointer gap-1.5 px-2 text-xs">
              <Upload size={13} />
              Add image
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) addFile(f)
                  e.target.value = ''
                }}
              />
            </label>
          </>
        }
        about={<AbAbout />}
      >
        {run.results.map(({ case: c, value: a, error }, i) => {
          if (!a) {
            return (
              <CaseRow key={c.name} title={c.name}>
                <NoteBox tone="bad">Failed to trace: {error}</NoteBox>
              </CaseRow>
            )
          }
          return (
            <CaseRow
              key={c.name}
              title={c.name}
              badges={
                c.file && (
                  <button
                    type="button"
                    onClick={() => setExtras((prev) => prev.filter((e) => e !== c))}
                    className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[0.6rem] text-faint transition-colors hover:bg-surface-3 hover:text-bad"
                  >
                    <X size={10} />
                    remove
                  </button>
                )
              }
              right={`${a.width}×${a.height}`}
            >
              <Panel
                label="source"
                note={`${a.width}×${a.height}`}
                aspect={a.width / a.height}
                primary={i === 0}
              >
                <img src={c.src} alt="" />
              </Panel>
              {a.variants.map((v) => (
                <Panel
                  key={v.name}
                  label={<span className={v.tone ? TONE[v.tone] : undefined}>{v.name}</span>}
                  note={`${v.stats.paths}p · ${v.stats.nodes}n · ${v.stats.edges}e · ${v.stats.junctions}j`}
                  aspect={a.width / a.height}
                >
                  <RawArt html={v.svg} />
                </Panel>
              ))}
            </CaseRow>
          )
        })}
        {run.pending && <PendingRow title={run.pending.name} />}
      </LabPage>
    </div>
  )
}

function AbAbout() {
  return (
    <>
      <p className="mb-2 max-w-[96ch]">
        Every case is traced by the planar engine once per <b>variant</b> — the same image, the same
        options, one <code>planarFit</code> flag apart. All the boxes share one camera, so you can
        zoom into a single junction and see what each variant did to it, side by side.
      </p>
      <p className="mb-2 max-w-[96ch]">
        <b>Input px</b> re-rasterizes the SVG cases at a different size: a tracer whose node and
        junction counts swing with input resolution is fragile, and only a resolution-independent
        source can reveal that. <b>Nodes/edges</b> reveals the wireframe already baked into every
        panel — square dots are corners, round are smooth, green rings are junction vertices — with
        no re-trace.
      </p>
      <p className="max-w-[96ch]">
        Drop an image anywhere on the page (or use <b>Add image</b>) to run your own logo through
        every variant. Dropped images last for the session.
      </p>
    </>
  )
}
