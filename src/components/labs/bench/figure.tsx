import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { parseGroundTruth } from '../../../../bench/svgGround'
import { heatCss } from '../../../lib/heat'
import { deltaEField, deltaEHeat } from '../../../lib/render/fidelity'
import { diffPicture } from '../../../lib/render/diffView'
import { Tooltip } from '../../ui/Tooltip'
import { useLabZoom } from '../LabPage'
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
export function SvgArt({
  url,
  breaks,
  dirs,
  w,
  h,
}: {
  url: string
  breaks?: number[]
  dirs?: number[]
  w?: number
  h?: number
}) {
  const svg = useFetched<string>(url, 'text')
  const html = useMemo(() => (svg ? withWire(svg) : ''), [svg])
  return (
    <>
      {html && <RawArt html={html} />}
      {breaks && breaks.length > 0 && w && h && <Kinks w={w} h={h} breaks={breaks} dirs={dirs} />}
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

/** Screen px of each tangent arm drawn at a kink: at 8° the two arms' ends are ~8 px apart. */
const ARM = 60
/** Zoom from which a kink shows its arms and angle. Below it the rings sit a few px apart
 *  where kinks cluster (VTracer's eyebrows), and their arms crossed into a scribble. */
const DETAIL_ZOOM = 3

/**
 * The kinks the scorer counted, drawn as it measured them, in the `w`×`h` pixels it scored
 * in (overlay.json): a ring on the node, the direction the outline ARRIVES in carried on
 * past it (dashed: where a smooth curve would have gone), the direction it actually LEAVES
 * in (solid), and the angle between the two. An 8° kink is a real corner and still hard to
 * see on a curve that bends across the whole panel; the two arms make it readable at any
 * zoom, which an angle needs, since zooming in flattens the curve but never the kink.
 *
 * Each mark is a nested <svg> placed in PERCENT of the panel and drawn in screen px, scaled
 * by 1/zoom, so it is the same size at every zoom and needs no viewBox to agree with the
 * art's. It is a `.lab-wire`, so it shows with the wireframe. Arms and angles wait for
 * DETAIL_ZOOM; the ring alone says where.
 */
function Kinks({ w, h, breaks, dirs }: { w: number; h: number; breaks: number[]; dirs?: number[] }) {
  const detail = useLabZoom().pz.scale >= DETAIL_ZOOM
  const counter: CSSProperties = { transform: 'scale(calc(1 / var(--pz-scale, 1)))' }
  const marks = []
  for (let i = 0, k = 0; i < breaks.length; i += 3, k += 4) {
    const d = detail && dirs && dirs.length >= k + 4 ? dirs.slice(k, k + 4) : null
    marks.push(
      <svg key={i} x={`${(breaks[i] / w) * 100}%`} y={`${(breaks[i + 1] / h) * 100}%`} overflow="visible">
        <g style={counter}>
          {d && (
            <>
              <line x1={-ARM * d[0]} y1={-ARM * d[1]} x2={0} y2={0} />
              <line x1={0} y1={0} x2={ARM * d[0]} y2={ARM * d[1]} strokeDasharray="3 3" />
              <line x1={0} y1={0} x2={ARM * d[2]} y2={ARM * d[3]} />
            </>
          )}
          <circle r={6} />
          {detail && (
            <text
              x={9}
              y={-9}
              fill="#dc2626"
              stroke="#fff"
              strokeWidth={3}
              paintOrder="stroke"
              fontSize={11}
              fontWeight={600}
            >
              {breaks[i + 2]}°
            </text>
          )}
        </g>
      </svg>,
    )
  }
  return (
    <div className="lab-wire absolute inset-0">
      <svg className="h-full w-full overflow-visible" fill="none" stroke="#dc2626" strokeWidth={1.75} aria-hidden>
        {marks}
      </svg>
    </div>
  )
}

export type CaseMode = 'picture' | 'nodes' | 'diff'

const MODES: { id: CaseMode; label: string; hint: string }[] = [
  { id: 'picture', label: 'Picture', hint: 'The SVG files themselves. Zoom in: they stay sharp.' },
  {
    id: 'nodes',
    label: 'Nodes & kinks',
    hint: 'Outlines and anchors (square: corner, round: smooth). A red ring is a kink the scorer counted, a 5°+ corner where the drawing is smooth: dashed is where the outline was heading, solid where it goes.',
  },
  {
    id: 'diff',
    label: 'Difference',
    hint: 'Per-pixel colour error (ΔE) against the authored render, over a dim ghost of the art: hot is wrong.',
  },
]

/** Picture | Nodes & kinks | Difference: how a row of panels draws each SVG. */
export function ModeSwitch({ mode, onMode }: { mode: CaseMode; onMode: (m: CaseMode) => void }) {
  return (
    <div className="inline-flex rounded-md border border-line bg-surface-2 p-0.5 text-xs">
      {MODES.map((m) => (
        <Tooltip key={m.id} label={m.hint} side="bottom">
          <button
            type="button"
            aria-pressed={mode === m.id}
            onClick={() => onMode(m.id)}
            className={`rounded px-2.5 py-1 transition-colors ${mode === m.id ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
          >
            {m.label}
          </button>
        </Tooltip>
      ))}
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

// One decode per URL and size for the life of the page: the authored render is the left side
// of every tool's difference in its row.
const pixelCache = new Map<string, Promise<ImageData>>()

/** A raster or an SVG file as pixels, ON WHITE as the run rendered every input: at `size`,
 *  or at its natural size. */
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
        g.fillStyle = '#fff'
        g.fillRect(0, 0, w, h)
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

/**
 * The studio's Difference picture for one output: heat over a ghost of the art, from ONE
 * deltaEField call (CLAUDE.md: the number and the picture are one field), both sides drawn
 * on white at `w`×`h` (default: the truth's own size). `mean` adds the field's mean ΔE in a corner chip; the Overview leaves
 * it off, since a browser raster scores a hair off the run's resvg one and the table under
 * the figure already prints the run's number.
 */
export function DiffArt({
  truth,
  render,
  w,
  h,
  mean: showMean = true,
}: {
  truth: string
  render: string
  w?: number
  h?: number
  mean?: boolean
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [mean, setMean] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    ;(async () => {
      const src = await loadPixels(truth, w && h ? { w, h } : undefined)
      const out = await loadPixels(render, { w: src.width, h: src.height })
      if (!live) return
      const { width, height } = src
      const field = deltaEField(src.data, out.data, width, height)
      const pic = diffPicture(deltaEHeat(field.de), field.de, src.data, width, height)
      const c = ref.current
      if (!c) return
      c.width = width
      c.height = height
      const g = c.getContext('2d')
      if (g) {
        const img = g.createImageData(width, height)
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
  }, [truth, render, w, h])
  return (
    <>
      <canvas ref={ref} />
      {err && <span className="absolute inset-x-1 top-1 text-[0.6rem] text-bad">{err}</span>}
      {showMean && mean !== null && (
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
