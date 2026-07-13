// Reads an authored SVG into GROUND-TRUTH geometry, in Node, without a DOM.
//
// Why not `model.parseSvg`: it needs DOMParser (absent under `node --test`), and it
// deliberately routes gradient-filled shapes into RawItems — lossy in exactly the
// dimension a ground-truth scorer wants to measure. So this is a small element scanner
// that reuses the pure, already-tested primitives: `parsePathD` for `d` strings and
// `ellipseSubPaths` for circles/ellipses.
//
// We read GEOMETRY ONLY — no fills, no compositing. Colour truth comes from the resvg
// raster of the same file (the composited pixel IS the authored colour), which means we
// never have to reimplement alpha compositing or painter's-algorithm occlusion here.

import { parsePathD, ellipseSubPaths } from '../lib/path/model.ts'
import { parseTransformAttr, composeAffine, transformSubPaths } from '../lib/path/geometry.ts'
import type { SubPath, PathNode, Affine } from '../lib/path/types.ts'

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]

/** One authored shape: its outline(s) in viewBox units, plus which element made it. */
export interface GroundShape {
  tag: string
  subPaths: SubPath[]
}

export interface GroundTruth {
  /** [minX, minY, width, height] as authored. */
  viewBox: [number, number, number, number]
  shapes: GroundShape[]
  /**
   * Elements whose true visible boundary this reader CANNOT produce. Ground truth is only
   * usable if this is empty — see `unscorable`.
   *
   * `stroked`: a stroked element's visible boundary is the OUTLINE OF THE STROKE (an offset
   * curve), not the path we parse — for `<line stroke-width="44">` the truth is a 44px-wide
   * rectangle, while we would hand back its centerline. Scoring that would report a
   * confident, entirely wrong number, so we refuse instead. (Implementing it means offset
   * curves + joins + caps; deliberately out of scope.)
   *
   * `unmodelled`: elements with no outline we can derive (<text>, <use>, <image>).
   */
  stroked: string[]
  unmodelled: string[]
}

/** Ground truth is trustworthy only when nothing was silently dropped. */
export function unscorable(gt: GroundTruth): string | null {
  if (gt.stroked.length) return `stroked geometry (${[...new Set(gt.stroked)].join(', ')}) — visible boundary is the stroke outline, which this reader does not model`
  if (gt.unmodelled.length) return `unmodelled elements (${[...new Set(gt.unmodelled)].join(', ')})`
  if (!gt.shapes.length) return 'no geometry parsed'
  return null
}

const num = (v: string | undefined, dflt = 0): number => {
  const n = Number.parseFloat(v ?? '')
  return Number.isFinite(n) ? n : dflt
}

/** Attributes of one start tag: name="value" (single or double quoted). */
function attrs(tagBody: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tagBody)) !== null) out[m[1]] = m[3] ?? m[4] ?? ''
  return out
}

/** "x,y x,y" / "x y x y" → flat number list. */
function points(s: string): number[] {
  return s.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite)
}

/** A closed/open subpath of straight corner nodes. */
function polySubPath(pts: number[], closed: boolean): SubPath[] {
  const nodes: PathNode[] = []
  for (let i = 0; i + 1 < pts.length; i += 2) {
    nodes.push({ x: pts[i], y: pts[i + 1], hIn: null, hOut: null, kind: 'corner' })
  }
  return nodes.length >= 2 ? [{ nodes, closed }] : []
}

/** Axis-aligned rect (rx/ry rounding is NOT modelled — authored GT should use plain rects
 *  or a path; a rounded rect would be scored as if its corners were sharp). */
function rectSubPath(a: Record<string, string>): SubPath[] {
  const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height)
  if (w <= 0 || h <= 0) return []
  return polySubPath([x, y, x + w, y, x + w, y + h, x, y + h], true)
}

/** Convert one shape element to outline subpaths in its own local space. */
function shapeSubPaths(tag: string, a: Record<string, string>): SubPath[] {
  switch (tag) {
    case 'path': return a.d ? parsePathD(a.d) : []
    case 'circle': {
      const r = num(a.r)
      return r > 0 ? (ellipseSubPaths(num(a.cx), num(a.cy), r, r) ?? []) : []
    }
    case 'ellipse': {
      const rx = num(a.rx), ry = num(a.ry)
      return rx > 0 && ry > 0 ? (ellipseSubPaths(num(a.cx), num(a.cy), rx, ry) ?? []) : []
    }
    case 'rect': return rectSubPath(a)
    case 'polygon': return polySubPath(points(a.points ?? ''), true)
    case 'polyline': return polySubPath(points(a.points ?? ''), false)
    case 'line': return polySubPath([num(a.x1), num(a.y1), num(a.x2), num(a.y2)], false)
    default: return []
  }
}

const SHAPES = new Set(['path', 'circle', 'ellipse', 'rect', 'polygon', 'polyline', 'line'])

/** Is this element painted with a stroke we'd have to outline to get its true boundary? */
function isStroked(a: Record<string, string>): boolean {
  const style = a.style ?? ''
  const stroke = a.stroke ?? /(?:^|;)\s*stroke\s*:\s*([^;]+)/.exec(style)?.[1]?.trim()
  if (!stroke || stroke === 'none') return false
  const wAttr = a['stroke-width'] ?? /(?:^|;)\s*stroke-width\s*:\s*([^;]+)/.exec(style)?.[1]?.trim()
  // Default stroke-width is 1 when a stroke paint is present but no width is given.
  return num(wAttr, 1) > 0
}

/**
 * Parse an authored SVG's geometry. Handles `<g>` transform nesting and per-element
 * `transform`. Ignores <defs> content (gradient definitions carry no outline).
 *
 * Anything whose true boundary we cannot produce is REPORTED rather than approximated —
 * see GroundTruth.stroked / .unmodelled and `unscorable()`. A ground-truth scorer that
 * quietly guesses is worse than one that admits it cannot score a case.
 */
export function parseGroundTruth(svg: string): GroundTruth {
  const vbAttr = /viewBox\s*=\s*["']([^"']+)["']/.exec(svg)
  const vb = vbAttr ? points(vbAttr[1]) : []
  const viewBox: [number, number, number, number] =
    vb.length === 4 ? [vb[0], vb[1], vb[2], vb[3]] : [0, 0, num(/width\s*=\s*["'](\d+)/.exec(svg)?.[1], 512), num(/height\s*=\s*["'](\d+)/.exec(svg)?.[1], 512)]

  const shapes: GroundShape[] = []
  const stroked: string[] = []
  const unmodelled: string[] = []
  const stack: Affine[] = [IDENTITY]
  let inDefs = 0

  // Scan start/end tags in document order — painter order is preserved, which is all we
  // need (occlusion is resolved by the rasterizer, not here).
  const re = /<\s*(\/?)\s*([\w:-]+)([^>]*?)(\/?)\s*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(svg)) !== null) {
    const [, close, rawTag, body, selfClose] = m
    const tag = rawTag.replace(/^.*:/, '') // strip namespace prefix

    if (tag === 'defs') { inDefs += close ? -1 : selfClose ? 0 : 1; continue }
    if (inDefs > 0) continue

    if (tag === 'g') {
      if (close) { if (stack.length > 1) stack.pop() }
      else {
        const t = parseTransformAttr(attrs(body).transform)
        stack.push(composeAffine(stack[stack.length - 1], t))
        if (selfClose) stack.pop()
      }
      continue
    }

    if (close || !SHAPES.has(tag)) {
      if (!close && (tag === 'text' || tag === 'use' || tag === 'image')) unmodelled.push(tag)
      continue
    }

    const a = attrs(body)
    if (isStroked(a)) { stroked.push(tag); continue }

    const local = shapeSubPaths(tag, a)
    if (!local.length) continue

    const m2 = composeAffine(stack[stack.length - 1], parseTransformAttr(a.transform))
    shapes.push({ tag, subPaths: transformSubPaths(local, m2) })
  }

  return { viewBox, shapes, stroked, unmodelled }
}

/**
 * Scale ground-truth geometry from viewBox units into RASTER PIXEL space, so it is
 * directly comparable to a traced doc (whose coordinates are pixel-space). Assumes the
 * raster preserved aspect ratio, which resvg's fitTo:width does.
 */
export function toRasterSpace(gt: GroundTruth, rasterWidth: number): GroundShape[] {
  const [minX, minY, vw] = gt.viewBox
  const s = rasterWidth / vw
  if (s === 1 && minX === 0 && minY === 0) return gt.shapes
  const m: Affine = [s, 0, 0, s, -minX * s, -minY * s]
  return gt.shapes.map((sh) => ({ tag: sh.tag, subPaths: transformSubPaths(sh.subPaths, m) }))
}

/** Total authored anchor count — the parsimony denominator. */
export function countNodes(shapes: GroundShape[]): number {
  let n = 0
  for (const sh of shapes) for (const sp of sh.subPaths) n += sp.nodes.length
  return n
}
