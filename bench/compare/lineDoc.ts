// A tool's SVG → the stroke-aware EditableDoc centerlineScore.ts reads, in the pixels of the
// render — the 'line' corpus counterpart of traceSvg.ts.
//
// The reader is the ANSWER SHEET's (bench/lineArtGround.ts parseLineArt), as traceSvg.ts
// reuses svgGround's: a traced stroke and an authored stroke become centrelines with widths
// by the same code, dots and all. LogoLab's output takes this path too, from its serialized
// string — no tool is scored on an in-memory doc the others do not get. Before it:
//
//   • the root is normalised to w×h (render.ts normalizeRoot), so the geometry lands in
//     the pixels resvg painted, and inherited paint is resolved and invisible elements
//     dropped (traceSvg.ts resolvePaint);
//   • a `<style>` sheet is refused ('styled'), as traceSvg refuses it: paint the reader
//     cannot see would be scored as paint that is not there.
//
// After it, three rules of the TRACE side (the answer sheet does not need them):
//
//   • paper is not ink. On a one-ink-on-white corpus a light paint (Rec.601 luma ≥ 128,
//     the cut every tool's input was made with) is the ground: LogoLab's paper rectangle,
//     VTracer's white background, a white counter. Dropped, so it is neither a traced fill
//     nor a traced stroke. (A white counter stacked over a black fill is then lost from the
//     fill mask, which only widens the "under traced ink" recall allowance; the outline
//     tools that draw that way have no strokes, and so no centreline score, anyway.)
//   • a path that returns to its own start is a ring, whatever its cap. The answer sheet
//     closes only round-capped meets (lineArtGround.closeCoincident: a butt meet paints a
//     notch). AutoTrace writes every loop it finds as an open butt-capped path back to its
//     start; counting two ends there would score its file syntax, not its topology.
//   • every fill is nonzero, as traceSvg.ts's shimDoc is.
//
// `strokes === 0` is the 'no strokes' refusal score.ts writes for an outline tracer: its
// pixel metrics still apply, the centreline metrics are n/a.

import { transformSubPaths, affineScale } from '../../src/lib/path/geometry.ts'
import type { EditableDoc, PathItem, SubPath } from '../../src/lib/path/types.ts'
import { parseLineArt } from '../lineArtGround.ts'
import { normalizeRoot } from './render.ts'
import { resolvePaint } from './traceSvg.ts'

export interface LineTrace {
  doc: EditableDoc
  strokes: number
  fills: number
  /** Anchors over every painted element, paper included (docNodes on a line row). Counted
   *  by svgGround's shape reader, as docNodes is on a fill row. */
  nodes: number
  /** Painted elements, paper included (docPaths on a line row). */
  paths: number
}

/** Paint → [r, g, b], or null for paint we cannot read (treated as ink). */
export function paintRgb(paint: string | undefined): [number, number, number] | null {
  const p = (paint ?? '').trim().toLowerCase()
  if (p === '' || p === 'currentcolor' || p === 'black') return [0, 0, 0]
  if (p === 'white') return [255, 255, 255]
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(p)
  if (m) return [m[1], m[2], m[3]].map((h) => Number.parseInt(h + h, 16)) as [number, number, number]
  m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(p)
  if (m) return [m[1], m[2], m[3]].map((h) => Number.parseInt(h, 16)) as [number, number, number]
  m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(p)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  return null
}

/** Light paint is paper (see the header). Unreadable paint counts as ink. */
export const isPaperPaint = (paint: string | undefined): boolean => {
  const c = paintRgb(paint)
  return c !== null && 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] >= 128
}

const hex = (paint: string | undefined): string => {
  const c = paintRgb(paint) ?? [0, 0, 0]
  return `#${c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`
}

/** Close an open subpath whose ends meet within `eps` px (the ring rule above). */
export function closeMeet(sp: SubPath, eps: number): SubPath {
  if (sp.closed || sp.nodes.length < 3) return sp
  const a = sp.nodes[0]
  const b = sp.nodes[sp.nodes.length - 1]
  if (Math.hypot(a.x - b.x, a.y - b.y) > eps) return sp
  const nodes = sp.nodes.slice(0, -1)
  nodes[0] = { ...a, hIn: b.hIn }
  return { nodes, closed: true }
}

/** Parse a tool's SVG into pixel space. Returns the refusal string when it cannot be read. */
export function parseLineTrace(svg: string, w: number, h: number): LineTrace | string {
  let root: ReturnType<typeof normalizeRoot>
  try {
    root = normalizeRoot(svg, w, h)
  } catch (e) {
    return `no root (${(e as Error).message})`
  }
  if (/<\s*style\b/.test(svg)) return 'styled'
  const gt = parseLineArt(resolvePaint(root.svg))
  const k = affineScale(root.toPixels)
  const items: PathItem[] = []
  let strokes = 0
  let fills = 0
  // File cost counts every painted element, paper included: a white background or counter
  // is part of what the tool wrote, even though it is not ink to score.
  const anchors = (sps: SubPath[]): number => sps.reduce((n, sp) => n + sp.nodes.length, 0)
  let nodes = 0
  let paths = 0
  for (const st of gt.strokes) {
    nodes += anchors(st.subPaths)
    paths++
    if (isPaperPaint(st.color)) continue
    const width = st.width * k
    const subPaths = transformSubPaths(st.subPaths, root.toPixels).map((sp) =>
      closeMeet(sp, Math.max(0.05, 1e-3 * width)),
    )
    items.push({
      kind: 'path',
      id: `s${strokes}`,
      fill: 'none',
      fillRule: 'nonzero',
      subPaths,
      stroke: { color: hex(st.color), width, cap: st.cap, join: st.join },
      visible: true,
    })
    strokes++
  }
  for (const f of gt.fills) {
    nodes += anchors(f.subPaths)
    paths++
    if (isPaperPaint(f.fill)) continue
    const subPaths = transformSubPaths(f.subPaths, root.toPixels)
    items.push({ kind: 'path', id: `f${fills}`, fill: hex(f.fill), fillRule: 'nonzero', subPaths, visible: true })
    fills++
  }
  return { doc: { viewBox: [0, 0, w, h], items }, strokes, fills, nodes, paths }
}
