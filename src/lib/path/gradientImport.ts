// SVG gradient paint-server import — the read-side counterpart to
// trace/gradient.ts `gradientToSvgDef`. Reads <linearGradient>/<radialGradient>
// defs and resolves a shape's `url(#id)` fill into the editable GradientFill
// model, so gradient output round-trips back into node-editable paths.
//
// Coordinate handling: gradient coords live in either `userSpaceOnUse` (already
// in user units) or `objectBoundingBox` (fractions of the filled shape's tight
// bbox). `gradientTransform` and the shape's baked-in ancestor transform are
// folded into one affine. Linear endpoints transform exactly; a radial only
// survives when that affine keeps its circle a circle (a similarity) — under a
// non-uniform/shearing map it would become a rotated ellipse the single-radius
// model can't store, so we bail (the shape stays raw markup — lossless).

import type { Affine, GradientFill, GradientStop, RadialGradient, Vec } from './types'
import { applyAffine, composeAffine, parseTransformAttr } from './geometry.ts'
import { normalizeHex, rgbToHex } from '../colorUtils.ts'

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

/** CSS color → #rrggbb. Returns null for forms we can't reduce (named colors). */
function cssColorToHex(c: string): string | null {
  const t = c.trim()
  if (t.startsWith('#')) return normalizeHex(t)
  const m = /^rgba?\(([^)]+)\)/i.exec(t)
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean)
    if (parts.length >= 3) {
      const ch = (s: string) => {
        const v = s.endsWith('%') ? Math.round(parseFloat(s) * 2.55) : parseInt(s, 10)
        return Math.max(0, Math.min(255, Number.isFinite(v) ? v : 0))
      }
      return rgbToHex({ r: ch(parts[0]), g: ch(parts[1]), b: ch(parts[2]) })
    }
  }
  return null
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
  // SVG requires non-decreasing offsets; sort defensively for hand-made input.
  out.sort((a, b) => a.offset - b.offset)
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
  // SVG default stop-color is black.
  const resolved = color ? (cssColorToHex(color) ?? color) : '#000000'
  return { color: resolved, opacity }
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
 * `ancestorTransform` is the same affine baked into the path nodes.
 */
export function resolveGradientFill(
  el: Element,
  map: Map<string, Element>,
  bounds: { x: number; y: number; w: number; h: number } | null,
  ancestorTransform: Affine,
): GradientFill | null {
  const stops = inheritedStops(el, map)
  if (stops.length < 2) return null

  const units = inheritedAttr(el, map, 'gradientUnits') === 'userSpaceOnUse' ? 'user' : 'bbox'
  if (units === 'bbox' && (!bounds || bounds.w < EPS || bounds.h < EPS)) return null

  const gtAttr = inheritedAttr(el, map, 'gradientTransform')
  let m: Affine = gtAttr ? parseTransformAttr(gtAttr) : IDENTITY
  if (units === 'bbox' && bounds) {
    // objectBoundingBox: gradient unit square maps onto the shape's bbox.
    m = composeAffine([bounds.w, 0, 0, bounds.h, bounds.x, bounds.y], m)
  }
  m = composeAffine(ancestorTransform, m)

  const num = (name: string, fallback: number): number => {
    const raw = inheritedAttr(el, map, name)
    if (raw === null) return fallback
    const n = parseFloat(raw)
    if (!Number.isFinite(n)) return fallback
    return raw.endsWith('%') ? n / 100 : n
  }

  if (el.tagName.toLowerCase() === 'radialgradient') {
    const cx = num('cx', 0.5)
    const cy = num('cy', 0.5)
    const r = num('r', 0.5)
    if (r < EPS) return null
    const fx = num('fx', cx)
    const fy = num('fy', cy)
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

  const p1 = applyAffine(m, { x: num('x1', 0), y: num('y1', 0) })
  const p2 = applyAffine(m, { x: num('x2', 1), y: num('y2', 0) })
  if (dist(p1, p2) < EPS) return null
  return { type: 'linear', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stops }
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}
