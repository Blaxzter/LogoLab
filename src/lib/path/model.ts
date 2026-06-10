// SVG ⇄ editable document conversion: full path-data parsing (arcs and
// quadratics normalized to cubics), basic-shape conversion, and compact
// serialization. Fillable geometry becomes node-editable PathItems; anything
// else (strokes, gradients, text, defs…) round-trips verbatim as RawItems.
//
// parsePathD / subPathsToD are pure string work and run anywhere; parseSvg /
// serializeDoc use DOMParser / XMLSerializer and are browser-only.

import type { Affine, DocItem, EditableDoc, PathItem, PathNode, RawItem, SubPath, Vec } from './types'
import {
  affineToString,
  composeAffine,
  isIdentityAffine,
  parseTransformAttr,
  segmentCount,
  transformSubPaths,
} from './geometry'

const EPS = 1e-6

/** Circle/ellipse quarter-arc cubic control distance, as a fraction of r. */
const KAPPA = 0.5522847498

/** cos(2°) — handle-collinearity tolerance for 'smooth' detection. */
const SMOOTH_COS = Math.cos((2 * Math.PI) / 180)

// ---------------------------------------------------------------------------
// Path data → SubPath[]
// ---------------------------------------------------------------------------

/**
 * Parse SVG path data (the `d` attribute) into subpaths of cubic segments.
 * Supports the full grammar — M/L/H/V/C/S/Q/T/A/Z, relative forms, implicit
 * command repetition, exponent numbers, and unseparated arc flags. Quadratics
 * are converted to exact cubics; arcs are approximated with ≤ 90° cubic
 * slices. Parsing stops at the first malformed token (per spec behavior).
 */
export function parsePathD(d: string): SubPath[] {
  const n = d.length
  let i = 0

  const subPaths: SubPath[] = []
  let cur: PathNode[] | null = null
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  let prevCmd = ''
  let prevCubic: Vec | null = null // previous segment's second cubic control
  let prevQuad: Vec | null = null // previous segment's quadratic control

  const isSep = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ','
  const skipSep = () => {
    while (i < n && isSep(d[i])) i++
  }

  const readNumber = (): number | null => {
    skipSep()
    const start = i
    if (d[i] === '+' || d[i] === '-') i++
    let digits = false
    while (i < n && d[i] >= '0' && d[i] <= '9') {
      i++
      digits = true
    }
    if (d[i] === '.') {
      i++
      while (i < n && d[i] >= '0' && d[i] <= '9') {
        i++
        digits = true
      }
    }
    if (!digits) {
      i = start
      return null
    }
    if (d[i] === 'e' || d[i] === 'E') {
      const mark = i
      i++
      if (d[i] === '+' || d[i] === '-') i++
      let expDigits = false
      while (i < n && d[i] >= '0' && d[i] <= '9') {
        i++
        expDigits = true
      }
      if (!expDigits) i = mark
    }
    return parseFloat(d.slice(start, i))
  }

  // Arc flags are single chars and may be unseparated ('…0 011 0').
  const readFlag = (): number | null => {
    skipSep()
    const c = d[i]
    if (c !== '0' && c !== '1') return null
    i++
    return c === '1' ? 1 : 0
  }

  const mkNode = (x: number, y: number): PathNode => ({ x, y, hIn: null, hOut: null, kind: 'corner' })

  const flushOpen = () => {
    if (cur && cur.length >= 2) subPaths.push({ nodes: cur, closed: false })
    cur = null
  }

  // After Z the pen sits at the subpath start; further draws begin a new
  // subpath there lazily.
  const ensure = (): PathNode[] => {
    if (!cur) cur = [mkNode(cx, cy)]
    return cur
  }

  const lineTo = (x: number, y: number) => {
    const nodes = ensure()
    const last = nodes[nodes.length - 1]
    cx = x
    cy = y
    if (Math.abs(x - last.x) < EPS && Math.abs(y - last.y) < EPS) return
    nodes.push(mkNode(x, y))
  }

  const curveTo = (c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) => {
    const nodes = ensure()
    const last = nodes[nodes.length - 1]
    // Handles collapsed onto their anchors are stored as null (line joint).
    const hOut = Math.abs(c1x - last.x) < EPS && Math.abs(c1y - last.y) < EPS ? null : { x: c1x, y: c1y }
    const hIn = Math.abs(c2x - x) < EPS && Math.abs(c2y - y) < EPS ? null : { x: c2x, y: c2y }
    cx = x
    cy = y
    if (!hOut && !hIn && Math.abs(x - last.x) < EPS && Math.abs(y - last.y) < EPS) return
    last.hOut = hOut
    nodes.push({ x, y, hIn, hOut: null, kind: 'corner' })
  }

  const closePath = () => {
    if (cur) {
      const nodes: PathNode[] = cur
      // Merge a coincident last anchor into the first (keep ≥ 2 nodes so a
      // single-cubic loop isn't reduced to an unserializable point).
      if (nodes.length >= 3) {
        const first = nodes[0]
        const last = nodes[nodes.length - 1]
        if (Math.abs(last.x - first.x) < EPS && Math.abs(last.y - first.y) < EPS) {
          first.hIn = last.hIn
          nodes.pop()
        }
      }
      if (nodes.length >= 2) subPaths.push({ nodes, closed: true })
      cur = null
    }
    cx = sx
    cy = sy
  }

  let cmd = ''
  parse: while (i < n) {
    skipSep()
    if (i >= n) break
    const ch = d[i]
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
      cmd = ch
      i++
    } else if (!cmd) {
      break
    }
    const rel = cmd >= 'a'
    const upper = rel ? cmd.toUpperCase() : cmd

    switch (upper) {
      case 'M': {
        const x = readNumber()
        const y = readNumber()
        if (x === null || y === null) break parse
        flushOpen()
        cx = rel ? cx + x : x
        cy = rel ? cy + y : y
        sx = cx
        sy = cy
        cur = [mkNode(cx, cy)]
        cmd = rel ? 'l' : 'L' // M's extra pairs are linetos
        break
      }
      case 'L': {
        const x = readNumber()
        const y = readNumber()
        if (x === null || y === null) break parse
        lineTo(rel ? cx + x : x, rel ? cy + y : y)
        break
      }
      case 'H': {
        const x = readNumber()
        if (x === null) break parse
        lineTo(rel ? cx + x : x, cy)
        break
      }
      case 'V': {
        const y = readNumber()
        if (y === null) break parse
        lineTo(cx, rel ? cy + y : y)
        break
      }
      case 'C': {
        const nums = [readNumber(), readNumber(), readNumber(), readNumber(), readNumber(), readNumber()]
        if (nums.some((v) => v === null)) break parse
        const [a, b, c, e, f, g] = nums as number[]
        const c1x = rel ? cx + a : a
        const c1y = rel ? cy + b : b
        const c2x = rel ? cx + c : c
        const c2y = rel ? cy + e : e
        curveTo(c1x, c1y, c2x, c2y, rel ? cx + f : f, rel ? cy + g : g)
        prevCubic = { x: c2x, y: c2y }
        break
      }
      case 'S': {
        const nums = [readNumber(), readNumber(), readNumber(), readNumber()]
        if (nums.some((v) => v === null)) break parse
        const [c, e, f, g] = nums as number[]
        const reflect = prevCmd === 'C' || prevCmd === 'c' || prevCmd === 'S' || prevCmd === 's'
        const c1x = reflect && prevCubic ? 2 * cx - prevCubic.x : cx
        const c1y = reflect && prevCubic ? 2 * cy - prevCubic.y : cy
        const c2x = rel ? cx + c : c
        const c2y = rel ? cy + e : e
        curveTo(c1x, c1y, c2x, c2y, rel ? cx + f : f, rel ? cy + g : g)
        prevCubic = { x: c2x, y: c2y }
        break
      }
      case 'Q': {
        const nums = [readNumber(), readNumber(), readNumber(), readNumber()]
        if (nums.some((v) => v === null)) break parse
        const [a, b, f, g] = nums as number[]
        const qx = rel ? cx + a : a
        const qy = rel ? cy + b : b
        quadTo(qx, qy, rel ? cx + f : f, rel ? cy + g : g)
        prevQuad = { x: qx, y: qy }
        break
      }
      case 'T': {
        const x = readNumber()
        const y = readNumber()
        if (x === null || y === null) break parse
        const reflect = prevCmd === 'Q' || prevCmd === 'q' || prevCmd === 'T' || prevCmd === 't'
        const qx: number = reflect && prevQuad ? 2 * cx - prevQuad.x : cx
        const qy: number = reflect && prevQuad ? 2 * cy - prevQuad.y : cy
        quadTo(qx, qy, rel ? cx + x : x, rel ? cy + y : y)
        prevQuad = { x: qx, y: qy }
        break
      }
      case 'A': {
        const rx = readNumber()
        const ry = readNumber()
        const rot = readNumber()
        if (rx === null || ry === null || rot === null) break parse
        const laf = readFlag()
        const swf = readFlag()
        if (laf === null || swf === null) break parse
        const x = readNumber()
        const y = readNumber()
        if (x === null || y === null) break parse
        arcTo(rx, ry, rot, laf === 1, swf === 1, rel ? cx + x : x, rel ? cy + y : y)
        break
      }
      case 'Z': {
        closePath()
        break
      }
      default:
        break parse
    }
    prevCmd = cmd

    // S/T reflection only sees an immediately preceding cubic/quadratic.
    if (upper !== 'C' && upper !== 'S') prevCubic = null
    if (upper !== 'Q' && upper !== 'T') prevQuad = null
  }
  flushOpen()

  for (const sp of subPaths) detectKinds(sp)
  return subPaths

  /** Quadratic → exact cubic elevation. */
  function quadTo(qx: number, qy: number, x: number, y: number): void {
    const c1x = cx + (2 / 3) * (qx - cx)
    const c1y = cy + (2 / 3) * (qy - cy)
    const c2x = x + (2 / 3) * (qx - x)
    const c2y = y + (2 / 3) * (qy - y)
    curveTo(c1x, c1y, c2x, c2y, x, y)
  }

  /** Elliptical arc → cubic slices (SVG spec F.6.5 endpoint→center form). */
  function arcTo(rx: number, ry: number, xrot: number, largeArc: boolean, sweep: boolean, x: number, y: number): void {
    const x1 = cx
    const y1 = cy
    if (Math.abs(x - x1) < EPS && Math.abs(y - y1) < EPS) return
    rx = Math.abs(rx)
    ry = Math.abs(ry)
    if (rx < EPS || ry < EPS) {
      lineTo(x, y)
      return
    }
    const phi = (xrot * Math.PI) / 180
    const cosPhi = Math.cos(phi)
    const sinPhi = Math.sin(phi)
    const hx = (x1 - x) / 2
    const hy = (y1 - y) / 2
    const x1p = cosPhi * hx + sinPhi * hy
    const y1p = -sinPhi * hx + cosPhi * hy
    // Out-of-range radii: scale up until the endpoints fit the ellipse.
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if (lambda > 1) {
      const s = Math.sqrt(lambda)
      rx *= s
      ry *= s
    }
    const rx2 = rx * rx
    const ry2 = ry * ry
    const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p
    const den = rx2 * y1p * y1p + ry2 * x1p * x1p
    const coef = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den))
    const cxp = (coef * (rx * y1p)) / ry
    const cyp = (coef * (-ry * x1p)) / rx
    const centerX = cosPhi * cxp - sinPhi * cyp + (x1 + x) / 2
    const centerY = sinPhi * cxp + cosPhi * cyp + (y1 + y) / 2
    const startAngle = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx)
    const endAngle = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx)
    let dTheta = endAngle - startAngle
    if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI
    else if (sweep && dTheta < 0) dTheta += 2 * Math.PI

    const pointAt = (theta: number): Vec => ({
      x: centerX + rx * Math.cos(theta) * cosPhi - ry * Math.sin(theta) * sinPhi,
      y: centerY + rx * Math.cos(theta) * sinPhi + ry * Math.sin(theta) * cosPhi,
    })
    const derivAt = (theta: number): Vec => ({
      x: -rx * Math.sin(theta) * cosPhi - ry * Math.cos(theta) * sinPhi,
      y: -rx * Math.sin(theta) * sinPhi + ry * Math.cos(theta) * cosPhi,
    })

    const slices = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)))
    const delta = dTheta / slices
    const alpha = (4 / 3) * Math.tan(delta / 4)
    let theta = startAngle
    let p = pointAt(theta)
    for (let s = 0; s < slices; s++) {
      const thetaNext = theta + delta
      // Land the final slice exactly on the endpoint to avoid drift.
      const q = s === slices - 1 ? { x, y } : pointAt(thetaNext)
      const d1 = derivAt(theta)
      const d2 = derivAt(thetaNext)
      curveTo(p.x + alpha * d1.x, p.y + alpha * d1.y, q.x - alpha * d2.x, q.y - alpha * d2.y, q.x, q.y)
      theta = thetaNext
      p = q
    }
  }
}

/** Tag nodes 'smooth' when their handles are collinear-opposite (within ~2°). */
function detectKinds(sp: SubPath): void {
  for (const node of sp.nodes) {
    node.kind = isSmoothJoint(node) ? 'smooth' : 'corner'
  }
}

function isSmoothJoint(node: PathNode): boolean {
  if (!node.hIn || !node.hOut) return false
  const ix = node.x - node.hIn.x
  const iy = node.y - node.hIn.y
  const ox = node.hOut.x - node.x
  const oy = node.hOut.y - node.y
  const li = Math.hypot(ix, iy)
  const lo = Math.hypot(ox, oy)
  if (li < EPS || lo < EPS) return false
  return (ix * ox + iy * oy) / (li * lo) >= SMOOTH_COS
}

// ---------------------------------------------------------------------------
// SubPath[] → path data
// ---------------------------------------------------------------------------

/**
 * Serialize subpaths back to compact path data: 'L' for straight segments,
 * 'C' otherwise (null handles emit their anchor coords), 'Z' for closed.
 * Subpaths with fewer than 2 nodes are skipped.
 */
export function subPathsToD(subPaths: SubPath[], precision = 2): string {
  const fmt = (v: number) => String(Number(v.toFixed(precision)))
  let out = ''
  for (const sp of subPaths) {
    if (sp.nodes.length < 2) continue
    const first = sp.nodes[0]
    out += `M${fmt(first.x)} ${fmt(first.y)}`
    const count = segmentCount(sp)
    for (let seg = 0; seg < count; seg++) {
      const a = sp.nodes[seg]
      const b = sp.nodes[(seg + 1) % sp.nodes.length]
      if (!a.hOut && !b.hIn) {
        // The closing straight segment is implied by Z.
        if (!(sp.closed && seg === count - 1)) out += `L${fmt(b.x)} ${fmt(b.y)}`
      } else {
        const c1 = a.hOut ?? a
        const c2 = b.hIn ?? b
        out += `C${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(b.x)} ${fmt(b.y)}`
      }
    }
    if (sp.closed) out += 'Z'
  }
  return out
}

// ---------------------------------------------------------------------------
// SVG → EditableDoc
// ---------------------------------------------------------------------------

/** Presentation context composed while walking the SVG tree. */
interface PaintContext {
  transform: Affine
  fill: string | null
  fillRule: string | null
  fillOpacity: number | null
  stroke: string | null
  /** Group opacity multiplies down the tree (unlike the inherited props). */
  opacity: number
}

const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line'])

/**
 * Parse SVG markup into an EditableDoc. Fillable shapes (fill that isn't
 * none/url(), no stroke) become PathItems with ancestor transforms baked in;
 * everything else that paints round-trips as RawItems in document order.
 * Returns null when the markup doesn't parse as SVG.
 */
export function parseSvg(svg: string): EditableDoc | null {
  let dom: Document
  try {
    dom = new DOMParser().parseFromString(svg, 'image/svg+xml')
  } catch {
    return null
  }
  const root = dom.documentElement
  if (!root || root.nodeName.toLowerCase() !== 'svg' || dom.querySelector('parsererror')) return null

  let viewBox: [number, number, number, number] | null = null
  const vbAttr = root.getAttribute('viewBox')
  if (vbAttr) {
    const p = vbAttr.trim().split(/[\s,]+/).map(Number)
    if (p.length === 4 && p.every(Number.isFinite) && p[2] > 0 && p[3] > 0) {
      viewBox = [p[0], p[1], p[2], p[3]]
    }
  }
  if (!viewBox) {
    const w = parseFloat(root.getAttribute('width') || '')
    const h = parseFloat(root.getAttribute('height') || '')
    viewBox = w > 0 && h > 0 ? [0, 0, w, h] : [0, 0, 512, 512]
  }

  const items: DocItem[] = []
  let counter = 0
  const nextId = () => `p${++counter}`
  const rootCtx = childContext(root, {
    transform: [1, 0, 0, 1, 0, 0],
    fill: null,
    fillRule: null,
    fillOpacity: null,
    stroke: null,
    opacity: 1,
  })
  walkChildren(root, rootCtx, items, nextId)
  return { viewBox, items }
}

function walkChildren(parent: Element, ctx: PaintContext, items: DocItem[], nextId: () => string): void {
  for (const el of Array.from(parent.children)) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'title' || tag === 'desc' || tag === 'metadata') continue
    if (tag === 'defs' || tag === 'style') {
      // Preserved wholesale; defs/style don't render, so no context needed.
      items.push({ kind: 'raw', id: nextId(), markup: serializeElement(el), visible: true })
      continue
    }
    if (tag === 'g') {
      if (el.children.length === 0) continue
      walkChildren(el, childContext(el, ctx), items, nextId)
      continue
    }
    if (SHAPE_TAGS.has(tag)) {
      const shapeCtx = childContext(el, ctx)
      if (isFillable(shapeCtx)) {
        const subPaths = shapeToSubPaths(el, tag)
        // Degenerate shapes (zero size, too few points) render nothing.
        if (!subPaths || subPaths.length === 0) continue
        items.push(makePathItem(nextId(), subPaths, shapeCtx))
        continue
      }
    }
    items.push(makeRawItem(nextId(), el, ctx))
  }
}

/** Compose an element's transform + presentation props onto its parent context. */
function childContext(el: Element, ctx: PaintContext): PaintContext {
  const t = el.getAttribute('transform')
  const opacity = parseOpacity(presentationProp(el, 'opacity'))
  return {
    transform: t ? composeAffine(ctx.transform, parseTransformAttr(t)) : ctx.transform,
    fill: presentationProp(el, 'fill') ?? ctx.fill,
    fillRule: presentationProp(el, 'fill-rule') ?? ctx.fillRule,
    fillOpacity: parseOpacity(presentationProp(el, 'fill-opacity')) ?? ctx.fillOpacity,
    stroke: presentationProp(el, 'stroke') ?? ctx.stroke,
    opacity: opacity !== null ? ctx.opacity * opacity : ctx.opacity,
  }
}

/** Resolve a presentation property: inline style wins over the attribute. */
function presentationProp(el: Element, name: string): string | null {
  const style = el.getAttribute('style')
  if (style) {
    const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i').exec(style)
    if (m) return m[1].trim()
  }
  const attr = el.getAttribute(name)
  return attr !== null && attr.trim() !== '' ? attr.trim() : null
}

/** Parse an opacity value ('0.5' or '50%') clamped to [0, 1]; null if absent. */
function parseOpacity(v: string | null): number | null {
  if (v === null) return null
  const pct = v.endsWith('%')
  const num = parseFloat(v)
  if (!Number.isFinite(num)) return null
  return Math.max(0, Math.min(1, pct ? num / 100 : num))
}

/** Editable = solid fill (not none / url(...)) and no stroke. */
function isFillable(ctx: PaintContext): boolean {
  if (ctx.fill !== null) {
    const f = ctx.fill.toLowerCase()
    if (f === 'none' || f.startsWith('url(')) return false
  }
  if (ctx.stroke !== null && ctx.stroke.toLowerCase() !== 'none') return false
  return true
}

function makePathItem(id: string, subPaths: SubPath[], ctx: PaintContext): PathItem {
  const fillOpacity = (ctx.fillOpacity ?? 1) * ctx.opacity
  const item: PathItem = {
    kind: 'path',
    id,
    fill: ctx.fill ?? '#000000',
    fillRule: ctx.fillRule?.toLowerCase() === 'evenodd' ? 'evenodd' : 'nonzero',
    subPaths: transformSubPaths(subPaths, ctx.transform),
    visible: true,
  }
  if (fillOpacity < 1) item.fillOpacity = fillOpacity
  return item
}

function makeRawItem(id: string, el: Element, ctx: PaintContext): RawItem {
  const item: RawItem = { kind: 'raw', id, markup: serializeElement(el), visible: true }
  if (!isIdentityAffine(ctx.transform)) item.transform = affineToString(ctx.transform)
  const inherited: Record<string, string> = {}
  if (ctx.fill !== null) inherited['fill'] = ctx.fill
  if (ctx.fillRule !== null) inherited['fill-rule'] = ctx.fillRule
  if (ctx.fillOpacity !== null) inherited['fill-opacity'] = String(ctx.fillOpacity)
  if (ctx.stroke !== null) inherited['stroke'] = ctx.stroke
  if (ctx.opacity < 1) inherited['opacity'] = String(Number(ctx.opacity.toFixed(4)))
  if (Object.keys(inherited).length > 0) item.inherited = inherited
  return item
}

function serializeElement(el: Element): string {
  return new XMLSerializer().serializeToString(el)
}

// --- Basic shapes → SubPath[] (untransformed local coordinates) -------------

function shapeToSubPaths(el: Element, tag: string): SubPath[] | null {
  switch (tag) {
    case 'path':
      return parsePathD(el.getAttribute('d') ?? '')
    case 'rect':
      return rectSubPaths(el)
    case 'circle': {
      const r = attrNum(el, 'r', 0)
      return ellipseSubPaths(attrNum(el, 'cx', 0), attrNum(el, 'cy', 0), r, r)
    }
    case 'ellipse':
      return ellipseSubPaths(attrNum(el, 'cx', 0), attrNum(el, 'cy', 0), attrNum(el, 'rx', 0), attrNum(el, 'ry', 0))
    case 'polygon':
      return pointsSubPaths(el, true)
    case 'polyline':
      return pointsSubPaths(el, false)
    case 'line': {
      const x1 = attrNum(el, 'x1', 0)
      const y1 = attrNum(el, 'y1', 0)
      const x2 = attrNum(el, 'x2', 0)
      const y2 = attrNum(el, 'y2', 0)
      if (Math.abs(x2 - x1) < EPS && Math.abs(y2 - y1) < EPS) return null
      return [
        {
          closed: false,
          nodes: [
            { x: x1, y: y1, hIn: null, hOut: null, kind: 'corner' },
            { x: x2, y: y2, hIn: null, hOut: null, kind: 'corner' },
          ],
        },
      ]
    }
    default:
      return null
  }
}

function attrNum(el: Element, name: string, fallback: number): number {
  const v = parseFloat(el.getAttribute(name) ?? '')
  return Number.isFinite(v) ? v : fallback
}

function rectSubPaths(el: Element): SubPath[] | null {
  const x = attrNum(el, 'x', 0)
  const y = attrNum(el, 'y', 0)
  const w = attrNum(el, 'width', 0)
  const h = attrNum(el, 'height', 0)
  if (w <= 0 || h <= 0) return null

  // rx/ry default to each other when only one is given; clamp to half-size.
  const rxRaw = parseFloat(el.getAttribute('rx') ?? '')
  const ryRaw = parseFloat(el.getAttribute('ry') ?? '')
  let rx = Number.isFinite(rxRaw) ? rxRaw : Number.isFinite(ryRaw) ? ryRaw : 0
  let ry = Number.isFinite(ryRaw) ? ryRaw : Number.isFinite(rxRaw) ? rxRaw : 0
  rx = Math.min(Math.max(rx, 0), w / 2)
  ry = Math.min(Math.max(ry, 0), h / 2)

  const corner = (px: number, py: number): PathNode => ({ x: px, y: py, hIn: null, hOut: null, kind: 'corner' })
  if (rx < EPS || ry < EPS) {
    return [
      {
        closed: true,
        nodes: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)],
      },
    ]
  }

  // Rounded corners: quarter-ellipse arcs as kappa cubics, clockwise from the
  // end of the top-left corner arc.
  const kx = rx * (1 - KAPPA)
  const ky = ry * (1 - KAPPA)
  const node = (px: number, py: number, hIn: Vec | null, hOut: Vec | null): PathNode => ({
    x: px,
    y: py,
    hIn,
    hOut,
    kind: 'corner',
  })
  return [
    {
      closed: true,
      nodes: [
        node(x + rx, y, { x: x + kx, y }, null),
        node(x + w - rx, y, null, { x: x + w - kx, y }),
        node(x + w, y + ry, { x: x + w, y: y + ky }, null),
        node(x + w, y + h - ry, null, { x: x + w, y: y + h - ky }),
        node(x + w - rx, y + h, { x: x + w - kx, y: y + h }, null),
        node(x + rx, y + h, null, { x: x + kx, y: y + h }),
        node(x, y + h - ry, { x, y: y + h - ky }, null),
        node(x, y + ry, null, { x, y: y + ky }),
      ],
    },
  ]
}

function ellipseSubPaths(cx: number, cy: number, rx: number, ry: number): SubPath[] | null {
  if (rx <= 0 || ry <= 0) return null
  const ox = rx * KAPPA
  const oy = ry * KAPPA
  const node = (px: number, py: number, hIn: Vec, hOut: Vec): PathNode => ({
    x: px,
    y: py,
    hIn,
    hOut,
    kind: 'smooth',
  })
  return [
    {
      closed: true,
      nodes: [
        node(cx + rx, cy, { x: cx + rx, y: cy - oy }, { x: cx + rx, y: cy + oy }),
        node(cx, cy + ry, { x: cx + ox, y: cy + ry }, { x: cx - ox, y: cy + ry }),
        node(cx - rx, cy, { x: cx - rx, y: cy + oy }, { x: cx - rx, y: cy - oy }),
        node(cx, cy - ry, { x: cx - ox, y: cy - ry }, { x: cx + ox, y: cy - ry }),
      ],
    },
  ]
}

function pointsSubPaths(el: Element, closed: boolean): SubPath[] | null {
  const parts = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).filter(Boolean)
  const pts: Vec[] = []
  for (let k = 0; k + 1 < parts.length; k += 2) {
    const px = Number(parts[k])
    const py = Number(parts[k + 1])
    if (!Number.isFinite(px) || !Number.isFinite(py)) break // spec: stop at first bad pair
    const last = pts[pts.length - 1]
    if (last && Math.abs(px - last.x) < EPS && Math.abs(py - last.y) < EPS) continue
    pts.push({ x: px, y: py })
  }
  if (closed && pts.length >= 2) {
    const first = pts[0]
    const last = pts[pts.length - 1]
    if (Math.abs(last.x - first.x) < EPS && Math.abs(last.y - first.y) < EPS) pts.pop()
  }
  if (pts.length < (closed ? 3 : 2)) return null
  return [
    {
      closed,
      nodes: pts.map((p) => ({ x: p.x, y: p.y, hIn: null, hOut: null, kind: 'corner' as const })),
    },
  ]
}

// ---------------------------------------------------------------------------
// EditableDoc → SVG
// ---------------------------------------------------------------------------

/**
 * Serialize a document to compact SVG markup. Hidden items are skipped; raw
 * items are re-wrapped in a <g> carrying their captured ancestor context.
 */
export function serializeDoc(doc: EditableDoc, precision = 2): string {
  const fmt = (v: number) => String(Number(v.toFixed(precision)))
  const [x, y, w, h] = doc.viewBox
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)}">`
  for (const item of doc.items) {
    if (!item.visible) continue
    if (item.kind === 'path') {
      out += `<path fill="${escapeAttr(item.fill)}"`
      if (item.fillOpacity !== undefined && item.fillOpacity < 1) {
        out += ` fill-opacity="${Number(item.fillOpacity.toFixed(4))}"`
      }
      if (item.fillRule === 'evenodd') out += ' fill-rule="evenodd"'
      out += ` d="${subPathsToD(item.subPaths, precision)}"/>`
    } else {
      const inherited = item.inherited ?? {}
      const keys = Object.keys(inherited)
      if (item.transform || keys.length > 0) {
        out += '<g'
        if (item.transform) out += ` transform="${escapeAttr(item.transform)}"`
        for (const key of keys) out += ` ${key}="${escapeAttr(inherited[key])}"`
        out += `>${item.markup}</g>`
      } else {
        out += item.markup
      }
    }
  }
  return out + '</svg>'
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** Path / node / distinct-fill counts over the visible PathItems. */
export function docStats(doc: EditableDoc): { paths: number; nodes: number; colors: number } {
  let paths = 0
  let nodes = 0
  const fills = new Set<string>()
  for (const item of doc.items) {
    if (item.kind !== 'path' || !item.visible) continue
    paths++
    for (const sp of item.subPaths) nodes += sp.nodes.length
    fills.add(item.fill.trim().toLowerCase())
  }
  return { paths, nodes, colors: fills.size }
}
