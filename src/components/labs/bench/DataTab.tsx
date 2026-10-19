import { useMemo, useState } from 'react'
import { ExternalLink } from '../../ui/icons'
import { LabSelect } from '../LabPage'
import {
  CORE_TOOLS,
  GROUP_LABEL,
  METRICS,
  METRIC_BY_KEY,
  caseDir,
  caseTable,
  corpusInfo,
  fmt,
  num,
  toolInfo,
  type BenchResults,
} from './benchData'
import { CorpusLine, runUrl, useFetched } from './ui'

/**
 * Data: where the selected corpus comes from, and every case in it as one row — its source,
 * its licence, how many nodes the artist used, and how each tool did on one metric. The
 * cells are shaded within the ROW (best to worst of the tools on that case), so a column
 * that stays pale is a tool that is rarely best, whatever the metric's units.
 */

interface Manifest {
  dataset: string
  revision: string
  split: string
  parquetSha256: string
  note: string
  rows: { file: string; source: string; license: string }[]
}

type SortKey = 'name' | 'gtNodes' | string

export function DataTab({
  data,
  run,
  corpus,
  tools,
  metric: metricKey,
  onMetric,
  onCase,
}: {
  data: BenchResults
  run: string
  corpus: string
  tools: string[]
  metric: string
  onMetric: (k: string) => void
  onCase: (id: string) => void
}) {
  const info = corpusInfo(corpus)
  const manifest = useFetched<Manifest>(corpus.startsWith('svgemoji') ? '/__bench/manifest' : null, 'json')
  const table = useMemo(() => caseTable(data.rows, corpus), [data, corpus])
  const meta = useMemo(() => new Map(data.meta.cases.map((c) => [c.id, c])), [data])
  const metric = METRIC_BY_KEY.get(metricKey) ?? METRICS[0]
  const cols = tools.filter((t) => CORE_TOOLS.includes(t))
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })

  const rows = useMemo(() => {
    const list = [...table.entries()].map(([id, byTool]) => {
      const any = byTool.values().next().value
      return { id, byTool, gtNodes: num(any, 'gtNodes') }
    })
    const key = (r: (typeof list)[number]): string | number | null =>
      sort.key === 'name' ? r.id : sort.key === 'gtNodes' ? r.gtNodes : num(r.byTool.get(sort.key), metric.key)
    return list.sort((a, b) => {
      const ka = key(a)
      const kb = key(b)
      if (ka === null) return kb === null ? 0 : 1
      if (kb === null) return -1
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * sort.dir
    })
  }, [table, sort, metric])

  const licences = new Map<string, number>()
  for (const id of table.keys()) {
    const l = meta.get(id)?.license ?? '?'
    licences.set(l, (licences.get(l) ?? 0) + 1)
  }
  const refused = [...table.keys()].filter((id) => meta.get(id)?.gtRefusal).length

  const header = (key: SortKey, label: string, right = false) => (
    <th className={`px-2 py-1.5 font-medium ${right ? 'text-right' : 'text-left'}`}>
      <button
        type="button"
        className="whitespace-nowrap hover:text-ink"
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}
      >
        {label}
        {sort.key === key && (sort.dir === 1 ? ' ↑' : ' ↓')}
      </button>
    </th>
  )

  return (
    <div className="space-y-5 px-4 pb-10 pt-2">
      <section className="rounded-lg border border-line bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <CorpusLine corpus={corpus} n={table.size} />
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
        <p className="mt-1.5 max-w-[100ch] text-xs leading-relaxed text-muted">{info.blurb}</p>
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[0.7rem]">
          <dt className="text-faint">Licences</dt>
          <dd className="text-ink-2">{[...licences.entries()].map(([l, n]) => `${l} × ${n}`).join(' · ')}</dd>
          {refused > 0 && (
            <>
              <dt className="text-faint">Geometry n/a</dt>
              <dd className="text-warn">
                {refused} cases use strokes or clips the geometry scorer cannot model; they keep their pixel scores
              </dd>
            </>
          )}
          {manifest && (
            <>
              <dt className="text-faint">Pinned</dt>
              <dd className="break-all font-mono text-ink-2">
                {manifest.dataset}@{manifest.revision.slice(0, 12)} · {manifest.split} · parquet sha256{' '}
                {manifest.parquetSha256.slice(0, 16)}…
              </dd>
              <dt className="text-faint">Selection</dt>
              <dd className="text-ink-2">{manifest.note}</dd>
            </>
          )}
          <dt className="text-faint">Input</dt>
          <dd className="text-ink-2">
            every tool gets the authored SVG rendered with resvg on white at {data.meta.res} px
          </dd>
        </dl>
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
          <h3 className="text-sm font-semibold text-ink">Every case</h3>
          <LabSelect
            label="Cells show"
            value={metric.key}
            onChange={onMetric}
            options={METRICS.map((m) => ({ value: m.key, label: m.label, group: GROUP_LABEL[m.group] }))}
          />
          <span className="text-[0.7rem] text-muted">
            Green is the best tool on that case, red the worst. Click a row to open it.
          </span>
        </div>
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[760px] text-xs tabular-nums">
            <thead className="border-b border-line bg-surface-2 text-[0.68rem] text-muted">
              <tr>
                <th className="w-12" />
                {header('name', 'Case')}
                <th className="px-2 py-1.5 text-left font-medium">Source · licence</th>
                {header('gtNodes', 'Artist nodes', true)}
                {cols.map((t) => header(t, toolInfo(t).label, true))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const m = meta.get(r.id)
                const vals = cols.map((t) => num(r.byTool.get(t), metric.key))
                const present = vals.filter((v): v is number => v !== null)
                const lo = Math.min(...present)
                const hi = Math.max(...present)
                const shade = (v: number | null) => {
                  if (v === null || present.length < 2 || hi === lo) return undefined
                  const t = (v - lo) / (hi - lo) // 0 = lowest
                  const good = metric.better === 'lower' ? 1 - t : t
                  return good > 0.999
                    ? 'bg-good/15 text-good font-semibold'
                    : good < 0.001
                      ? 'bg-bad/10 text-bad'
                      : 'text-ink-2'
                }
                return (
                  <tr
                    key={r.id}
                    className="cursor-pointer border-t border-line hover:bg-surface-2"
                    onClick={() => onCase(r.id)}
                  >
                    <td className="py-1 pl-2">
                      <img
                        src={runUrl(run, `${caseDir(r.id)}/truth.png`)}
                        alt=""
                        loading="lazy"
                        className="h-8 w-8 rounded border border-line bg-white object-contain"
                      />
                    </td>
                    <td className="px-2 font-mono text-[0.68rem] text-ink">{r.id.slice(r.id.indexOf('/') + 1)}</td>
                    <td className="max-w-[16rem] truncate px-2 text-[0.68rem] text-muted">
                      {m?.source.replace(/ sha256:.*/, '')} · {m?.license}
                      {m?.gtRefusal && <span className="ml-1 text-warn">(geometry n/a)</span>}
                    </td>
                    <td className="px-2 text-right text-muted">{r.gtNodes ?? '—'}</td>
                    {vals.map((v, i) => (
                      <td key={cols[i]} className={`px-2 py-1 text-right ${shade(v) ?? 'text-faint'}`}>
                        {fmt(v, metric.digits)}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
