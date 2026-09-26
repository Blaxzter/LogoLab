// Post-processing for traced/uploaded SVG: round coordinates, strip pixel
// dimensions (keeping viewBox), force a single fill, drop a background plate,
// and tidy the markup. Best-effort, dependency-free (DOMParser/XMLSerializer).

export interface CleanOptions {
  /** Decimal places to round coordinate numbers to. */
  precision: number
  /** Remove width/height attributes (keep viewBox) for responsive SVG. */
  stripDimensions: boolean
  /** When set, override every shape's fill with this color. */
  forceFill: string | null
  /** Drop the dominant background plate to produce a transparent SVG. */
  removeBackground: boolean
}

export interface CleanResult {
  svg: string
  beforeBytes: number
  afterBytes: number
  paths: number
  colors: number
}

export const DEFAULT_CLEAN_OPTIONS: CleanOptions = {
  precision: 2,
  stripDimensions: true,
  forceFill: null,
  removeBackground: false,
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** UTF-8 byte length of a string. */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

/** Tags whose geometry numbers (in d/points/coords) we round. */
const SHAPE_TAGS = ['path', 'polygon', 'polyline', 'rect', 'circle', 'ellipse', 'line']
const COORD_ATTRS = [
  'd',
  'points',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
]

const FLOAT_RE = /-?\d*\.\d+(?:e[-+]?\d+)?/gi

/** Round every floating-point token in a coordinate string to `precision`. */
function roundNumbers(value: string, precision: number): string {
  return value.replace(FLOAT_RE, (m) => {
    const n = Number(m)
    if (!Number.isFinite(n)) return m
    // Number() drops trailing zeros (e.g. 7.30 → "7.3"), so result stays compact.
    return String(Number(n.toFixed(precision)))
  })
}

/** Resolve the effective fill of an element (attribute or inline style). */
function getFill(el: Element): string | null {
  const attr = el.getAttribute('fill')
  if (attr) return attr.trim().toLowerCase()
  const style = el.getAttribute('style')
  if (style) {
    const m = /(?:^|;)\s*fill\s*:\s*([^;]+)/i.exec(style)
    if (m) return m[1].trim().toLowerCase()
  }
  return null
}

/** Parse "0 0 W H" viewBox into numbers. */
function parseViewBox(svg: Element): [number, number, number, number] | null {
  const vb = svg.getAttribute('viewBox')
  if (!vb) return null
  const p = vb.split(/[\s,]+/).map(Number)
  if (p.length === 4 && p.every((n) => Number.isFinite(n))) {
    return [p[0], p[1], p[2], p[3]]
  }
  return null
}

/** Remove all XML comment nodes within a root. */
function removeComments(root: Node): void {
  const doc = root.ownerDocument
  if (!doc) return
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT)
  const toRemove: Node[] = []
  let n = walker.nextNode()
  while (n) {
    toRemove.push(n)
    n = walker.nextNode()
  }
  toRemove.forEach((c) => c.parentNode?.removeChild(c))
}

/** Recursively drop <g> elements that contain no element children. */
function removeEmptyGroups(el: Element): void {
  const groups = Array.from(el.querySelectorAll('g'))
  // Process deepest-first so emptied parents are caught too.
  groups.reverse().forEach((g) => {
    if (g.children.length === 0) g.parentNode?.removeChild(g)
  })
}

/**
 * Best-effort background removal: find a shape that fills the whole canvas and
 * carries the most common fill, then remove it.
 */
function removeBackgroundPlate(svg: Element, vb: [number, number, number, number] | null): void {
  const shapes = SHAPE_TAGS.flatMap((t) => Array.from(svg.getElementsByTagName(t)))
  if (shapes.length === 0) return

  // Tally fills to find the dominant one.
  const fillCounts = new Map<string, number>()
  for (const s of shapes) {
    const f = getFill(s) ?? 'none'
    fillCounts.set(f, (fillCounts.get(f) ?? 0) + 1)
  }
  let dominantFill = ''
  let dominantCount = -1
  for (const [f, c] of fillCounts) {
    if (f !== 'none' && c > dominantCount) {
      dominantFill = f
      dominantCount = c
    }
  }

  const area = vb ? vb[2] * vb[3] : 0

  // 1) A literal full-canvas <rect>.
  if (vb) {
    for (const s of shapes) {
      if (s.tagName.toLowerCase() !== 'rect') continue
      const w = parseFloat(s.getAttribute('width') || '0')
      const h = parseFloat(s.getAttribute('height') || '0')
      if (w >= vb[2] * 0.98 && h >= vb[3] * 0.98) {
        s.parentNode?.removeChild(s)
        return
      }
    }
  }

  // 2) The first path/polygon spanning (≥90% of) the viewBox that has the
  //    dominant fill — typically the traced background layer.
  if (vb && dominantFill) {
    let best: Element | null = null
    let bestSpan = 0
    for (const s of shapes) {
      if ((getFill(s) ?? 'none') !== dominantFill) continue
      const span = shapeSpan(s, area)
      if (span > bestSpan) {
        bestSpan = span
        best = s
      }
    }
    if (best && bestSpan >= 0.9) {
      best.parentNode?.removeChild(best)
      return
    }
  }

  // 3) Fallback: if no viewBox, just drop the single most common fill's
  //    largest path so transparent output is still attempted.
  if (!vb && dominantFill) {
    const candidate = shapes.find((s) => (getFill(s) ?? 'none') === dominantFill)
    candidate?.parentNode?.removeChild(candidate)
  }
}

/** Approximate fraction of `area` covered by a shape's bounding extent. */
function shapeSpan(el: Element, area: number): number {
  if (area <= 0) return 0
  const tag = el.tagName.toLowerCase()
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  const consider = (x: number, y: number) => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  if (tag === 'path') {
    const d = el.getAttribute('d') || ''
    const nums = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? []
    for (let i = 0; i + 1 < nums.length; i += 2) consider(nums[i], nums[i + 1])
  } else if (tag === 'polygon' || tag === 'polyline') {
    const pts = (el.getAttribute('points') || '').split(/[\s,]+/).map(Number).filter(Number.isFinite)
    for (let i = 0; i + 1 < pts.length; i += 2) consider(pts[i], pts[i + 1])
  } else if (tag === 'rect') {
    const x = parseFloat(el.getAttribute('x') || '0')
    const y = parseFloat(el.getAttribute('y') || '0')
    const w = parseFloat(el.getAttribute('width') || '0')
    const h = parseFloat(el.getAttribute('height') || '0')
    consider(x, y)
    consider(x + w, y + h)
  } else {
    return 0
  }

  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return 0
  return ((maxX - minX) * (maxY - minY)) / area
}

export function cleanSvg(svg: string, opts: CleanOptions): CleanResult {
  const beforeBytes = byteLength(svg)
  const precision = Math.max(0, Math.min(6, Math.round(opts.precision)))

  let doc: Document
  try {
    doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  } catch {
    return { svg, beforeBytes, afterBytes: beforeBytes, paths: 0, colors: 0 }
  }

  const root = doc.documentElement
  // Parse error or non-SVG root → return input unchanged.
  if (!root || root.nodeName.toLowerCase() === 'parsererror' || root.nodeName.toLowerCase() !== 'svg') {
    return { svg, beforeBytes, afterBytes: beforeBytes, paths: 0, colors: 0 }
  }

  // Ensure a viewBox exists (derive from width/height if needed) before we
  // potentially strip the pixel dimensions.
  let vb = parseViewBox(root)
  if (!vb) {
    const w = parseFloat(root.getAttribute('width') || '')
    const h = parseFloat(root.getAttribute('height') || '')
    if (w > 0 && h > 0) {
      root.setAttribute('viewBox', `0 0 ${w} ${h}`)
      vb = [0, 0, w, h]
    }
  }

  // Remove background plate before counting / stripping for accurate stats.
  if (opts.removeBackground) {
    removeBackgroundPlate(root, vb)
  }

  if (opts.stripDimensions) {
    root.removeAttribute('width')
    root.removeAttribute('height')
  }

  // Round coordinate numbers on every shape.
  for (const tag of SHAPE_TAGS) {
    const els = Array.from(root.getElementsByTagName(tag))
    for (const el of els) {
      for (const attr of COORD_ATTRS) {
        const v = el.getAttribute(attr)
        if (v && FLOAT_RE.test(v)) {
          FLOAT_RE.lastIndex = 0
          el.setAttribute(attr, roundNumbers(v, precision))
        }
        FLOAT_RE.lastIndex = 0
      }
    }
  }

  // Force a single fill if requested.
  if (opts.forceFill) {
    for (const tag of SHAPE_TAGS) {
      const els = Array.from(root.getElementsByTagName(tag))
      for (const el of els) {
        el.setAttribute('fill', opts.forceFill)
        // Drop any conflicting inline fill in style.
        const style = el.getAttribute('style')
        if (style && /fill\s*:/i.test(style)) {
          const next = style.replace(/(?:^|;)\s*fill\s*:[^;]*/gi, '').replace(/^;+/, '').trim()
          if (next) el.setAttribute('style', next)
          else el.removeAttribute('style')
        }
      }
    }
  }

  // Tidy.
  removeComments(root)
  removeEmptyGroups(root)
  // Strip the tool's verbose desc attribute if present.
  root.removeAttribute('desc')
  if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', SVG_NS)

  // Count paths (all shapes) and distinct fills.
  const allShapes = SHAPE_TAGS.flatMap((t) => Array.from(root.getElementsByTagName(t)))
  const paths = allShapes.length
  const fills = new Set<string>()
  for (const s of allShapes) {
    const f = getFill(s)
    if (f && f !== 'none') fills.add(f)
  }
  const colors = opts.forceFill ? Math.min(fills.size || 1, 1) : fills.size

  // Serialize and collapse redundant whitespace between tags.
  let out = new XMLSerializer().serializeToString(root)
  out = out
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim()

  return {
    svg: out,
    beforeBytes,
    afterBytes: byteLength(out),
    paths,
    colors,
  }
}
