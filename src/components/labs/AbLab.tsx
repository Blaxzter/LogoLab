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
import { labImageData, rasterizeSvgResvg } from './resvgRaster'
import { rgbaToUrl } from './raster'
import { heatColor, HEAT_BG } from './heat'
import { DEFAULT_VECTORIZE_OPTIONS } from '../../lib/trace'
import type { VectorizeOptions } from '../../types'
import type { EditableDoc } from '../../lib/path/types'
import type { PlanarFitOptions } from '../../lib/trace/planarFit'
import { AB_CORPUS, abUrl, type AbSnapshotManifest } from '../../devtest/abCorpus'
import { fnv1a } from './engineFingerprint'
import { LabPage, LabCheck, LabSelect } from './LabPage'
import { Panel, RawArt } from './Panel'
import { CaseRow, PendingRow, NoteBox } from './CaseRow'
import { useLabState } from './useLabState'
import { useLabRun } from './useLabRun'
import { labTrace } from './labTrace'
import { docStats, traceSvg } from './wire'
import { serializeDoc } from '../../lib/path/model'

// The frozen comparison targets, bundled like GoldenLab's fixtures (they live outside
// public/, so fetching would 404 in a build). Each snapshot is a SUBDIR under
// test/ab-snapshots/; the globs tolerate none existing yet — the dropdown just shows
// "Live variants" until `pnpm gen:absnapshot` runs.
const SNAP_META = import.meta.glob('/test/ab-snapshots/*/manifest.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const SNAP_SVGS = import.meta.glob('/test/ab-snapshots/*/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const SNAP_PNGS = import.meta.glob('/test/ab-snapshots/*/*.png', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>

interface SnapEntry {
  name: string
  manifest: AbSnapshotManifest
}

/** Every snapshot found under test/ab-snapshots/<name>/, newest date first (the dropdown
 *  order). The subdir name is the identity; the manifest's own `name` mirrors it. */
const SNAPSHOTS: SnapEntry[] = Object.entries(SNAP_META)
  .map(([path, raw]) => {
    // /test/ab-snapshots/<name>/manifest.json → <name>
    const name = path.split('/').slice(-2, -1)[0]
    return { name, manifest: JSON.parse(raw) as AbSnapshotManifest }
  })
  .sort((a, b) => (a.manifest.date < b.manifest.date ? 1 : a.manifest.date > b.manifest.date ? -1 : a.name.localeCompare(b.name)))

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
  // §10.1 scale-relative snap ε. The pair below makes the thesis visible: turn the §9.8
  // corner-turn veto OFF and small squares round to blobs (`checker`, `scale-blind`); a
  // scale-relative ε alone puts the corners back, discriminating by SIZE, no turn test.
  // `Scale-ε (veto on)` is byte-identical to Arc-snap on most cases (its extra bite — a
  // sub-6px flat blob the veto is blind to — is a narrow population); default is OFF.
  { name: 'Veto off (§9.8 guard removed)', tone: 'base', planarFit: { arcSnap: true, cornerVeto: false } },
  { name: 'Veto off + scale-ε', tone: 'shipped', planarFit: { arcSnap: true, cornerVeto: false, localScaleK: 0.15 } },
  { name: 'Scale-ε (veto on)', tone: 'refine', planarFit: { arcSnap: true, localScaleK: 0.15 } },
]

// The variant SET is part of what the cache key must cover: ENGINE_HASH fingerprints the
// tracer + scoring source (src/lib, src/devtest) but NOT this file, so adding a column or
// retuning a flag here would otherwise serve a stale cached analysis (missing the new column,
// or the old localScaleK). Fold a hash of the variant definitions into the options key so any
// edit above invalidates just the AB variant cache.
const VARIANTS_HASH = fnv1a(JSON.stringify(VARIANTS))

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
  /** Snapshot mode only: did the working tree's trace differ from the frozen one? undefined in
   *  variants mode (no baseline to diff against). Drives the "Changed only" filter. */
  changed?: boolean
  /** Snapshot mode, changed cases only: a per-pixel heat of WHERE the two traces disagree
   *  (data URL). Lets a change be located, not just counted. */
  heatUrl?: string
  variants: { name: string; tone?: string; svg: string; stats?: ReturnType<typeof docStats> }[]
}

/** Full-scale (RGB euclidean distance) at which the diff heat saturates to its hottest. A
 *  clean fill swap (ink↔beige, ~250) pins hot; sub-pixel AA jitter stays cool. */
const HEAT_SCALE = 110

/** Per-pixel diff of two equal-size rasters → a heat RGBA buffer on HEAT_BG: hot where the
 *  traces disagree, the shared cold→hot ramp (heat.ts) so it reads like every other lab heat.
 *  Pure — no DOM — so the pixel math is testable headless; rgbaToUrl does the canvas encode. */
function diffHeatBuffer(a: ImageData, b: ImageData): Uint8ClampedArray {
  const n = a.width * a.height
  const out = new Uint8ClampedArray(n * 4)
  const bg = [10, 12, 22] // ~HEAT_BG, so cold pixels sit on the panel's own backdrop
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const dr = a.data[o] - b.data[o]
    const dg = a.data[o + 1] - b.data[o + 1]
    const db = a.data[o + 2] - b.data[o + 2]
    const t = Math.min(1, Math.sqrt(dr * dr + dg * dg + db * db) / HEAT_SCALE)
    if (t < 0.02) {
      out[o] = bg[0]; out[o + 1] = bg[1]; out[o + 2] = bg[2]; out[o + 3] = 255
      continue
    }
    const [hr, hg, hb] = heatColor(t)
    out[o] = hr; out[o + 1] = hg; out[o + 2] = hb; out[o + 3] = 255
  }
  return out
}

/** Vs-snapshot mode: trace the WORKING TREE's default config from the snapshot's own stored
 *  pixels and pair it with the stored trace — same input file, two code revisions. */
async function analyzeSnapshot(c: AbCase, gradients: boolean, snap: SnapEntry): Promise<AbAnalysis> {
  const entry = snap.manifest.cases.find((s) => s.id === c.id)
  if (!entry) throw new Error(`case not in snapshot ${snap.name} — rerun pnpm gen:absnapshot`)
  const dir = `/test/ab-snapshots/${snap.name}`
  const pngUrl = SNAP_PNGS[`${dir}/${entry.png}`]
  const snapSvg = SNAP_SVGS[`${dir}/${gradients ? entry.grad : entry.flat}`]
  if (!pngUrl || !snapSvg) throw new Error('snapshot files missing — rerun pnpm gen:absnapshot')

  const image = await labImageData(pngUrl, Math.max(entry.width, entry.height))
  const doc: EditableDoc = await labTrace(image, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients })
  // "Changed" is an exact-serialization diff: the snapshot IS serializeDoc(doc) at the frozen
  // rev (writeAbSnapshots.ts) and gradientId is deterministic, so identical geometry+paint
  // serializes byte-identically — a difference here is a real trace change, nothing cosmetic.
  const live = serializeDoc(doc, 2)
  const changed = live !== snapSvg
  // For changed cases, rasterize BOTH plain-fill traces (no wireframe) on white and heat
  // their per-pixel delta, so the diff is LOCATED. Only changed cases pay this, and only in
  // snapshot mode — an unchanged corpus costs nothing.
  let heatUrl: string | undefined
  if (changed) {
    const [snapImg, liveImg] = await Promise.all([
      rasterizeSvgResvg(snapSvg, entry.width, { background: 'white' }),
      rasterizeSvgResvg(live, entry.width, { background: 'white' }),
    ])
    if (snapImg.width === liveImg.width && snapImg.height === liveImg.height) {
      heatUrl = rgbaToUrl(diffHeatBuffer(snapImg, liveImg), snapImg.width, snapImg.height)
    }
  }
  return {
    width: entry.width,
    height: entry.height,
    srcOverride: pngUrl,
    changed,
    heatUrl,
    variants: [
      { name: `Snapshot @ ${snap.manifest.rev}`, tone: 'base', svg: snapSvg },
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
  const [ui, setUi] = useLabState('lab:ab', { box: 300, gradients: false, raster: 512, wire: false, snapName: '', changedOnly: false })
  // Dropped images live for the session only — their object URLs die on reload.
  const [extras, setExtras] = useState<AbCase[]>([])
  const [over, setOver] = useState(false)

  const cases = useMemo(() => [...CASES, ...extras], [extras])
  // The selected snapshot (or null in variants mode). An unknown name (a snapshot deleted since
  // it was last chosen) falls back to variants rather than erroring.
  const selectedSnap = SNAPSHOTS.find((s) => s.name === ui.snapName) ?? null
  const snapMode = selectedSnap != null
  const changedOnly = snapMode && ui.changedOnly

  const run = useLabRun(
    cases,
    (c) => (selectedSnap ? analyzeSnapshot(c, ui.gradients, selectedSnap) : analyze(c, ui.raster, ui.gradients)),
    {
      label: (c) => (snapMode ? `Tracing ${c.name} vs ${selectedSnap!.name}` : `Tracing ${c.name} × ${VARIANTS.length} variants`),
      done: (n) =>
        selectedSnap
          ? `Done — ${n} cases, working tree vs snapshot ${selectedSnap.name} @ ${selectedSnap.manifest.rev} (${selectedSnap.manifest.date}) · gradients ${ui.gradients ? 'on' : 'off'} · input pinned to the snapshot's stored pixels.`
          : `Done — ${n} cases × ${VARIANTS.length} variants · gradients ${ui.gradients ? 'on' : 'off'} @ ${ui.raster}px. Drop an image anywhere to add it.`,
      deps: [ui.raster, ui.gradients, cases, ui.snapName],
      // Cache corpus cases (stable `id`); skip session-dropped images (no id). The snapshot NAME
      // is in the key so switching snapshots (or re-blessing one) invalidates results — the frozen
      // SVGs live outside src/, so ENGINE_HASH alone wouldn't catch a re-bless. `v2` bumps past
      // caches written before the diff-heat field existed.
      cache: {
        id: 'ab',
        key: (c) => c.id ?? null,
        optionsKey: selectedSnap
          ? `snap:v2:${selectedSnap.name}:g${ui.gradients}`
          : `var:r${ui.raster}:g${ui.gradients}:v${VARIANTS_HASH}`,
      },
    },
  )

  const addFile = (f: File) => {
    if (!f.type.startsWith('image/')) return
    setExtras((prev) => [
      ...prev,
      { name: f.name, src: URL.createObjectURL(f), kind: f.type.includes('svg') ? 'svg' : 'png', file: f },
    ])
  }

  // "Changed only" hides cases whose working-tree trace serializes identically to the snapshot.
  // Errors (value null) and still-resolving rows are kept — only a confirmed match is hidden.
  const shown = changedOnly ? run.results.filter((r) => r.value?.changed !== false) : run.results
  const changedN = run.results.filter((r) => r.value?.changed === true).length
  const unchangedN = run.results.filter((r) => r.value?.changed === false).length

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
        progress={run.progress}
        box={ui.box}
        onBox={(box) => setUi({ box })}
        wires={ui.wire}
        controls={
          <>
            {SNAPSHOTS.length > 0 && (
              <LabSelect
                label="Vs snapshot"
                value={ui.snapName}
                onChange={(snapName) => setUi({ snapName })}
                options={[
                  { value: '', label: 'Live variants' },
                  ...SNAPSHOTS.map((s) => ({ value: s.name, label: `${s.name} · ${s.manifest.date}` })),
                ]}
              />
            )}
            {snapMode && (
              <LabCheck
                label="Changed only"
                checked={ui.changedOnly}
                onChange={(changedOnly) => setUi({ changedOnly })}
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
        {snapMode && (changedN > 0 || unchangedN > 0) && (
          <div className="mb-2 text-xs text-muted">
            <b className="text-fg">{changedN}</b> changed · {unchangedN} unchanged vs snapshot{' '}
            {selectedSnap!.name} @ {selectedSnap!.manifest.rev}
            {changedOnly && unchangedN > 0 && <span className="text-faint"> · {unchangedN} hidden</span>}
            {changedOnly && changedN === 0 && (
              <span className="text-good"> — working tree matches the snapshot</span>
            )}
          </div>
        )}
        {shown.map(({ case: c, value: a, error }) => {
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
                <>
                  {snapMode && a.changed != null && (
                    <span
                      className={`rounded px-1 py-0.5 text-[0.6rem] ${a.changed ? 'bg-warn/20 text-warn' : 'text-faint'}`}
                    >
                      {a.changed ? 'changed' : 'unchanged'}
                    </span>
                  )}
                  {c.file && (
                    <button
                      type="button"
                      onClick={() => setExtras((prev) => prev.filter((e) => e !== c))}
                      className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[0.6rem] text-faint transition-colors hover:bg-surface-3 hover:text-bad"
                    >
                      <X size={10} />
                      remove
                    </button>
                  )}
                </>
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
                grid={{ w: a.width, h: a.height }}
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
                      : `frozen ${selectedSnap?.manifest.date ?? ''}`
                  }
                  aspect={a.width / a.height}
                  grid={{ w: a.width, h: a.height }}
                >
                  <RawArt html={v.svg} />
                </Panel>
              ))}
              {snapMode && a.heatUrl && (
                <Panel
                  label={<span className="text-warn">diff heat</span>}
                  note="hot = snapshot ≠ working tree"
                  aspect={a.width / a.height}
                  pixelated
                  grid={{ w: a.width, h: a.height }}
                >
                  <img src={a.heatUrl} alt="" style={{ background: HEAT_BG }} />
                </Panel>
              )}
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
        <b>Vs snapshot</b> (the dropdown) compares the working tree against a baseline frozen by{' '}
        <code>pnpm gen:absnapshot [name]</code> — each snapshot is its own subdir under
        test/ab-snapshots, so several coexist and you pick which to diff against (newest first;
        the manifest records the git rev + date). Both panels trace the snapshot&apos;s own stored
        pixels, so what differs is the code, never the rasterizer; the raster switch is hidden
        because the input is pinned. Typical flow: BEFORE a change, freeze a baseline —{' '}
        <code>pnpm gen:absnapshot before-thing</code> — then this page shows exactly what the
        working tree changed against it. <b>Changed only</b> collapses the corpus to just the cases
        whose trace actually moved (an exact serialization diff — a snapshot IS{' '}
        <code>serializeDoc</code> at its rev), and each changed case gets a <b>diff heat</b> panel
        that rasterizes both traces and paints WHERE they disagree (the shared cold→hot ramp) — so
        a change is located, not just flagged. Re-run to re-bless a snapshot after a change is
        accepted. (Residual caveat: the browser&apos;s canvas PNG decode can differ from
        Node&apos;s by ±1 on a few partial-alpha pixels — the aurora story in docs/labs.md — which
        is far below anything judged visually here.)
      </p>
      <p className="max-w-[96ch]">
        Drop an image anywhere on the page (or use <b>Add image</b>) to run your own logo through
        every variant. Dropped images last for the session (and have no snapshot).
      </p>
    </>
  )
}
