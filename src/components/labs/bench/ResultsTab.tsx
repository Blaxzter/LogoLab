import { useMemo, useState } from 'react'
import { Tooltip } from '../../ui/Tooltip'
import { LabCheck, LabSelect } from '../LabPage'
import {
  FAMILY_LABEL,
  GROUP_LABEL,
  HEADLINE_TOOL,
  METRICS,
  METRIC_BY_KEY,
  caseTable,
  fmt,
  num,
  summarize,
  paired,
  toolInfo,
  type BenchResults,
  type BenchRow,
  type Metric,
  type MetricGroup,
  type ToolFamily,
  type ToolSummary,
} from './benchData'
import { CorpusLine, More, SectionTitle, Th, ToolName } from './ui'

/**
 * Results: who wins, by the picture and by the drawing. A short table first — seven columns,
 * the ones the Overview argues with — and everything else one click away: every column, the
 * paired test, the per-case distributions.
 */
export function ResultsTab({
  data,
  corpus,
  tools,
  metric: metricKey,
  onMetric,
  onCase,
}: {
  data: BenchResults
  corpus: string
  tools: string[]
  metric: string
  onMetric: (k: string) => void
  onCase: (id: string) => void
}) {
  const [detail, setDetail] = useState(false)
  const summaries = useMemo(() => summarize(data.rows, corpus, tools), [data, corpus, tools])
  const table = useMemo(() => caseTable(data.rows, corpus), [data, corpus])
  const metric = METRIC_BY_KEY.get(metricKey) ?? METRICS[0]

  return (
    <div className="space-y-5 px-4 pb-10 pt-2">
      <CorpusLine corpus={corpus} n={table.size} />

      <section>
        <SectionTitle
          title="Leaderboard"
          note="Medians per tool. Green is the best in its column. Hover a number for its spread, a column for what it measures."
          right={<LabCheck label="All columns" checked={detail} onChange={setDetail} />}
        />
        <Leaderboard summaries={summaries} nCases={table.size} detail={detail} />
      </section>

      <More title="Distributions" note="one dot per case: where a median hides failures">
        <div className="mb-2 text-xs">
          <LabSelect
            label="Metric"
            value={metric.key}
            onChange={onMetric}
            options={METRICS.map((m) => ({ value: m.key, label: m.label, group: GROUP_LABEL[m.group] }))}
          />
        </div>
        <StripPlot data={data} corpus={corpus} tools={tools} metric={metric} onCase={onCase} />
      </More>

      {tools.includes(HEADLINE_TOOL) && (
        <More title="Statistics" note={`paired against ${toolInfo(HEADLINE_TOOL).label}, with 95% intervals`}>
          <p className="mb-2 text-[0.7rem] leading-relaxed text-muted">
            Mean of (tool − LogoLab) over the cases both scored. ✔ = the interval excludes 0. The small numbers are
            cases the tool is better / worse on. Green = the tool beats LogoLab. For any two tools, use Compare.
          </p>
          <PairedTable table={table} tools={tools.filter((t) => t !== HEADLINE_TOOL)} />
        </More>
      )}
    </div>
  )
}

/** What a newcomer sees: two picture scores, four drawing scores, the file size. */
const SHORT_COLS = ['sbDino', 'sbLpips', 'meanDeltaE', 'chamfer', 'nodeRatio', 'tangentBreaks', 'bytes']
/** Everything, grouped so each group's columns are contiguous (the header spans them). */
const ALL_COLS = [
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

function Leaderboard({ summaries, nCases, detail }: { summaries: ToolSummary[]; nCases: number; detail: boolean }) {
  const cols = (detail ? ALL_COLS : SHORT_COLS).map((k) => METRIC_BY_KEY.get(k)).filter((m): m is Metric => !!m)
  const fixed = detail ? 4 : 1
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
      <table className={`w-full text-xs tabular-nums ${detail ? 'min-w-[900px]' : 'min-w-[640px]'}`}>
        <thead className="bg-surface-2 text-[0.68rem] text-muted">
          <tr>
            <th colSpan={fixed} />
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
            {detail && (
              <>
                <Th hint="Cases this tool was run on.">n</Th>
                <Th hint="Outputs that failed to parse or render. Scored, never dropped.">fail</Th>
                <Th hint="Cases where every applicable truth-gate check passes, at tool-neutral limits. The zero-tolerance tangent-break gate decides it for every tool, so it says more about LogoLab's own priorities than about the tools.">
                  all gates
                </Th>
              </>
            )}
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
                  <td
                    colSpan={fixed + cols.length}
                    className="px-2 py-1 text-[0.62rem] uppercase tracking-wide text-faint"
                  >
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
                {detail && (
                  <>
                    <td className="px-2 text-right">{s.n}</td>
                    <td className={`px-2 text-right ${s.failures ? 'text-bad' : 'text-faint'}`}>{s.failures}</td>
                    <td className="px-2 text-right">{s.gatesAllPass}</td>
                  </>
                )}
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

const PAIRED_COLS = ['meanDeltaE', 'chamfer', 'docNodes', 'tangentBreaks', 'sbDino', 'sbLpips', 'sbSsim']
  .map((k) => METRIC_BY_KEY.get(k))
  .filter((m): m is Metric => !!m)

export function PairedTable({
  table,
  tools,
  against: refTool = HEADLINE_TOOL,
}: {
  table: Map<string, Map<string, BenchRow>>
  tools: string[]
  against?: string
}) {
  const cols = PAIRED_COLS
  const cells = useMemo(
    () => tools.map((t) => ({ tool: t, results: cols.map((m) => paired(table, t, refTool, m)) })),
    [table, tools, refTool],
  )
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[820px] text-xs tabular-nums">
        <thead className="border-b border-line bg-surface-2 text-[0.68rem] text-muted">
          <tr>
            <th className="px-2 py-1.5 text-left font-medium">{`Tool − ${toolInfo(refTool).label}`}</th>
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
export function StripPlot({
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
            {fmt(hover.v, metric.digits)}. The same case is highlighted in every row.
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
