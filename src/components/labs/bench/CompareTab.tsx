import { useMemo, useState } from 'react'
import { LabSelect } from '../LabPage'
import {
  METRICS,
  METRIC_BY_KEY,
  caseDir,
  caseTable,
  disagreements,
  fmt,
  paired,
  toolInfo,
  type BenchResults,
  type Disagreement,
  type Metric,
} from './benchData'
import { CorpusLine, SectionTitle, ToolSelect, runUrl } from './ui'

/**
 * Compare: any two tools, case by case. Two questions, one each:
 *
 *   Head to head        on each metric, how many cases each tool wins, and by how much on
 *                       average (paired, with a 95% interval).
 *   Where they disagree a picture metric against a drawing metric, one dot per case, placed
 *                       by which tool each metric favours. Dots off the diagonal quadrants
 *                       are the cases the Overview is about: the picture says one tool, the
 *                       drawing says the other.
 */

export interface CompareView {
  a: string
  b: string
  x: string
  y: string
}

const HEAD_METRICS = ['sbDino', 'sbLpips', 'sbSsim', 'meanDeltaE', 'chamfer', 'docNodes', 'tangentBreaks', 'bytes']
const PICTURE = new Set(['sbDino', 'sbLpips', 'sbSsim', 'sbMse'])

export function CompareTab({
  data,
  run,
  corpus,
  tools,
  view,
  setView,
  onCase,
}: {
  data: BenchResults
  run: string
  corpus: string
  tools: string[]
  view: CompareView
  setView: (p: Partial<CompareView>) => void
  onCase: (id: string) => void
}) {
  const table = useMemo(() => caseTable(data.rows, corpus), [data, corpus])
  const a = tools.includes(view.a) ? view.a : tools[0]
  const b = tools.includes(view.b) && view.b !== a ? view.b : (tools.find((t) => t !== a) ?? a)
  const la = toolInfo(a).label
  const lb = toolInfo(b).label

  return (
    <div className="space-y-6 px-4 pb-10 pt-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <CorpusLine corpus={corpus} n={table.size} />
        <span className="ml-auto inline-flex flex-wrap items-center gap-3">
          <ToolSelect label="Compare" value={a} tools={tools} onChange={(v) => setView({ a: v })} />
          <ToolSelect label="with" value={b} tools={tools.filter((t) => t !== a)} onChange={(v) => setView({ b: v })} />
        </span>
      </div>

      <section>
        <SectionTitle
          title="Head to head"
          note={`Each bar is the cases where ${la} wins, the two tie, and ${lb} wins. The number on the right is the average margin, paired by case; ✔ means the 95% interval excludes zero.`}
        />
        <HeadToHead table={table} a={a} b={b} />
      </section>

      <section>
        <SectionTitle
          title="Where the picture and the drawing disagree"
          note={`One dot per case. Right and up favour ${la}, left and down favour ${lb}. The two shaded corners are the cases where one score names ${la} and the other names ${lb}. Click a dot to open the case.`}
          right={
            <span className="inline-flex flex-wrap gap-3">
              <LabSelect
                label="Across"
                value={view.x}
                onChange={(x) => setView({ x })}
                options={METRICS.map((m) => ({ value: m.key, label: m.label }))}
              />
              <LabSelect
                label="Up"
                value={view.y}
                onChange={(y) => setView({ y })}
                options={METRICS.map((m) => ({ value: m.key, label: m.label }))}
              />
            </span>
          }
        />
        <Disagree table={table} a={a} b={b} xKey={view.x} yKey={view.y} run={run} onCase={onCase} />
      </section>
    </div>
  )
}

function HeadToHead({ table, a, b }: { table: ReturnType<typeof caseTable>; a: string; b: string }) {
  const rows = useMemo(
    () =>
      HEAD_METRICS.map((k) => METRIC_BY_KEY.get(k))
        .filter((m): m is Metric => !!m)
        // paired(b vs a): wins are B's, so A's wins are B's losses.
        .map((m) => ({ m, p: paired(table, b, a, m) })),
    [table, a, b],
  )
  const la = toolInfo(a).label
  const lb = toolInfo(b).label
  return (
    <div className="space-y-1.5 rounded-lg border border-line bg-surface p-3">
      <div className="grid grid-cols-[9rem_1fr_11rem] gap-3 text-[0.65rem] text-faint">
        <span />
        <span className="flex justify-between">
          <span className="text-accent">◀ {la} wins</span>
          <span>{lb} wins ▶</span>
        </span>
        <span className="text-right">average margin</span>
      </div>
      {rows.map(({ m, p }) => {
        if (!p) return null
        const aw = p.losses
        const bw = p.wins
        const tie = p.n - aw - bw
        const pct = (v: number) => `${(v / p.n) * 100}%`
        // meanDiff is B − A in the metric's units; who it favours depends on the direction.
        const aBetter = m.better === 'lower' ? p.meanDiff > 0 : p.meanDiff < 0
        const margin = Math.abs(p.meanDiff)
        return (
          <div key={m.key} className="grid grid-cols-[9rem_1fr_11rem] items-center gap-3 text-xs">
            <span className="truncate text-muted">
              {m.label}
              <span className="ml-1 text-[0.6rem] uppercase tracking-wide text-faint">
                {PICTURE.has(m.key) ? 'picture' : 'drawing'}
              </span>
            </span>
            <div className="flex h-4 overflow-hidden rounded bg-surface-3 text-[0.6rem] tabular-nums leading-4">
              <div className="bg-accent text-center text-white" style={{ width: pct(aw) }}>
                {aw > 2 ? aw : ''}
              </div>
              <div className="text-center text-faint" style={{ width: pct(tie) }}>
                {tie > 2 ? tie : ''}
              </div>
              <div className="bg-ink-2/70 text-center text-white" style={{ width: pct(bw) }}>
                {bw > 2 ? bw : ''}
              </div>
            </div>
            <span
              className={`text-right tabular-nums ${p.significant ? (aBetter ? 'text-accent' : 'text-ink') : 'text-faint'}`}
            >
              {p.significant
                ? `${aBetter ? la : lb} by ${fmt(margin, Math.max(m.digits, 2))} ✔`
                : 'no clear difference'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Signed log scale: the margins span orders of magnitude (0.0004 DINO, 30 kinks). Each axis
 *  is scaled by its own median |margin|, so the cloud fills the square whatever the metric. */
function symlog(values: number[]): (v: number) => number {
  const abs = values
    .map(Math.abs)
    .filter((v) => v > 0)
    .sort((x, y) => x - y)
  const s = abs.length ? abs[Math.floor(abs.length / 2)] : 1
  const f = (v: number) => Math.sign(v) * Math.log1p(Math.abs(v) / s)
  const max = Math.max(1e-9, ...values.map((v) => Math.abs(f(v))))
  return (v) => f(v) / max
}

function Disagree({
  table,
  a,
  b,
  xKey,
  yKey,
  run,
  onCase,
}: {
  table: ReturnType<typeof caseTable>
  a: string
  b: string
  xKey: string
  yKey: string
  run: string
  onCase: (id: string) => void
}) {
  const mx = METRIC_BY_KEY.get(xKey) ?? METRICS[0]
  const my = METRIC_BY_KEY.get(yKey) ?? METRICS[1]
  const pts = useMemo(() => disagreements(table, a, b, mx, my), [table, a, b, mx, my])
  const [hover, setHover] = useState<Disagreement | null>(null)
  const sx = useMemo(() => symlog(pts.map((p) => p.x)), [pts])
  const sy = useMemo(() => symlog(pts.map((p) => p.y)), [pts])
  const la = toolInfo(a).label
  const lb = toolInfo(b).label
  if (!pts.length) return <p className="text-xs text-muted">No case has both metrics for both tools.</p>

  const q = { both: 0, neither: 0, xa: 0, ya: 0 }
  for (const p of pts) {
    if (p.x > 0 && p.y > 0) q.both++
    else if (p.x < 0 && p.y < 0) q.neither++
    else if (p.x > 0 && p.y < 0) q.xa++
    else if (p.x < 0 && p.y > 0) q.ya++
  }
  // The strongest disagreements: both scores clearly pick a side, and not the same side.
  const worst = pts
    .filter((p) => Math.sign(p.x) * Math.sign(p.y) < 0)
    .map((p) => ({ p, k: Math.min(Math.abs(sx(p.x)), Math.abs(sy(p.y))) }))
    .sort((u, v) => v.k - u.k)
    .slice(0, 6)

  const S = 400
  const pos = (v: number) => S / 2 + v * (S / 2 - 14)
  const say = (m: Metric, v: number) =>
    v === 0 ? `${m.label}: tie` : `${m.label} favours ${v > 0 ? la : lb} by ${fmt(Math.abs(v), Math.max(m.digits, 2))}`

  return (
    <div className="flex flex-wrap items-start gap-6">
      <div className="w-full max-w-[420px]">
        <svg
          viewBox={`0 0 ${S} ${S}`}
          className="block w-full rounded-lg border border-line bg-surface"
          role="img"
          aria-label="Disagreement plot"
        >
          <rect x={0} y={0} width={S / 2} height={S / 2} className="fill-warn/10" />
          <rect x={S / 2} y={S / 2} width={S / 2} height={S / 2} className="fill-warn/10" />
          <line x1={S / 2} x2={S / 2} y1={0} y2={S} className="stroke-line-strong" />
          <line x1={0} x2={S} y1={S / 2} y2={S / 2} className="stroke-line-strong" />
          <text x={S - 6} y={14} textAnchor="end" className="fill-faint text-[10px]">
            both favour {la} · {q.both}
          </text>
          <text x={6} y={S - 6} className="fill-faint text-[10px]">
            both favour {lb} · {q.neither}
          </text>
          <text x={6} y={14} className="fill-warn text-[10px]">
            disagree · {q.ya}
          </text>
          <text x={S - 6} y={S - 6} textAnchor="end" className="fill-warn text-[10px]">
            disagree · {q.xa}
          </text>
          {pts.map((p) => (
            <circle
              key={p.caseId}
              cx={pos(sx(p.x))}
              cy={pos(-sy(p.y))}
              r={hover?.caseId === p.caseId ? 6 : 3.5}
              className={`cursor-pointer ${Math.sign(p.x) * Math.sign(p.y) < 0 ? 'fill-warn' : 'fill-ink-2'} ${hover?.caseId === p.caseId ? 'opacity-100' : 'opacity-60'}`}
              role="button"
              tabIndex={0}
              aria-label={p.caseId}
              onMouseEnter={() => setHover(p)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onCase(p.caseId)}
              onKeyDown={(e) => e.key === 'Enter' && onCase(p.caseId)}
            />
          ))}
        </svg>
        <div className="mt-1 flex justify-between text-[0.65rem] text-faint">
          <span>
            ◀ {mx.label} favours {lb}
          </span>
          <span>{la} ▶</span>
        </div>
        <p className="mt-1 min-h-[2.5em] text-[0.7rem] leading-snug text-muted">
          {hover ? (
            <>
              <b className="text-ink">{hover.caseId.slice(hover.caseId.indexOf('/') + 1)}</b>: {say(mx, hover.x)};{' '}
              {say(my, hover.y)}.
            </>
          ) : (
            <>
              Up is {my.label} favouring {la}. Axes are log-scaled margins, so small and large wins both show.
            </>
          )}
        </p>
      </div>

      <div className="min-w-[260px] flex-1">
        <h4 className="mb-2 text-xs font-semibold text-ink">Clearest disagreements</h4>
        {worst.length === 0 && (
          <p className="text-xs text-muted">None: on every case both scores pick the same tool.</p>
        )}
        <ul className="space-y-2">
          {worst.map(({ p }) => (
            <li key={p.caseId}>
              <button
                type="button"
                onClick={() => onCase(p.caseId)}
                className="flex w-full items-center gap-3 rounded-lg border border-line bg-surface p-2 text-left transition-colors hover:border-accent"
              >
                {['truth', a, b].map((t) => (
                  <img
                    key={t}
                    src={runUrl(run, `${caseDir(p.caseId)}/${t}.png`)}
                    alt=""
                    loading="lazy"
                    className="h-12 w-12 shrink-0 rounded border border-line bg-white object-contain"
                  />
                ))}
                <span className="min-w-0 text-[0.7rem] leading-snug text-muted">
                  <b className="block truncate text-ink">{p.caseId.slice(p.caseId.indexOf('/') + 1)}</b>
                  {say(mx, p.x)}
                  <br />
                  {say(my, p.y)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[0.65rem] text-faint">
          Thumbnails: authored, {la}, {lb}.
        </p>
      </div>
    </div>
  )
}
