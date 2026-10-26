import { useEffect, useRef, useState } from 'react'
import { type Leaderboard, cdGroups, corpusInfo, isAblationRow, toolInfo } from './benchData'
import { LEADERBOARD } from './leaderboard.generated'
import { Th, ToolName } from './ui'

/**
 * The benchmark's headline on the Overview: MEAN RANK per held-out corpus, as a table and a
 * critical-difference diagram. Everything is read from leaderboard.generated.ts
 * (bench/compare/leaderboard.ts), which calls the same pure leaderboard() that writes the
 * top of summary.md, so the hosted page and the run's report print the same ranks.
 *
 * The ablation view (oracle, no-probe, swept and ablation rows) is one click away and says
 * so in its own caption; it is never what shows first. A line corpus and a fill corpus are
 * separate boards: they are ranked on different metrics, and an average would mean nothing.
 */
export function MeanRankBoard() {
  const corpora = [...new Set(LEADERBOARD.boards.map((b) => b.corpus))]
  const [corpus, setCorpus] = useState(corpora[0] ?? '')
  const [view, setView] = useState<'headline' | 'ablation'>('headline')
  const board = LEADERBOARD.boards.find((b) => b.corpus === corpus && b.view === view)
  if (!board) return null
  return (
    <div className="not-prose my-4">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        {corpora.length > 1 && (
          <Segmented
            value={corpus}
            onChange={setCorpus}
            options={corpora.map((c) => ({ value: c, label: corpusInfo(c).label }))}
          />
        )}
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'headline', label: 'Tools as shipped' },
            { value: 'ablation', label: 'With ablations' },
          ]}
        />
        <span className="text-faint">
          {board.n} cases · {board.k} {view === 'headline' ? 'tools' : 'rows'}
        </span>
      </div>
      <RankTable board={board} />
      <CdDiagram board={board} />
      <BoardNote board={board} />
    </div>
  )
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="inline-flex rounded-md border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded px-2.5 py-1 transition-colors ${value === o.value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const pct = (v: number) => `${Math.round(v * 100)}%`

/** Mean rank, its interval, the Pareto shares, and the per-metric ranks it averages. On a
 *  phone the breakdown moves under the tool's name: four columns fit, nine do not. */
function RankTable({ board }: { board: Leaderboard }) {
  const metrics = board.metrics
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full text-xs tabular-nums">
        <thead className="border-b border-line bg-surface-2 text-[0.68rem] text-muted">
          <tr>
            <th className="w-6 px-2 py-1.5 text-right font-medium">#</th>
            <th className="px-2 py-1.5 text-left font-medium">Tool</th>
            <Th hint="Mean over every (case, metric) of the tool's rank: 1 is best on everything. The bracket is a 95% bootstrap interval over cases.">
              Mean rank ↓
            </Th>
            <Th hint="Pareto: the share of (case, other tool) pairs where this tool is at least as good on every metric and better on one, then the share where the other tool is. The rest are trades: each better somewhere.">
              Wins / losses
            </Th>
            {metrics.map((m, i) => (
              <th
                key={m.key}
                className={`hidden px-2 py-1.5 text-right font-medium sm:table-cell ${i === 0 ? 'border-l border-line' : ''}`}
              >
                {m.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {board.tools.map((t, i) => (
            <tr key={t.tool} className={`border-t border-line ${t.tool === 'logolab-auto' ? 'bg-accent-soft/40' : ''}`}>
              <td className="px-2 py-1.5 text-right align-top text-faint">{i + 1}</td>
              <td className="px-2 py-1.5 text-left align-top">
                <ToolName tool={t.tool} />
                {isAblationRow(t.tool) ? <span className="ml-1 text-[0.62rem] text-faint">ablation</span> : null}
                <span className="mt-0.5 block text-[0.62rem] leading-tight text-faint sm:hidden">
                  {metrics.map((m) => `${m.label} ${t.perMetric[m.key]?.toFixed(1) ?? '—'}`).join(' · ')}
                </span>
              </td>
              <td className="px-2 py-1.5 text-right align-top">
                <span className="font-semibold text-ink">{t.mean.toFixed(2)}</span>
                <span className="block text-[0.62rem] text-faint sm:ml-1 sm:inline">
                  [{t.lo.toFixed(2)}, {t.hi.toFixed(2)}]
                </span>
              </td>
              <td className="whitespace-nowrap px-2 py-1.5 text-right align-top text-ink-2">
                <span className="text-good">{pct(t.pareto.win)}</span> / <span>{pct(t.pareto.loss)}</span>
              </td>
              {metrics.map((m, k) => (
                <td
                  key={m.key}
                  className={`hidden px-2 py-1.5 text-right align-top text-ink-2 sm:table-cell ${k === 0 ? 'border-l border-line' : ''}`}
                >
                  {t.perMetric[m.key]?.toFixed(2) ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Demšar's critical-difference diagram, laid out for a narrow column: one row per tool,
 * best first, its mean case rank as a dot on a shared rank axis, and a bar in the right
 * gutter joining each run of tools whose ranks are closer than the CD (not significantly
 * different at α .05). Drawn at the measured width, so the labels stay text-sized on a
 * phone instead of shrinking with a viewBox.
 */
function CdDiagram({ board }: { board: Leaderboard }) {
  const ref = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(640)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const fit = () => setW(Math.max(260, el.clientWidth))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const cd = board.cd05
  const rows = [...board.tools].sort((a, b) => a.caseMean - b.caseMean)
  const means = rows.map((t) => t.caseMean)
  const groups = cd === null ? [] : cdGroups(means, cd)
  const lo = Math.max(1, Math.floor(means[0] ?? 1))
  const hi = Math.min(board.k, Math.max(lo + 1, Math.ceil(means[means.length - 1] ?? board.k)))
  const rowH = 22
  const axis = 34
  // Demšar's bars, one lane each, between the axis and the rows: a bar spans the ranks of
  // the tools it joins, so it reads against the same axis the dots do.
  const laneH = 7
  const top = axis + 6 + groups.length * laneH + (groups.length ? 6 : 0)
  const labelW = Math.round(Math.min(170, Math.max(100, W * 0.34)))
  const x0 = labelW + 12
  const x1 = W - 16 - 36
  const x = (r: number) => x0 + ((r - lo) / (hi - lo)) * (x1 - x0)
  const y = (i: number) => top + i * rowH + rowH / 2
  const H = top + rows.length * rowH + 6
  const step = hi - lo > 10 ? 2 : 1
  const ticks: number[] = []
  for (let r = lo; r <= hi; r += step) ticks.push(r)
  return (
    <div ref={ref} className="mt-3 rounded-lg border border-line bg-surface p-2">
      <svg
        width={W - 16}
        height={H}
        viewBox={`0 0 ${W - 16} ${H}`}
        className="block max-w-full"
        role="img"
        aria-label={`Critical-difference diagram: mean ranks of ${rows.length} tools, CD ${cd?.toFixed(2) ?? 'n/a'}`}
      >
        {/* the CD as a length on the rank axis */}
        {cd !== null && x(lo + cd) <= x1 && (
          <g className="stroke-ink-2" strokeWidth={1.5}>
            <line x1={x0} x2={x(lo + cd)} y1={8} y2={8} />
            <line x1={x0} x2={x0} y1={4} y2={12} />
            <line x1={x(lo + cd)} x2={x(lo + cd)} y1={4} y2={12} />
            <text x={x(lo + cd) + 6} y={12} className="fill-ink-2 stroke-none text-[11px]">
              CD {cd.toFixed(2)}
            </text>
          </g>
        )}
        {ticks.map((r) => (
          <g key={r}>
            <line x1={x(r)} x2={x(r)} y1={axis - 4} y2={H - 4} className="stroke-line" strokeWidth={1} />
            <text x={x(r)} y={axis - 8} textAnchor="middle" className="fill-faint text-[11px]">
              {r}
            </text>
          </g>
        ))}
        {rows.map((t, i) => {
          const head = t.tool === 'logolab-auto'
          return (
            <g key={t.tool}>
              <text
                x={labelW}
                y={y(i) + 4}
                textAnchor="end"
                className={`text-[12px] ${head ? 'fill-accent font-semibold' : 'fill-ink-2'}`}
              >
                {toolInfo(t.tool).label}
              </text>
              <line x1={x0} x2={x(t.caseMean)} y1={y(i)} y2={y(i)} className="stroke-line-strong" strokeWidth={1} />
              <circle cx={x(t.caseMean)} cy={y(i)} r={4.5} className={head ? 'fill-accent' : 'fill-ink-2'} />
              <text x={x(t.caseMean) + 8} y={y(i) + 4} className="fill-muted text-[10px]">
                {t.caseMean.toFixed(2)}
              </text>
            </g>
          )
        })}
        {groups.map(([a, b], g) => {
          const gy = axis + 6 + g * laneH + laneH / 2
          return (
            <g key={`${a}-${b}`}>
              <line
                x1={x(means[a]) - 3}
                x2={x(means[b]) + 3}
                y1={gy}
                y2={gy}
                className="stroke-ink"
                strokeWidth={3}
                strokeLinecap="round"
              />
              {/* a faint drop from each end to its tool's dot */}
              {[a, b].map((i) => (
                <line
                  key={i}
                  x1={x(means[i])}
                  x2={x(means[i])}
                  y1={gy}
                  y2={y(i)}
                  className="stroke-line-strong"
                  strokeWidth={1}
                  strokeDasharray="2 3"
                />
              ))}
            </g>
          )
        })}
      </svg>
      <p className="px-1 pt-1 text-[0.7rem] leading-relaxed text-muted">
        Each dot is a tool’s mean rank, case by case (left is better). A black bar joins tools whose ranks are closer
        than the critical difference (CD, top left): the test cannot tell those apart at α 0.05. Nemenyi, after Demšar
        (2006).
      </p>
    </div>
  )
}

function BoardNote({ board }: { board: Leaderboard }) {
  const f = board.friedman
  const p = (v: number) => (v < 1e-300 ? '< 1e-300' : v < 0.001 ? `= ${v.toExponential(1)}` : `= ${v.toFixed(3)}`)
  return (
    <p className="mt-2 max-w-[72ch] text-[0.78rem] leading-relaxed text-muted">
      {board.view === 'ablation' && (
        <b className="text-warn">
          Ablation view: LogoLab configurations no user gets and grid-searched settings are ranked too, which moves
          everyone’s rank. The headline is the other view.{' '}
        </b>
      )}
      Ranked on {board.metrics.map((m) => m.label).join(', ')}, every case of {corpusInfo(board.corpus).label}.{' '}
      {f && (
        <>
          {f.pF < 0.05 ? 'The tools are not all equal' : 'The test cannot tell the tools apart'}: Friedman χ²({f.df}) ={' '}
          {f.chi2.toFixed(1)}, Iman–Davenport F({f.df1}, {f.df2}) = {f.ff.toFixed(1)}, p {p(f.pF)}.{' '}
        </>
      )}
      A failed or unreadable output counts as last on that metric, so a tool cannot rank well by skipping hard cases.
      {board.excluded.length > 0 && (
        <>
          {' '}
          Not ranked, for running on only part of the set:{' '}
          {board.excluded.map((e) => toolInfo(e.tool).label).join(', ')}.
        </>
      )}{' '}
      Run {LEADERBOARD.run}.
    </p>
  )
}
