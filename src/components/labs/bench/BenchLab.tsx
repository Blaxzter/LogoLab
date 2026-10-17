import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ExternalLink } from '../../ui/icons'
import { Tooltip } from '../../ui/Tooltip'
import { LabCheck, LabPage, LabSelect } from '../LabPage'
import { Badge, CaseRow, NoteBox } from '../CaseRow'
import { Panel } from '../Panel'
import { useLabState } from '../useLabState'
import { useLabSearch } from '../useLabSearch'
import { deltaEField, deltaEHeat } from '../../../lib/render/fidelity'
import { diffPicture } from '../../../lib/render/diffView'
import { heatCss } from '../../../lib/heat'
import {
  FAMILY_LABEL,
  GROUP_LABEL,
  HEADLINE_TOOL,
  METRICS,
  METRIC_BY_KEY,
  caseDir,
  caseTable,
  corpusInfo,
  fmt,
  num,
  paired,
  summarize,
  toolInfo,
  type BenchCaseMeta,
  type BenchResults,
  type BenchRow,
  type Metric,
  type MetricGroup,
  type RunInfo,
  type ToolFamily,
  type ToolSummary,
} from './benchData'

/**
 * /labs/bench — the vectorizer comparison, browsable. ONE question: how does each tool do
 * on each case, and where does that number come from?
 *
 * It reads what bench/compare/run.ts already measured (served from the gitignored
 * `.bench-tools/results/` by scripts/benchPlugin.ts, in `vite dev` only) and re-scores
 * nothing — except the Difference view, which paints the shipped `deltaEField` between a
 * tool's render and the authored render, the same field the run's ΔE column averages.
 *
 * Four tabs: Results (the leaderboard, the paired test, the distributions), Cases (every
 * tool's render of one case side by side), Datasets (where every case comes from, under
 * which licence) and Run (versions, provenance, the summary the CLI wrote).
 */

type Tab = 'results' | 'cases' | 'datasets' | 'run'

const TABS: { id: Tab; label: string }[] = [
  { id: 'results', label: 'Results' },
  { id: 'cases', label: 'Cases' },
  { id: 'datasets', label: 'Datasets' },
  { id: 'run', label: 'Run' },
]

const FAMILY_ORDER: ToolFamily[] = ['logolab', 'external', 'reference', 'ablation']
const PAGE = 10
const runUrl = (run: string, path: string) => `/__bench/runs/${encodeURIComponent(run)}/${path}`

interface View {
  run: string
  tab: Tab
  corpus: string
  ablations: boolean
  metric: string
  sortTool: string
  sortDir: 'worst' | 'best' | 'name'
  diff: boolean
  box: number
}

const DEFAULT_VIEW: View = {
  run: '',
  tab: 'results',
  corpus: 'svgemoji-v0',
  ablations: false,
  metric: 'meanDeltaE',
  sortTool: HEADLINE_TOOL,
  sortDir: 'worst',
  diff: false,
  box: 220,
}

export default function BenchLab() {
  const [view, setView] = useLabState<View>('lab:bench', DEFAULT_VIEW)
  const [runs, setRuns] = useState<RunInfo[] | null>(null)
  const [runsError, setRunsError] = useState<string | null>(null)
  const [data, setData] = useState<BenchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)
  const search = useLabSearch(() => setPage(0))

  // The run list. A hosted build has no endpoint — the page says how to make the data.
  useEffect(() => {
    if (!import.meta.env.DEV) {
      setRunsError('hosted')
      return
    }
    let live = true
    fetch('/__bench/runs')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { runs: RunInfo[] }) => live && setRuns(j.runs))
      .catch((e) => live && setRunsError(String(e)))
    return () => {
      live = false
    }
  }, [])

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
    fetch(runUrl(run, 'results.json'))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: BenchResults) => live && setData(j))
      .catch((e) => live && setRunsError(String(e)))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [run])

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

  // The search box's readout: cases in this corpus, and how many the settled query keeps.
  const caseCount = useMemo(() => {
    if (!data) return { matched: 0, total: 0 }
    const source = new Map(data.meta.cases.map((c) => [c.id, c.source]))
    const ids = new Set(data.rows.filter((r) => r.corpus === corpus).map((r) => r.caseId))
    let matched = 0
    for (const id of ids) if (search.match(id, source.get(id))) matched++
    return { matched, total: ids.size }
  }, [data, corpus, search.match])

  const openCase = (caseId: string) => {
    search.setQuery(caseId.slice(caseId.indexOf('/') + 1))
    setPage(0)
    setView({ tab: 'cases' })
    window.scrollTo({ top: 0 })
  }

  const status = runsError
    ? runsError === 'hosted'
      ? 'The benchmark results are local — run it, then open this lab under `vite dev`.'
      : `Could not load benchmark results: ${runsError}`
    : !runs
      ? 'Looking for runs…'
      : runs.length === 0
        ? 'No runs yet in .bench-tools/results/.'
        : loading || !data
          ? `Loading ${run}…`
          : `${run} · ${data.rows.length} scored outputs · ${data.meta.tools.length} tools · ${data.meta.corpora.length} corpora · traced at ${data.meta.res}px · ${new Date(data.meta.date).toLocaleString()}`

  const controls = (
    <>
      <div className="inline-flex rounded-md border border-line bg-surface-2 p-0.5" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={view.tab === t.id}
            onClick={() => setView({ tab: t.id })}
            className={`rounded px-2.5 py-1 text-xs transition-colors ${view.tab === t.id ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {runs && runs.length > 0 && (
        <LabSelect
          label="Run"
          value={run}
          onChange={(v) => setView({ run: v })}
          hint="A directory under .bench-tools/results/ that holds a results.json. Write one with `node --experimental-strip-types bench/compare/run.ts --run <name>`."
          options={runs.map((r) => ({
            value: r.name,
            label: r.name,
            note: `${r.rows} rows${r.date ? ` · ${r.date.slice(0, 10)}` : ''}`,
          }))}
        />
      )}
      {corpora.length > 0 && (
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
      <LabCheck
        label="Ablations"
        checked={view.ablations}
        onChange={(ablations) => setView({ ablations })}
        hint="Also show LogoLab configurations no user gets — the preset without its probes and the layering × gradients grid. They attribute a difference; they are not results."
      />
    </>
  )

  return (
    <LabPage
      storageKey="lab:bench"
      title="Benchmark"
      subtitle="LogoLab against VTracer, Potrace and StarVector, scored against the authored SVG"
      about={<About />}
      controls={controls}
      search={
        view.tab === 'cases' && data ? { state: search, matched: caseCount.matched, total: caseCount.total } : undefined
      }
      status={status}
      running={loading || (!runs && !runsError)}
      box={view.box}
      onBox={(box) => setView({ box })}
    >
      {runsError === 'hosted' || (runs && runs.length === 0) ? (
        <HowToRun />
      ) : data && corpus ? (
        <>
          {view.tab === 'results' && (
            <ResultsTab data={data} corpus={corpus} tools={tools} view={view} setView={setView} onCase={openCase} />
          )}
          {view.tab === 'cases' && (
            <CasesTab
              data={data}
              run={run}
              corpus={corpus}
              tools={tools}
              view={view}
              setView={setView}
              match={search.match}
              page={page}
              setPage={setPage}
            />
          )}
          {view.tab === 'datasets' && <DatasetsTab data={data} run={run} onCase={openCase} />}
          {view.tab === 'run' && <RunTab data={data} run={run} />}
        </>
      ) : null}
    </LabPage>
  )
}

// ---------------------------------------------------------------------------
// Results

function ResultsTab({
  data,
  corpus,
  tools,
  view,
  setView,
  onCase,
}: {
  data: BenchResults
  corpus: string
  tools: string[]
  view: View
  setView: (p: Partial<View>) => void
  onCase: (id: string) => void
}) {
  const info = corpusInfo(corpus)
  const summaries = useMemo(() => summarize(data.rows, corpus, tools), [data, corpus, tools])
  const table = useMemo(() => caseTable(data.rows, corpus), [data, corpus])
  const metric = METRIC_BY_KEY.get(view.metric) ?? METRICS[0]
  const nCases = table.size

  return (
    <div className="space-y-6 px-4 pb-10">
      <CorpusHeader corpus={corpus} n={nCases} />

      <section>
        <SectionTitle
          title="Leaderboard"
          note="Medians over the cases each tool produced a scorable output for (n). The best value in each column is marked."
        />
        <Leaderboard summaries={summaries} nCases={nCases} />
      </section>

      {tools.includes(HEADLINE_TOOL) && (
        <section>
          <SectionTitle
            title={`Paired against ${toolInfo(HEADLINE_TOOL).label}`}
            note="Mean of (tool − LogoLab) over the cases both scored, with a 95% paired-bootstrap interval. ✔ = the interval excludes 0. W/L = cases the tool is strictly better / worse on. Green = the tool beats LogoLab."
          />
          <PairedTable table={table} tools={tools.filter((t) => t !== HEADLINE_TOOL)} />
        </section>
      )}

      <section>
        <SectionTitle
          title="Distribution"
          note="One dot per case. Click a dot to open that case. Heavy tails are where a median hides failures."
          right={
            <LabSelect
              label="Metric"
              value={metric.key}
              onChange={(v) => setView({ metric: v })}
              options={METRICS.map((m) => ({ value: m.key, label: m.label, group: GROUP_LABEL[m.group] }))}
            />
          }
        />
        <StripPlot data={data} corpus={corpus} tools={tools} metric={metric} onCase={onCase} />
      </section>

      {!info.heldOut && (
        <NoteBox tone="warn">
          This corpus is <b>in-sample</b>: LogoLab was developed against it. A win here explains a mechanism; it is not
          evidence. Switch to an SVG-Bench corpus for that.
        </NoteBox>
      )}
    </div>
  )
}

function CorpusHeader({ corpus, n }: { corpus: string; n: number }) {
  const info = corpusInfo(corpus)
  return (
    <div className="mt-2 rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-ink">{info.label}</h2>
        <Badge tone={info.heldOut ? 'ok' : 'warn'}>{info.heldOut ? 'held out' : 'in-sample'}</Badge>
        <span className="text-[0.7rem] text-faint">
          {n} cases · {info.license}
        </span>
      </div>
      <p className="mt-1 max-w-[90ch] text-xs leading-relaxed text-muted">{info.blurb}</p>
    </div>
  )
}

function SectionTitle({ title, note, right }: { title: string; note?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-end gap-x-4 gap-y-1">
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {note && <p className="max-w-[100ch] text-[0.7rem] leading-relaxed text-muted">{note}</p>}
      </div>
      {right && <div className="text-xs">{right}</div>}
    </div>
  )
}

// Grouped so each group's columns are contiguous (the header spans them).
const LEADER_COLS = [
  'meanDeltaE',
  'chamfer',
  'p95',
  'nodeRatio',
  'tangentBreaks',
  'cornersInvented',
  'sbDino',
  'sbLpips',
  'sbSsim',
  'docNodes',
  'bytes',
  'ms',
]

function Leaderboard({ summaries, nCases }: { summaries: ToolSummary[]; nCases: number }) {
  const cols = LEADER_COLS.map((k) => METRIC_BY_KEY.get(k)).filter((m): m is Metric => !!m)
  // The best median per column, among tools scored on at least half the cases — a tool
  // that parsed on 3 cases should not win a column on those 3.
  const best = new Map<string, number>()
  for (const m of cols) {
    const vals = summaries
      .filter((s) => s.metrics[m.key].n >= nCases / 2)
      .map((s) => s.metrics[m.key].median)
      .filter(Number.isFinite)
    if (vals.length) best.set(m.key, m.better === 'lower' ? Math.min(...vals) : Math.max(...vals))
  }
  const groups: { group: MetricGroup; span: number }[] = []
  for (const m of cols) {
    const last = groups[groups.length - 1]
    if (last && last.group === m.group) last.span++
    else groups.push({ group: m.group, span: 1 })
  }
  let family: ToolFamily | null = null
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[900px] text-xs tabular-nums">
        <thead className="bg-surface-2 text-[0.68rem] text-muted">
          <tr>
            <th colSpan={4} />
            {groups.map((g, i) => (
              <th
                key={`${g.group}-${i}`}
                colSpan={g.span}
                className="border-l border-line px-2 pt-1.5 text-left font-medium"
              >
                {GROUP_LABEL[g.group]}
              </th>
            ))}
          </tr>
          <tr className="border-b border-line">
            <th className="px-2 py-1.5 text-left font-medium">Tool</th>
            <Th hint="Cases this tool was run on.">n</Th>
            <Th hint="Outputs that failed to parse or render. Scored, never dropped.">fail</Th>
            <Th hint="Cases where EVERY applicable truth-gate check passes, at tool-neutral limits. The zero-tolerance tangent-break gate dominates it for every tool — read it as a LogoLab lens, not a verdict.">
              all gates
            </Th>
            {cols.map((m, i) => (
              <Th key={m.key} hint={m.help} first={i === 0 || cols[i - 1].group !== m.group}>
                {m.label}
                <span className="ml-0.5 text-faint">{m.better === 'lower' ? '↓' : '↑'}</span>
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {summaries.map((s) => {
            const info = toolInfo(s.tool)
            const header =
              info.family !== family ? (
                <tr key={`f-${info.family}`} className="bg-surface-2/60">
                  <td colSpan={4 + cols.length} className="px-2 py-1 text-[0.62rem] uppercase tracking-wide text-faint">
                    {FAMILY_LABEL[info.family]}
                  </td>
                </tr>
              ) : null
            family = info.family
            return [
              header,
              <tr
                key={s.tool}
                className={`border-t border-line ${s.tool === HEADLINE_TOOL ? 'bg-accent-soft/40' : ''}`}
              >
                <td className="px-2 py-1.5">
                  <ToolName tool={s.tool} />
                </td>
                <td className="px-2 text-right">{s.n}</td>
                <td className={`px-2 text-right ${s.failures ? 'text-bad' : 'text-faint'}`}>{s.failures}</td>
                <td className="px-2 text-right">{s.gatesAllPass}</td>
                {cols.map((m, i) => {
                  const d = s.metrics[m.key]
                  const isBest = best.get(m.key) === d.median && d.n >= nCases / 2
                  return (
                    <td
                      key={m.key}
                      className={`px-2 text-right ${i === 0 || cols[i - 1].group !== m.group ? 'border-l border-line' : ''} ${isBest ? 'font-semibold text-good' : ''}`}
                    >
                      <Tooltip
                        label={
                          d.n
                            ? `n ${d.n} · mean ${fmt(d.mean, m.digits)} · IQR ${fmt(d.p25, m.digits)}–${fmt(d.p75, m.digits)} · max ${fmt(d.max, m.digits)}`
                            : 'not scored'
                        }
                      >
                        <span>
                          {fmt(d.median, m.digits)}
                          {d.n > 0 && d.n < s.n && <sup className="ml-0.5 text-[0.55rem] text-warn">{d.n}</sup>}
                        </span>
                      </Tooltip>
                    </td>
                  )
                })}
              </tr>,
            ]
          })}
        </tbody>
      </table>
    </div>
  )
}

function Th({ children, hint, first }: { children: ReactNode; hint: string; first?: boolean }) {
  return (
    <th className={`px-2 py-1.5 text-right font-medium ${first ? 'border-l border-line' : ''}`}>
      <Tooltip label={hint} side="bottom">
        <span className="cursor-help whitespace-nowrap">{children}</span>
      </Tooltip>
    </th>
  )
}

function ToolName({ tool }: { tool: string }) {
  const info = toolInfo(tool)
  return (
    <Tooltip
      label={
        <>
          <b>{tool}</b> — {info.blurb}
        </>
      }
    >
      <span className="cursor-help whitespace-nowrap font-medium text-ink">
        {info.label}
        {tool === HEADLINE_TOOL && <span className="ml-1 text-accent">★</span>}
      </span>
    </Tooltip>
  )
}

const PAIRED_COLS = ['meanDeltaE', 'chamfer', 'docNodes', 'tangentBreaks', 'sbDino', 'sbLpips', 'sbSsim']
  .map((k) => METRIC_BY_KEY.get(k))
  .filter((m): m is Metric => !!m)

function PairedTable({ table, tools }: { table: Map<string, Map<string, BenchRow>>; tools: string[] }) {
  const cols = PAIRED_COLS
  const cells = useMemo(
    () => tools.map((t) => ({ tool: t, results: cols.map((m) => paired(table, t, HEADLINE_TOOL, m)) })),
    [table, tools],
  )
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[820px] text-xs tabular-nums">
        <thead className="border-b border-line bg-surface-2 text-[0.68rem] text-muted">
          <tr>
            <th className="px-2 py-1.5 text-left font-medium">Tool − LogoLab</th>
            {cols.map((m) => (
              <Th key={m.key} hint={m.help}>
                {m.label}
                <span className="ml-0.5 text-faint">{m.better === 'lower' ? '↓' : '↑'}</span>
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cells.map(({ tool, results }) => (
            <tr key={tool} className="border-t border-line">
              <td className="px-2 py-1.5">
                <ToolName tool={tool} />
              </td>
              {results.map((p, i) => {
                const m = cols[i]
                if (!p)
                  return (
                    <td key={m.key} className="px-2 text-right text-faint">
                      —
                    </td>
                  )
                const toolBetter = m.better === 'lower' ? p.meanDiff < 0 : p.meanDiff > 0
                const tone = !p.significant ? 'text-muted' : toolBetter ? 'text-good' : 'text-bad'
                const d = Math.max(m.digits, 2)
                return (
                  <td key={m.key} className={`px-2 py-1 text-right ${tone}`}>
                    <Tooltip label={`95% CI [${fmt(p.lo, d)}, ${fmt(p.hi, d)}] over ${p.n} paired cases`}>
                      <span className="whitespace-nowrap">
                        {p.meanDiff > 0 ? '+' : ''}
                        {fmt(p.meanDiff, d)}
                        {p.significant ? ' ✔' : ''}
                        <span className="ml-1 text-[0.62rem] text-faint">
                          {p.wins}/{p.losses}
                        </span>
                      </span>
                    </Tooltip>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Dots per case, one row per tool, on a log1p axis for the heavy-tailed error metrics
 *  (a linear axis spends all its width on StarVector's 50px outliers) and linear for the
 *  bounded literature scores. */
function StripPlot({
  data,
  corpus,
  tools,
  metric,
  onCase,
}: {
  data: BenchResults
  corpus: string
  tools: string[]
  metric: Metric
  onCase: (id: string) => void
}) {
  const [hover, setHover] = useState<{ tool: string; caseId: string; v: number } | null>(null)
  const series = useMemo(
    () =>
      tools
        .map((tool) => ({
          tool,
          pts: data.rows
            .filter((r) => r.corpus === corpus && r.tool === tool)
            .map((r) => ({ caseId: r.caseId, v: num(r, metric.key) }))
            .filter((p): p is { caseId: string; v: number } => p.v !== null),
        }))
        .filter((s) => s.pts.length),
    [data, corpus, tools, metric],
  )
  const all = series.flatMap((s) => s.pts.map((p) => p.v))
  if (!all.length) return <p className="text-xs text-muted">No values for {metric.label} on this corpus.</p>
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const log = metric.group !== 'literature' && lo >= 0
  const f = (v: number) => (log ? Math.log1p(v) : v)
  const span = f(hi) - f(lo) || 1
  const W = 1000
  const L = 150
  const R = 20
  const rowH = 26
  const x = (v: number) => L + ((f(v) - f(lo)) / span) * (W - L - R)
  const ticks = log
    ? [0, 0.3, 1, 3, 10, 30, 100, 300, 1000, 3000, 10000, 30000].filter((t) => t >= lo && t <= hi)
    : Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4)
  const H = series.length * rowH + 24
  return (
    <div className="rounded-lg border border-line bg-surface p-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full"
        role="img"
        aria-label={`${metric.label} per case, per tool`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={0} y2={H - 18} className="stroke-line" strokeWidth={1} />
            <text x={x(t)} y={H - 4} textAnchor="middle" className="fill-faint text-[11px]">
              {fmt(
                t,
                t < 1 && t > 0 ? Math.max(1, metric.digits) : metric.digits === 0 ? 0 : Math.min(2, metric.digits),
              )}
            </text>
          </g>
        ))}
        {series.map((s, i) => {
          const y = i * rowH + rowH / 2
          const sorted = s.pts.map((p) => p.v).sort((a, b) => a - b)
          const med = sorted[Math.floor((sorted.length - 1) / 2)]
          return (
            <g key={s.tool}>
              <text x={L - 8} y={y + 4} textAnchor="end" className="fill-ink-2 text-[12px]">
                {toolInfo(s.tool).label}
              </text>
              {s.pts.map((p, k) => (
                <circle
                  key={p.caseId}
                  cx={x(p.v)}
                  // a deterministic jitter, so coincident values still read as many
                  cy={y + (((k * 7919) % 13) - 6) * 0.9}
                  r={hover?.caseId === p.caseId ? 5 : 3}
                  className={`cursor-pointer ${s.tool === HEADLINE_TOOL ? 'fill-accent' : 'fill-ink-2'} ${hover?.caseId === p.caseId ? 'opacity-100' : 'opacity-45'}`}
                  onMouseEnter={() => setHover({ tool: s.tool, caseId: p.caseId, v: p.v })}
                  onMouseLeave={() => setHover(null)}
                  role="button"
                  tabIndex={0}
                  aria-label={`${p.caseId}: ${fmt(p.v, metric.digits)}`}
                  onClick={() => onCase(p.caseId)}
                  onKeyDown={(e) => e.key === 'Enter' && onCase(p.caseId)}
                />
              ))}
              <line x1={x(med)} x2={x(med)} y1={y - 9} y2={y + 9} className="stroke-bad" strokeWidth={2} />
            </g>
          )
        })}
      </svg>
      <div className="h-5 px-1 text-[0.7rem] text-muted">
        {hover ? (
          <>
            <b className="text-ink">{hover.caseId}</b> · {toolInfo(hover.tool).label} · {metric.label}{' '}
            {fmt(hover.v, metric.digits)} — the same case is highlighted in every row
          </>
        ) : (
          <>
            Red tick = median. {log ? 'Axis is log(1 + x).' : 'Linear axis.'} {metric.help}
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cases

const SORT_OPTIONS = [
  { value: 'worst' as const, label: 'Worst first' },
  { value: 'best' as const, label: 'Best first' },
  { value: 'name' as const, label: 'By name' },
]

function CasesTab({
  data,
  run,
  corpus,
  tools,
  view,
  setView,
  match,
  page,
  setPage,
}: {
  data: BenchResults
  run: string
  corpus: string
  tools: string[]
  view: View
  setView: (p: Partial<View>) => void
  match: (...fields: (string | undefined | null)[]) => boolean
  page: number
  setPage: (p: number) => void
}) {
  const table = useMemo(() => caseTable(data.rows, corpus), [data, corpus])
  const metric = METRIC_BY_KEY.get(view.metric) ?? METRICS[0]
  const sortTool = tools.includes(view.sortTool) ? view.sortTool : (tools[0] ?? HEADLINE_TOOL)
  const meta = useMemo(() => new Map(data.meta.cases.map((c) => [c.id, c])), [data])

  const ids = useMemo(() => {
    const list = [...table.keys()].filter((id) => match(id, meta.get(id)?.source))
    if (view.sortDir === 'name') return list.sort()
    const v = (id: string) => num(table.get(id)?.get(sortTool), metric.key)
    // Missing values sink to the end in both directions — "worst first" must not lead
    // with cases that were never scored.
    const sign = (view.sortDir === 'worst') === (metric.better === 'lower') ? -1 : 1
    return list.sort((a, b) => {
      const va = v(a)
      const vb = v(b)
      if (va === null) return vb === null ? 0 : 1
      if (vb === null) return -1
      return sign * (va - vb)
    })
  }, [table, match, meta, view.sortDir, sortTool, metric])

  const pages = Math.max(1, Math.ceil(ids.length / PAGE))
  const p = Math.min(page, pages - 1)
  const shown = ids.slice(p * PAGE, p * PAGE + PAGE)

  return (
    <div className="pb-10">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2 text-xs">
        <LabSelect
          label="Sort by"
          value={metric.key}
          onChange={(v) => setView({ metric: v })}
          options={METRICS.map((m) => ({ value: m.key, label: m.label, group: GROUP_LABEL[m.group] }))}
        />
        <LabSelect
          label="of"
          value={sortTool}
          onChange={(v) => setView({ sortTool: v })}
          options={tools.map((t) => ({ value: t, label: toolInfo(t).label }))}
        />
        <LabSelect
          label="Order"
          value={view.sortDir}
          onChange={(v) => setView({ sortDir: v })}
          options={SORT_OPTIONS}
        />
        <LabCheck
          label="Difference"
          checked={view.diff}
          onChange={(diff) => setView({ diff })}
          hint="Paint every render's per-pixel ΔE against the authored render — the shipped deltaEField, the same field the ΔE column averages — over a dim ghost of the art."
        />
        <span className="ml-auto text-faint">
          {ids.length} cases{ids.length !== table.size && ` of ${table.size}`} · page
        </span>
        <Pager page={p} pages={pages} setPage={setPage} />
      </div>
      {shown.map((id) => (
        <CaseView
          key={id}
          run={run}
          caseId={id}
          byTool={table.get(id) ?? new Map()}
          tools={tools}
          meta={meta.get(id)}
          diff={view.diff}
          focus={metric}
        />
      ))}
      {pages > 1 && (
        <div className="flex justify-end px-4 py-3 text-xs">
          <Pager page={p} pages={pages} setPage={setPage} />
        </div>
      )}
    </div>
  )
}

function Pager({ page, pages, setPage }: { page: number; pages: number; setPage: (p: number) => void }) {
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        className="btn btn-ghost h-7 px-2 text-xs"
        disabled={page === 0}
        onClick={() => setPage(page - 1)}
      >
        ‹
      </button>
      <span className="tabular-nums text-muted">
        {page + 1}/{pages}
      </span>
      <button
        type="button"
        className="btn btn-ghost h-7 px-2 text-xs"
        disabled={page >= pages - 1}
        onClick={() => setPage(page + 1)}
      >
        ›
      </button>
    </span>
  )
}

const CASE_METRICS = ['meanDeltaE', 'chamfer', 'docNodes', 'tangentBreaks']

function CaseView({
  run,
  caseId,
  byTool,
  tools,
  meta,
  diff,
  focus,
}: {
  run: string
  caseId: string
  byTool: Map<string, BenchRow>
  tools: string[]
  meta: BenchCaseMeta | undefined
  diff: boolean
  focus: Metric
}) {
  const dir = caseDir(caseId)
  const truth = runUrl(run, `${dir}/truth.png`)
  const [aspect, setAspect] = useState(1)
  const any = byTool.values().next().value as BenchRow | undefined
  const keys = [focus.key, ...CASE_METRICS.filter((k) => k !== focus.key)].slice(0, 4)
  // The best value of the focused metric in this row, so the winner of the case is visible.
  const vals = tools.map((t) => num(byTool.get(t), focus.key)).filter((v): v is number => v !== null)
  const best = vals.length ? (focus.better === 'lower' ? Math.min(...vals) : Math.max(...vals)) : null

  return (
    <CaseRow
      title={caseId.slice(caseId.indexOf('/') + 1)}
      note={meta?.source}
      badges={
        <>
          {meta && <Badge>{meta.license}</Badge>}
          {any && <Badge tone={any.heldOut ? 'ok' : 'warn'}>{any.heldOut ? 'held out' : 'in-sample'}</Badge>}
          {any && <Badge tone="neutral">{any.lane}</Badge>}
          {meta?.gtRefusal && <Badge tone="warn">geometry n/a: {meta.gtRefusal}</Badge>}
        </>
      }
      right={
        <span className="inline-flex gap-2">
          <a
            href={runUrl(run, `gt/${caseId}`)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 hover:text-accent"
          >
            authored SVG <ExternalLink size={10} />
          </a>
        </span>
      }
    >
      <Panel label="Authored" note="the answer sheet, rendered with resvg" aspect={aspect} pixelated>
        <img
          src={truth}
          alt=""
          onLoad={(e) => setAspect(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)}
        />
      </Panel>
      {tools.map((tool) => {
        const r = byTool.get(tool)
        if (!r) return null
        const v = num(r, focus.key)
        return (
          <Panel
            key={tool}
            aspect={aspect}
            dark={diff}
            pixelated
            label={
              <span className="inline-flex items-center gap-1">
                <ToolName tool={tool} />
                <a
                  href={runUrl(run, `${dir}/${tool}.svg`)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-faint hover:text-accent"
                  aria-label={`Open ${tool}'s SVG`}
                >
                  <ExternalLink size={10} />
                </a>
              </span>
            }
            note={
              <>
                <span className="tabular-nums">
                  {keys.map((k, i) => {
                    const m = METRIC_BY_KEY.get(k)
                    if (!m) return null
                    const val = num(r, k)
                    const win = k === focus.key && val !== null && val === best && vals.length > 1
                    return (
                      <span key={k} className={win ? 'font-semibold text-good' : ''}>
                        {i > 0 && ' · '}
                        {m.label} {fmt(val, m.digits)}
                      </span>
                    )
                  })}
                </span>
                {r.status !== 'ok' && <span className="text-bad"> · {r.status}</span>}
                {r.failedGates && r.failedGates.length > 0 && (
                  <span className="text-faint"> · fails {r.failedGates.join(', ')}</span>
                )}
                {r.notes && (
                  <Tooltip label={r.notes}>
                    <span className="cursor-help text-faint"> · notes</span>
                  </Tooltip>
                )}
                {v === null && r.geomRefusal && <span className="text-warn"> · {r.geomRefusal}</span>}
              </>
            }
          >
            {diff ? (
              <DiffArt truth={truth} render={runUrl(run, `${dir}/${tool}.png`)} />
            ) : (
              <img src={runUrl(run, `${dir}/${tool}.png`)} alt="" loading="lazy" />
            )}
          </Panel>
        )
      })}
    </CaseRow>
  )
}

// One decode per URL for the life of the page: the authored render is the left side of
// every tool's difference in its row.
const pixelCache = new Map<string, Promise<ImageData>>()

function loadPixels(url: string, size?: { w: number; h: number }): Promise<ImageData> {
  const key = size ? `${url}@${size.w}x${size.h}` : url
  let hit = pixelCache.get(key)
  if (!hit) {
    hit = new Promise<ImageData>((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const w = size?.w ?? img.naturalWidth
        const h = size?.h ?? img.naturalHeight
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const g = c.getContext('2d', { willReadFrequently: true })
        if (!g) return reject(new Error('no 2d context'))
        g.drawImage(img, 0, 0, w, h)
        resolve(g.getImageData(0, 0, w, h))
      }
      img.onerror = () => reject(new Error(`could not load ${url}`))
      img.src = url
    })
    pixelCache.set(key, hit)
  }
  return hit
}

/** The studio's Difference picture for one render: heat over a ghost of the art, from ONE
 *  deltaEField call (CLAUDE.md: the number and the picture are one field). The render is
 *  resampled to the authored render's size if the two differ. */
function DiffArt({ truth, render }: { truth: string; render: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [mean, setMean] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    ;(async () => {
      const src = await loadPixels(truth)
      const out = await loadPixels(render, { w: src.width, h: src.height })
      if (!live) return
      const field = deltaEField(src.data, out.data, src.width, src.height)
      const pic = diffPicture(deltaEHeat(field.de), field.de, src.data, src.width, src.height)
      const c = ref.current
      if (!c) return
      c.width = src.width
      c.height = src.height
      const g = c.getContext('2d')
      if (g) {
        const img = g.createImageData(src.width, src.height)
        img.data.set(pic)
        g.putImageData(img, 0, 0)
      }
      let s = 0
      for (let i = 0; i < field.de.length; i++) s += field.de[i]
      setMean(s / field.de.length)
    })().catch((e) => live && setErr(String(e)))
    return () => {
      live = false
    }
  }, [truth, render])
  return (
    <>
      <canvas ref={ref} />
      {err && <span className="absolute inset-x-1 top-1 text-[0.6rem] text-bad">{err}</span>}
      {mean !== null && (
        <span
          className="absolute bottom-1 right-1 rounded px-1 text-[0.6rem] tabular-nums text-white"
          style={{ background: heatCss(Math.min(1, mean / 5)) }}
        >
          ΔE {mean.toFixed(2)}
        </span>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Datasets

interface Manifest {
  dataset: string
  revision: string
  split: string
  url: string
  parquetSha256: string
  note: string
  rows: { file: string; source: string; license: string; home?: string; sha256: string; v0: boolean }[]
}

function DatasetsTab({ data, run, onCase }: { data: BenchResults; run: string; onCase: (id: string) => void }) {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  useEffect(() => {
    let live = true
    fetch('/__bench/manifest')
      .then((r) => (r.ok ? r.json() : null))
      .then((m: Manifest | null) => live && setManifest(m))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  const byCorpus = useMemo(() => {
    const m = new Map<string, BenchCaseMeta[]>()
    for (const c of data.meta.cases) {
      const corpus = c.id.slice(0, c.id.indexOf('/'))
      m.set(corpus, [...(m.get(corpus) ?? []), c])
    }
    return m
  }, [data])

  return (
    <div className="space-y-6 px-4 py-3 pb-10">
      <NoteBox tone="info">
        Every case carries its <b>authored SVG</b> — the vector art that produced the pixels — so every tool is scored
        against the drawing itself, not against another tracer. A corpus is <b>held out</b> when LogoLab was never tuned
        on it: only those are evidence. The renders below are what every tool was given (resvg on white, {data.meta.res}
        px).
      </NoteBox>
      {[...byCorpus.entries()].map(([corpus, cases]) => {
        const info = corpusInfo(corpus)
        const licenses = new Map<string, number>()
        for (const c of cases) licenses.set(c.license, (licenses.get(c.license) ?? 0) + 1)
        const refused = cases.filter((c) => c.gtRefusal).length
        return (
          <section key={corpus} className="rounded-lg border border-line bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-ink">{info.label}</h2>
              <Badge tone={info.heldOut ? 'ok' : 'warn'}>{info.heldOut ? 'held out' : 'in-sample'}</Badge>
              <span className="text-[0.7rem] text-faint">{cases.length} cases</span>
              {info.sourceUrl && (
                <a
                  href={info.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto inline-flex items-center gap-1 text-[0.7rem] text-muted hover:text-accent"
                >
                  source <ExternalLink size={10} />
                </a>
              )}
            </div>
            <p className="mt-1 max-w-[100ch] text-xs leading-relaxed text-muted">{info.blurb}</p>
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[0.7rem]">
              <dt className="text-faint">Source</dt>
              <dd className="text-ink-2">{info.source}</dd>
              <dt className="text-faint">Licences</dt>
              <dd className="text-ink-2">{[...licenses.entries()].map(([l, n]) => `${l} × ${n}`).join(' · ')}</dd>
              {refused > 0 && (
                <>
                  <dt className="text-faint">Geometry n/a</dt>
                  <dd className="text-warn">
                    {refused} cases — the authored SVG uses strokes or clips the geometry scorer cannot model; they keep
                    their pixel metrics rather than being dropped
                  </dd>
                </>
              )}
              {corpus.startsWith('svgemoji') && manifest && (
                <>
                  <dt className="text-faint">Pinned</dt>
                  <dd className="break-all font-mono text-ink-2">
                    {manifest.dataset}@{manifest.revision.slice(0, 12)} · {manifest.split} · parquet sha256{' '}
                    {manifest.parquetSha256.slice(0, 16)}…
                  </dd>
                  <dt className="text-faint">Selection</dt>
                  <dd className="text-ink-2">{manifest.note}</dd>
                  <dt className="text-faint">Split</dt>
                  <dd className="text-ink-2">
                    {manifest.rows.length} rows:{' '}
                    {Object.entries(
                      manifest.rows.reduce<Record<string, number>>((acc, r) => {
                        acc[r.source] = (acc[r.source] ?? 0) + 1
                        return acc
                      }, {}),
                    )
                      .map(([s, n]) => `${s} ${n}`)
                      .join(' · ')}
                  </dd>
                </>
              )}
            </dl>
            <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1.5">
              {cases.map((c) => (
                <Tooltip
                  key={c.id}
                  label={`${c.id} · ${c.license}${c.gtRefusal ? ` · geometry n/a (${c.gtRefusal})` : ''}`}
                >
                  <button
                    type="button"
                    onClick={() => onCase(c.id)}
                    className={`checkerboard dark:checkerboard-dark aspect-square overflow-hidden rounded border transition-colors hover:border-accent ${c.gtRefusal ? 'border-warn/60' : 'border-line'}`}
                  >
                    <img
                      src={runUrl(run, `${caseDir(c.id)}/truth.png`)}
                      alt={c.id}
                      loading="lazy"
                      className="h-full w-full object-contain"
                    />
                  </button>
                </Tooltip>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Run

function RunTab({ data, run }: { data: BenchResults; run: string }) {
  const [summary, setSummary] = useState<string | null>(null)
  const [attribution, setAttribution] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const text = (p: string) => fetch(runUrl(run, p)).then((r) => (r.ok ? r.text() : null))
    text('summary.md').then((t) => live && setSummary(t))
    text('ATTRIBUTION.md').then((t) => live && setAttribution(t))
    return () => {
      live = false
    }
  }, [run])
  const m = data.meta
  const git = (m.provenance?.git ?? null) as {
    head?: string
    dirty?: boolean
    status?: string[]
    diffSha1?: string
  } | null
  return (
    <div className="space-y-6 px-4 py-3 pb-10">
      <section>
        <SectionTitle title="Tools and versions" note="What every row ran, exactly as the run recorded it." />
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-xs">
            <tbody>
              {m.tools.map((t) => (
                <tr key={t} className="border-t border-line first:border-t-0">
                  <td className="w-56 px-2 py-1.5 align-top">
                    <ToolName tool={t} />
                    <div className="font-mono text-[0.62rem] text-faint">{t}</div>
                  </td>
                  <td className="px-2 py-1.5 align-top">
                    <div className="break-all font-mono text-[0.68rem] text-ink-2">{m.versions[t] ?? '—'}</div>
                    <div className="mt-0.5 text-[0.68rem] leading-relaxed text-muted">{toolInfo(t).blurb}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <SectionTitle title="Provenance" />
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[0.7rem]">
          <dt className="text-faint">Run</dt>
          <dd className="text-ink-2">
            {m.run} · {new Date(m.date).toLocaleString()} · traced at {m.res}px
          </dd>
          <dt className="text-faint">LogoLab</dt>
          <dd className="font-mono text-ink-2">{m.logolab}</dd>
          {git && (
            <>
              <dt className="text-faint">Tree</dt>
              <dd className={git.dirty ? 'text-warn' : 'text-good'}>
                {git.head}{' '}
                {git.dirty
                  ? `+ uncommitted changes (diff sha1 ${git.diffSha1?.slice(0, 8)}) — not reproducible from a checkout`
                  : '· clean'}
              </dd>
            </>
          )}
          <dt className="text-faint">Raw</dt>
          <dd className="font-mono text-ink-2 break-all">
            {JSON.stringify({ ...m.provenance, git: undefined, svgbench: m.svgbench }).slice(0, 600)}
          </dd>
        </dl>
      </section>
      <section>
        <SectionTitle
          title="summary.md"
          note="The report the CLI wrote, verbatim — including the paper's numbers and their caveats."
        />
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-surface-2 p-3 font-mono text-[0.68rem] leading-relaxed text-ink-2">
          {summary ?? 'Loading…'}
        </pre>
      </section>
      {attribution && (
        <section>
          <SectionTitle title="Attribution" />
          <pre className="whitespace-pre-wrap rounded-lg border border-line bg-surface-2 p-3 font-mono text-[0.68rem] leading-relaxed text-ink-2">
            {attribution}
          </pre>
        </section>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function HowToRun() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 text-sm leading-relaxed text-ink-2">
      <h2 className="text-base font-semibold text-ink">No benchmark results here</h2>
      <p className="mt-2">
        The comparison runs locally — it drives VTracer, Potrace and a 1B-parameter model on your GPU, and its renders
        are of art that is not redistributed — so the results never ship with the site. Make some from a checkout:
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs">
        {`bash bench/compare/py/setup.sh            # vtracer, potrace, StarVector venv, pinned
.bench-tools/starvector-venv/Scripts/python.exe -I bench/compare/py/fetch_svgbench.py
node --experimental-strip-types bench/compare/run.ts --run my-run
pnpm dev                                   # then open /labs/bench`}
      </pre>
    </div>
  )
}

function About() {
  return (
    <>
      <p>
        Every tool traces the same rasters, and every output goes through the <b>same scorer</b>
        (bench/compare/score.ts): the truth gate’s geometry against the authored SVG, the shipped ΔE, and SVG-Bench’s
        own metrics so the numbers line up with the StarVector paper. Nothing on this page re-scores anything — it reads
        <code>.bench-tools/results/&lt;run&gt;/results.json</code>.
      </p>
      <p>
        <b>Results</b>: medians per tool, a paired bootstrap against LogoLab, and per-case distributions (click a dot).{' '}
        <b>Cases</b>: every render of one case side by side under one camera; <b>Difference</b> paints each render’s
        per-pixel ΔE. <b>Datasets</b>: where every case comes from and under which licence. <b>Run</b>: versions,
        provenance and the CLI’s own summary.
      </p>
      <p>
        Read the in-sample corpora as explanation, not evidence. The “all gates” column applies LogoLab’s own
        zero-tolerance tangent-break gate to everyone — it is a LogoLab lens. The <b>ms</b> column is not comparable
        across tools.
      </p>
    </>
  )
}
