import { useEffect, useMemo, useState } from 'react'
import { LabCheck, LabPage, LabSelect } from '../LabPage'
import { useLabState } from '../useLabState'
import { useLabSearch } from '../useLabSearch'
import { HEADLINE_TOOL, corpusInfo, toolInfo, type BenchResults, type RunInfo, type ToolFamily } from './benchData'
import { Article } from './Article'
import { CasesTab, type CaseMode } from './CasesTab'
import { CompareTab } from './CompareTab'
import { DataTab } from './DataTab'
import { ResultsTab } from './ResultsTab'
import { RunTab } from './RunTab'
import { SHOWCASE } from './showcase.generated'
import { HUB_SOURCE, LOCAL_SOURCE, hubSource, parseRunIndex } from './benchSource'
import { BenchSourceProvider, HowToRun, type BenchSourceState } from './ui'

/** Dev reads the local runs unless `?source=hub` asks for the published ones; a build has
 *  no local endpoint, so it always reads the hub. In dev, `?hub=<base url>` reads a hub
 *  layout from elsewhere — a staged publish (.bench-tools/hf-staging/<run>/) served with
 *  CORS — so a publish can be looked at before it is uploaded. */
function pickSource() {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams()
  if (!import.meta.env.DEV) return HUB_SOURCE
  const base = q.get('hub')
  if (base) return hubSource(base)
  return q.get('source') === 'hub' ? HUB_SOURCE : LOCAL_SOURCE
}

/**
 * /labs/bench — the vectorizer comparison. /benchmark redirects here.
 *
 * Overview is the argument, written for someone who has never seen the benchmark, and the
 * one tab that needs no run (it reads frozen examples, showcase.generated.ts). The other five
 * read a bench/compare run from a SOURCE (benchSource.ts): in `vite dev` the gitignored
 * .bench-tools/results/, served by scripts/benchPlugin.ts; on the hosted site the published
 * Hugging Face dataset (bench/compare/publishHf.ts), whose runs ship SVGs and no PNG renders.
 * `?source=hub` reads the hub from dev too. When the source has no runs (the dataset is not
 * published yet, the network is down) the tabs say how to make one, as they always did:
 *
 *   Results   who wins, by the picture and by the drawing: a short table, detail on request
 *   Compare   any two tools head to head, and the cases where the two kinds of score disagree
 *   Cases     every tool's SVG for one case, as a picture, as nodes and kinks, as a ΔE map
 *   Data      where each case comes from, and how every tool did on it, one row per case
 *   Run       versions, provenance, and the diff against another run
 *
 * Each tab shows the controls IT uses and no others. The first version put every control and
 * every table on one screen, and that was the complaint: too much data at once.
 */

type Tab = 'overview' | 'results' | 'compare' | 'cases' | 'data' | 'run'

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'results', label: 'Results' },
  { id: 'compare', label: 'Compare' },
  { id: 'cases', label: 'Cases' },
  { id: 'data', label: 'Data' },
  { id: 'run', label: 'Run' },
]

const FAMILY_ORDER: ToolFamily[] = ['logolab', 'external', 'reference', 'ablation']

interface View {
  run: string
  tab: Tab
  corpus: string
  ablations: boolean
  metric: string
  box: number
  // Cases
  sortTool: string
  sortDir: 'worst' | 'best' | 'name'
  mode: CaseMode
  allTools: boolean
  // Compare
  a: string
  b: string
  x: string
  y: string
  // Run
  other: string
}

const DEFAULT_VIEW: View = {
  run: '',
  tab: 'overview',
  corpus: 'svgemoji-v0',
  ablations: false,
  metric: 'meanDeltaE',
  box: 220,
  sortTool: HEADLINE_TOOL,
  sortDir: 'worst',
  mode: 'picture',
  allTools: false,
  a: HEADLINE_TOOL,
  b: 'vtracer-default',
  x: 'sbDino',
  y: 'chamfer',
  other: '',
}

export default function BenchLab() {
  const [view, setView] = useLabState<View>('lab:bench:v2', DEFAULT_VIEW)
  const [runs, setRuns] = useState<RunInfo[] | null>(null)
  const [runsError, setRunsError] = useState<string | null>(null)
  const [data, setData] = useState<BenchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)
  const search = useLabSearch(() => setPage(0))
  const [source] = useState(pickSource)
  const hub = source.kind === 'hub'
  const tab = TABS.some((t) => t.id === view.tab) ? view.tab : 'overview'

  // The run list. On the hub a missing dataset (404) or no network is not an error to show:
  // it is "nothing published yet", and the tabs fall back to saying how to make a run.
  useEffect(() => {
    let live = true
    fetch(source.runsUrl)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: unknown) => live && setRuns(parseRunIndex(j)))
      .catch((e) => {
        if (!live) return
        if (hub) setRuns([])
        else setRunsError(String(e))
      })
    return () => {
      live = false
    }
  }, [source, hub])

  const sourceState = useMemo<BenchSourceState>(() => {
    const noRenders = new Set((runs ?? []).filter((r) => r.renders === false).map((r) => r.name))
    return { source, renders: (r: string) => !noRenders.has(r) }
  }, [source, runs])
  const available = !!runs && runs.length > 0

  // By default the run with the most tools, then the most rows: a smoke run is a run too,
  // but rarely the one you meant.
  const run = useMemo(() => {
    if (!runs?.length) return ''
    if (runs.some((r) => r.name === view.run)) return view.run
    return [...runs].sort(
      (a, b) => b.tools.length - a.tools.length || b.rows - a.rows || (b.date ?? '').localeCompare(a.date ?? ''),
    )[0].name
  }, [runs, view.run])

  useEffect(() => {
    if (!run) return
    let live = true
    setLoading(true)
    fetch(source.file(run, 'results.json'))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: BenchResults) => live && setData(j))
      .catch((e) => live && setRunsError(String(e)))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [run, source])

  const corpora = data?.meta.corpora ?? []
  const corpus = corpora.includes(view.corpus) ? view.corpus : (corpora[0] ?? '')
  const tools = useMemo(() => {
    const all = data?.meta.tools ?? []
    const shown = all.filter((t) => view.ablations || toolInfo(t).family !== 'ablation')
    return [...shown].sort(
      (a, b) =>
        FAMILY_ORDER.indexOf(toolInfo(a).family) - FAMILY_ORDER.indexOf(toolInfo(b).family) ||
        all.indexOf(a) - all.indexOf(b),
    )
  }, [data, view.ablations])

  // The search box's readout on Cases: cases in this corpus, and how many the query keeps.
  const caseCount = useMemo(() => {
    if (!data) return { matched: 0, total: 0 }
    const source = new Map(data.meta.cases.map((c) => [c.id, c.source]))
    const ids = new Set(data.rows.filter((r) => r.corpus === corpus).map((r) => r.caseId))
    let matched = 0
    for (const id of ids) if (search.match(id, source.get(id))) matched++
    return { matched, total: ids.size }
  }, [data, corpus, search.match])

  const go = (t: Tab) => {
    setView({ tab: t })
    window.scrollTo({ top: 0 })
  }
  const openCase = (caseId: string) => {
    search.setQuery(caseId.slice(caseId.indexOf('/') + 1))
    setPage(0)
    go('cases')
  }

  const ready = available && data && corpus
  const status =
    tab === 'overview'
      ? `A frozen summary of run ${SHOWCASE.run}: ${SHOWCASE.cases} held-out emoji, ${SHOWCASE.summary.length} tools.${available ? '' : ' The other tabs read a benchmark run.'}`
      : runsError
        ? `Could not load benchmark results: ${runsError}`
        : !runs
          ? 'Looking for runs…'
          : runs.length === 0
            ? hub
              ? 'No published benchmark run could be loaded.'
              : 'No runs yet in .bench-tools/results/.'
            : loading || !data
              ? `Loading ${run}…`
              : `${run}${hub ? ' (Hugging Face)' : ''} · ${corpusInfo(corpus).label} · ${new Date(data.meta.date).toLocaleDateString()}`

  const dataTab = tab !== 'overview'
  const controls = (
    <>
      <div className="inline-flex flex-wrap rounded-md border border-line bg-surface-2 p-0.5" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => go(t.id)}
            className={`rounded px-2.5 py-1 text-xs transition-colors ${tab === t.id ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {dataTab && runs && runs.length > 1 && tab !== 'run' && (
        <LabSelect
          label="Run"
          value={run}
          onChange={(v) => setView({ run: v })}
          hint={
            hub
              ? 'A run published to the logolab-bench dataset on Hugging Face.'
              : 'A directory under .bench-tools/results/ that holds a results.json.'
          }
          options={runs.map((r) => ({
            value: r.name,
            label: r.name,
            note: `${r.rows} rows${r.date ? ` · ${r.date.slice(0, 10)}` : ''}`,
          }))}
        />
      )}
      {dataTab && tab !== 'run' && corpora.length > 1 && (
        <LabSelect
          label="Corpus"
          value={corpus}
          onChange={(v) => {
            setPage(0)
            setView({ corpus: v })
          }}
          hint="Held-out corpora are the evidence; in-sample ones (the tracer was developed against them) explain it."
          options={corpora.map((c) => ({
            value: c,
            label: corpusInfo(c).label,
            group: corpusInfo(c).heldOut ? 'Held out' : 'In-sample',
          }))}
        />
      )}
      {(tab === 'results' || tab === 'compare') && (
        <LabCheck
          label="Ablations"
          checked={view.ablations}
          onChange={(ablations) => setView({ ablations })}
          hint="Also show LogoLab configurations no user gets: the preset without its probes and the layering × gradients grid."
        />
      )}
    </>
  )

  return (
    <BenchSourceProvider value={sourceState}>
      <LabPage
        storageKey="lab:bench"
        title="Benchmark"
        subtitle="LogoLab against classic tracers and image-to-SVG models, scored against the authored SVG"
        about={<About />}
        controls={controls}
        viewControls={tab === 'cases'}
        wires={tab === 'cases' && view.mode === 'nodes'}
        search={
          tab === 'cases' && ready ? { state: search, matched: caseCount.matched, total: caseCount.total } : undefined
        }
        status={status}
        running={dataTab && (loading || (!runs && !runsError))}
        box={view.box}
        onBox={(box) => setView({ box })}
      >
        {tab === 'overview' ? (
          <Article onExplore={() => go(available ? 'compare' : 'results')} />
        ) : runs && runs.length === 0 ? (
          <HowToRun compact />
        ) : ready ? (
          <>
            {tab === 'results' && (
              <ResultsTab
                data={data}
                corpus={corpus}
                tools={tools}
                metric={view.metric}
                onMetric={(metric) => setView({ metric })}
                onCase={openCase}
              />
            )}
            {tab === 'compare' && (
              <CompareTab
                data={data}
                run={run}
                corpus={corpus}
                tools={tools}
                view={{ a: view.a, b: view.b, x: view.x, y: view.y }}
                setView={setView}
                onCase={openCase}
              />
            )}
            {tab === 'cases' && (
              <CasesTab
                data={data}
                run={run}
                corpus={corpus}
                tools={tools}
                view={{
                  metric: view.metric,
                  sortTool: view.sortTool,
                  sortDir: view.sortDir,
                  mode: view.mode,
                  allTools: view.allTools,
                }}
                setView={setView}
                match={search.match}
                page={page}
                setPage={setPage}
              />
            )}
            {tab === 'data' && (
              <DataTab
                data={data}
                run={run}
                corpus={corpus}
                tools={tools}
                metric={view.metric}
                onMetric={(metric) => setView({ metric })}
                onCase={openCase}
              />
            )}
            {tab === 'run' && runs && (
              <RunTab data={data} run={run} runs={runs} other={view.other} onOther={(other) => setView({ other })} />
            )}
          </>
        ) : null}
      </LabPage>
    </BenchSourceProvider>
  )
}

function About() {
  return (
    <>
      <p>
        Every tool traces the same rasters, and every output goes through the <b>same scorer</b>{' '}
        (bench/compare/score.ts): the truth gate’s geometry against the authored SVG, the shipped ΔE, and SVG-Bench’s
        own metrics so the numbers line up with the StarVector paper. Nothing on this page re-scores anything.
      </p>
      <p>
        Start with <b>Overview</b>. <b>Results</b> is the leaderboard, <b>Compare</b> puts two tools head to head and
        finds the cases where the picture and the drawing disagree, <b>Cases</b> shows every output as a picture, as
        nodes and kinks, or as a colour-error map, <b>Data</b> lists every case with its source and licence, and{' '}
        <b>Run</b> says what produced the numbers.
      </p>
      <p>
        The in-sample corpora were used to develop LogoLab, so they can explain a result but not support one. The kink
        count is LogoLab’s own measure, and the ms column is not comparable across tools.
      </p>
    </>
  )
}
