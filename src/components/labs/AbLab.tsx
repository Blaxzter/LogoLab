// Feature A/B — trace variants side by side on real logos.
//
// The corpus metrics tell you a number moved. They cannot tell you whether the picture got
// better. This lab traces every case with the planar engine under each VARIANT, side by side,
// under one camera PER ROW — so a change can be JUDGED VISUALLY (a band↔ring junction, a wedge
// crossing) at the same framing across every variant of a case at once.
//
// TWO modes:
//  • variants (default) — the same working-tree code, one planarFit flag apart per panel.
//  • VS SNAPSHOT — the working-tree DEFAULT trace against the output frozen by
//    `pnpm gen:absnapshot` at an earlier revision (test/ab-snapshots/). Both panels trace
//    the snapshot's OWN stored pixels, so the delta is code, never rasterizer — the input
//    contract lives in src/devtest/abCorpus.ts, which also owns the shared case list.
//
// Meant to STAY in the tree and grow with future features. To A/B a new feature: add a VARIANT
// with its `planarFit` override (index.ts merges it last), or add a CASE in abCorpus.ts — or
// just drop an image onto the page.

import { useMemo, useState } from 'react'
import { Upload, X } from 'lucide-react'
import { labImageData } from './resvgRaster'
import { DEFAULT_VECTORIZE_OPTIONS } from '../../lib/trace'
import type { VectorizeOptions } from '../../types'
import type { EditableDoc } from '../../lib/path/types'
import type { PlanarFitOptions } from '../../lib/trace/planarFit'
import { AB_CORPUS, abUrl, type AbSnapshotManifest } from '../../devtest/abCorpus'
import { LabPage, LabCheck, LabSelect } from './LabPage'
import { Panel, RawArt } from './Panel'
import { CaseRow, PendingRow, NoteBox } from './CaseRow'
import { useLabState } from './useLabState'
import { useLabRun } from './useLabRun'
import { labTrace } from './labTrace'
import { docStats, traceSvg } from './wire'

// The frozen comparison target, bundled like GoldenLab's fixtures (it lives outside
// public/, so fetching would 404 in a build). Globs tolerate the directory not
// existing yet — the toggle just stays disabled until `pnpm gen:absnapshot` runs.
const SNAP_META = import.meta.glob('/test/ab-snapshots/manifest.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const SNAP_SVGS = import.meta.glob('/test/ab-snapshots/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const SNAP_PNGS = import.meta.glob('/test/ab-snapshots/*.png', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>

const SNAPSHOT: AbSnapshotManifest | null = (() => {
  const raw = Object.values(SNAP_META)[0]
  return raw ? (JSON.parse(raw) as AbSnapshotManifest) : null
})()

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
  /** abCorpus id — the key into the snapshot manifest (absent for dropped images). */
  id?: string
  /** Session-dropped images carry their File so they can be re-rasterized at a new size. */
  file?: File
}

// The case list is OWNED by src/devtest/abCorpus.ts — the same list the snapshot
// writer traces, so the two consumers cannot drift. The handcrafted ⟐ edge cases
// are authored as SVG (src/devtest/genEdgeCases.ts), so the raster switch
// re-rasterizes each at any size: same vector content, varying resolution.
const CASES: AbCase[] = AB_CORPUS.map((c) => ({ id: c.id, name: c.name, kind: c.kind, src: abUrl(c.path) }))

/** Rasterization sizes offered by the raster switch (SVG cases re-render at each; raster
 *  cases only downscale, so they cap at their native size). */
const RASTER_SIZES = [128, 256, 512, 768, 1024]

interface AbAnalysis {
  width: number
  height: number
  /** In snapshot mode the source panel must show the SNAPSHOT's pixels, not the live case URL. */
  srcOverride?: string
  variants: { name: string; tone?: string; svg: string; stats?: ReturnType<typeof docStats> }[]
}

/** Vs-snapshot mode: trace the WORKING TREE's default config from the snapshot's own stored
 *  pixels and pair it with the stored trace — same input file, two code revisions. */
async function analyzeSnapshot(c: AbCase, gradients: boolean): Promise<AbAnalysis> {
  const entry = SNAPSHOT?.cases.find((s) => s.id === c.id)
  if (!SNAPSHOT || !entry) throw new Error('no snapshot for this case — rerun pnpm gen:absnapshot')
  const pngUrl = SNAP_PNGS[`/test/ab-snapshots/${entry.png}`]
  const snapSvg = SNAP_SVGS[`/test/ab-snapshots/${gradients ? entry.grad : entry.flat}`]
  if (!pngUrl || !snapSvg) throw new Error('snapshot files missing — rerun pnpm gen:absnapshot')

  const image = await labImageData(pngUrl, Math.max(entry.width, entry.height))
  const doc: EditableDoc = await labTrace(image, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients })
  return {
    width: entry.width,
    height: entry.height,
    srcOverride: pngUrl,
    variants: [
      { name: `Snapshot @ ${SNAPSHOT.rev}`, tone: 'base', svg: snapSvg },
      { name: 'Working tree', tone: 'shipped', svg: traceSvg(doc, entry.width, entry.height), stats: docStats(doc) },
    ],
  }
}

async function analyze(c: AbCase, raster: number, gradients: boolean): Promise<AbAnalysis> {
  const svgText = c.kind === 'svg' ? await (c.file ? c.file.text() : (await fetch(c.src)).text()) : undefined
  const image = await labImageData(c.src, raster, svgText)
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
  const [ui, setUi] = useLabState('lab:ab', { box: 300, gradients: false, raster: 512, wire: false, snap: false })
  // Dropped images live for the session only — their object URLs die on reload.
  const [extras, setExtras] = useState<AbCase[]>([])
  const [over, setOver] = useState(false)

  const cases = useMemo(() => [...CASES, ...extras], [extras])
  const snapMode = ui.snap && SNAPSHOT != null

  const run = useLabRun(
    cases,
    (c) => (snapMode ? analyzeSnapshot(c, ui.gradients) : analyze(c, ui.raster, ui.gradients)),
    {
      label: (c) => (snapMode ? `Tracing ${c.name} vs snapshot` : `Tracing ${c.name} × ${VARIANTS.length} variants`),
      done: (n) =>
        snapMode
          ? `Done — ${n} cases, working tree vs snapshot ${SNAPSHOT!.rev} (${SNAPSHOT!.date}) · gradients ${ui.gradients ? 'on' : 'off'} · input pinned to the snapshot's stored pixels.`
          : `Done — ${n} cases × ${VARIANTS.length} variants · gradients ${ui.gradients ? 'on' : 'off'} @ ${ui.raster}px. Drop an image anywhere to add it.`,
      deps: [ui.raster, ui.gradients, cases, snapMode],
    },
  )

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
        subtitle="Trace variants side by side, one camera per row, nodes/edges overlay"
        status={run.status}
        running={run.running}
        box={ui.box}
        onBox={(box) => setUi({ box })}
        wires={ui.wire}
        controls={
          <>
            {SNAPSHOT && (
              <LabCheck
                label={`Vs snapshot ${SNAPSHOT.rev}`}
                checked={ui.snap}
                onChange={(snap) => setUi({ snap })}
              />
            )}
            <LabCheck
              label="Gradients"
              checked={ui.gradients}
              onChange={(gradients) => setUi({ gradients })}
            />
            {!snapMode && (
              <LabSelect
                label="Input px"
                value={ui.raster}
                onChange={(raster) => setUi({ raster })}
                options={RASTER_SIZES.map((s) => ({ value: s, label: `${s}px` }))}
              />
            )}
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
                note={a.srcOverride ? `snapshot input · ${a.width}×${a.height}` : `${a.width}×${a.height}`}
                aspect={a.width / a.height}
                // Raster sources zoom as their ACTUAL pixels (the traces are vectors and stay
                // crisp regardless): browser bilinear upscale would show a soft blur that reads
                // as detail the tracer never saw. In snapshot mode the source is ALWAYS the
                // stored input PNG — the very pixels both revisions traced.
                pixelated={a.srcOverride != null || c.kind === 'png'}
              >
                <img src={a.srcOverride ?? c.src} alt="" />
              </Panel>
              {a.variants.map((v) => (
                <Panel
                  key={v.name}
                  label={<span className={v.tone ? TONE[v.tone] : undefined}>{v.name}</span>}
                  note={
                    v.stats
                      ? `${v.stats.paths}p · ${v.stats.nodes}n · ${v.stats.edges}e · ${v.stats.junctions}j`
                      : `frozen ${SNAPSHOT?.date ?? ''}`
                  }
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
        options, one <code>planarFit</code> flag apart. The boxes of a row share one camera (each row
        zooms independently), so you can zoom into a single junction and see what each variant did
        to it, side by side.
      </p>
      <p className="mb-2 max-w-[96ch]">
        <b>Input px</b> re-rasterizes the SVG cases at a different size: a tracer whose node and
        junction counts swing with input resolution is fragile, and only a resolution-independent
        source can reveal that. <b>Nodes/edges</b> reveals the wireframe already baked into every
        panel — square dots are corners, round are smooth, green rings are junction vertices — with
        no re-trace.
      </p>
      <p className="mb-2 max-w-[96ch]">
        <b>Vs snapshot</b> compares the working tree against the output frozen by{' '}
        <code>pnpm gen:absnapshot</code> (test/ab-snapshots — the manifest records the git rev).
        Both panels trace the snapshot&apos;s own stored pixels, so what you see differing is the
        code, never the rasterizer; the raster switch is hidden because the input is pinned.
        Typical flow: <code>git stash && pnpm gen:absnapshot && git stash pop</code> freezes the
        last committed revision, then this page shows exactly what your working tree changed.
        Re-run the command to re-bless after a change is accepted. (Residual caveat: the browser&apos;s
        canvas PNG decode can differ from Node&apos;s by ±1 on a few partial-alpha pixels — the
        aurora story in docs/labs.md — which is far below anything judged visually here.)
      </p>
      <p className="max-w-[96ch]">
        Drop an image anywhere on the page (or use <b>Add image</b>) to run your own logo through
        every variant. Dropped images last for the session (and have no snapshot).
      </p>
    </>
  )
}
