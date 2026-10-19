import type { CSSProperties, ReactNode } from 'react'
import type { PanZoom } from '../../../hooks/usePanZoom'
import { ZoomSurface } from '../../ui/ZoomSurface'
import { toolInfo } from './benchData'

/**
 * The SVGs of one case side by side, with their nodes and the kinks the scorer counted —
 * shared by the Overview article and the Cases tab, so "68 nodes, 0 kinks" means the same
 * picture in both.
 *
 * The overlay's marks are sized in SCREEN pixels whatever the zoom: radii and strokes are
 * divided by `--pz-scale`, which usePanZoom sets on every camera, the labs' rows and NodePanels
 * alike. Without it a 4× zoom draws 4× dots that bury the curve they mark.
 */

export interface NodePanel {
  key: string
  title: ReactNode
  /** Small print right of the title (counts, a status). */
  note?: ReactNode
  src: string
  anchors: number[]
  /** Flat [x, y, kink°, …]. */
  breaks: number[]
}

/** Dots on anchors, red rings on counted kinks, in the art's `w`×`h` pixel space. */
export function NodeOverlay({ w, h, anchors, breaks }: { w: number; h: number; anchors: number[]; breaks: number[] }) {
  // User units per screen pixel at a ~220px panel; the zoom divides it back out via CSS.
  const u = w / 220
  const px = (v: number): CSSProperties => ({ r: `calc(${v * u}px / var(--pz-scale, 1))` }) as CSSProperties
  const sw = (v: number): CSSProperties => ({ strokeWidth: `calc(${v * u}px / var(--pz-scale, 1))` })
  const dots: ReactNode[] = []
  for (let i = 0; i < anchors.length; i += 2)
    dots.push(<circle key={i} cx={anchors[i]} cy={anchors[i + 1]} style={px(1.6)} />)
  const rings: ReactNode[] = []
  for (let i = 0; i < breaks.length; i += 3)
    rings.push(<circle key={i} cx={breaks[i]} cy={breaks[i + 1]} style={px(5)} />)
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
      <g fill="#4f46e5" stroke="#fff" style={sw(0.6)}>
        {dots}
      </g>
      <g fill="none" stroke="#dc2626" style={sw(1.6)}>
        {rings}
      </g>
    </svg>
  )
}

/**
 * Panels on ONE camera (`pz`, the caller's, so it can put the zoom pill where it likes):
 * the labs' pan and zoom, drag and pinch and double-click to reset, with every panel moving
 * in lockstep. The wheel zooms only with Ctrl/⌘ held: on a scrolling article a plain wheel
 * that zooms instead of scrolling is a trap.
 */
export function NodePanels({
  panels,
  width,
  height,
  nodes,
  pz,
  columns,
}: {
  panels: NodePanel[]
  width: number
  height: number
  nodes: boolean
  pz: PanZoom
  /** Panels per row from `sm` up; defaults to all of them. */
  columns?: number
}) {
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:[grid-template-columns:repeat(var(--cols),minmax(0,1fr))]"
      style={{ '--cols': columns ?? panels.length } as CSSProperties}
    >
      {panels.map((p, i) => (
        <div key={p.key} className="min-w-0">
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
            <b className="font-semibold text-ink">{p.title}</b>
            {p.note && <span className="shrink-0 tabular-nums text-faint">{p.note}</span>}
          </div>
          <ZoomSurface
            pz={pz}
            primary={i === 0}
            wheel="modifier"
            className="rounded-lg border border-line bg-white"
            style={{ aspectRatio: `${width} / ${height}` }}
          >
            <img src={p.src} alt="" className="h-full w-full" loading="lazy" draggable={false} />
            {nodes && <NodeOverlay w={width} h={height} anchors={p.anchors} breaks={p.breaks} />}
          </ZoomSurface>
        </div>
      ))}
    </div>
  )
}

export interface ScoreRow {
  key: string
  label: string
  better: 'lower' | 'higher'
  digits: number
}

export const PICTURE_ROWS: ScoreRow[] = [
  { key: 'sbDino', label: 'DINO score', better: 'higher', digits: 4 },
  { key: 'sbLpips', label: 'LPIPS', better: 'lower', digits: 4 },
  { key: 'sbSsim', label: 'SSIM', better: 'higher', digits: 3 },
]
export const DRAWING_ROWS: ScoreRow[] = [
  { key: 'meanDeltaE', label: 'Colour error (ΔE)', better: 'lower', digits: 2 },
  { key: 'chamfer', label: 'Edge error (px)', better: 'lower', digits: 2 },
  { key: 'docNodes', label: 'Nodes', better: 'lower', digits: 0 },
  { key: 'tangentBreaks', label: 'Kinks on smooth curves', better: 'lower', digits: 0 },
]

const val = (m: Record<string, unknown>, k: string): number | null =>
  typeof m[k] === 'number' ? (m[k] as number) : null

/**
 * Both kinds of score for one case, the winner of each row marked. The argument of the whole
 * benchmark is that the two halves of this table disagree, so they are drawn as two halves.
 */
export function ScoreTable({ columns }: { columns: { tool: string; metrics: Record<string, unknown> }[] }) {
  const rows = [...PICTURE_ROWS, ...DRAWING_ROWS]
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full min-w-[460px] text-xs tabular-nums">
        <thead className="border-b border-line bg-surface-2 text-[0.68rem] text-muted">
          <tr>
            <th className="px-2.5 py-1.5 text-left font-medium" />
            {columns.map((c) => (
              <th key={c.tool} className="px-2.5 py-1.5 text-right font-medium">
                {toolInfo(c.tool).label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const vals = columns.map((c) => val(c.metrics, r.key))
            const present = vals.filter((v): v is number => v !== null)
            const best = present.length ? (r.better === 'lower' ? Math.min(...present) : Math.max(...present)) : null
            const tie = present.filter((v) => v.toFixed(r.digits) === best?.toFixed(r.digits)).length > 1
            return (
              <tr
                key={r.key}
                className={`border-t border-line ${i === PICTURE_ROWS.length ? 'border-t-2 border-t-line-strong' : ''}`}
              >
                <td className="whitespace-nowrap px-2.5 py-1.5 text-muted">
                  {r.label}
                  {i === 0 && (
                    <span className="ml-1.5 rounded bg-surface-3 px-1 py-0.5 text-[0.6rem] uppercase tracking-wide">
                      picture
                    </span>
                  )}
                  {i === PICTURE_ROWS.length && (
                    <span className="ml-1.5 rounded bg-accent-soft px-1 py-0.5 text-[0.6rem] uppercase tracking-wide text-accent">
                      drawing
                    </span>
                  )}
                </td>
                {vals.map((v, k) => (
                  <td
                    key={columns[k].tool}
                    className={`px-2.5 py-1.5 text-right ${v !== null && v === best && !tie ? 'font-semibold text-good' : 'text-ink-2'}`}
                  >
                    {v === null ? '—' : v.toFixed(r.digits)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
