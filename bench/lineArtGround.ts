// The answer sheet for the CENTRELINE tracer: an authored line-art SVG read as
// centrelines with widths, plus its fills.
//
// svgGround.ts refuses stroked elements, and for the outline lanes that refusal is
// correct — an outline tracer is scored on the stroke's boundary, which is an offset
// curve the reader does not build. Here the stroke IS the answer: the `d` is the
// centreline the engine has to find, `stroke-width` the width it has to measure and
// `stroke-linecap` the cap it has to read. So this reader ACCEPTS strokes and reports
// exactly those three things (in viewBox units, scaled to the raster by
// `lineArtToRaster`), and hands filled elements back as fills for the fill lane.
//
// One conversion is deliberate: a stroked circle or ellipse whose radius is no more
// than half its width paints a solid disc (Lucide draws its dots that way: r=1 at
// width 2). Its centreline is a degenerate ring inside the disc, and no tracer should
// be asked to recover it — it is a fill, radius r + w/2, and is scored as one.

import type { Affine, SubPath } from '../src/lib/path/types.ts'
import { ellipseSubPaths } from '../src/lib/path/model.ts'
import { affineScale, composeAffine, parseTransformAttr, transformSubPaths } from '../src/lib/path/geometry.ts'
import { attrs, prop, shapeSubPaths, SHAPES, STENCILS, type GroundShape } from './svgGround.ts'

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]
const num = (s: string | undefined, fallback = 0): number => {
  const v = Number.parseFloat(s ?? '')
  return Number.isFinite(v) ? v : fallback
}

export type CapKind = 'butt' | 'round' | 'square'
export type JoinKind = 'miter' | 'round' | 'bevel'

export interface GroundStroke {
  tag: string
  /** Centreline(s), in viewBox units (or raster px after `lineArtToRaster`). */
  subPaths: SubPath[]
  width: number
  cap: CapKind
  join: JoinKind
}

export interface LineArtGround {
  viewBox: [number, number, number, number]
  strokes: GroundStroke[]
  fills: GroundShape[]
}

interface Ctx {
  m: Affine
  stroke: string | null
  strokeWidth: string | null
  cap: string | null
  join: string | null
  fill: string | null
  /** Inside a `data-ground="none"` group: rendered, never scored. */
  noise?: boolean
}

const inherit = (a: Record<string, string>, ctx: Ctx, name: string, cur: string | null): string | null => {
  const v = prop(a, name)
  return v !== '' ? v : cur
}

/** Parse an authored line-art SVG. `<g>` nesting carries transforms and the stroke/fill
 *  presentation properties down; stencil containers are skipped as svgGround does. */
export function parseLineArt(svg: string): LineArtGround {
  const vbAttr = /viewBox\s*=\s*["']([^"']+)["']/.exec(svg)
  const vb = (vbAttr?.[1] ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  const viewBox: [number, number, number, number] = vb.length === 4 ? [vb[0], vb[1], vb[2], vb[3]] : [0, 0, 256, 256]
  const strokes: GroundStroke[] = []
  const fills: GroundShape[] = []
  const stack: Ctx[] = [{ m: IDENTITY, stroke: null, strokeWidth: null, cap: null, join: null, fill: null }]
  let inStencil = 0
  const re = /<\s*(\/?)\s*([\w:-]+)([^>]*?)(\/?)\s*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(svg)) !== null) {
    const [, close, rawTag, body, selfClose] = m
    const tag = rawTag.replace(/^.*:/, '')
    if (STENCILS.has(tag)) {
      inStencil += close ? -1 : selfClose ? 0 : 1
      continue
    }
    if (inStencil > 0) continue
    if (tag === 'g' || tag === 'svg') {
      if (close) {
        if (stack.length > 1) stack.pop()
      } else {
        const a = attrs(body)
        const top = stack[stack.length - 1]
        stack.push({
          m: composeAffine(top.m, parseTransformAttr(a.transform)),
          stroke: inherit(a, top, 'stroke', top.stroke),
          strokeWidth: inherit(a, top, 'stroke-width', top.strokeWidth),
          cap: inherit(a, top, 'stroke-linecap', top.cap),
          join: inherit(a, top, 'stroke-linejoin', top.join),
          fill: inherit(a, top, 'fill', top.fill),
          noise: top.noise || a['data-ground'] === 'none',
        })
        if (selfClose) stack.pop()
      }
      continue
    }
    if (close || !SHAPES.has(tag)) continue
    const a = attrs(body)
    const ctx = stack[stack.length - 1]
    // Drawn but not part of the answer: texture a fixture puts in the ink on purpose
    // (la-stubs' grey bumps), which the tracer must not turn into strokes.
    if (ctx.noise || a['data-ground'] === 'none') continue
    const m2 = composeAffine(ctx.m, parseTransformAttr(a.transform))
    const stroke = inherit(a, ctx, 'stroke', ctx.stroke)
    const fill = inherit(a, ctx, 'fill', ctx.fill)
    const stroked =
      stroke !== null && stroke !== 'none' && num(inherit(a, ctx, 'stroke-width', ctx.strokeWidth) ?? '1', 1) > 0
    const filled = fill === null ? true : fill !== 'none'
    const local = shapeSubPaths(tag, a)
    if (!local.length) continue
    const scale = affineScale(m2)
    if (stroked) {
      const width = num(inherit(a, ctx, 'stroke-width', ctx.strokeWidth) ?? '1', 1) * scale
      const cap = ((inherit(a, ctx, 'stroke-linecap', ctx.cap) ?? 'butt') as CapKind) || 'butt'
      const join = ((inherit(a, ctx, 'stroke-linejoin', ctx.join) ?? 'miter') as JoinKind) || 'miter'
      // A stroked disc with no hole is a fill.
      if ((tag === 'circle' || tag === 'ellipse') && !filled) {
        const r = tag === 'circle' ? num(a.r) : Math.min(num(a.rx), num(a.ry))
        if (r * scale <= width / 2 + 1e-6) {
          const R = r * scale + width / 2
          const rx = tag === 'circle' ? num(a.r) : num(a.rx)
          const ry = tag === 'circle' ? num(a.r) : num(a.ry)
          const disc = ellipseSubPaths(num(a.cx), num(a.cy), rx + width / 2 / scale, ry + width / 2 / scale)
          if (disc) fills.push({ tag, subPaths: transformSubPaths(disc, m2), fill: stroke })
          void R
          continue
        }
      }
      strokes.push({ tag, subPaths: transformSubPaths(local, m2), width, cap, join })
    }
    if (filled) fills.push({ tag, subPaths: transformSubPaths(local, m2), fill: fill ?? undefined })
  }
  return { viewBox, strokes, fills }
}

/** Scale the answer sheet into raster pixel space (aspect preserved, as resvg's fitTo:width is). */
export function lineArtToRaster(gt: LineArtGround, rasterWidth: number): LineArtGround {
  const [minX, minY, vw] = gt.viewBox
  const s = rasterWidth / vw
  const m: Affine = [s, 0, 0, s, -minX * s, -minY * s]
  return {
    viewBox: [0, 0, rasterWidth, (gt.viewBox[3] * rasterWidth) / vw],
    strokes: gt.strokes.map((st) => ({ ...st, subPaths: transformSubPaths(st.subPaths, m), width: st.width * s })),
    fills: gt.fills.map((f) => ({ ...f, subPaths: transformSubPaths(f.subPaths, m) })),
  }
}
