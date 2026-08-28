// The Workbench — ONE analysis, over a switchable corpus.
//
// Pick a corpus; the view never changes shape. Every case is an authored SVG, rasterized, traced
// and scored against the art that made the pixels (see ./analysis.tsx). The corpus selector means
// exactly one thing — WHICH IMAGES — and every control below it applies to every corpus.
//
// It reuses the shared shell wholesale: LabPage (toolbar + about + status + dark/zoom contexts),
// useLabRun (one case at a time, traced off the main thread via labTrace), CaseRow/Panel/GateTable.

import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { LabPage, LabSelect, LabCheck, LabField } from '../LabPage'
import { PendingRow } from '../CaseRow'
import { useLabRun } from '../useLabRun'
import { useLabSearch } from '../useLabSearch'
import { useLabState } from '../useLabState'
import { TRUTH_RESOLUTIONS } from '../../../devtest/truthCorpus'
import { CORPORA, corpusById } from './corpora'
import { analyze, AnalysisCaseRow, type AnalysisResult } from './analysis'
import { DEFAULT_WB_UI } from './types'

const PAGE_SIZES = [4, 8, 16, 32]
const HEAT_SCALES = [1, 2, 5, 10, 25]

export default function Workbench() {
  const [params, setParams] = useSearchParams()
  const [ui, setUi] = useLabState('lab:workbench', DEFAULT_WB_UI)

  // The corpus lives in the URL so a link can point at one (the old /labs/truth and /labs/logos
  // routes redirect here with ?corpus=…).
  const corpus = corpusById(params.get('corpus') ?? '') ?? CORPORA[0]

  // Searching jumps back to page 1 — "All tiers" is 231 cases over 8 pages, and the case you
  // just named is almost certainly not on the one you were reading.
  const search = useLabSearch(() => setUi({ page: 0 }))

  const corpusCases = useMemo(() => corpus.cases(), [corpus])
  // Filtered BEFORE the page slice, so a query reaches the whole corpus rather than the 16
  // cases in front of you — and so only the matches are ever traced.
  // `note` is a ReactNode in general (a corpus may hand back markup); only a plain string is
  // something a substring query can honestly be run against.
  const all = useMemo(
    () => corpusCases.filter((c) => search.match(c.title, c.key, typeof c.note === 'string' ? c.note : undefined)),
    [corpusCases, search.match],
  )
  const pages = Math.max(1, Math.ceil(all.length / ui.pageSize))
  // Changing the corpus, the page size or the search can strand you past the end.
  const page = Math.min(ui.page, pages - 1)
  const cases = useMemo(
    () => all.slice(page * ui.pageSize, page * ui.pageSize + ui.pageSize),
    [all, page, ui.pageSize],
  )

  const run = useLabRun(cases, (c) => analyze(c, ui.res, ui.ab), {
    label: (c) => `Tracing ${c.title} @ ${ui.res}px`,
    done: () =>
      `${cases.length} of ${all.length}${search.active ? ` matching “${search.q}”` : ''} cases · ` +
      `page ${page + 1}/${pages} @ ${ui.res}px. ` +
      `Every number is measured against the authored SVG — nothing here reads or writes trace-baseline.json.`,
    // The heat scale only recolours the diagnostics (no re-trace), so it stays out of the deps.
    deps: [corpus.id, cases, ui.res, ui.ab],
    // Cache per case, keyed by corpus + the only two globals that move the numbers (res, ab —
    // gradients is per-case identity). Also makes paging back instant: `page` in the deps used to
    // discard the other page's traces, now they're served from the store.
    cache: {
      id: 'workbench',
      key: (c) => `${corpus.id}/${c.key}`,
      optionsKey: `res=${ui.res}&ab=${ui.ab}`,
      // Only `img` is heavy (a 512² ImageData), and after analyze nothing reads its pixels — the
      // shown raster lives in `rasterUrl`/`dropUrl`. Drop it to its dimensions before persisting.
      serialize: (r: AnalysisResult) =>
        'blocked' in r ? r : { ...r, img: { width: r.img.width, height: r.img.height } },
    },
  })

  const selectCorpus = (id: string) => {
    setUi({ page: 0 })
    setParams({ corpus: id }, { replace: true })
  }

  return (
    <LabPage
      storageKey="lab:workbench"
      title="Workbench"
      subtitle={`${corpus.label} · scored against the authored SVG`}
      status={corpus.available ? run.status : `${corpus.label} — not present in this build`}
      running={corpus.available && run.running}
      progress={run.progress}
      box={ui.box}
      onBox={(box) => setUi({ box })}
      wires={ui.wire}
      search={{ state: search, matched: all.length, total: corpusCases.length }}
      controls={
        <>
          <LabSelect
            label="Corpus"
            hint="Which images to score. Only that — the analysis below is the same for every corpus."
            value={corpus.id}
            onChange={selectCorpus}
            options={CORPORA.map((c) => ({ value: c.id, label: c.label }))}
          />
          <span className="hidden h-5 w-px shrink-0 bg-line sm:block" />
          <LabField
            label="Page"
            hint="Move between pages — the corpus is traced one page at a time so the tab stays responsive while it fills in."
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
          <LabSelect
            label="Per page"
            hint="How many cases to trace per page. Fewer settles faster; more shows more at once."
            value={ui.pageSize}
            onChange={(pageSize) => setUi({ pageSize, page: 0 })}
            options={PAGE_SIZES.map((n) => ({ value: n, label: String(n) }))}
          />
          <LabSelect
            label="Raster"
            hint="Rasterize the SVG at this width before tracing. Watch the scores stay flat across sizes — that's the scale-stability check."
            value={ui.res}
            onChange={(res) => setUi({ res })}
            options={TRUTH_RESOLUTIONS.map((r) => ({ value: r, label: `${r}px` }))}
          />
          <LabSelect
            label="Heat"
            hint="Full-scale of the miss/invented boundary heat maps, in px (a hot dot is that far from the other side's boundary). Recolours only — no re-trace."
            value={ui.heat}
            onChange={(heat) => setUi({ heat })}
            options={HEAT_SCALES.map((s) => ({ value: s, label: `0 → ${s}px` }))}
          />
          <LabCheck
            label="Nodes/edges"
            hint="Overlay the anchor wireframe on the truth + current-trace panels — square dots are corners, round are smooth, green rings are junction vertices (traced graph only). Pure CSS, no re-trace."
            checked={ui.wire}
            onChange={(wire) => setUi({ wire })}
          />
          {/* Only tier 1 carries flat twins, so the toggle only exists where it does something. */}
          {corpus.hasFlatTwins && (
            <LabCheck
              label="flat A/B"
              hint="Tier-1 gradient glyphs only: also trace and score the same glyph authored FLAT, so you can see the tracer inventing edges inside the gradient. Doubles the row's cost."
              checked={ui.ab}
              onChange={(ab) => setUi({ ab })}
            />
          )}
        </>
      }
      about={<WorkbenchAbout blurb={corpus.blurb} />}
    >
      {!corpus.available && corpus.emptyState}
      {corpus.available &&
        run.results.map((r) => (
          <AnalysisCaseRow key={r.case.key} c={r.case} value={r.value} error={r.error} ui={ui} />
        ))}
      {corpus.available && run.pending && (
        <PendingRow title={run.pending.title} note={run.pending.note} />
      )}
    </LabPage>
  )
}

function WorkbenchAbout({ blurb }: { blurb: string }) {
  return (
    <>
      <p className="mb-2 max-w-[96ch]">
        One question, asked of every corpus: <b>is the trace correct?</b> Each case is an{' '}
        <b>authored SVG that produced the pixels</b> — rasterized, traced, and the recovered vectors
        compared to the art itself. Every gate is an absolute distance from correct (<b>0px boundary
        error, parsimony 1.0, every region recovered</b>), so improvements move numbers down and
        nothing ever needs re-blessing. The <b>Corpus</b> selector changes which images and nothing
        else — the panels and the numbers mean the same thing wherever you point it.
      </p>
      <p className="mb-2 max-w-[96ch]">
        <b>This corpus.</b> {blurb}
      </p>
      <p className="mb-2 max-w-[96ch]">
        <b>Tiers are calibrated populations, not opinions.</b> Tier 0's limits (chamfer 1.0px / p95
        2.5px) were measured on crisp flat art; soft-edged gradient art is not gradeable there, so
        tiers 1 and 2 have their own limits measured on their own populations
        (<code>calibrateTier1.ts</code> / <code>calibrateTier2.ts</code>). Each row's badge says which
        limit it was held to — a green bar can never mean "we quietly widened tier 0". A corpus
        outside every calibrated population (the logos) gets the measurements and <b>no</b> pass/fail
        bars, because a borrowed limit is a verdict nobody measured.
      </p>
      <p className="mb-2 max-w-[96ch]">
        Raster-only art is deliberately not here: with no authored vector there is nothing to score
        against. Those images live in <b>Feature A/B</b> (compare revisions/variants) and the{' '}
        <b>Gallery</b> (just look). potrace vs crisp is the <b>Engine scoreboard</b>.
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
          <b className="text-ink">miss heat</b> — the VISIBLE authored boundary, coloured by how far
          the nearest traced boundary is. <span className="lab-ramp" /> Hot = the tracer{' '}
          <b>missed</b> that arc. Authored outline occluded behind later-painted shapes is excluded —
          no tracer can recover an edge that made no pixels.
        </div>
        <div className="max-w-[32ch]">
          <b className="text-ink">invented heat</b> — the traced boundary, coloured by distance to the
          nearest authored boundary. Hot = the tracer <b>invented</b> an edge the art does not have.
        </div>
        <div className="max-w-[32ch]">
          <b className="text-ink">dropped regions</b> — red marks a flat region the composited art
          contains and the trace does not. This is the failure raster fidelity is blind to: merging a
          small low-contrast region into its neighbour barely moves ΔE or SSIM while destroying the
          topology.
        </div>
      </div>
      <div className="mt-2 max-w-[96ch] rounded-md border border-ok/30 bg-ok/8 px-2.5 py-1.5 text-ok">
        <b>Rasterizer.</b> This page rasterizes with <code>@resvg/resvg-wasm</code> — the WebAssembly
        build of the <em>same</em> Rust engine the Node runner (<code>groundTruthRun.ts</code>) uses
        via <code>@resvg/resvg-js</code>, with the same options (<code>fitTo width</code>,{' '}
        <code>background: white</code>). Verified byte-identical, so <b>what you see is exactly what
        CI measures</b>. The corpus, trace options, gates and scoring are already the same modules
        (<code>truthCorpus.ts</code>, <code>geomScore.ts</code>, <code>svgGround.ts</code>).
      </div>
    </>
  )
}
