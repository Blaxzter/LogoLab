// Gallery — "here, take a look at how these currently render".
//
// No scoring, no gates, no answer sheet: rasterize, trace with the shipping flat config, and put
// the two side by side. This is the home for art the Workbench can't ask its question of —
// the whole brand-logo set (most marks use strokes/filters/clips, so their visible boundary isn't
// their path geometry and svgGround refuses to score them) and anything you drop in.
//
// The logo SVGs load via import.meta.glob (see ../../devtest/logoCorpus): the corpus is full after
// `npm run fetch:logos` and shows an empty-state hint in any build that didn't fetch them.

import { useMemo, useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { DEFAULT_VECTORIZE_OPTIONS } from '../../lib/trace'
import type { EditableDoc } from '../../lib/path/types'
import { LOGO_CORPUS, LOGO_CORPUS_AVAILABLE } from '../../devtest/logoCorpus'
import { LabPage, LabCheck, LabField } from './LabPage'
import { Tooltip } from '../ui/Tooltip'
import { Panel, RawArt } from './Panel'
import { CaseRow, NoteBox, PendingRow } from './CaseRow'
import { useLabState } from './useLabState'
import { useLabRun } from './useLabRun'
import { labImageData } from './resvgRaster'
import { labTrace } from './labTrace'
import { traceSvg, docStats } from './wire'
import { rgbaToUrl } from './raster'

const MAX_DIM = 512
const PAGE_SIZE = 24

/** One thing to look at: bundled logo markup, or a dropped file. */
interface GalleryCase {
  key: string
  title: string
  note?: string
  /** Inline SVG markup (logos, dropped SVG) — rasterized with resvg, no fetch. */
  svgText?: string
  /** Object URL for a dropped raster. */
  url?: string
}

interface GalleryResult {
  width: number
  height: number
  /** The rasterized source — what the tracer actually ingests, composited on white. */
  srcUrl: string
  /** The flat planar trace, as panel art (wireframe baked in, hidden until toggled). */
  svg: string
  stats: ReturnType<typeof docStats>
}

async function analyze(c: GalleryCase): Promise<GalleryResult> {
  const image = await labImageData(c.url ?? '', MAX_DIM, c.svgText, { background: 'white' })
  const w = image.width
  const h = image.height
  // Flat trace: the product target is flat icons, and solid-fill output carries no gradient <defs>
  // ids — so a whole page of traces can share one document without id collisions.
  const doc: EditableDoc = await labTrace(image, {
    ...DEFAULT_VECTORIZE_OPTIONS,
    engine: 'planar',
    gradients: false,
  })
  return { width: w, height: h, srcUrl: rgbaToUrl(image.data, w, h), svg: traceSvg(doc, w, h), stats: docStats(doc) }
}

export default function GalleryLab() {
  const [ui, setUi] = useLabState('lab:gallery', { box: 240, page: 0, wire: false })
  // Dropped images live for the session only — their object URLs die on reload.
  const [dropped, setDropped] = useState<GalleryCase[]>([])
  const [over, setOver] = useState(false)
  const idRef = useRef(0)

  const logos = useMemo(
    (): GalleryCase[] =>
      LOGO_CORPUS.map((c) => ({ key: c.file, title: c.company, note: c.notes, svgText: c.svg })),
    [],
  )
  const pages = Math.max(1, Math.ceil(logos.length / PAGE_SIZE))
  const page = Math.min(ui.page, pages - 1)
  // Dropped images always ride along at the top — you dropped them to look at them now, not to
  // find them on page 4.
  const cases = useMemo(
    () => [...dropped, ...logos.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)],
    [dropped, logos, page],
  )

  const run = useLabRun(cases, analyze, {
    label: (c) => `Tracing ${c.title}`,
    done: (n) => `Done — ${n} @ ${MAX_DIM}px${pages > 1 ? ` (logos page ${page + 1}/${pages})` : ''}.`,
    deps: [page, dropped],
    // Cache the logo traces (stable keys) across pages and sessions; skip session-dropped images
    // (their object URLs die on reload, so a `drop-N` key can't be re-derived). Fixed size, flat.
    cache: {
      id: 'gallery',
      key: (c) => (c.key.startsWith('drop-') ? null : c.key),
      optionsKey: `flat${MAX_DIM}`,
    },
  })

  const addFile = async (f: File) => {
    if (!f.type.startsWith('image/')) return
    // Vector art is read as markup so resvg rasterizes it (the CI engine); a raster gets an
    // object URL and goes through the product's canvas decode. Resolve before the updater — a
    // state updater can't be async.
    const isSvg = f.type.includes('svg')
    const svgText = isSvg ? await f.text() : undefined
    const url = isSvg ? undefined : URL.createObjectURL(f)
    setDropped((prev) => [
      ...prev,
      { key: `drop-${idRef.current++}`, title: f.name, note: 'dropped · session only', svgText, url },
    ])
  }

  const empty = !LOGO_CORPUS_AVAILABLE && dropped.length === 0

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
        if (f) void addFile(f)
      }}
      className={over ? 'ring-2 ring-inset ring-accent' : ''}
    >
      <LabPage
        storageKey="lab:gallery"
        title="Gallery"
        subtitle="How the tracer currently renders these — no score, just look"
        status={run.status}
        running={run.running}
        progress={run.progress}
        box={ui.box}
        onBox={(box) => setUi({ box })}
        wires={ui.wire}
        controls={
          <>
            {pages > 1 && (
              <LabField
                label="Page"
                hint="Move between pages of the logo set (24 at a time) — it's traced a page at a time so the tab stays responsive."
              >
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
            )}
            <LabCheck
              label="Nodes/edges"
              hint="Overlay the traced nodes/edges wireframe — square dots are corners, round are smooth, green rings are junction vertices. No re-trace."
              checked={ui.wire}
              onChange={(wire) => setUi({ wire })}
            />
            <Tooltip
              side="bottom"
              label="Add an image from disk and trace it (session only — object URLs die on reload). You can also drop one anywhere on this page."
            >
              <label className="btn btn-secondary h-7 cursor-pointer gap-1.5 px-2 text-xs">
                <Upload size={13} />
                Add image
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void addFile(f)
                    e.target.value = ''
                  }}
                />
              </label>
            </Tooltip>
          </>
        }
        about={<GalleryAbout />}
      >
        {empty && (
          <div className="px-4 py-8">
            <NoteBox tone="warn">
              The logo corpus isn't present in this build. It's a private, git-ignored set of brand
              marks (not redistributed). Run <code>npm run fetch:logos</code> to download it into{' '}
              <code>examples/logos/</code>, then reload — or just drop an image here.
            </NoteBox>
          </div>
        )}
        {run.results.map(({ case: c, value: r, error }) => {
          if (!r) {
            return (
              <CaseRow key={c.key} title={c.title} note={c.note}>
                <NoteBox tone="bad">Failed: {error}</NoteBox>
              </CaseRow>
            )
          }
          const aspect = r.width / r.height
          return (
            <CaseRow key={c.key} title={c.title} note={c.note} right={`${r.width}×${r.height}`}>
              <Panel label="source · rasterized" note="what the tracer sees" aspect={aspect}>
                <img src={r.srcUrl} alt="" />
              </Panel>
              <Panel
                label="traced · planar flat"
                note={`${r.stats.paths}p · ${r.stats.nodes}n · ${r.stats.edges}e`}
                aspect={aspect}
              >
                <RawArt html={r.svg} />
              </Panel>
            </CaseRow>
          )
        })}
        {run.pending && <PendingRow title={run.pending.title} note={run.pending.note} />}
      </LabPage>
    </div>
  )
}

function GalleryAbout() {
  return (
    <>
      <p className="mb-2 max-w-[96ch]">
        A looking-glass, not a gate. Every source is rasterized at {MAX_DIM}px on white — the exact
        input the tracer ingests — and traced with the shipping flat planar config. Nothing here is
        scored, because nothing here can be: this is the art the <b>Workbench</b> has to refuse.
      </p>
      <p className="mb-2 max-w-[96ch]">
        The <b>logo corpus</b> is ~150 real, authored brand marks (svgl.app, vectorlogo.zone,
        Wikimedia Commons), spanning simple flat marks to gradient- and stroke-heavy artwork. Most of
        them can't be ground truth: a stroked, filtered, clipped or masked mark renders a silhouette
        that isn't the geometry its paths describe, so scoring it would measure the trace against
        something the renderer never drew. The subset that <em>can</em> be scored is in the{' '}
        <b>Workbench</b> under <b>Logo corpus (scorable)</b>; all of them are here.
      </p>
      <p className="max-w-[96ch]">
        The .svg files are <b>git-ignored</b> and never deployed; run <code>npm run fetch:logos</code>{' '}
        to rehydrate them. Drop an image anywhere (or use <b>Add image</b>) to run your own art
        through the same flat trace — dropped images last for the session.
      </p>
    </>
  )
}
