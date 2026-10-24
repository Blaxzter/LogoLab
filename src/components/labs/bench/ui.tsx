import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown } from '../../ui/icons'
import { Tooltip } from '../../ui/Tooltip'
import { Badge } from '../CaseRow'
import { LabSelect } from '../LabPage'
import { HEADLINE_TOOL, corpusInfo, toolInfo } from './benchData'

// The small pieces every /labs/bench tab shares.

export const runUrl = (run: string, path: string) => `/__bench/runs/${encodeURIComponent(run)}/${path}`

/** Fetch a run file once per URL; `null` while loading or when it is missing. */
export function useFetched<T>(url: string | null, as: 'json' | 'text'): T | null {
  const [v, setV] = useState<T | null>(null)
  useEffect(() => {
    setV(null)
    if (!url) return
    let live = true
    fetch(url)
      .then((r) => (r.ok ? (as === 'json' ? r.json() : r.text()) : null))
      .then((x) => live && setV(x as T | null))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [url, as])
  return v
}

export function ToolName({ tool }: { tool: string }) {
  const info = toolInfo(tool)
  return (
    <Tooltip
      label={
        <>
          <b>{tool}</b>: {info.blurb}
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

export function Th({ children, hint, first }: { children: ReactNode; hint: string; first?: boolean }) {
  return (
    <th className={`px-2 py-1.5 text-right font-medium ${first ? 'border-l border-line' : ''}`}>
      <Tooltip label={hint} side="bottom">
        <span className="cursor-help whitespace-nowrap">{children}</span>
      </Tooltip>
    </th>
  )
}

export function SectionTitle({ title, note, right }: { title: string; note?: ReactNode; right?: ReactNode }) {
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

/** A section that starts closed: the detail is there for whoever wants it, and out of the way
 *  of whoever doesn't. Most of what made the first version of this lab overwhelming was detail
 *  shown to everyone. */
export function More({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <details className="group rounded-lg border border-line bg-surface">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-2 text-xs text-ink-2 [&::-webkit-details-marker]:hidden">
        <ChevronDown size={13} className="shrink-0 transition-transform group-open:rotate-180" />
        <b className="font-semibold">{title}</b>
        {note && <span className="text-muted">{note}</span>}
      </summary>
      <div className="border-t border-line p-3">{children}</div>
    </details>
  )
}

export function CorpusLine({ corpus, n }: { corpus: string; n: number }) {
  const info = corpusInfo(corpus)
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <b className="text-ink">{info.label}</b>
      <Badge tone={info.heldOut ? 'ok' : 'warn'}>{info.heldOut ? 'held out' : 'in-sample'}</Badge>
      <span className="text-faint">
        {n} cases · {info.license}
      </span>
      {!info.heldOut && (
        <span className="text-warn">LogoLab was developed against these: read them as explanation, not evidence.</span>
      )}
    </div>
  )
}

export function ToolSelect({
  label,
  value,
  tools,
  onChange,
}: {
  label: string
  value: string
  tools: string[]
  onChange: (t: string) => void
}) {
  return (
    <LabSelect
      label={label}
      value={value}
      onChange={onChange}
      options={tools.map((t) => ({ value: t, label: toolInfo(t).label }))}
    />
  )
}

export function HowToRun({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`mx-auto max-w-3xl px-4 text-sm leading-relaxed text-ink-2 ${compact ? 'py-6' : 'py-10'}`}>
      <h2 className="text-base font-semibold text-ink">This tab reads a local run</h2>
      <p className="mt-2">
        The full results drive VTracer, Potrace and a 1B-parameter model on a GPU, and their renders are of art that is
        not redistributed, so they never ship with the site. The Overview tab is the frozen summary. To explore every
        case, make a run from a checkout:
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
