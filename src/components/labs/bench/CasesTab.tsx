import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink } from '../../ui/icons'
import { Tooltip } from '../../ui/Tooltip'
import { Badge, CaseRow } from '../CaseRow'
import { LabCheck, LabSelect } from '../LabPage'
import { Panel } from '../Panel'
import { deltaEField, deltaEHeat } from '../../../lib/render/fidelity'
import { diffPicture } from '../../../lib/render/diffView'
import { heatCss } from '../../../lib/heat'
import {
  CORE_TOOLS,
  GROUP_LABEL,
  HEADLINE_TOOL,
  METRICS,
  METRIC_BY_KEY,
  caseDir,
  caseTable,
  num,
  toolInfo,
  type BenchCaseMeta,
  type BenchResults,
  type BenchRow,
} from './benchData'
import { NodeCount, ScoreTable, SvgArt } from './figure'
import { runUrl, useFetched } from './ui'

/**
 * Cases: every tool's output for one case side by side, under one camera per row (wheel to
 * zoom, drag to pan, double-click to reset). Three ways to look:
 *
 *   Picture     the SVG itself, not its PNG render, so a zoom shows the curves
 *   Nodes       the same SVG with its anchors and the kinks the scorer counted (overlay.json)
 *   Difference  per-pixel ΔE against the authored render, the shipped deltaEField
 *
 * Under each row, the picture and drawing scores of the tools shown, as two halves of one
 * table: the same table the Overview uses. Four tools by default, one of each kind.
 */

export type CaseMode = 'picture' | 'nodes' | 'diff'

const MODES: { id: CaseMode; label: string; hint: string }[] = [
  { id: 'picture', label: 'Picture', hint: 'The SVG files themselves. Zoom in: they stay sharp.' },
  {
    id: 'nodes',
    label: 'Nodes',
    hint: 'Every anchor as a dot, every kink the scorer counted (a 5°+ corner where the drawing is smooth) as a red ring.',
  },
  {
    id: 'diff',
    label: 'Difference',
    hint: 'Per-pixel colour error (ΔE) against the authored render, over a dim ghost of the art: hot is wrong.',
  },
]

const SORT_OPTIONS = [
  { value: 'worst' as const, label: 'Worst first' },
  { value: 'best' as const, label: 'Best first' },
  { value: 'name' as const, label: 'By name' },
]

const PAGE = 8

export interface CasesView {
  metric: string
  sortTool: string
  sortDir: 'worst' | 'best' | 'name'
  mode: CaseMode
  allTools: boolean
}

export function CasesTab({
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
  view: CasesView
  setView: (p: Partial<CasesView>) => void
  match: (...fields: (string | undefined | null)[]) => boolean
  page: number
  setPage: (p: number) => void
}) {
  const table = useMemo(() => caseTable(data.rows, corpus), [data, corpus])
  const metric = METRIC_BY_KEY.get(view.metric) ?? METRICS[0]
  const shownTools = view.allTools ? tools : tools.filter((t) => CORE_TOOLS.includes(t))
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
        <div className="inline-flex rounded-md border border-line bg-surface-2 p-0.5">
          {MODES.map((m) => (
            <Tooltip key={m.id} label={m.hint} side="bottom">
              <button
                type="button"
                aria-pressed={view.mode === m.id}
                onClick={() => setView({ mode: m.id })}
                className={`rounded px-2.5 py-1 transition-colors ${view.mode === m.id ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
              >
                {m.label}
              </button>
            </Tooltip>
          ))}
        </div>
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
          label="All tools"
          checked={view.allTools}
          onChange={(allTools) => setView({ allTools })}
          hint="Show every tool in the run, not just one of each kind (LogoLab, VTracer, StarVector, Potrace)."
        />
        <span className="ml-auto text-faint">
          {ids.length} cases{ids.length !== table.size && ` of ${table.size}`}
        </span>
        <Pager page={p} pages={pages} setPage={setPage} />
      </div>
      {shown.map((id) => (
        <CaseView
          key={id}
          run={run}
          caseId={id}
          byTool={table.get(id) ?? new Map()}
          tools={shownTools}
          meta={meta.get(id)}
          mode={view.mode}
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

interface Overlay {
  width: number
  height: number
  authored: number[]
  tools: Record<string, { anchors: number[]; breaks: number[] }>
}

function CaseView({
  run,
  caseId,
  byTool,
  tools,
  meta,
  mode,
}: {
  run: string
  caseId: string
  byTool: Map<string, BenchRow>
  tools: string[]
  meta: BenchCaseMeta | undefined
  mode: CaseMode
}) {
  const dir = caseDir(caseId)
  const truth = runUrl(run, `${dir}/truth.png`)
  // The panels take the authored drawing's shape, read off its viewBox.
  const authored = useFetched<string>(runUrl(run, `gt/${caseId}`), 'text')
  const aspect = useMemo(() => {
    const vb = authored && /viewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)/i.exec(authored)
    return vb ? Number(vb[1]) / Number(vb[2]) || 1 : 1
  }, [authored])
  // Only fetched once someone asks for nodes: 100 cases × 11 tools of anchors is not free.
  const overlay = useFetched<Overlay>(mode === 'nodes' ? runUrl(run, `${dir}/overlay.json`) : null, 'json')
  const any = byTool.values().next().value as BenchRow | undefined
  const present = tools.filter((t) => byTool.has(t))
  const count = (o: { anchors: number[]; breaks: number[] } | undefined) => (o ? <NodeCount {...o} /> : undefined)

  return (
    <CaseRow
      title={caseId.slice(caseId.indexOf('/') + 1)}
      badges={
        <>
          {any && <Badge tone={any.heldOut ? 'ok' : 'warn'}>{any.heldOut ? 'held out' : 'in-sample'}</Badge>}
          {meta?.gtRefusal && <Badge tone="warn">geometry n/a: {meta.gtRefusal}</Badge>}
        </>
      }
      right={
        <a
          href={runUrl(run, `gt/${caseId}`)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 hover:text-accent"
        >
          authored SVG <ExternalLink size={10} />
        </a>
      }
      footer={
        <>
          <ScoreTable columns={present.map((t) => ({ tool: t, metrics: byTool.get(t) as Record<string, unknown> }))} />
          <p className="mt-1.5 text-[0.65rem] text-faint">
            {meta?.source} · {meta?.license}
          </p>
        </>
      }
    >
      <Panel
        label="Authored"
        note={
          mode === 'nodes' ? count(overlay ? { anchors: overlay.authored, breaks: [] } : undefined) : 'the answer sheet'
        }
        aspect={aspect}
        pixelated={mode === 'diff'}
      >
        {mode === 'diff' ? <img src={truth} alt="" /> : <SvgArt url={runUrl(run, `gt/${caseId}`)} />}
      </Panel>
      {present.map((tool) => {
        const r = byTool.get(tool)
        const failed = r && r.status !== 'ok'
        const o = overlay?.tools[tool]
        return (
          <Panel
            key={tool}
            aspect={aspect}
            dark={mode === 'diff'}
            pixelated={mode === 'diff'}
            label={
              <span className="inline-flex items-center gap-1">
                {toolInfo(tool).label}
                <a
                  href={runUrl(run, `${dir}/${tool}.svg`)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-faint hover:text-accent"
                  aria-label={`Open the ${toolInfo(tool).label} SVG`}
                >
                  <ExternalLink size={10} />
                </a>
              </span>
            }
            note={failed ? <span className="text-bad">{r?.status}</span> : mode === 'nodes' ? count(o) : undefined}
          >
            {mode === 'diff' ? (
              <DiffArt truth={truth} render={runUrl(run, `${dir}/${tool}.png`)} />
            ) : (
              <SvgArt
                url={runUrl(run, `${dir}/${tool}.svg`)}
                breaks={o?.breaks}
                w={overlay?.width}
                h={overlay?.height}
              />
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
