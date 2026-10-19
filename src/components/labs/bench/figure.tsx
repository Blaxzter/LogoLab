import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import { parseGroundTruth } from '../../../../bench/svgGround'
import { RawArt } from '../Panel'
import { subPathsWire } from '../wire'
import { toolInfo } from './benchData'
import { useFetched } from './ui'

/**
 * One SVG of a case as the A/B lab draws a trace: INLINE, so the browser re-renders the
 * vectors at every zoom (an `<img>` under a CSS scale magnifies a bitmap, and at 4000% its
 * blurred edge no longer runs through the nodes on it), with the lab's `.lab-wire`
 * wireframe of the file's own geometry appended in the file's own user units: outlines,
 * square dots on corners, round ones on smooth nodes, a constant screen size at any zoom.
 * Like every lab panel the wireframe is in the markup and shows when an ancestor carries
 * `.wires`, so the Nodes toggle needs no refetch.
 *
 * Shared by the Overview figures and the Cases tab, so "68 nodes, 0 kinks" is the same
 * picture in both.
 */
export function SvgArt({ url, breaks, w, h }: { url: string; breaks?: number[]; w?: number; h?: number }) {
  const svg = useFetched<string>(url, 'text')
  const html = useMemo(() => (svg ? withWire(svg) : ''), [svg])
  return (
    <>
      {html && <RawArt html={html} />}
      {breaks && breaks.length > 0 && w && h && <KinkRings w={w} h={h} breaks={breaks} />}
    </>
  )
}

/** The file's markup, filled at full size, with its fill dimmable and its wireframe added. */
function withWire(svg: string): string {
  const open = /<svg\b[^>]*>/i.exec(svg)
  if (!open) return ''
  const end = svg.lastIndexOf('</svg>')
  const inner = svg.slice(open.index + open[0].length, end < 0 ? undefined : end)
  let wire = ''
  try {
    // parseGroundTruth applies every group transform, so the nodes land in the root's
    // user units: StarVector's files draw inside a flipped, scaled <g>.
    wire = subPathsWire(parseGroundTruth(svg).shapes.map((s) => s.subPaths))
  } catch {
    // no wireframe for a file the reader cannot parse; the picture still shows
  }
  // Fill the panel. A file sized by width/height alone (VTracer's) draws in those units, so
  // the size becomes its viewBox before it goes.
  let tag = open[0]
  if (!/\sviewBox\s*=/i.test(tag)) {
    const w = /\swidth\s*=\s*["']([\d.]+)/i.exec(tag)?.[1]
    const h = /\sheight\s*=\s*["']([\d.]+)/i.exec(tag)?.[1]
    if (w && h) tag = tag.replace(/<svg\b/i, `<svg viewBox="0 0 ${Number(w)} ${Number(h)}"`)
  }
  tag = tag.replace(/\s(?:width|height)\s*=\s*("[^"]*"|'[^']*')/g, '').replace(/\/?>$/, ' width="100%" height="100%">')
  return `${tag}<g class="lab-fill">${inner}</g>${wire}</svg>`
}

/**
 * Red rings on the kinks the scorer counted, in the `w`×`h` pixels it scored in
 * (overlay.json). Positioned in PERCENT of the panel with radii in CSS px divided by the
 * zoom, so a ring is the same screen size at 100% and 4000% and needs no viewBox to agree
 * with the art's. It is a `.lab-wire`, so it shows with the wireframe.
 */
function KinkRings({ w, h, breaks }: { w: number; h: number; breaks: number[] }) {
  const ring: CSSProperties = {
    r: 'calc(6px / var(--pz-scale, 1))',
    strokeWidth: 'calc(1.75px / var(--pz-scale, 1))',
  } as CSSProperties
  const rings = []
  for (let i = 0; i < breaks.length; i += 3)
    rings.push(<circle key={i} cx={`${(breaks[i] / w) * 100}%`} cy={`${(breaks[i + 1] / h) * 100}%`} style={ring} />)
  return (
    <div className="lab-wire absolute inset-0">
      <svg className="h-full w-full overflow-visible" fill="none" stroke="#dc2626" aria-hidden>
        {rings}
      </svg>
    </div>
  )
}

/** "N nodes · K kinks" under a panel title. */
export function NodeCount({ anchors, breaks }: { anchors: number[]; breaks: number[] }) {
  return (
    <span className="tabular-nums">
      {anchors.length / 2} nodes
      {breaks.length > 0 && <span className="text-bad"> · {breaks.length / 3} kinks</span>}
    </span>
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
