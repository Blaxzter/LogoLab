import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { LabSelect } from '../LabPage'
import { METRIC_BY_KEY, fmt, num, summarize, toolInfo, type BenchResults, type RunInfo } from './benchData'
import { More, SectionTitle, ToolName, runUrl, useFetched } from './ui'

/**
 * Run: what produced these numbers — every tool's exact version, the tree the run was made
 * from — and how the run differs from another one. The diff is the A/B lab's question asked
 * of the benchmark: after a tracer change, which tools' outputs moved, and did the medians?
 */

const DIFF_KEYS = ['meanDeltaE', 'chamfer', 'docNodes', 'tangentBreaks', 'sbDino']
/** Below this, two floats are the same measurement printed twice. */
const SAME = 1e-9

export function RunTab({
  data,
  run,
  runs,
  other,
  onOther,
}: {
  data: BenchResults
  run: string
  runs: RunInfo[]
  other: string
  onOther: (r: string) => void
}) {
  const m = data.meta
  const git = (m.provenance?.git ?? null) as { head?: string; dirty?: boolean; diffSha1?: string } | null
  const summary = useFetched<string>(runUrl(run, 'summary.md'), 'text')
  const attribution = useFetched<string>(runUrl(run, 'ATTRIBUTION.md'), 'text')
  const choices = runs.filter((r) => r.name !== run)
  const otherName = choices.some((r) => r.name === other) ? other : (choices[0]?.name ?? '')
  const otherData = useFetched<BenchResults>(otherName ? runUrl(otherName, 'results.json') : null, 'json')

  return (
    <div className="space-y-6 px-4 pb-10 pt-2">
      <section>
        <SectionTitle
          title="What ran"
          note={`${m.run} · ${new Date(m.date).toLocaleString()} · traced at ${m.res}px`}
          right={
            git && (
              <span className={git.dirty ? 'text-warn' : 'text-good'}>
                LogoLab {git.head}
                {git.dirty ? ` + uncommitted changes (${git.diffSha1?.slice(0, 8)}): not reproducible` : ', clean tree'}
              </span>
            )
          }
        />
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-xs">
            <tbody>
              {m.tools.map((t) => (
                <tr key={t} className="border-t border-line first:border-t-0">
                  <td className="w-52 px-2.5 py-1.5 align-top">
                    <ToolName tool={t} />
                  </td>
                  <td className="px-2.5 py-1.5 align-top">
                    <div className="text-[0.7rem] leading-relaxed text-muted">{toolInfo(t).blurb}</div>
                    <div className="mt-0.5 break-all font-mono text-[0.65rem] text-faint">{m.versions[t] ?? '—'}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {choices.length > 0 && (
        <section>
          <SectionTitle
            title="Compared with another run"
            note="Per tool: how many outputs changed any score, and how its medians moved. Run it before and after a tracer change."
            right={
              <LabSelect
                label="Against"
                value={otherName}
                onChange={onOther}
                options={choices.map((r) => ({ value: r.name, label: r.name, note: `${r.rows} rows` }))}
              />
            }
          />
          {otherData ? <RunDiff a={otherData} b={data} /> : <p className="text-xs text-muted">Loading {otherName}…</p>}
        </section>
      )}

      {summary && (
        <More title="The CLI’s summary" note="summary.md, including the paper’s numbers and their caveats">
          <Markdown text={summary} />
        </More>
      )}
      {attribution && (
        <More title="Attribution" note="the licences of the art these renders are made from">
          <Markdown text={attribution} />
        </More>
      )}
    </div>
  )
}

function RunDiff({ a, b }: { a: BenchResults; b: BenchResults }) {
  const rows = useMemo(() => {
    const before = new Map(a.rows.map((r) => [`${r.tool}|${r.caseId}`, r]))
    const tools = b.meta.tools.filter((t) => a.meta.tools.includes(t))
    return tools.map((tool) => {
      let changed = 0
      let common = 0
      for (const r of b.rows) {
        if (r.tool !== tool) continue
        const o = before.get(`${tool}|${r.caseId}`)
        if (!o) continue
        common++
        if (
          DIFF_KEYS.some((k) => {
            const x = num(o, k)
            const y = num(r, k)
            return x === null ? y !== null : y === null || Math.abs(x - y) > SAME * Math.max(1, Math.abs(x))
          })
        )
          changed++
      }
      const corpus = b.meta.corpora[0]
      const sa = summarize(a.rows, corpus, [tool])[0]
      const sb = summarize(b.rows, corpus, [tool])[0]
      return { tool, changed, common, sa, sb }
    })
  }, [a, b])
  const nothing = rows.every((r) => r.changed === 0)
  return (
    <>
      {nothing && (
        <p className="mb-2 text-xs text-good">
          Identical: every output scores the same in both runs ({rows.reduce((s, r) => s + r.common, 0)} compared).
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[640px] text-xs tabular-nums">
          <thead className="border-b border-line bg-surface-2 text-[0.68rem] text-muted">
            <tr>
              <th className="px-2.5 py-1.5 text-left font-medium">Tool</th>
              <th className="px-2.5 py-1.5 text-right font-medium">changed</th>
              {DIFF_KEYS.map((k) => (
                <th key={k} className="px-2.5 py-1.5 text-right font-medium">
                  {METRIC_BY_KEY.get(k)?.label} median
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ tool, changed, common, sa, sb }) => (
              <tr key={tool} className="border-t border-line">
                <td className="px-2.5 py-1.5">
                  <ToolName tool={tool} />
                </td>
                <td className={`px-2.5 text-right ${changed ? 'text-warn' : 'text-faint'}`}>
                  {changed}/{common}
                </td>
                {DIFF_KEYS.map((k) => {
                  const d = METRIC_BY_KEY.get(k)?.digits ?? 2
                  const x = sa?.metrics[k]?.median
                  const y = sb?.metrics[k]?.median
                  const moved = x !== undefined && y !== undefined && Math.abs(x - y) > SAME
                  return (
                    <td key={k} className={`px-2.5 text-right ${moved ? 'text-ink' : 'text-faint'}`}>
                      {moved ? `${fmt(x, d)} → ${fmt(y, d)}` : fmt(y, d)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/** Enough Markdown for what run.ts writes: headings, pipe tables, lists, paragraphs, and
 *  inline bold and code. Not a general renderer, and not worth a dependency. */
function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r/g, '').split('\n')
  let i = 0
  const inline = (s: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, k) =>
      part.startsWith('**') ? (
        <b key={k} className="text-ink">
          {part.slice(2, -2)}
        </b>
      ) : part.startsWith('`') ? (
        <code key={k} className="rounded bg-surface-3 px-1 text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      ) : (
        part
      ),
    )
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      blocks.push(
        <p
          key={i}
          className={`${h[1].length <= 2 ? 'mt-4 text-sm' : 'mt-3 text-xs'} font-semibold text-ink first:mt-0`}
        >
          {inline(h[2])}
        </p>,
      )
      i++
      continue
    }
    if (line.trimStart().startsWith('|')) {
      const rows: string[][] = []
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        const cells = lines[i]
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim())
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells)
        i++
      }
      const [head, ...body] = rows
      blocks.push(
        <div key={i} className="my-2 overflow-x-auto rounded border border-line">
          <table className="w-full text-[0.68rem] tabular-nums">
            <thead className="bg-surface-2 text-muted">
              <tr>
                {head.map((c, k) => (
                  <th key={k} className="whitespace-nowrap px-2 py-1 text-left font-medium">
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, k) => (
                <tr key={k} className="border-t border-line">
                  {r.map((c, j) => (
                    <td key={j} className="whitespace-nowrap px-2 py-1 text-ink-2">
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*[-*]\s+/, '')
        i++
        // continuation lines (indented, not a new item)
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) {
          item += ` ${lines[i].trim()}`
          i++
        }
        items.push(item)
      }
      blocks.push(
        <ul key={i} className="my-1.5 list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-ink-2">
          {items.map((it, k) => (
            <li key={k}>{inline(it)}</li>
          ))}
        </ul>,
      )
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !lines[i].trimStart().startsWith('|') &&
      !/^\s*[-*]\s+/.test(lines[i])
    ) {
      para.push(lines[i].trim())
      i++
    }
    blocks.push(
      <p key={i} className="my-1.5 max-w-[100ch] text-xs leading-relaxed text-ink-2">
        {inline(para.join(' '))}
      </p>,
    )
  }
  return <div>{blocks}</div>
}
