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
   * usable if ALL of these are empty — see `unscorable`.
   *
   * `stroked`: a stroked element's visible boundary is the OUTLINE OF THE STROKE (an offset
   * curve), not the path we parse — for `<line stroke-width="44">` the truth is a 44px-wide
   * rectangle, while we would hand back its centerline. Scoring that would report a
   * confident, entirely wrong number, so we refuse instead. (Implementing it means offset
   * curves + joins + caps; deliberately out of scope.)
   *
   * `filtered`: a `filter="url(#…)"` on the element or any ancestor `<g>`. Both filter
   * families Fluent Emoji uses break ground truth, for DIFFERENT reasons — which is why this
   * is refused rather than approximated:
   *   • a foreground blur (feGaussianBlur on SourceGraphic) DISPLACES the silhouette outright:
   *     the authored path is nowhere near the visible boundary;
   *   • an inner shadow (SourceAlpha → feOffset → blur → feComposite k2=-1 k3=1) leaves the
   *     silhouette intact but paints a soft shaded band INSIDE it. That band is a real visible
   *     edge with NO counterpart in the authored path list, so a tracer that correctly
   *     reproduces it gets scored as having HALLUCINATED boundary. The ground truth is
   *     incomplete, and an incomplete answer sheet marks correct work wrong.
   *
   * `clipped` / `masked`: a `clip-path=`/`mask="url(#…)"` on the element or an ancestor `<g>`.
   * The visible boundary is the INTERSECTION with the clip (or the alpha of the mask), not the
   * path we parse.
   *
   * `unmodelled`: elements with no outline we can derive (<text>, <use>, <image>).
   */
  stroked: string[]
  filtered: string[]
  clipped: string[]
  masked: string[]
  /**
   * `patterned`: `fill="url(#p)"` where #p is a `<pattern>`. The visible boundary is the
   * TILING of the pattern across the shape, not the shape's own outline — checker.svg is one
   * 256px rect plus one 128px rect, but the picture is a checkerboard of ~7,000 edges.
   * Scored against the two rects, a tracer that correctly recovers the checkerboard reads as
   * having INVENTED 52px of boundary and spent 32× the artist's nodes.
   *
   * A GRADIENT fill is deliberately NOT refused: `fill="url(#paint0_linear)"` leaves the
   * shape's outline exactly where it was authored. That distinction is the whole of tier 1,
   * so the check resolves the referenced id rather than matching on `url(`.
   */
  patterned: string[]
  unmodelled: string[]
}

/** Machine-readable refusal reason — the triage manifest histograms these. */
export type RefusalCode = 'stroked' | 'filtered' | 'clipped' | 'masked' | 'patterned' | 'unmodelled' | 'empty'

/** Every reason this SVG cannot serve as ground truth. Empty ⇒ scorable. */
export function refusals(gt: GroundTruth): { code: RefusalCode; detail: string }[] {
  const out: { code: RefusalCode; detail: string }[] = []
  const tags = (xs: string[]): string => [...new Set(xs)].join(', ')
  if (gt.stroked.length)
    out.push({ code: 'stroked', detail: `stroked geometry (${tags(gt.stroked)}) — visible boundary is the stroke outline, which this reader does not model` })
  if (gt.filtered.length)
    out.push({ code: 'filtered', detail: `filtered geometry (${tags(gt.filtered)}) — a filter displaces the silhouette (blur) or adds a soft interior edge the authored paths do not contain (inner shadow)` })
  if (gt.clipped.length)
    out.push({ code: 'clipped', detail: `clipped geometry (${tags(gt.clipped)}) — the visible boundary is the intersection with the clip path, not the path itself` })
  if (gt.masked.length)
    out.push({ code: 'masked', detail: `masked geometry (${tags(gt.masked)}) — the visible boundary is the mask's alpha, not the path itself` })
  if (gt.patterned.length)
    out.push({ code: 'patterned', detail: `pattern-filled geometry (${tags(gt.patterned)}) — the visible boundary is the pattern's tiling, not the shape's own outline` })
  if (gt.unmodelled.length)
    out.push({ code: 'unmodelled', detail: `unmodelled elements (${tags(gt.unmodelled)})` })
  if (!gt.shapes.length) out.push({ code: 'empty', detail: 'no geometry parsed' })
  return out
}

/** Ground truth is trustworthy only when nothing was silently dropped. */
export function unscorable(gt: GroundTruth): string | null {
  return refusals(gt)[0]?.detail ?? null
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

/**
 * Containers whose children are a STENCIL, not artwork: they are never painted where they
 * are declared. Counting their shapes as ground truth would invent boundaries the render
 * does not contain — and unlike <defs>, Figma exports these at TOP LEVEL, so a defs-only
 * skip does not catch them.
 */
const STENCILS = new Set(['defs', 'mask', 'clipPath', 'pattern', 'marker', 'symbol'])

/** Value of a presentation property, whether written as an attribute or in `style`. */
function prop(a: Record<string, string>, name: string): string {
  const fromStyle = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(a.style ?? '')?.[1]
  return (a[name] ?? fromStyle ?? '').trim()
}

/** Is this element painted with a stroke we'd have to outline to get its true boundary? */
function isStroked(a: Record<string, string>): boolean {
  const stroke = prop(a, 'stroke')
  if (!stroke || stroke === 'none') return false
  // Default stroke-width is 1 when a stroke paint is present but no width is given.
  return num(prop(a, 'stroke-width') || undefined, 1) > 0
}

/** filter / clip-path / mask — any non-`none` value re-defines the visible boundary. */
const isFiltered = (a: Record<string, string>): boolean => { const v = prop(a, 'filter'); return v !== '' && v !== 'none' }
const isClipped = (a: Record<string, string>): boolean => { const v = prop(a, 'clip-path'); return v !== '' && v !== 'none' }
const isMasked = (a: Record<string, string>): boolean => { const v = prop(a, 'mask'); return v !== '' && v !== 'none' }

/** ids of every `<pattern>` in the document — a *gradient* url() fill is fine, a pattern is not. */
function patternIds(svg: string): Set<string> {
  const ids = new Set<string>()
  for (const m of svg.matchAll(/<\s*(?:[\w-]+:)?pattern\b([^>]*)>/g)) {
    const id = attrs(m[1]).id
    if (id) ids.add(id)
  }
  return ids
}

/** Does this element's fill reference a `<pattern>` (as opposed to a gradient)? */
function isPatterned(a: Record<string, string>, patterns: Set<string>): boolean {
  if (!patterns.size) return false
  const ref = /url\(\s*['"]?#([^)'"\s]+)/.exec(prop(a, 'fill'))?.[1]
  return ref !== undefined && patterns.has(ref)
}

/** The inherited paint context of the enclosing <g> chain. */
interface Ctx { m: Affine; filtered: boolean; clipped: boolean; masked: boolean }

/**
 * Parse an authored SVG's geometry. Handles `<g>` nesting for BOTH transforms and the paint
 * context (filter / clip-path / mask are inherited by every descendant). Skips stencil
 * containers — see STENCILS.
 *
 * Anything whose true boundary we cannot produce is REPORTED rather than approximated — see
 * GroundTruth's refusal lists and `unscorable()`. A ground-truth scorer that quietly guesses
 * is worse than one that admits it cannot score a case: the guess still produces a number,
 * and the number looks just as confident as a real one.
 */
export function parseGroundTruth(svg: string): GroundTruth {
  const vbAttr = /viewBox\s*=\s*["']([^"']+)["']/.exec(svg)
  const vb = vbAttr ? points(vbAttr[1]) : []
  const viewBox: [number, number, number, number] =
    vb.length === 4 ? [vb[0], vb[1], vb[2], vb[3]] : [0, 0, num(/width\s*=\s*["'](\d+)/.exec(svg)?.[1], 512), num(/height\s*=\s*["'](\d+)/.exec(svg)?.[1], 512)]

  const shapes: GroundShape[] = []
  const stroked: string[] = []
  const filtered: string[] = []
  const clipped: string[] = []
  const masked: string[] = []
  const patterned: string[] = []
  const unmodelled: string[] = []
  const patterns = patternIds(svg)
  const stack: Ctx[] = [{ m: IDENTITY, filtered: false, clipped: false, masked: false }]
  /** Depth inside a <defs>/<mask>/<clipPath>/… subtree. >0 ⇒ nothing here is painted. */
  let inStencil = 0

  // Scan start/end tags in document order — painter order is preserved, which is all we
  // need (occlusion is resolved by the rasterizer, not here).
  const re = /<\s*(\/?)\s*([\w:-]+)([^>]*?)(\/?)\s*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(svg)) !== null) {
    const [, close, rawTag, body, selfClose] = m
    const tag = rawTag.replace(/^.*:/, '') // strip namespace prefix

    if (STENCILS.has(tag)) { inStencil += close ? -1 : selfClose ? 0 : 1; continue }
    if (inStencil > 0) continue

    if (tag === 'g') {
      if (close) { if (stack.length > 1) stack.pop() }
      else {
        const a = attrs(body)
        const top = stack[stack.length - 1]
        // A filter/clip/mask on a <g> applies to the WHOLE SUBTREE. Figma puts them here,
        // never on the leaf — so ignoring the group's paint context (as a transform-only
        // reader does) lets every child through as if it were crisp, unclipped geometry.
        stack.push({
          m: composeAffine(top.m, parseTransformAttr(a.transform)),
          filtered: top.filtered || isFiltered(a),
          clipped: top.clipped || isClipped(a),
          masked: top.masked || isMasked(a),
        })
        if (selfClose) stack.pop()
      }
      continue
    }

    if (close || !SHAPES.has(tag)) {
      if (!close && (tag === 'text' || tag === 'use' || tag === 'image')) unmodelled.push(tag)
      continue
    }

    const a = attrs(body)
    const ctx = stack[stack.length - 1]
    // Report EVERY reason this element is unrepresentable, so the triage histogram is honest
    // about what the art actually contains rather than about which check ran first.
    let refused = false
    if (isStroked(a)) { stroked.push(tag); refused = true }
    if (ctx.filtered || isFiltered(a)) { filtered.push(tag); refused = true }
    if (ctx.clipped || isClipped(a)) { clipped.push(tag); refused = true }
    if (ctx.masked || isMasked(a)) { masked.push(tag); refused = true }
    if (isPatterned(a, patterns)) { patterned.push(tag); refused = true }
    if (refused) continue

    const local = shapeSubPaths(tag, a)
    if (!local.length) continue

    shapes.push({ tag, subPaths: transformSubPaths(local, composeAffine(ctx.m, parseTransformAttr(a.transform))) })
  }

  return { viewBox, shapes, stroked, filtered, clipped, masked, patterned, unmodelled }
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
