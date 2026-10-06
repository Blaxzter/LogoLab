// SVG gradient import, the counterpart to `gradientToSvgDef`: resolves a
// shape's `url(#id)` fill into the editable GradientFill model.
//
// `gradientUnits`, `gradientTransform` and the shape's ancestor transform are
// folded into one affine. A radial survives only when that affine is a
// similarity; otherwise it would be an ellipse the single-radius model cannot
// store, so we return null and the shape stays raw markup. The same goes for a
// `reflect`/`repeat` spread, which the model (always `pad`) cannot hold.

import type { Affine, GradientFill, GradientStop, RadialGradient, Vec } from './types'
import { applyAffine, composeAffine, parseTransformAttr } from './geometry.ts'
import { normalizeHex } from '../colorUtils.ts'
import { parseCssColor, rgbaToHex } from './cssColor.ts'

const EPS = 1e-6
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]
const XLINK_NS = 'http://www.w3.org/1999/xlink'

/** Index every gradient paint server in the document by its id. */
export function collectGradientElements(dom: Document): Map<string, Element> {
  const map = new Map<string, Element>()
  for (const el of Array.from(dom.querySelectorAll('linearGradient, radialGradient'))) {
    const id = el.getAttribute('id')
    if (id && !map.has(id)) map.set(id, el)
  }
  return map
}

/** Extract the gradient id from a `url(#id)` paint, else null. */
export function gradientRefId(paint: string | null): string | null {
  if (!paint) return null
  const m = /^url\(\s*['"]?#([^)'"]+)['"]?\s*\)$/i.exec(paint.trim())
  return m ? m[1] : null
}

/** Local `href`/`xlink:href` target id of a gradient (for stop/attr inheritance). */
function hrefTarget(el: Element): string | null {
  const h = el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? el.getAttributeNS(XLINK_NS, 'href')
  return h && h.startsWith('#') ? h.slice(1) : null
}

/** The gradient followed by every gradient its href chain reaches. */
export function gradientChain(el: Element, map: Map<string, Element>): Element[] {
  const out: Element[] = []
  const seen = new Set<string>()
  let cur: Element | null = el
  while (cur) {
    out.push(cur)
    const next = hrefTarget(cur)
    if (!next || seen.has(next)) break
    seen.add(next)
    cur = map.get(next) ?? null
  }
  return out
}

/** Resolve an attribute through the gradient's href chain (first defined wins). */
function inheritedAttr(el: Element, map: Map<string, Element>, name: string): string | null {
  let cur: Element | null = el
  const seen = new Set<string>()
  while (cur) {
    const v = cur.getAttribute(name)
    if (v !== null && v.trim() !== '') return v.trim()
    const next = hrefTarget(cur)
    if (!next || seen.has(next)) break
    seen.add(next)
    cur = map.get(next) ?? null
  }
  return null
}

/** Resolve stops from the first gradient in the href chain that defines any. */
function inheritedStops(el: Element, map: Map<string, Element>): GradientStop[] {
  let cur: Element | null = el
  const seen = new Set<string>()
  while (cur) {
    const stops = parseStops(cur)
    if (stops.length) return stops
    const next = hrefTarget(cur)
    if (!next || seen.has(next)) break
    seen.add(next)
    cur = map.get(next) ?? null
  }
  return []
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function parseStops(el: Element): GradientStop[] {
  const out: GradientStop[] = []
  for (const s of Array.from(el.children)) {
    if (s.tagName.toLowerCase() !== 'stop') continue
    const offset = parseStopOffset(s.getAttribute('offset'))
    const { color, opacity } = stopPaint(s)
    const stop: GradientStop = { offset, color }
    if (opacity !== null && opacity < 1) stop.opacity = opacity
    out.push(stop)
  }
  // An offset below an earlier one is raised to it (SVG's rule), in document order —
  // sorting would reorder the colours of out-of-order input instead.
  for (let i = 1; i < out.length; i++) out[i].offset = Math.max(out[i].offset, out[i - 1].offset)
  return out
}

function parseStopOffset(v: string | null): number {
  if (!v) return 0
  const t = v.trim()
  const n = parseFloat(t)
  if (!Number.isFinite(n)) return 0
  return clamp01(t.endsWith('%') ? n / 100 : n)
}

function stopPaint(el: Element): { color: string; opacity: number | null } {
  let color: string | null = null
  let opacity: number | null = null
  const style = el.getAttribute('style')
  if (style) {
    const cm = /(?:^|;)\s*stop-color\s*:\s*([^;]+)/i.exec(style)
    if (cm) color = cm[1].trim()
    const om = /(?:^|;)\s*stop-opacity\s*:\s*([^;]+)/i.exec(style)
    if (om) opacity = clamp01(parseFloat(om[1]))
  }
  if (!color) {
    const a = el.getAttribute('stop-color')
    if (a) color = a.trim()
  }
  if (opacity === null) {
    const a = el.getAttribute('stop-opacity')
    if (a !== null && a.trim() !== '') opacity = clamp01(parseFloat(a))
  }
  // SVG default stop-color is black. A colour's own alpha (`rgba()`, `#rrggbbaa`,
  // `transparent`) multiplies the stop-opacity.
  if (!color) return { color: '#000000', opacity }
  const c = parseCssColor(color)
  if (!c) return { color, opacity }
  return { color: rgbaToHex(c), opacity: c.a < 1 ? (opacity ?? 1) * c.a : opacity }
}

/** A solid swatch / fallback fill for a gradient: the stop nearest the middle. */
export function representativeStopColor(stops: GradientStop[]): string {
  let best = '#000000'
  let bestD = Infinity
  for (const s of stops) {
    const d = Math.abs(s.offset - 0.5)
    if (d < bestD) {
      bestD = d
      best = s.color
    }
  }
  return normalizeHex(best) ?? '#000000'
}

/**
 * Resolve a gradient element to an absolute-coordinate GradientFill, or null
 * when it can't be modeled (too few stops, degenerate, or a radial that the
 * effective transform would turn into a rotated ellipse). `bounds` is the
 * shape's tight bbox in local coords (only needed for objectBoundingBox);
 * `ancestorTransform` is the same affine baked into the path nodes. `viewport`
 * (the root viewBox size) is what a userSpaceOnUse percentage — or a missing
 * coordinate, whose default is a percentage — resolves against; without it such a
 * gradient stays raw.
 */
export function resolveGradientFill(
  el: Element,
  map: Map<string, Element>,
  bounds: { x: number; y: number; w: number; h: number } | null,
  ancestorTransform: Affine,
  viewport: { w: number; h: number } | null = null,
): GradientFill | null {
  const stops = inheritedStops(el, map)
  if (stops.length < 2) return null
  const spread = inheritedAttr(el, map, 'spreadMethod')
  if (spread === 'reflect' || spread === 'repeat') return null

  const units = inheritedAttr(el, map, 'gradientUnits') === 'userSpaceOnUse' ? 'user' : 'bbox'
  if (units === 'bbox' && (!bounds || bounds.w < EPS || bounds.h < EPS)) return null

  const gtAttr = inheritedAttr(el, map, 'gradientTransform')
  let m: Affine = gtAttr ? parseTransformAttr(gtAttr) : IDENTITY
  if (units === 'bbox' && bounds) {
    // objectBoundingBox: gradient unit square maps onto the shape's bbox.
    m = composeAffine([bounds.w, 0, 0, bounds.h, bounds.x, bounds.y], m)
  }
  m = composeAffine(ancestorTransform, m)

  // A coordinate as a fraction of its axis: bbox units read it as is, user units
  // scale it by the viewport's width ('x'), height ('y') or normalized diagonal
  // ('r'). `fallback` is the spec default, itself a fraction. NaN = unresolvable.
  const axis = (a: 'x' | 'y' | 'r'): number => {
    if (units === 'bbox') return 1
    if (!viewport) return NaN
    return a === 'x' ? viewport.w : a === 'y' ? viewport.h : Math.sqrt((viewport.w ** 2 + viewport.h ** 2) / 2)
  }
  const num = (name: string, fallback: number, a: 'x' | 'y' | 'r'): number => {
    const raw = inheritedAttr(el, map, name)
    const n = raw === null ? NaN : parseFloat(raw)
    if (!Number.isFinite(n)) return fallback * axis(a)
    if (!raw!.endsWith('%')) return n
    return (n / 100) * axis(a)
  }

  if (el.tagName.toLowerCase() === 'radialgradient') {
    const cx = num('cx', 0.5, 'x')
    const cy = num('cy', 0.5, 'y')
    const r = num('r', 0.5, 'r')
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r) || r < EPS) return null
    const fxRaw = inheritedAttr(el, map, 'fx')
    const fyRaw = inheritedAttr(el, map, 'fy')
    // An absent (or unparseable) focus defaults to the centre.
    const fx = fxRaw === null || !Number.isFinite(parseFloat(fxRaw)) ? cx : num('fx', 0, 'x')
    const fy = fyRaw === null || !Number.isFinite(parseFloat(fyRaw)) ? cy : num('fy', 0, 'y')
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null
    // A radial only stays a circle under a similarity (orthogonal, equal-length
    // columns). Otherwise it's a rotated/sheared ellipse → not modelable.
    const [a, b, c, d] = m
    const len1 = Math.hypot(a, b)
    const len2 = Math.hypot(c, d)
    const scaleRef = Math.max(len1, len2, 1)
    if (Math.abs(len1 - len2) > 1e-3 * scaleRef || Math.abs(a * c + b * d) > 1e-3 * scaleRef * scaleRef) {
      return null
    }
    const center = applyAffine(m, { x: cx, y: cy })
    const focal = applyAffine(m, { x: fx, y: fy })
    const grad: RadialGradient = { type: 'radial', cx: center.x, cy: center.y, r: r * ((len1 + len2) / 2), stops }
    if (Math.abs(focal.x - center.x) > EPS || Math.abs(focal.y - center.y) > EPS) {
      grad.fx = focal.x
      grad.fy = focal.y
    }
    return grad
  }

  const x1 = num('x1', 0, 'x')
  const y1 = num('y1', 0, 'y')
  const x2 = num('x2', 1, 'x')
  const y2 = num('y2', 0, 'y')
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null
  const p1 = applyAffine(m, { x: x1, y: y1 })
  const p2 = applyAffine(m, { x: x2, y: y2 })
  if (dist(p1, p2) < EPS) return null
  return { type: 'linear', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stops }
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}
