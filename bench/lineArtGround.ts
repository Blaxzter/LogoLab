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
// be asked to recover it — it is a fill, radius r + w/2, and is scored as one. The
// same holds for every other way the icon sets draw a dot (`solidDot`: a zero-length
// round-capped stroke, a point-to-itself `<line>`, a closed arc pair too small to leave
// a hole), and an open round-capped path that ends where it began is read as the
// closed loop its ink is (`closeCoincident`). Both rules came with the strokes-oss
// corpus (bench/compare/strokesOss.ts), where Tabler and Feather draw that way.

import type { Affine, SubPath } from '../src/lib/path/types.ts'
import { flattenSubPath } from './geomScore.ts'
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
  /** The resolved `stroke` paint, verbatim. No scorer of the answer sheet reads it; the
   *  benchmark's trace reader (compare/lineDoc.ts) uses it to tell ink from paper. */
  color?: string
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
      // Per subpath: a meet closes the loop, a dot is a fill (the rules above `solidDot`).
      const kept: SubPath[] = []
      for (const raw of transformSubPaths(local, m2)) {
        const sp = closeCoincident(raw, width, cap)
        const dot = solidDot(sp, width, cap)
        if (dot === 'blank') continue
        if (dot) fills.push({ tag, subPaths: dot, fill: stroke })
        else kept.push(sp)
      }
      if (kept.length) strokes.push({ tag, subPaths: kept, width, cap, join, color: stroke ?? undefined })
    }
    if (filled) fills.push({ tag, subPaths: transformSubPaths(local, m2), fill: fill ?? undefined })
  }
  return { viewBox, strokes, fills }
}

/** A dot is a stroke whose extent is at most this fraction of its width (`solidDot`). */
export const DOT_EXTENT = 0.25

/**
 * An open subpath that ends where it started, drawn with ROUND caps, is a closed loop:
 * the two round caps paint exactly what a round join would, so the ink has no end there
 * and no tracer can find one. Tabler draws every circle this way (`M3 12a9 9 0 1 0 18 0
 * a9 9 0 1 0 -18 0`, no `z`) and Lucide's heart is one open path round to its start.
 * Read as open, each costs the trace −2 ends for drawing the ring the ink shows. Not for
 * butt or square caps: those paint a notch or a tab at the meet, a visible end.
 */
export function closeCoincident(sp: SubPath, width: number, cap: CapKind): SubPath {
  if (sp.closed || cap !== 'round' || sp.nodes.length < 3) return sp
  const a = sp.nodes[0]
  const b = sp.nodes[sp.nodes.length - 1]
  if (Math.hypot(a.x - b.x, a.y - b.y) > 1e-3 * Math.max(width, 1e-6)) return sp
  const nodes = sp.nodes.slice(0, -1)
  nodes[0] = { ...a, hIn: b.hIn }
  return { nodes, closed: true }
}

/**
 * A stroke that paints a solid DOT, as a fill — the circle rule above, for every other
 * way icon sets draw a dot. Lucide and Tabler write a dot as a zero-length round-capped
 * stroke (`M12 17h.01`, `l.01 0`; ~8% of Lucide, ~11% of Tabler); Feather as a
 * `<line>` from a point to itself; Tabler a small dot as a closed r=1 arc pair at width
 * 2. None of those has a centreline a tracer could recover: the ink is a disc.
 *
 *   open, extent ≤ DOT_EXTENT·w   round cap → a disc of radius w/2 (plus half the
 *                                  extent); square cap → the w-sided square SVG paints
 *                                  for a zero-length subpath; butt cap → nothing
 *                                  ('blank': SVG paints no zero-length butt stroke).
 *   closed, every point within w/2 of the centroid
 *                                  → no hole is left inside the band: a disc of radius
 *                                  mean-radius + w/2 (exact for a circle).
 *
 * Null when the subpath is a real stroke.
 */
export function solidDot(sp: SubPath, width: number, cap: CapKind): SubPath[] | 'blank' | null {
  const poly = flattenSubPath(sp)
  if (poly.length === 0) return 'blank'
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of poly) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const half = width / 2
  if (!sp.closed) {
    const extent = Math.hypot(maxX - minX, maxY - minY)
    if (extent > DOT_EXTENT * width) return null
    if (cap === 'butt') return 'blank'
    if (cap === 'round') return ellipseSubPaths(cx, cy, half + extent / 2, half + extent / 2)
    const hx = half + (maxX - minX) / 2
    const hy = half + (maxY - minY) / 2
    const corner = (x: number, y: number) => ({ x, y, hIn: null, hOut: null, kind: 'corner' as const })
    return [
      {
        closed: true,
        nodes: [corner(cx - hx, cy - hy), corner(cx + hx, cy - hy), corner(cx + hx, cy + hy), corner(cx - hx, cy + hy)],
      },
    ]
  }
  // The bounding box's centre, not the points' mean: the flattening samples unevenly (and
  // repeats its start), which pulls a mean off the middle of a circle.
  const mx = cx
  const my = cy
  let maxR = 0
  let sumR = 0
  for (const p of poly) {
    const r = Math.hypot(p.x - mx, p.y - my)
    maxR = Math.max(maxR, r)
    sumR += r
  }
  // 1% slack: an arc reaches us as cubics, which bulge ~0.03% of r past the circle (a
  // Tabler r=1 dot read 1.00026 against a half-width of 1).
  if (maxR > half * 1.01) return null
  const R = sumR / poly.length + half
  return ellipseSubPaths(mx, my, R, R)
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
