// SVG ⇄ editable document conversion: full path-data parsing (arcs and
// quadratics normalized to cubics), basic-shape conversion, and compact
// serialization. Fillable geometry becomes node-editable PathItems; anything
// else (strokes, gradients, text, defs…) round-trips verbatim as RawItems.
//
// parsePathD / subPathsToD are pure string work and run anywhere; parseSvg /
// serializeDoc use DOMParser / XMLSerializer and are browser-only.

import type {
  Affine,
  DocItem,
  EditableDoc,
  GradientFill,
  GroupItem,
  PathItem,
  PathNode,
  RawItem,
  Stroke,
  SubPath,
  Vec,
} from './types'
import { allLeaves, leafItems, removeItems } from './docTree.ts'
import {
  affineScale,
  affineToString,
  composeAffine,
  isIdentityAffine,
  parseTransformAttr,
  segmentCount,
  subPathsTightBounds,
  transformSubPaths,
} from './geometry.ts'
import { gradientToSvgDef } from '../trace/gradient.ts'
import {
  collectGradientElements,
  gradientRefId,
  representativeStopColor,
  resolveGradientFill,
} from './gradientImport.ts'

/** Stable <defs> id for a path's gradient paint server. */
const gradientId = (itemId: string): string => 'grad-' + itemId

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
  strokeWidth: string | null
  strokeCap: string | null
  strokeJoin: string | null
  strokeDash: string | null
  strokeOpacity: number | null
  /** Group opacity multiplies down the tree (unlike the inherited props). */
  opacity: number
}

const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line'])

/**
 * Attributes that change how a shape paints in ways this model cannot express.
 * A shape carrying any of them stays a RawItem, because lifting it into a
 * PathItem would render it correctly today and then silently drop the attribute
 * on export — a lossless round-trip quietly becoming a lossy one is far worse
 * than a shape you can't node-edit.
 */
const UNMODELLABLE_ATTRS = [
  'filter',
  'mask',
  'clip-path',
  'marker-start',
  'marker-mid',
  'marker-end',
  'vector-effect',
  'stroke-miterlimit',
  'stroke-dashoffset',
  'pathLength',
  'transform-origin',
]

/** Options for {@link parseSvg}. */
export interface ParseSvgOptions {
  /**
   * Keep `<g>` nesting as GroupItems instead of flattening it away.
   *
   * OFF by default, because the vectorize studio re-parses its own serialized
   * output and wants the flat item list it has always had. The SVG editor turns
   * it ON so an imported file keeps the layer folders its author made.
   *
   * Either way ancestor transforms are still baked into the leaves — a
   * GroupItem carries no transform of its own (see {@link GroupItem}).
   */
  preserveGroups?: boolean
}

/**
 * Parse SVG markup into an EditableDoc. Fillable shapes (fill that isn't
 * none/url(), no stroke) become PathItems with ancestor transforms baked in;
 * everything else that paints round-trips as RawItems in document order.
 * Returns null when the markup doesn't parse as SVG.
 */
export function parseSvg(svg: string, options: ParseSvgOptions = {}): EditableDoc | null {
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
  // Paint servers indexed by id, so a shape's url(#id) fill can be lifted back
  // into an editable gradient instead of being dumped as raw markup.
  const gradients = collectGradientElements(dom)
  const consumedGradients = new Set<string>()
  // <defs> blocks and stand-alone gradient elements are finalized after the
  // walk: gradients we lifted into paths are stripped so they don't survive as
  // dead markup (and get re-emitted with fresh ids on serialize).
  const deferredDefs: { item: RawItem; el: Element }[] = []
  let counter = 0
  const nextId = () => `p${++counter}`
  const ctx: WalkContext = {
    items,
    nextId,
    gradients,
    consumedGradients,
    deferredDefs,
    preserveGroups: options.preserveGroups === true,
  }
  const rootCtx = childContext(root, {
    transform: [1, 0, 0, 1, 0, 0],
    fill: null,
    fillRule: null,
    fillOpacity: null,
    stroke: null,
    strokeWidth: null,
    strokeCap: null,
    strokeJoin: null,
    strokeDash: null,
    strokeOpacity: null,
    opacity: 1,
  })
  walkChildren(root, rootCtx, ctx)

  // Strip consumed gradients from the defs they lived in, unless a surviving raw
  // item still references them (e.g. a stroked shape sharing the same paint).
  if (consumedGradients.size > 0) {
    const stillReferenced = new Set<string>()
    for (const it of allLeaves(items)) {
      if (it.kind === 'raw') for (const id of referencedIds(it.markup)) stillReferenced.add(id)
    }
    const removable = new Set([...consumedGradients].filter((id) => !stillReferenced.has(id)))
    if (removable.size > 0) {
      const dropped = new Set<string>()
      for (const { item, el } of deferredDefs) {
        const next = stripGradients(el, removable)
        if (next === null) dropped.add(item.id)
        else item.markup = next
      }
      if (dropped.size > 0) return { viewBox, items: removeItems(items, dropped) }
    }
  }
  return { viewBox, items }
}

/** Shared mutable state threaded through the recursive SVG walk. */
interface WalkContext {
  items: DocItem[]
  nextId: () => string
  gradients: Map<string, Element>
  consumedGradients: Set<string>
  deferredDefs: { item: RawItem; el: Element }[]
  preserveGroups: boolean
}

function walkChildren(parent: Element, ctx: PaintContext, w: WalkContext): void {
  for (const el of Array.from(parent.children)) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'title' || tag === 'desc' || tag === 'metadata') continue
    if (tag === 'defs' || tag === 'style') {
      // Preserved wholesale; defs/style don't render, so no context needed.
      const item: RawItem = { kind: 'raw', id: w.nextId(), markup: serializeElement(el), visible: true }
      w.items.push(item)
      if (tag === 'defs') w.deferredDefs.push({ item, el })
      continue
    }
    if (tag === 'lineargradient' || tag === 'radialgradient') {
      // Stand-alone paint server (not under <defs>): round-trips as raw unless a
      // fill consumes it, in which case the finalize pass drops it.
      const item: RawItem = { kind: 'raw', id: w.nextId(), markup: serializeElement(el), visible: true }
      w.items.push(item)
      w.deferredDefs.push({ item, el })
      continue
    }
    if (tag === 'g') {
      if (el.children.length === 0) continue
      if (!w.preserveGroups) {
        walkChildren(el, childContext(el, ctx), w)
        continue
      }
      // Collect the subtree into its own list, then wrap it. The group's own
      // transform/opacity are consumed by `childContext` on the way down — they
      // reach the leaves baked into coordinates and paint, so the GroupItem is
      // pure structure and nothing downstream has to compose a matrix chain.
      const children: DocItem[] = []
      walkChildren(el, childContext(el, ctx), { ...w, items: children })
      if (children.length === 0) continue
      const group: GroupItem = {
        kind: 'group',
        id: w.nextId(),
        children,
        visible: true,
        expanded: true,
      }
      const name = el.getAttribute('data-name') ?? el.getAttribute('id')
      if (name) group.name = name
      w.items.push(group)
      continue
    }
    if (SHAPE_TAGS.has(tag)) {
      const shapeCtx = childContext(el, ctx)
      // Anything carrying paint we can't re-emit stays raw, whatever else is
      // true of it — a lossy round-trip is worse than an uneditable shape.
      const lossy = hasUnmodellableAttrs(el) || hasUnmodellableStroke(shapeCtx)

      if (!lossy && hasPlainFill(shapeCtx)) {
        const subPaths = shapeToSubPaths(el, tag)
        // Degenerate shapes (zero size, too few points) render nothing.
        if (!subPaths || subPaths.length === 0) continue
        w.items.push(makePathItem(w.nextId(), subPaths, shapeCtx))
        continue
      }
      // Gradient fill: lift into an editable path when the paint server
      // resolves to a gradient the model can represent. A modellable stroke
      // rides along; an unmodellable one already forced `lossy`.
      const gradId = !lossy ? gradientRefId(shapeCtx.fill) : null
      const gradEl = gradId ? w.gradients.get(gradId) : null
      if (gradId && gradEl) {
        const subPaths = shapeToSubPaths(el, tag)
        if (!subPaths || subPaths.length === 0) continue
        const gradient = resolveGradientFill(gradEl, w.gradients, subPathsTightBounds(subPaths), shapeCtx.transform)
        if (gradient) {
          const item = makePathItem(w.nextId(), subPaths, { ...shapeCtx, fill: representativeStopColor(gradient.stops) })
          item.gradient = gradient
          w.items.push(item)
          w.consumedGradients.add(gradId)
          continue
        }
      }
    }
    w.items.push(makeRawItem(w.nextId(), el, ctx))
  }
}

/** Ids referenced by markup via url(#id) or (xlink:)href="#id". */
function referencedIds(markup: string): string[] {
  const ids: string[] = []
  const url = /url\(\s*['"]?#([^)'"]+)/gi
  const href = /\bhref\s*=\s*['"]#([^'"]+)/gi
  let m: RegExpExecArray | null
  while ((m = url.exec(markup))) ids.push(m[1])
  while ((m = href.exec(markup))) ids.push(m[1])
  return ids
}

/**
 * Remove the given gradient ids from a defs/paint-server element and reserialize.
 * Returns null when nothing renderable is left (the caller drops the item).
 */
function stripGradients(el: Element, remove: Set<string>): string | null {
  const tag = el.tagName.toLowerCase()
  if (tag === 'lineargradient' || tag === 'radialgradient') {
    const id = el.getAttribute('id')
    return id && remove.has(id) ? null : serializeElement(el)
  }
  const clone = el.cloneNode(true) as Element
  for (const g of Array.from(clone.querySelectorAll('linearGradient, radialGradient'))) {
    const id = g.getAttribute('id')
    if (id && remove.has(id)) g.parentNode?.removeChild(g)
  }
  return clone.children.length === 0 ? null : serializeElement(clone)
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
    strokeWidth: presentationProp(el, 'stroke-width') ?? ctx.strokeWidth,
    strokeCap: presentationProp(el, 'stroke-linecap') ?? ctx.strokeCap,
    strokeJoin: presentationProp(el, 'stroke-linejoin') ?? ctx.strokeJoin,
    strokeDash: presentationProp(el, 'stroke-dasharray') ?? ctx.strokeDash,
    strokeOpacity: parseOpacity(presentationProp(el, 'stroke-opacity')) ?? ctx.strokeOpacity,
    opacity: opacity !== null ? ctx.opacity * opacity : ctx.opacity,
  }
}

/**
 * The stroke a context paints, as an editable Stroke — or null when there is
 * none, or when it is a paint server this model can't express (a gradient or
 * pattern stroke, which has to stay raw to survive export).
 */
function resolveStroke(ctx: PaintContext): Stroke | null {
  if (ctx.stroke === null) return null
  const paint = ctx.stroke.trim().toLowerCase()
  if (paint === 'none' || paint === 'transparent' || paint.startsWith('url(')) return null

  // SVG's own default is 1 when the attribute is absent.
  const width = ctx.strokeWidth === null ? 1 : parseFloat(ctx.strokeWidth)
  if (!Number.isFinite(width) || width <= 0) return null
  // A percentage width resolves against the viewport diagonal, which we don't
  // track here — leave those raw rather than guess.
  if (ctx.strokeWidth !== null && /%\s*$/.test(ctx.strokeWidth)) return null

  const cap = ctx.strokeCap?.trim().toLowerCase()
  const join = ctx.strokeJoin?.trim().toLowerCase()
  const stroke: Stroke = {
    color: ctx.stroke.trim(),
    width,
    cap: cap === 'round' || cap === 'square' ? cap : 'butt',
    join: join === 'round' || join === 'bevel' ? join : 'miter',
  }

  if (ctx.strokeDash) {
    const dash = ctx.strokeDash
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    if (dash.length > 0 && dash.every((n) => Number.isFinite(n) && n >= 0) && dash.some((n) => n > 0)) {
      stroke.dash = dash
    } else if (ctx.strokeDash.trim().toLowerCase() !== 'none') {
      // An unparseable dash pattern would be silently dropped — keep it raw.
      return null
    }
  }

  // Element opacity multiplies the stroke as well as the fill.
  const alpha = (ctx.strokeOpacity ?? 1) * ctx.opacity
  if (alpha < 1) stroke.opacity = alpha
  return stroke
}

/** Scale a stroke's scalar lengths by a baked transform. */
function scaleStroke(stroke: Stroke, m: Affine): Stroke {
  const k = affineScale(m)
  if (k === 1) return stroke
  const next: Stroke = { ...stroke, width: stroke.width * k }
  if (stroke.dash) next.dash = stroke.dash.map((d) => d * k)
  return next
}

/** True when the element carries paint we would drop on the way back out. */
function hasUnmodellableAttrs(el: Element): boolean {
  for (const name of UNMODELLABLE_ATTRS) {
    const v = el.getAttribute(name)
    if (v !== null && v.trim() !== '' && v.trim().toLowerCase() !== 'none') return true
    // The same properties can arrive through `style`.
    const style = el.getAttribute('style')
    if (style && new RegExp(`(?:^|;)\\s*${name}\\s*:`, 'i').test(style)) return true
  }
  return false
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

/**
 * Whether the fill is one this model can hold directly: absent (⇒ black),
 * `none`, or a solid colour. A `url(...)` fill is handled separately, by
 * lifting the referenced gradient.
 */
function hasPlainFill(ctx: PaintContext): boolean {
  if (ctx.fill === null) return true
  const f = ctx.fill.trim().toLowerCase()
  return !f.startsWith('url(')
}

/** A stroke that exists but this model can't express ⇒ the shape stays raw. */
function hasUnmodellableStroke(ctx: PaintContext): boolean {
  if (ctx.stroke === null) return false
  const s = ctx.stroke.trim().toLowerCase()
  if (s === 'none' || s === 'transparent') return false
  return resolveStroke(ctx) === null
}

function makePathItem(id: string, subPaths: SubPath[], ctx: PaintContext): PathItem {
  const fillOpacity = (ctx.fillOpacity ?? 1) * ctx.opacity
  // `fill` is the SVG keyword when the shape is stroke-only, so a line drawn
  // as pure outline round-trips as one instead of gaining a black interior.
  const fill = ctx.fill === null ? '#000000' : ctx.fill.trim()
  const filled = fill.toLowerCase() !== 'none'
  const item: PathItem = {
    kind: 'path',
    id,
    fill: filled ? fill : 'none',
    fillRule: ctx.fillRule?.toLowerCase() === 'evenodd' ? 'evenodd' : 'nonzero',
    subPaths: transformSubPaths(subPaths, ctx.transform),
    visible: true,
  }
  if (filled && fillOpacity < 1) item.fillOpacity = fillOpacity
  const stroke = resolveStroke(ctx)
  // The transform is baked into the coordinates, so the width has to follow it.
  if (stroke) item.stroke = scaleStroke(stroke, ctx.transform)
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

export function ellipseSubPaths(cx: number, cy: number, rx: number, ry: number): SubPath[] | null {
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

  // Gradient paint servers for visible paths that carry one. Shared gradient
  // objects (merged bands) are emitted once and referenced by every path.
  // `leafItems` flattens groups and prunes hidden subtrees, so for the flat,
  // group-free docs the tracer produces this visits exactly what it always did.
  const gradIds = new Map<GradientFill, string>()
  let defs = ''
  for (const item of leafItems(doc.items)) {
    if (item.kind === 'path' && item.gradient && !gradIds.has(item.gradient)) {
      const id = gradientId(item.id)
      gradIds.set(item.gradient, id)
      defs += gradientToSvgDef(item.gradient, id, precision)
    }
  }
  if (defs) out += `<defs>${defs}</defs>`

  out += serializeItems(doc.items, gradIds, precision, fmt)
  return out + '</svg>'
}

/** Body markup for one level of the item tree; recurses through groups. */
function serializeItems(
  items: readonly DocItem[],
  gradIds: Map<GradientFill, string>,
  precision: number,
  fmt: (v: number) => string,
): string {
  let out = ''
  for (const item of items) {
    if (!item.visible) continue
    if (item.kind === 'group') {
      // An empty folder (or one whose children are all hidden) is structure the
      // editor cares about and markup nobody does — emitting `<g></g>` would
      // just add noise to every export.
      const inner = serializeItems(item.children, gradIds, precision, fmt)
      if (!inner) continue
      out += '<g'
      if (item.name) out += ` data-name="${escapeAttr(item.name)}"`
      if (item.opacity !== undefined && item.opacity < 1) {
        out += ` opacity="${Number(item.opacity.toFixed(4))}"`
      }
      out += `>${inner}</g>`
    } else if (item.kind === 'path') {
      const fill = item.gradient ? `url(#${gradIds.get(item.gradient)})` : escapeAttr(item.fill)
      out += `<path fill="${fill}"`
      if (item.fillOpacity !== undefined && item.fillOpacity < 1) {
        out += ` fill-opacity="${Number(item.fillOpacity.toFixed(4))}"`
      }
      if (item.fillRule === 'evenodd') out += ' fill-rule="evenodd"'
      const s = item.stroke
      if (s && s.width > 0) {
        out += ` stroke="${escapeAttr(s.color)}" stroke-width="${fmt(s.width)}"`
        if (s.cap !== 'butt') out += ` stroke-linecap="${s.cap}"`
        if (s.join !== 'miter') out += ` stroke-linejoin="${s.join}"`
        if (s.dash && s.dash.length > 0) {
          out += ` stroke-dasharray="${s.dash.map(fmt).join(' ')}"`
        }
        if (s.opacity !== undefined && s.opacity < 1) {
          out += ` stroke-opacity="${Number(s.opacity.toFixed(4))}"`
        }
      }
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
  return out
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/**
 * True when the path paints only its outline — `fill="none"` with a stroke.
 * Such a path's visible colour is its STROKE, so any UI that shows "the
 * colour of this path" (swatch, palette, recolor, hover highlight) has to ask
 * here rather than reading `fill` and getting the string "none".
 */
export function isStrokeOnly(item: PathItem): boolean {
  return item.fill.trim().toLowerCase() === 'none' && item.stroke !== undefined
}

/** The colour that represents a path on screen: its fill, or its stroke. */
export function representativePaint(item: PathItem): string {
  return isStrokeOnly(item) ? (item.stroke?.color ?? '#000000') : item.fill
}

/** Path / node / distinct-fill counts over the visible PathItems. */
export function docStats(doc: EditableDoc): { paths: number; nodes: number; colors: number } {
  let paths = 0
  let nodes = 0
  const fills = new Set<string>()
  for (const item of leafItems(doc.items)) {
    if (item.kind !== 'path') continue
    paths++
    for (const sp of item.subPaths) nodes += sp.nodes.length
    // A stroke-only path contributes no fill colour.
    const f = item.fill.trim().toLowerCase()
    if (f !== 'none') fills.add(f)
  }
  return { paths, nodes, colors: fills.size }
}
