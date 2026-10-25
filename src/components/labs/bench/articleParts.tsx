import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { usePanZoom } from '../../../hooks/usePanZoom'
import { ZoomControls } from '../../ui/ZoomControls'
import { toolInfo } from './benchData'
import { MAX_ZOOM } from '../CaseRow'
import { LabZoomContext } from '../LabPage'
import { Panel } from '../Panel'
import { type CaseMode, DiffArt, ModeSwitch, NodeCount, type ScoreRow, ScoreTable, SvgArt } from './figure'
import type { ShowExample } from './showcaseTypes'

// The labs' long-form pages (/labs/bench's Overview, /labs/how): a titled section, and a
// figure of real SVG files drawn side by side on one pan/zoom camera.

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-14">
      <h2 className="text-xl font-bold tracking-tight text-ink">{title}</h2>
      <div className="mt-3 space-y-3 text-[0.92rem] leading-relaxed text-ink-2 [&_code]:rounded [&_code]:bg-surface-3 [&_code]:px-1 [&_code]:text-[0.85em] [&_li]:mt-1 [&_ul]:list-disc [&_ul]:pl-5 [&>p]:max-w-[72ch] [&>ul]:max-w-[72ch]">
        {children}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// One example: the authored drawing and each tool's SVG, the real files, side by side.
// `base` is where its files are served (default /benchmark/<slug>); `labels` names a column
// that is not a benchmark tool (how-it-works shows one tracer with a rule off and on).

export function Figure({
  example,
  caption,
  initialMode = 'picture',
  base = `/benchmark/${example.slug}`,
  labels,
  rows,
}: {
  example: ShowExample
  caption?: ReactNode
  initialMode?: CaseMode
  base?: string
  labels?: Record<string, string>
  /** The table's rows, when not both halves (see ScoreTable). */
  rows?: ScoreRow[]
}) {
  const [mode, setMode] = useState<CaseMode>(initialMode)
  const nodes = mode === 'nodes'
  // The labs' row camera, on the labs' panels: every panel pans and zooms as one.
  const pz = usePanZoom({ maxScale: MAX_ZOOM })
  const claimed = useRef(false)
  const zoom = useMemo(() => ({ pz, claimed }), [pz])
  const panels = [
    {
      key: 'authored',
      title: 'Drawn by the artist',
      anchors: example.authoredNodes,
      breaks: [] as number[],
      dirs: [] as number[],
    },
    ...example.tools.map((t) => ({
      key: t.tool,
      title: labels?.[t.tool] ?? toolInfo(t.tool).label,
      anchors: t.anchors,
      breaks: t.breaks,
      dirs: t.dirs,
    })),
  ]
  // A lab panel is `--lab-box` square; here that is whatever fills the row (two per row on
  // a phone), measured, since the article's column is not a fixed width.
  const row = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState(200)
  useEffect(() => {
    const el = row.current
    if (!el) return undefined
    const fit = () => {
      const cols = el.clientWidth < 520 ? 2 : panels.length
      setBox(Math.max(120, Math.floor((el.clientWidth - GAP * (cols - 1)) / cols)))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [panels.length])
  return (
    // Panels stay about icon-sized however many there are: the figure is as wide as its
    // panels, not as wide as the page.
    <figure className={`my-6 ${nodes ? 'wires' : ''}`} style={{ maxWidth: panels.length * 250 }}>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span className="font-mono text-[0.7rem] text-faint">
          {example.caseId.slice(example.caseId.indexOf('/') + 1)}
        </span>
        <ModeSwitch mode={mode} onMode={setMode} />
        <ZoomControls pz={pz} className="ml-auto" />
      </div>
      <LabZoomContext.Provider value={zoom}>
        <div
          ref={row}
          className="flex flex-wrap items-stretch"
          style={{ gap: GAP, '--lab-box': `${box}px` } as CSSProperties}
        >
          {panels.map((p) => {
            // In Difference the artist's panel stays the picture every heat map is measured from.
            const diff = mode === 'diff' && p.key !== 'authored'
            return (
              <Panel
                key={p.key}
                label={p.title}
                note={nodes ? <NodeCount anchors={p.anchors} breaks={p.breaks} /> : undefined}
                aspect={example.width / example.height}
                dark={diff}
                pixelated={diff}
              >
                {diff ? (
                  <DiffArt
                    truth={`${base}/authored.svg`}
                    render={`${base}/${p.key}.svg`}
                    w={example.width}
                    h={example.height}
                    mean={false}
                  />
                ) : (
                  <SvgArt
                    url={`${base}/${p.key}.svg`}
                    breaks={p.breaks}
                    dirs={p.dirs}
                    w={example.width}
                    h={example.height}
                  />
                )}
              </Panel>
            )
          })}
        </div>
      </LabZoomContext.Provider>
      <ScoreTable
        columns={example.tools.map((t) => ({ tool: t.tool, metrics: t.metrics }))}
        labels={labels}
        rows={rows}
      />
      {caption && (
        <figcaption className="mt-3 max-w-[72ch] text-[0.85rem] leading-relaxed text-muted">{caption}</figcaption>
      )}
    </figure>
  )
}

const GAP = 12
