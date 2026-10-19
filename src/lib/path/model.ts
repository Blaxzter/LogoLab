// SVG ⇄ editable document conversion: full path-data parsing (arcs and
// quadratics normalized to cubics), basic-shape conversion, and compact
// serialization. Fillable geometry becomes node-editable PathItems; anything
// else (strokes, gradients, text, defs…) round-trips verbatim as RawItems.
//
// parsePathD / subPathsToD are pure string work and run anywhere; parseSvg /
// serializeDoc use DOMParser / XMLSerializer and are browser-only.

import type {
  Affine,
  ClipShape,
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
  applyAffine,
  composeAffine,
  isIdentityAffine,
  itemBounds,
  parseTransformAttr,
  segmentCount,
  subPathsTightBounds,
  transformSubPaths,
} from './geometry.ts'
import { gradientToSvgDef } from '../trace/gradient.ts'
import {
  collectGradientElements,
  gradientChain,
  gradientRefId,
  representativeStopColor,
  resolveGradientFill,
} from './gradientImport.ts'
import { parseCssColor, rgbaToHex } from './cssColor.ts'
import { inlineStylesheets } from './svgStyle.ts'

/** Stable <defs> id for a path's gradient paint server. */
const gradientId = (itemId: string): string => 'grad-' + itemId

/** Stable <defs> id for a group's clipping path. */
const clipId = (groupId: string): string => 'clip-' + groupId

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
  strokeMiter: string | null
  strokeOpacity: number | null
  /** Group opacity multiplies down the tree (unlike the inherited props). */
  opacity: number
  /** The CSS `color` that `currentColor` paint resolves to. */
  color: string | null
  /** `visibility` inherits, and a descendant can turn itself back on. */
  visibility: string | null
  /** Inherited properties only a raw leaf reads (a `<text>`'s font, pointer-events). */
  rawProps: Record<string, string>
}

const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line'])

/**
 * Attributes that change how a shape paints in ways this model cannot express.
 * A shape carrying any of them stays a RawItem: as a PathItem it would render
 * correctly but silently lose the attribute on export, and a lossy round-trip
 * is worse than a shape you can't node-edit.
 */
const UNMODELLABLE_ATTRS = [
  'filter',
  'mask',
  'clip-path',
  'marker-start',
  'marker-mid',
  'marker-end',
  'vector-effect',
  'stroke-dashoffset',
  'pathLength',
  'transform-origin',
]

/**
 * The subset that acts on a `<g>` as a whole. Flattening the group would apply
 * each to nothing — masked or clipped art drawn unmasked — so such a group stays
 * raw. (The others inherit or do nothing on a group.) The exception is a clip
 * alone, when groups are kept: the model carries it (`GroupItem.clip`), so the
 * children stay editable — Illustrator wraps every export in one.
 */
const GROUP_EFFECT_ATTRS = ['filter', 'mask', 'clip-path', 'transform-origin']

/** The same lists without `clip-path`, which a clip group carries as model geometry. */
const UNMODELLABLE_BUT_CLIP = UNMODELLABLE_ATTRS.filter((a) => a !== 'clip-path')
const GROUP_EFFECT_BUT_CLIP = GROUP_EFFECT_ATTRS.filter((a) => a !== 'clip-path')

/**
 * Elements that never render by themselves and only exist to be referenced. They
 * round-trip as inert raw items, and the finalize pass drops one whose every
 * reference was lifted into the model.
 */
const REFERENCED_TAGS = new Set([
  'lineargradient',
  'radialgradient',
  'symbol',
  'clippath',
  'mask',
  'filter',
  'pattern',
  'marker',
])

/**
 * Inherited properties a raw leaf still needs once its `<g>` is gone: a `<text>`'s
 * font, and whether it is a pointer target in the page it is exported into.
 */
const RAW_PROPS = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'font-stretch',
  'text-anchor',
  'letter-spacing',
  'word-spacing',
  'dominant-baseline',
  'writing-mode',
  'direction',
  'pointer-events',
]

/** Options for {@link parseSvg}. */
export interface ParseSvgOptions {
  /**
   * Keep `<g>` nesting as GroupItems instead of flattening it away. Off by
   * default (the vectorize studio re-parses its own output and expects a flat
   * list); the SVG editor turns it on to keep the author's layer folders.
   * Ancestor transforms are baked into the leaves either way.
   */
  preserveGroups?: boolean
}

/**
 * Parse SVG markup into an EditableDoc. Fillable shapes (fill that isn't
 * none/url(), no stroke) become PathItems with ancestor transforms baked in;
 * everything else that paints round-trips as RawItems in document order, and
 * what paints nothing (defs, a shape with neither fill nor stroke) as INERT raw
 * items. Each item is named from what the source's author wrote (`sourceName`).
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
  // Internal CSS (Illustrator's `.cls-1{fill:…}`) folded into each element's
  // style, so the walk sees the paint; elements a rule can't be resolved for stay raw.
  const cssTainted = inlineStylesheets(dom)

  let viewBox: [number, number, number, number] | null = null
  const vbAttr = root.getAttribute('viewBox')
  if (vbAttr) {
    const p = vbAttr
      .trim()
      .split(/[\s,]+/)
      .map(Number)
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
  const byId = new Map<string, Element>()
  for (const el of Array.from(dom.querySelectorAll('*'))) {
    const id = el.getAttribute('id')
    if (id && !byId.has(id)) byId.set(id, el)
  }
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
    viewport: { w: viewBox[2], h: viewBox[3] },
    cssTainted,
    // A rule we could not resolve on the root itself would reach every shape.
    cssTaintAll: cssTainted.has(root),
    byId,
    consumedRefs: new Set(),
    useStack: new Set(),
    inert: new Set(),
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
    strokeMiter: null,
    strokeOpacity: null,
    opacity: 1,
    color: null,
    visibility: null,
    rawProps: {},
  })
  walkChildren(root, rootCtx, ctx)

  // Strip consumed gradients, clip paths and `<use>` targets from the defs they
  // lived in, unless a surviving raw item still references them (e.g. a stroked
  // shape sharing the same paint, or a use that stayed raw).
  const consumed = new Set([...consumedGradients, ...ctx.consumedRefs])
  if (consumed.size > 0) {
    const removable = removableIds(consumed, items, deferredDefs)
    if (removable.size > 0) {
      const dropped = new Set<string>()
      for (const { item, el } of deferredDefs) {
        const next = stripIds(el, removable)
        if (next === null) dropped.add(item.id)
        else item.markup = next
      }
      if (dropped.size > 0) return { viewBox, items: removeItems(items, dropped) }
    }
  }
  return { viewBox, items }
}

/**
 * Which consumed ids no surviving markup still references. A reference from
 * INSIDE something that is itself being removed does not count — Illustrator's
 * clip is a `<clipPath>` whose `<use>` points at a rect in `<defs>`, and once the
 * clip is lifted both are dead — so this narrows to a fixpoint from "all of them".
 */
function removableIds(
  consumed: Set<string>,
  items: readonly DocItem[],
  deferredDefs: readonly { item: RawItem; el: Element }[],
): Set<string> {
  const deferred = new Set(deferredDefs.map((d) => d.item.id))
  const fixed = new Set<string>()
  for (const it of allLeaves(items)) {
    if (it.kind === 'raw' && !deferred.has(it.id)) for (const id of referencedIds(it.markup)) fixed.add(id)
  }
  let removable = new Set([...consumed].filter((id) => !fixed.has(id)))
  for (;;) {
    const refs = new Set<string>()
    for (const { el } of deferredDefs) {
      const left = stripIds(el, removable)
      if (left !== null) for (const id of referencedIds(left)) refs.add(id)
    }
    const next = new Set([...removable].filter((id) => !refs.has(id)))
    if (next.size === removable.size) return next
    removable = next
  }
}

/** Shared mutable state threaded through the recursive SVG walk. */
interface WalkContext {
  items: DocItem[]
  nextId: () => string
  gradients: Map<string, Element>
  consumedGradients: Set<string>
  deferredDefs: { item: RawItem; el: Element }[]
  preserveGroups: boolean
  /** Root viewBox size: what a userSpaceOnUse gradient's percentages resolve against. */
  viewport: { w: number; h: number }
  /** Elements a stylesheet rule could not be resolved for (see svgStyle.ts). */
  cssTainted: Set<Element>
  cssTaintAll: boolean
  /** Elements by id, for `<use>`. First wins, as with getElementById. */
  byId: Map<string, Element>
  /** `<use>` targets inside `<defs>` / `<symbol>` that were lifted into paths. */
  consumedRefs: Set<string>
  /** The `<use>` targets being walked right now — a reference cycle stays raw. */
  useStack: Set<Element>
  /** Raw items that render nothing by themselves (defs, style, paint servers, symbols). */
  inert: Set<string>
}

function walkChildren(parent: Element, ctx: PaintContext, w: WalkContext): void {
  for (const el of Array.from(parent.children)) walkElement(el, ctx, w)
}

/** Push a container's walked children: as a GroupItem when groups are kept, else spliced in. */
function pushContainer(el: Element, children: DocItem[], w: WalkContext): void {
  if (children.length === 0) return
  if (!w.preserveGroups) {
    w.items.push(...children)
    return
  }
  // Transforms and opacity are baked into the leaves by `childContext`, so the
  // GroupItem is pure structure.
  const group: GroupItem = { kind: 'group', id: w.nextId(), children, visible: true, expanded: true }
  const name = sourceName(el)
  if (name) group.name = name
  w.items.push(group)
}

function walkElement(el: Element, ctx: PaintContext, w: WalkContext): void {
  const tag = el.tagName.toLowerCase()
  if (tag === 'title' || tag === 'desc' || tag === 'metadata') return
  if (tag === 'defs' || tag === 'style') {
    // Preserved wholesale; defs/style don't render, so no context needed.
    const item: RawItem = { kind: 'raw', id: w.nextId(), markup: serializeElement(el), visible: true, inert: true }
    w.items.push(item)
    w.inert.add(item.id)
    if (tag === 'defs') w.deferredDefs.push({ item, el })
    return
  }
  if (REFERENCED_TAGS.has(tag)) {
    // Stand-alone paint server / symbol / clip path (not under <defs>): none
    // renders by itself. Round-trips as raw unless what references it is lifted,
    // in which case the finalize pass drops it.
    const item: RawItem = { kind: 'raw', id: w.nextId(), markup: serializeElement(el), visible: true, inert: true }
    w.items.push(item)
    w.inert.add(item.id)
    w.deferredDefs.push({ item, el })
    return
  }
  if (presentationProp(el, 'display')?.toLowerCase() === 'none') {
    // Renders nothing, but may hold what something else references (a hidden
    // layer's gradients, a <use> target): kept raw, where it stays hidden.
    w.items.push(named(makeRawItem(w.nextId(), el, ctx), el))
    return
  }
  if (tag === 'g') {
    if (el.children.length === 0) return
    if (hasGroupEffect(el) || w.cssTainted.has(el)) {
      // A clip alone is model geometry: the children stay editable inside a group
      // that carries it.
      if (
        !w.cssTainted.has(el) &&
        !hasUnmodellableAttrs(el, GROUP_EFFECT_BUT_CLIP) &&
        walkClipped(el, ctx, w, (sub) => walkChildren(el, childContext(el, ctx), sub))
      ) {
        return
      }
      // Masked / filtered (or clipped by what the model can't hold) as a whole:
      // flattened, its children would be drawn without it. The PARENT context goes
      // on the wrapper; the group's own attributes stay in its markup.
      w.items.push(named(makeRawItem(w.nextId(), el, ctx), el))
      return
    }
    if (!w.preserveGroups) {
      walkChildren(el, childContext(el, ctx), w)
      return
    }
    const children: DocItem[] = []
    walkChildren(el, childContext(el, ctx), { ...w, items: children })
    pushContainer(el, children, w)
    return
  }
  if (tag === 'svg' && walkViewport(el, ctx, null, w)) return
  if (tag === 'use' && walkUse(el, ctx, w)) return
  if (SHAPE_TAGS.has(tag) && walkShape(el, tag, ctx, w, false)) return
  w.items.push(named(makeRawItem(w.nextId(), el, ctx), el))
}

/**
 * A basic shape as a PathItem (gradient fill lifted, modellable stroke kept), an
 * inert raw item when it paints nothing, or a clip group of one when it carries a
 * clip. False leaves it to the caller to keep raw. `clipped` says the clip-path is
 * already being handled by an enclosing {@link walkClipped}.
 */
function walkShape(el: Element, tag: string, ctx: PaintContext, w: WalkContext, clipped: boolean): boolean {
  if (
    !clipped &&
    w.preserveGroups &&
    hasUnmodellableAttrs(el, ['clip-path']) &&
    !hasUnmodellableAttrs(el, UNMODELLABLE_BUT_CLIP) &&
    walkClipped(el, ctx, w, (sub) => walkShape(el, tag, ctx, sub, true))
  ) {
    return true
  }
  const shapeCtx = childContext(el, ctx)
  // Anything carrying paint we can't re-emit stays raw — as does a hidden shape
  // (the model has no `visibility`) and one a stylesheet rule may still paint.
  const visibility = shapeCtx.visibility?.toLowerCase()
  const lossy =
    hasUnmodellableAttrs(el, clipped ? UNMODELLABLE_BUT_CLIP : UNMODELLABLE_ATTRS) ||
    hasUnmodellableStroke(shapeCtx) ||
    hasUnresolvableFill(shapeCtx) ||
    visibility === 'hidden' ||
    visibility === 'collapse' ||
    w.cssTaintAll ||
    w.cssTainted.has(el)

  if (!lossy && hasPlainFill(shapeCtx)) {
    const subPaths = shapeToSubPaths(el, tag)
    // Degenerate shapes (zero size, too few points) render nothing.
    if (!subPaths || subPaths.length === 0) return true
    const item = makePathItem(w.nextId(), subPaths, shapeCtx)
    if (paintsNothing(item)) {
      // Neither fill nor stroke (an engraver's metadata box): no layer, nothing to
      // click, but still in the file — verbatim, in place, with what it inherited.
      const raw = makeRawItem(item.id, el, ctx)
      raw.inert = true
      // Inside a `<use>` instance this is one COPY of the element, and every
      // use of it writes one: its id would be in the export twice.
      if (w.useStack.size > 0) raw.markup = withoutRootId(raw.markup)
      w.items.push(named(raw, el))
      w.inert.add(raw.id)
      return true
    }
    w.items.push(named(item, el))
    return true
  }
  // Gradient fill: lift into an editable path when the paint server
  // resolves to a gradient the model can represent. A modellable stroke
  // rides along; an unmodellable one already forced `lossy`.
  const gradId = !lossy ? gradientRefId(shapeCtx.fill) : null
  const gradEl = gradId ? w.gradients.get(gradId) : null
  if (gradId && gradEl && !gradientCssTainted(gradEl, w)) {
    const subPaths = shapeToSubPaths(el, tag)
    if (!subPaths || subPaths.length === 0) return true
    const gradient = resolveGradientFill(
      gradEl,
      w.gradients,
      subPathsTightBounds(subPaths),
      shapeCtx.transform,
      w.viewport,
    )
    if (gradient) {
      const item = makePathItem(w.nextId(), subPaths, {
        ...shapeCtx,
        fill: representativeStopColor(gradient.stops),
      })
      item.gradient = gradient
      w.items.push(named(item, el))
      w.consumedGradients.add(gradId)
      return true
    }
  }
  return false
}

/** Neither fill nor stroke paints anything — fully transparent counts as none. */
function paintsNothing(item: PathItem): boolean {
  const noFill = item.fill === 'none' || item.fillOpacity === 0
  return noFill && (!item.stroke || item.stroke.opacity === 0)
}

/**
 * An element whose `clip-path` the model can carry: its content walked into a
 * GroupItem holding the clip as absolute geometry. False (nothing pushed) when the
 * clip can't be read — the caller keeps the element raw, as before. Only when
 * groups are kept: the flat list has nowhere to put a clip.
 */
function walkClipped(el: Element, ctx: PaintContext, w: WalkContext, walkInner: (sub: WalkContext) => void): boolean {
  if (!w.preserveGroups || w.cssTaintAll) return false
  const ref = presentationProp(el, 'clip-path')
  const id = ref ? /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)$/i.exec(ref)?.[1] : undefined
  const clipEl = id ? w.byId.get(id) : undefined
  if (!id || !clipEl || clipEl.tagName.toLowerCase() !== 'clippath') return false

  const sub: WalkContext = {
    ...w,
    items: [],
    deferredDefs: [],
    consumedGradients: new Set(),
    consumedRefs: new Set(),
  }
  walkInner(sub)
  if (sub.items.length === 0) return false
  // The clip's user space is the referencing element's, its own transform included.
  const clip = resolveClip(clipEl, childContext(el, ctx).transform, sub.items, w, sub.consumedRefs)
  if (!clip) return false

  w.deferredDefs.push(...sub.deferredDefs)
  for (const g of sub.consumedGradients) w.consumedGradients.add(g)
  for (const r of sub.consumedRefs) w.consumedRefs.add(r)
  // Dead markup once nothing raw points at it; the finalize pass decides.
  w.consumedRefs.add(id)
  const group: GroupItem = { kind: 'group', id: w.nextId(), children: sub.items, visible: true, expanded: true, clip }
  const name = sourceName(el)
  if (name) group.name = name
  w.items.push(group)
  return true
}

/**
 * A `<clipPath>` as model geometry in absolute coordinates, or null when it holds
 * what the model can't (text, a nested clip, an unreadable rule). `frame` is the
 * referencing element's user space; `content` its walked children, which an
 * objectBoundingBox clip is sized from.
 */
function resolveClip(
  clipEl: Element,
  frame: Affine,
  content: readonly DocItem[],
  w: WalkContext,
  consumedRefs: Set<string>,
): ClipShape[] | null {
  if (w.cssTainted.has(clipEl) || hasUnmodellableAttrs(clipEl, GROUP_EFFECT_ATTRS)) return null
  let m = composeAffine(frame, parseTransformAttr(clipEl.getAttribute('transform')))
  if (clipEl.getAttribute('clipPathUnits')?.trim() === 'objectBoundingBox') {
    const box = localBox(content, frame, w.inert)
    if (!box) return null
    m = composeAffine(m, [box.w, 0, 0, box.h, box.x, box.y])
  }
  const inheritedRule = presentationProp(clipEl, 'clip-rule')
  const shapes: ClipShape[] = []
  for (const child of Array.from(clipEl.children)) {
    const tag = child.tagName.toLowerCase()
    if (tag === 'title' || tag === 'desc' || tag === 'metadata') continue
    if (w.cssTainted.has(child) || hasUnmodellableAttrs(child, GROUP_EFFECT_ATTRS)) return null
    if (!contributes(child)) continue
    let shapeEl = child
    let t = parseTransformAttr(child.getAttribute('transform'))
    let rule = presentationProp(child, 'clip-rule')
    if (tag === 'use') {
      const href = (child.getAttribute('href') ?? child.getAttribute('xlink:href'))?.trim()
      const target = href?.startsWith('#') ? w.byId.get(href.slice(1)) : undefined
      if (!target || !SHAPE_TAGS.has(target.tagName.toLowerCase())) return null
      if (w.cssTainted.has(target) || hasUnmodellableAttrs(target, GROUP_EFFECT_ATTRS)) return null
      if (!contributes(target)) continue
      const x = lengthAttr(child.getAttribute('x'), w.viewport.w)
      const y = lengthAttr(child.getAttribute('y'), w.viewport.h)
      if (x === null || y === null) return null
      t = composeAffine(composeAffine(t, [1, 0, 0, 1, x, y]), parseTransformAttr(target.getAttribute('transform')))
      rule = presentationProp(target, 'clip-rule') ?? rule
      shapeEl = target
      if (inDefsOrSymbol(target)) consumedRefs.add(href!.slice(1))
    } else if (!SHAPE_TAGS.has(tag)) {
      return null
    }
    const subPaths = shapeToSubPaths(shapeEl, shapeEl.tagName.toLowerCase())
    if (!subPaths || subPaths.length === 0) continue
    const r = (rule ?? inheritedRule)?.toLowerCase()
    shapes.push({
      rule: r === 'evenodd' ? 'evenodd' : 'nonzero',
      subPaths: transformSubPaths(subPaths, composeAffine(m, t)),
    })
  }
  // An empty clip hides everything: a group showing nothing is not worth lifting.
  return shapes.length > 0 ? shapes : null
}

/** Whether a clip child adds to the clip at all (`display` / `visibility` hide it). */
function contributes(el: Element): boolean {
  if (presentationProp(el, 'display')?.toLowerCase() === 'none') return false
  const v = presentationProp(el, 'visibility')?.toLowerCase()
  return v !== 'hidden' && v !== 'collapse'
}

/**
 * The bounding box of walked content in `frame`'s space — what an
 * objectBoundingBox clip is sized from. Null when it can't be told: raw content
 * has no geometry, and under a rotation the absolute box is not the local one.
 */
function localBox(
  content: readonly DocItem[],
  frame: Affine,
  inert: Set<string>,
): { x: number; y: number; w: number; h: number } | null {
  if (Math.abs(frame[1]) > EPS || Math.abs(frame[2]) > EPS || Math.abs(frame[0]) < EPS || Math.abs(frame[3]) < EPS) {
    return null
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const leaf of allLeaves(content)) {
    if (leaf.kind === 'raw') {
      if (inert.has(leaf.id)) continue
      return null
    }
    const b = subPathsTightBounds(leaf.subPaths)
    if (!b) continue
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  if (minX === Infinity) return null
  const ax = (minX - frame[4]) / frame[0]
  const bx = (maxX - frame[4]) / frame[0]
  const ay = (minY - frame[5]) / frame[3]
  const by = (maxY - frame[5]) / frame[3]
  const box = { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) }
  return box.w > EPS && box.h > EPS ? box : null
}

/* ------------------------------------------------------------- names */

/** Give an item the name the source wrote for its element, if it wrote one. */
function named<T extends DocItem>(item: T, el: Element): T {
  const name = sourceName(el)
  if (name) item.name = name
  return item
}

/**
 * The name a human gave an element: a `data-name` (Illustrator, Figma, and
 * this app's own export — first, so a rename in the editor wins over the
 * `<title>` it was imported with), its `<title>`, Inkscape's label, an
 * `aria-label`, or its id — unless the id is one a tool generated (`path123`, `g45`, `svg_3`,
 * `p0_font_1_63`, `Vector_12`, a hash), which would only be noise in a layers list.
 */
export function sourceName(el: Element): string | undefined {
  const dataName = cleanName(el.getAttribute('data-name'))
  if (dataName) return dataName
  for (const child of Array.from(el.children)) {
    if (child.tagName.toLowerCase() !== 'title') continue
    const t = cleanName(child.textContent)
    if (t) return t
  }
  for (const attr of ['inkscape:label', 'aria-label']) {
    const v = cleanName(el.getAttribute(attr))
    if (v) return v
  }
  const id = el.getAttribute('id')
  return id ? (humanId(id) ?? undefined) : undefined
}

function cleanName(v: string | null | undefined): string | undefined {
  const t = v?.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 120) : undefined
}

/** Words tools number their output with: `path123`, `Layer_1`, `SVGID_2_`, `Vector 12`. */
const MACHINE_WORDS =
  'path|g|group|rect|rectangle|circle|ellipse|line|polyline|polygon|shape|text|tspan|use|image|img|svg|svgid|' +
  'layer|vector|symbol|defs|clip|clippath|clip-path|mask|filter|pattern|marker|gradient|lineargradient|' +
  'radialgradient|stop|object|obj|element|el|node|item|frame|union|subtract|intersect|exclude|compound|' +
  'glyph|font|id|component|instance|metadata|namedview|title|desc|style|a|base|copy'
const MACHINE_ID = new RegExp(`^(?:${MACHINE_WORDS})[-_ .:]?\\d+(?:[-_.:]\\d+)*_?$`, 'i')

/** An id as a display name, or null when a tool generated it. */
export function humanId(raw: string): string | null {
  // Illustrator writes characters an id can't hold as `_xHH_`: `_x3C_Group_x3E_` is "<Group>".
  const id = raw.replace(/_x([0-9a-f]{2,4})_/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))).trim()
  if (!id || id.length > 64) return null
  // Illustrator's own unnamed "<Group>", "<Path>", "<Compound Path>".
  if (/^<.*>$/.test(id)) return null
  // Digits and punctuation, or a numeric start (`1`, `3d-1`): no word in it.
  if (!/[a-z]/i.test(id) || /^\d/.test(id)) return null
  if (MACHINE_ID.test(id)) return null
  // A letter and a counter: `p0`, `c12`, `p0_font_1_63`.
  if (/^[a-z]\d/i.test(id)) return null
  // Several counters strung together (`MJX-1-TEX-N-31`, `x_1_2`), unless spaced like prose.
  if (!/\s/.test(id) && (id.match(/\d+/g)?.length ?? 0) >= 2) return null
  // Hashes and framework ids: `a3f9c2d1e0`, `__svelte_4`, React's `:r1:`, a uuid.
  if (/^__/.test(id) || /^:.*:$/.test(id)) return null
  const hex = id.match(/[0-9a-f]{8,}/gi)
  if (hex?.some((h) => /\d/.test(h))) return null
  return id
}

/**
 * A nested `<svg>` (or a `<symbol>` a `<use>` instances) establishes a new
 * viewport: placed at x/y, sized width × height, its viewBox fitted into that per
 * preserveAspectRatio, and — unless overflow is visible — CLIPPED to it. The
 * placement folds into the context like any transform, so its shapes come out
 * editable. The clip has no place in the model, so it is only dropped where it
 * provably cuts nothing: every leaf is a path inside the viewport. Otherwise
 * nothing is pushed and the caller keeps the element raw, as before.
 *
 * `size` is a referencing `<use>`'s width/height, which override the element's.
 */
function walkViewport(
  el: Element,
  ctx: PaintContext,
  size: { width: string | null; height: string | null } | null,
  w: WalkContext,
): boolean {
  // A transform on the viewport element itself is SVG 2 only and renderers
  // disagree on it; an effect or unresolved rule would be lost when flattened.
  if (el.getAttribute('transform') || hasGroupEffect(el) || w.cssTainted.has(el)) return false
  const x = lengthAttr(el.getAttribute('x'), w.viewport.w)
  const y = lengthAttr(el.getAttribute('y'), w.viewport.h)
  const vw = lengthAttr(size?.width ?? el.getAttribute('width') ?? '100%', w.viewport.w)
  const vh = lengthAttr(size?.height ?? el.getAttribute('height') ?? '100%', w.viewport.h)
  if (x === null || y === null || vw === null || vh === null) return false
  if (vw <= 0 || vh <= 0) return true // renders nothing

  let m: Affine = [1, 0, 0, 1, x, y]
  const vb = parseViewBox(el.getAttribute('viewBox'))
  if (vb) {
    const fit = viewBoxFit(vb, vw, vh, el.getAttribute('preserveAspectRatio'))
    if (!fit) return false
    m = composeAffine(m, fit)
  }
  const inner = childContext(el, ctx)
  inner.transform = composeAffine(ctx.transform, m)

  const sub: WalkContext = {
    ...w,
    items: [],
    deferredDefs: [],
    consumedGradients: new Set(),
    consumedRefs: new Set(),
  }
  walkChildren(el, inner, sub)

  const overflow = presentationProp(el, 'overflow')?.toLowerCase()
  if (overflow !== 'visible' && overflow !== 'auto') {
    if (!insideClip(sub.items, { x, y, w: vw, h: vh }, ctx.transform, w.inert)) return false
  }
  w.deferredDefs.push(...sub.deferredDefs)
  for (const id of sub.consumedGradients) w.consumedGradients.add(id)
  for (const id of sub.consumedRefs) w.consumedRefs.add(id)
  // A viewport is a coordinate system, not a layer: an unnamed one (what an
  // engraver or a sprite wraps everything in) would only put every shape a
  // double-click away. A named one is the author's folder.
  if (sourceName(el)) pushContainer(el, sub.items, w)
  else w.items.push(...sub.items)
  return true
}

/**
 * Whether every leaf lies within a viewport's clip rect (in `parent` space), so
 * dropping the clip changes nothing. A raw leaf can't be measured, and a rotated
 * clip isn't a box, so either fails.
 */
function insideClip(
  items: readonly DocItem[],
  clip: { x: number; y: number; w: number; h: number },
  parent: Affine,
  inert: Set<string>,
): boolean {
  if (Math.abs(parent[1]) > EPS || Math.abs(parent[2]) > EPS) return false
  const a = applyAffine(parent, { x: clip.x, y: clip.y })
  const b = applyAffine(parent, { x: clip.x + clip.w, y: clip.y + clip.h })
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)
  // Sub-pixel slack for the control hull overshooting a curve that stays inside.
  const slack = 1e-3 * Math.max(maxX - minX, maxY - minY)
  for (const leaf of allLeaves(items)) {
    if (leaf.kind === 'raw') {
      if (inert.has(leaf.id)) continue
      return false
    }
    const bb = itemBounds(leaf)
    if (!bb) continue
    // Half the width each side; a miter tip or square cap can reach further, so a full width.
    const pad = leaf.stroke ? leaf.stroke.width : 0
    if (
      bb.x - pad < minX - slack ||
      bb.y - pad < minY - slack ||
      bb.x + bb.w + pad > maxX + slack ||
      bb.y + bb.h + pad > maxY + slack
    ) {
      return false
    }
  }
  return true
}

/**
 * `<use>` drawn as what it references: the target is walked as if it were a
 * child of a `<g>` carrying the use's transform, translate(x, y) and paint — which
 * is how SVG renders it — so a glyph or icon instanced from `<defs>` becomes an
 * editable path of its own. False leaves the `<use>` raw: an external or missing
 * reference, a cycle, an effect on the use, or a target kind this does not lift.
 */
function walkUse(el: Element, ctx: PaintContext, w: WalkContext): boolean {
  const href = el.getAttribute('href') ?? el.getAttribute('xlink:href')
  if (!href || !href.trim().startsWith('#')) return false
  const id = href.trim().slice(1)
  const target = w.byId.get(id)
  if (!target || w.useStack.has(target)) return false
  if (hasUnmodellableAttrs(el) || w.cssTaintAll || w.cssTainted.has(el)) return false
  const tag = target.tagName.toLowerCase()
  if (!SHAPE_TAGS.has(tag) && tag !== 'g' && tag !== 'use' && tag !== 'svg' && tag !== 'symbol') return false
  const x = lengthAttr(el.getAttribute('x'), w.viewport.w)
  const y = lengthAttr(el.getAttribute('y'), w.viewport.h)
  if (x === null || y === null) return false

  const useCtx = childContext(el, ctx)
  useCtx.transform = composeAffine(useCtx.transform, [1, 0, 0, 1, x, y])
  const start = w.items.length
  w.useStack.add(target)
  try {
    if (tag === 'svg' || tag === 'symbol') {
      const size = { width: el.getAttribute('width'), height: el.getAttribute('height') }
      if (!walkViewport(target, useCtx, size, w)) return false
    } else {
      walkElement(target, useCtx, w)
    }
  } finally {
    w.useStack.delete(target)
  }
  // The instance is named by the use when the use says something, else by what it
  // instances (which the walk already did). Several items from one use are one
  // layer when groups are kept.
  const useName = sourceName(el)
  const made = w.items.length - start
  if (useName && made === 1) w.items[start].name = useName
  else if (useName && made > 1 && w.preserveGroups) {
    const children = w.items.splice(start, made)
    w.items.push({ kind: 'group', id: w.nextId(), name: useName, children, visible: true, expanded: true })
  }
  // A target that only exists to be instanced is dead markup once every use of it
  // is lifted; the finalize pass drops it unless a raw item still points at it.
  if (inDefsOrSymbol(target)) w.consumedRefs.add(id)
  return true
}

function inDefsOrSymbol(el: Element): boolean {
  if (el.tagName.toLowerCase() === 'symbol') return true
  for (let p = el.parentNode as Element | null; p && p.tagName; p = p.parentNode as Element | null) {
    const t = p.tagName.toLowerCase()
    if (t === 'defs' || t === 'symbol') return true
  }
  return false
}

/** A user-unit length (`12`, `12px`) or a percentage of `ref`; null for other units. Absent ⇒ 0. */
function lengthAttr(v: string | null, ref: number): number | null {
  if (v === null || v.trim() === '') return 0
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|%)?\s*$/i.exec(v)
  if (!m) return null
  const n = parseFloat(m[1])
  return m[2] === '%' ? (n / 100) * ref : n
}

function parseViewBox(v: string | null): [number, number, number, number] | null {
  if (!v) return null
  const p = v
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  return p.length === 4 && p.every(Number.isFinite) && p[2] > 0 && p[3] > 0 ? [p[0], p[1], p[2], p[3]] : null
}

/** The viewBox → viewport mapping `preserveAspectRatio` asks for; null if unparseable. */
function viewBoxFit(vb: [number, number, number, number], w: number, h: number, par: string | null): Affine | null {
  const [vx, vy, vw, vh] = vb
  const parts = (par ?? 'xMidYMid meet').trim().split(/\s+/)
  const align = parts[0]
  const slice = parts[1] === 'slice'
  if (align === 'none') return [w / vw, 0, 0, h / vh, -vx * (w / vw), -vy * (h / vh)]
  const am = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.exec(align)
  if (!am) return null
  const k = slice ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh)
  const f = (a: string) => (a === 'Min' ? 0 : a === 'Mid' ? 0.5 : 1)
  const tx = (w - vw * k) * f(am[1]) - vx * k
  const ty = (h - vh * k) * f(am[2]) - vy * k
  return [k, 0, 0, k, tx, ty]
}

/**
 * A gradient (or a stop of one along its href chain) that a stylesheet rule could
 * not be resolved for: its stop colours may not be what the walk reads, so the
 * shape stays raw beside the paint server rather than being lifted with them.
 */
function gradientCssTainted(gradEl: Element, w: WalkContext): boolean {
  if (w.cssTainted.size === 0) return false
  return gradientChain(gradEl, w.gradients).some(
    (g) => w.cssTainted.has(g) || Array.from(g.children).some((c) => w.cssTainted.has(c)),
  )
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
 * Remove the elements with the given ids from a defs / paint-server / symbol
 * element and reserialize. Returns null when nothing is left (the caller drops
 * the item).
 */
function stripIds(el: Element, remove: Set<string>): string | null {
  if (el.tagName.toLowerCase() !== 'defs') {
    const id = el.getAttribute('id')
    return id && remove.has(id) ? null : serializeElement(el)
  }
  const clone = el.cloneNode(true) as Element
  for (const g of Array.from(clone.querySelectorAll('*'))) {
    const id = g.getAttribute('id')
    if (id && remove.has(id)) g.parentNode?.removeChild(g)
  }
  return clone.children.length === 0 ? null : serializeElement(clone)
}

/** Compose an element's transform + presentation props onto its parent context. */
function childContext(el: Element, ctx: PaintContext): PaintContext {
  const t = el.getAttribute('transform')
  // `inherit` is the parent's value, which is what an absent property gives too.
  const prop = (name: string) => {
    const v = presentationProp(el, name)
    return v !== null && v.toLowerCase() === 'inherit' ? null : v
  }
  const opacity = parseOpacity(prop('opacity'))
  let rawProps = ctx.rawProps
  for (const name of RAW_PROPS) {
    const v = prop(name)
    if (v !== null) rawProps = { ...rawProps, [name]: v }
  }
  return {
    transform: t ? composeAffine(ctx.transform, parseTransformAttr(t)) : ctx.transform,
    fill: prop('fill') ?? ctx.fill,
    fillRule: prop('fill-rule') ?? ctx.fillRule,
    fillOpacity: parseOpacity(prop('fill-opacity')) ?? ctx.fillOpacity,
    stroke: prop('stroke') ?? ctx.stroke,
    strokeWidth: prop('stroke-width') ?? ctx.strokeWidth,
    strokeCap: prop('stroke-linecap') ?? ctx.strokeCap,
    strokeJoin: prop('stroke-linejoin') ?? ctx.strokeJoin,
    strokeDash: prop('stroke-dasharray') ?? ctx.strokeDash,
    strokeMiter: prop('stroke-miterlimit') ?? ctx.strokeMiter,
    strokeOpacity: parseOpacity(prop('stroke-opacity')) ?? ctx.strokeOpacity,
    opacity: opacity !== null ? ctx.opacity * opacity : ctx.opacity,
    color: prop('color') ?? ctx.color,
    visibility: prop('visibility') ?? ctx.visibility,
    rawProps,
  }
}

/**
 * A solid paint as the model stores it: `#rrggbb` (a hex the source already
 * wrote as `#rgb`/`#rrggbb` is kept verbatim) with any alpha of its own split out,
 * `'none'` for `none` and fully transparent colours, or null for paint this
 * can't reduce (`var()`, garbage) — the shape then stays raw. `currentColor`
 * resolves through the inherited `color`, black when there is none.
 */
function resolvePaint(paint: string, color: string | null): { hex: string; alpha: number } | 'none' | null {
  const p = paint.trim()
  const lower = p.toLowerCase()
  if (lower === 'none') return 'none'
  if (/^#(?:[0-9a-f]{3}){1,2}$/i.test(p)) return { hex: p, alpha: 1 }
  if (lower === 'currentcolor') {
    if (color === null || color.trim().toLowerCase() === 'currentcolor') return { hex: '#000000', alpha: 1 }
    return resolvePaint(color, null)
  }
  const c = parseCssColor(p)
  if (!c) return null
  return c.a <= 0 ? 'none' : { hex: rgbaToHex(c), alpha: c.a }
}

/**
 * The stroke a context paints, as an editable Stroke — or null when there is
 * none, or when it is a paint server this model can't express (a gradient or
 * pattern stroke, which has to stay raw to survive export).
 */
function resolveStroke(ctx: PaintContext): Stroke | null {
  if (ctx.stroke === null) return null
  const paint = resolvePaint(ctx.stroke, ctx.color)
  if (paint === null || paint === 'none') return null

  // SVG's own default is 1 when the attribute is absent.
  const width = ctx.strokeWidth === null ? 1 : parseFloat(ctx.strokeWidth)
  if (!Number.isFinite(width) || width <= 0) return null
  // A percentage width resolves against the viewport diagonal, which we don't
  // track here — leave those raw rather than guess.
  if (ctx.strokeWidth !== null && /%\s*$/.test(ctx.strokeWidth)) return null

  const cap = ctx.strokeCap?.trim().toLowerCase()
  const join = ctx.strokeJoin?.trim().toLowerCase()
  const stroke: Stroke = {
    color: paint.hex,
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

  if (ctx.strokeMiter !== null) {
    // A ratio, so it is not scaled with the width. Under 1 is an error in SVG;
    // keep such a shape raw rather than guess what a renderer does with it.
    const limit = parseFloat(ctx.strokeMiter)
    if (!Number.isFinite(limit) || limit < 1) return null
    if (stroke.join === 'miter' && limit !== 4) stroke.miterLimit = limit
  }

  // Element opacity multiplies the stroke as well as the fill (and so does the
  // colour's own alpha, `rgba()` / `#rrggbbaa`).
  const alpha = (ctx.strokeOpacity ?? 1) * ctx.opacity * paint.alpha
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
function hasUnmodellableAttrs(el: Element, names: readonly string[] = UNMODELLABLE_ATTRS): boolean {
  for (const name of names) {
    const v = el.getAttribute(name)
    if (v !== null && v.trim() !== '' && v.trim().toLowerCase() !== 'none') return true
    // The same properties can arrive through `style`.
    const style = el.getAttribute('style')
    if (style && new RegExp(`(?:^|;)\\s*${name}\\s*:`, 'i').test(style)) return true
  }
  return false
}

/** A group-wide effect (mask, clip, filter) that flattening would lose. */
function hasGroupEffect(el: Element): boolean {
  return hasUnmodellableAttrs(el, GROUP_EFFECT_ATTRS)
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
  if (resolvePaint(ctx.stroke, ctx.color) === 'none') return false
  return resolveStroke(ctx) === null
}

/** A solid fill the model can't hold (`var()`, garbage) ⇒ the shape stays raw. */
function hasUnresolvableFill(ctx: PaintContext): boolean {
  if (ctx.fill === null || ctx.fill.trim().toLowerCase().startsWith('url(')) return false
  return resolvePaint(ctx.fill, ctx.color) === null
}

function makePathItem(id: string, subPaths: SubPath[], ctx: PaintContext): PathItem {
  // `fill` is the SVG keyword when the shape is stroke-only, so a line drawn
  // as pure outline round-trips as one instead of gaining a black interior.
  // Every other paint is reduced to hex here: the renderers read nothing else.
  const paint = ctx.fill === null ? { hex: '#000000', alpha: 1 } : (resolvePaint(ctx.fill, ctx.color) ?? 'none')
  const filled = paint !== 'none'
  const fillOpacity = (ctx.fillOpacity ?? 1) * ctx.opacity * (filled ? paint.alpha : 1)
  const item: PathItem = {
    kind: 'path',
    id,
    fill: filled ? paint.hex : 'none',
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
  // The rest of what a flattened <g> handed down: a raw stroke keeps its width and
  // ends, a raw <text> its font, a hidden layer's leaf stays hidden.
  if (ctx.strokeWidth !== null) inherited['stroke-width'] = ctx.strokeWidth
  if (ctx.strokeCap !== null) inherited['stroke-linecap'] = ctx.strokeCap
  if (ctx.strokeJoin !== null) inherited['stroke-linejoin'] = ctx.strokeJoin
  if (ctx.strokeDash !== null) inherited['stroke-dasharray'] = ctx.strokeDash
  if (ctx.strokeMiter !== null) inherited['stroke-miterlimit'] = ctx.strokeMiter
  if (ctx.strokeOpacity !== null) inherited['stroke-opacity'] = String(ctx.strokeOpacity)
  if (ctx.color !== null) inherited['color'] = ctx.color
  if (ctx.visibility !== null) inherited['visibility'] = ctx.visibility
  for (const name of Object.keys(ctx.rawProps)) inherited[name] = ctx.rawProps[name]
  if (ctx.opacity < 1) inherited['opacity'] = String(Number(ctx.opacity.toFixed(4)))
  if (Object.keys(inherited).length > 0) item.inherited = inherited
  return item
}

/** Markup with the `id` attribute of its outermost element removed. */
function withoutRootId(markup: string): string {
  return withRootAttr(markup, 'id', null)
}

/**
 * Markup with one attribute of its outermost element set (or removed, for
 * null). String-level, so it works where there is no DOM (the npm package).
 */
export function withRootAttr(markup: string, name: string, value: string | null): string {
  // `name` is a plain attribute name (letters, `-`, `:`), so it needs no escaping.
  const stripped = markup.replace(
    new RegExp(
      `^(\\s*<[^\\s>/]+)((?:\\s+[^\\s=>]+\\s*=\\s*(?:"[^"]*"|'[^']*'))*?)\\s+${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`,
    ),
    '$1$2',
  )
  if (value === null) return stripped
  return stripped.replace(/^(\s*<[^\s>/]+)/, `$1 ${name}="${escapeAttr(value)}"`)
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
  const parts = (el.getAttribute('points') ?? '')
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
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
export interface SerializeOptions {
  /**
   * Write a group some other way — the editor's live text, exported as
   * `<text>` instead of its outlines. Return null to serialize it as usual.
   * Kept as a hook so this module (which ships in the npm package) does not
   * depend on the text engine.
   */
  group?: (group: GroupItem, fmt: (v: number) => string) => { markup: string; defs?: string[] } | null
}

export function serializeDoc(doc: EditableDoc, precision = 2, opts: SerializeOptions = {}): string {
  const fmt = (v: number) => String(Number(v.toFixed(precision)))
  const [x, y, w, h] = doc.viewBox
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)}">`

  // Gradient paint servers for visible paths. A gradient object shared by
  // several paths (merged bands) is emitted once and referenced by each.
  const gradIds = new Map<GradientFill, string>()
  let defs = ''
  for (const item of leafItems(doc.items)) {
    if (item.kind === 'path' && item.gradient && !gradIds.has(item.gradient)) {
      const id = gradientId(item.id)
      gradIds.set(item.gradient, id)
      defs += gradientToSvgDef(item.gradient, id, precision)
    }
  }
  const extraDefs: string[] = []
  const body = serializeItems(doc.items, gradIds, precision, fmt, opts, extraDefs)
  defs += [...new Set(extraDefs)].join('')
  if (defs) out += `<defs>${defs}</defs>`
  out += body
  return out + '</svg>'
}

/** Body markup for one level of the item tree; recurses through groups. */
function serializeItems(
  items: readonly DocItem[],
  gradIds: Map<GradientFill, string>,
  precision: number,
  fmt: (v: number) => string,
  opts: SerializeOptions = {},
  extraDefs: string[] = [],
): string {
  let out = ''
  for (const item of items) {
    if (!item.visible) continue
    if (item.kind === 'group') {
      const custom = opts.group?.(item, fmt)
      if (custom) {
        out += custom.markup
        if (custom.defs) extraDefs.push(...custom.defs)
        continue
      }
      // An empty (or fully hidden) group is not emitted.
      const inner = serializeItems(item.children, gradIds, precision, fmt, opts, extraDefs)
      if (!inner) continue
      out += '<g'
      if (item.name) out += ` data-name="${escapeAttr(item.name)}"`
      if (item.opacity !== undefined && item.opacity < 1) {
        out += ` opacity="${Number(item.opacity.toFixed(4))}"`
      }
      if (item.clip && item.clip.length > 0) {
        // userSpaceOnUse (the default): the clip is absolute, like every coordinate here.
        const id = clipId(item.id)
        extraDefs.push(
          `<clipPath id="${id}">${item.clip
            .map(
              (c) =>
                `<path${c.rule === 'evenodd' ? ' clip-rule="evenodd"' : ''} d="${subPathsToD(c.subPaths, precision)}"/>`,
            )
            .join('')}</clipPath>`,
        )
        out += ` clip-path="url(#${id})"`
      }
      out += `>${inner}</g>`
    } else if (item.kind === 'path') {
      const fill = item.gradient ? `url(#${gradIds.get(item.gradient)})` : escapeAttr(item.fill)
      out += '<path'
      // Only a name someone gave it: the layers list's "Path 12" is never stored.
      if (item.name) out += ` data-name="${escapeAttr(item.name)}"`
      out += ` fill="${fill}"`
      if (item.fillOpacity !== undefined && item.fillOpacity < 1) {
        out += ` fill-opacity="${Number(item.fillOpacity.toFixed(4))}"`
      }
      if (item.fillRule === 'evenodd') out += ' fill-rule="evenodd"'
      const s = item.stroke
      if (s && s.width > 0) {
        out += ` stroke="${escapeAttr(s.color)}" stroke-width="${fmt(s.width)}"`
        if (s.cap !== 'butt') out += ` stroke-linecap="${s.cap}"`
        if (s.join !== 'miter') out += ` stroke-linejoin="${s.join}"`
        else if (s.miterLimit !== undefined && s.miterLimit !== 4) out += ` stroke-miterlimit="${fmt(s.miterLimit)}"`
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
 * True when the path paints only its outline (`fill="none"` with a stroke).
 * Its visible colour is the stroke, so UI showing a path's colour should ask
 * here rather than read `fill` and get "none".
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
  const colors = new Set<string>()
  for (const item of leafItems(doc.items)) {
    if (item.kind !== 'path') continue
    paths++
    for (const sp of item.subPaths) nodes += sp.nodes.length
    // A stroke-only path contributes no fill colour, but its stroke is a colour the
    // picture is painted in (a colour centreline trace is mostly strokes).
    const f = item.fill.trim().toLowerCase()
    if (f !== 'none') colors.add(f)
    if (item.stroke) colors.add(item.stroke.color.trim().toLowerCase())
  }
  return { paths, nodes, colors: colors.size }
}
