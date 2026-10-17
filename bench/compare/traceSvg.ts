// A tool's SVG → the geometry the scorers read, in the pixels of the render.
//
// Reuses svgGround's reader (the same one that produces the ANSWER SHEET), so a traced path
// and an authored path are turned into subpaths by the same code and counted the same way —
// anchors after normalising to cubics. Three things trace output needs that authored art
// did not, done here as a pre-pass on a COPY of the string (the render always uses the
// original):
//
//   • inheritance — svgGround reads an element's own fill/stroke only. A `<g fill="none"
//     stroke="#000">` (common in StarVector output) would hand back centrelines as if they
//     were filled outlines. The resolved stroke is written onto the element, so svgGround's
//     own stroke refusal fires; geometry is then n/a and only pixel metrics apply.
//   • invisible elements — a fill="none" shape with no stroke, display:none, opacity 0 paint
//     nothing, but svgGround would count their outline as boundary. Dropped.
//   • CSS — `<style>` rules are not read by svgGround, so a styled output is refused
//     ('styled') rather than scored against paint it may not have.
//
// The result's `shimDoc` is a plain EditableDoc of those subpaths: scoreGeometry and
// boundaryMask read only items' subPaths, so every tool goes through them unchanged.

import { gzipSync } from 'node:zlib'
import { parseGroundTruth, unscorable, attrs, prop, STENCILS, SHAPES, type GroundShape } from '../svgGround.ts'
import { transformSubPaths } from '../../src/lib/path/geometry.ts'
import { subPathsToD } from '../../src/lib/path/model.ts'
import type { EditableDoc } from '../../src/lib/path/types.ts'
import { normalizeRoot } from './render.ts'

export interface ParsedTrace {
  /** Pixel-space shapes, or null when geometry is n/a. */
  shapes: GroundShape[] | null
  shimDoc: EditableDoc | null
  /** Why geometry is n/a (svgGround's refusal, 'styled', 'no root', …). */
  refusal: string | null
  gradientDefs: number
  bytes: number
  gzipBytes: number
  /** Path data re-serialised at 2 decimals in pixel space — size without precision games. */
  normBytes: number | null
}

interface Ctx {
  fill: string
  fillOpacity: number
  stroke: string
  strokeWidth: string
  hidden: boolean
}

const num = (s: string, d: number): number => {
  const n = Number.parseFloat(s)
  return Number.isFinite(n) ? n : d
}

/** Resolve inherited paint onto each shape, drop shapes that paint nothing. */
export function resolvePaint(svg: string): string {
  const stack: Ctx[] = [{ fill: '#000000', fillOpacity: 1, stroke: 'none', strokeWidth: '1', hidden: false }]
  let inStencil = 0
  let out = ''
  let last = 0
  const re = /<\s*(\/?)\s*([\w:-]+)([^>]*?)(\/?)\s*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(svg)) !== null) {
    const [whole, close, rawTag, body, selfClose] = m
    const tag = rawTag.replace(/^.*:/, '')
    if (STENCILS.has(tag)) {
      inStencil += close ? -1 : selfClose ? 0 : 1
      continue
    }
    if (inStencil > 0) continue
    const top = stack[stack.length - 1]
    const ctxOf = (a: Record<string, string>): Ctx => {
      const fill = prop(a, 'fill') || top.fill
      const fo = prop(a, 'fill-opacity')
      const op = prop(a, 'opacity')
      const disp = prop(a, 'display')
      const vis = prop(a, 'visibility')
      return {
        fill,
        fillOpacity: fo ? num(fo, 1) : top.fillOpacity,
        stroke: prop(a, 'stroke') || top.stroke,
        strokeWidth: prop(a, 'stroke-width') || top.strokeWidth,
        hidden: top.hidden || disp === 'none' || vis === 'hidden' || (op !== '' && num(op, 1) <= 0),
      }
    }
    if (tag === 'g' || tag === 'svg') {
      if (close) {
        if (stack.length > 1) stack.pop()
      } else if (!selfClose) stack.push(ctxOf(attrs(body)))
      continue
    }
    if (close || !SHAPES.has(tag)) continue
    const a = attrs(body)
    const c = ctxOf(a)
    const stroked = c.stroke !== 'none' && c.stroke !== '' && num(c.strokeWidth, 1) > 0
    const filled = c.fill !== 'none' && c.fill !== 'transparent' && c.fillOpacity > 0
    let replacement: string
    if (c.hidden || (!filled && !stroked)) replacement = ''
    else {
      let extra = ''
      if (stroked && !prop(a, 'stroke')) extra += ` stroke="${c.stroke}" stroke-width="${c.strokeWidth}"`
      if (!prop(a, 'fill')) extra += ` fill="${c.fill}"`
      replacement = extra ? whole.replace(/\s*\/?\s*>$/, (end) => `${extra}${end}`) : whole
    }
    out += svg.slice(last, m.index) + replacement
    last = m.index + whole.length
  }
  return out + svg.slice(last)
}

export function parseTraceSvg(svg: string, w: number, h: number): ParsedTrace {
  const bytes = Buffer.byteLength(svg, 'utf8')
  const gzipBytes = gzipSync(Buffer.from(svg, 'utf8'), { level: 9 }).length
  const gradientDefs = (svg.match(/<\s*(?:[\w-]+:)?(?:linear|radial)Gradient\b/g) ?? []).length
  const na = (refusal: string): ParsedTrace => ({
    shapes: null,
    shimDoc: null,
    refusal,
    gradientDefs,
    bytes,
    gzipBytes,
    normBytes: null,
  })

  let root
  try {
    root = normalizeRoot(svg, w, h)
  } catch (e) {
    return na(`no root (${(e as Error).message})`)
  }
  if (/<\s*style\b/.test(svg)) return na('styled')
  const gt = parseGroundTruth(resolvePaint(root.svg))
  const why = unscorable(gt)
  if (why) return na(why)

  const shapes = gt.shapes.map((s) => ({ ...s, subPaths: transformSubPaths(s.subPaths, root.toPixels) }))
  const shimDoc: EditableDoc = {
    viewBox: [0, 0, w, h],
    items: shapes.map((s, i) => ({
      kind: 'path' as const,
      id: `t${i}`,
      fill: /^#[0-9a-f]{6}$/i.test(s.fill ?? '') ? (s.fill as string) : '#000000',
      fillRule: 'nonzero' as const,
      subPaths: s.subPaths,
      visible: true,
    })),
  }
  const normBytes = shapes.reduce((n, s) => n + subPathsToD(s.subPaths, 2).length, 0)
  return { shapes, shimDoc, refusal: null, gradientDefs, bytes, gzipBytes, normBytes }
}
