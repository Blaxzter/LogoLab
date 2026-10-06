// The traced document as DXF (CAD, cutters, plotters), PDF and Adobe Illustrator
// `.ai`. Pure: an EditableDoc in, file text out — no DOM, so node can test it.
//
// `.ai` is written as a PDF, which is what every Illustrator since CS has saved
// by default ("Create PDF Compatible File"): Illustrator opens it as native
// paths, and so do Inkscape, Affinity and CorelDRAW. The old PostScript flavour
// would need Ghostscript to open anywhere but Illustrator.
//
// DXF is R12 (AC1009), the one every CAD and cutter reader accepts without the
// handle/class/object tables later versions demand. R12 has no fills, no curves
// and no true colour, so: every subpath is a polyline (curves flattened to a
// sub-pixel chord), and each colour gets its own LAYER, named by its exact hex,
// with the nearest ACI index as the layer colour.
//
// Both formats skip RawItems (markup the editor could not model — text, images)
// and hidden items, exactly as the SVG export leaves hidden ones out.

import type { DocItem, EditableDoc, GradientFill, PathItem, SubPath, Vec } from '../path/types'
import { parseCssColor } from '../path/cssColor.ts'

/** A visible path, with its group opacities folded in. */
interface Leaf {
  item: PathItem
  opacity: number
}

function visibleLeaves(items: readonly DocItem[], opacity = 1, out: Leaf[] = []): Leaf[] {
  for (const item of items) {
    if (!item.visible) continue
    if (item.kind === 'group') visibleLeaves(item.children, opacity * (item.opacity ?? 1), out)
    else if (item.kind === 'path') out.push({ item, opacity })
  }
  return out
}

/** How many visible items an export to DXF / AI leaves out (imported markup it can't read). */
export function unsupportedItemCount(doc: EditableDoc): number {
  let n = 0
  const walk = (items: readonly DocItem[]) => {
    for (const item of items) {
      if (!item.visible) continue
      if (item.kind === 'group') walk(item.children)
      else if (item.kind === 'raw') n++
    }
  }
  walk(doc.items)
  return n
}

const isNone = (paint: string) => {
  const p = paint.trim().toLowerCase()
  return p === 'none' || p === 'transparent'
}

function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim())
  if (!m) {
    // Paint the import did not reduce to hex (`red`, `rgb(…)`): read it, don't paint black.
    const c = parseCssColor(hex)
    return c ? [Math.round(c.r), Math.round(c.g), Math.round(c.b)] : [0, 0, 0]
  }
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

/** Each segment of a subpath as [from, c1, c2, to]; straight ones have c1 = from, c2 = to. */
function segments(sp: SubPath): [Vec, Vec, Vec, Vec][] {
  const { nodes } = sp
  const out: [Vec, Vec, Vec, Vec][] = []
  const n = sp.closed ? nodes.length : nodes.length - 1
  for (let i = 0; i < n; i++) {
    const a = nodes[i]
    const b = nodes[(i + 1) % nodes.length]
    out.push([a, a.hOut ?? a, b.hIn ?? b, b])
  }
  return out
}

const isLine = ([p0, c1, c2, p3]: [Vec, Vec, Vec, Vec]) =>
  c1.x === p0.x && c1.y === p0.y && c2.x === p3.x && c2.y === p3.y

/** The download formats a vector document offers, in menu order. */
export const VECTOR_FORMATS = [
  { id: 'svg', label: 'SVG', ext: 'svg', note: 'For the web, apps and every vector editor.' },
  {
    id: 'ai',
    label: 'Adobe Illustrator (.ai)',
    ext: 'ai',
    note: 'PDF-compatible. Opens in Illustrator, Inkscape and Affinity.',
  },
  { id: 'pdf', label: 'PDF', ext: 'pdf', note: 'Vector, for printing or sending to people. Same file as the .ai.' },
  { id: 'dxf', label: 'DXF', ext: 'dxf', note: 'Outlines for CAD, laser and vinyl cutters. One layer per colour.' },
] as const

export type VectorFormat = (typeof VECTOR_FORMATS)[number]['id']

// ---------------------------------------------------------------------------
// DXF
// ---------------------------------------------------------------------------

/** The ACI palette (AutoCAD Color Index 1–255) as RGB, for nearest-colour layer tints. */
const ACI: [number, number, number][] = (() => {
  const t: [number, number, number][] = [[0, 0, 0]]
  t.push([255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255], [255, 255, 255])
  t.push([128, 128, 128], [192, 192, 192])
  // 10–249: 24 hues × 5 shades × (full, half saturation).
  const values = [255, 204, 153, 127, 76]
  for (let h = 0; h < 24; h++) {
    for (let s = 0; s < 10; s++) {
      const v = values[s >> 1]
      const sat = s & 1 ? 0.5 : 1
      const hue = h * 15
      const k = (n: number) => (n + hue / 60) % 6
      const f = (n: number) => v - v * sat * Math.max(0, Math.min(k(n), 4 - k(n), 1))
      t.push([Math.round(f(5)), Math.round(f(3)), Math.round(f(1))])
    }
  }
  for (const g of [51, 91, 132, 173, 214, 255]) t.push([g, g, g])
  return t
})()

/** Nearest ACI index. Black maps to 7, which CAD shows as black on white and white on black. */
export function nearestAci(hex: string): number {
  const [r, g, b] = hexRgb(hex)
  if (r + g + b < 60) return 7
  let best = 1
  let bestD = Infinity
  for (let i = 1; i < ACI.length; i++) {
    if (i === 7) continue
    const [R, G, B] = ACI[i]
    const d = 2 * (r - R) ** 2 + 4 * (g - G) ** 2 + 3 * (b - B) ** 2
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/** Flatten a cubic until each chord is within `tol` of the curve. */
function flattenCubic(seg: [Vec, Vec, Vec, Vec], tol: number, out: Vec[]): void {
  const [p0, p1, p2, p3] = seg
  // Wang's bound on the second difference gives the step count for a chord error ≤ tol.
  const dd = Math.max(
    Math.hypot(p0.x - 2 * p1.x + p2.x, p0.y - 2 * p1.y + p2.y),
    Math.hypot(p1.x - 2 * p2.x + p3.x, p1.y - 2 * p2.y + p3.y),
  )
  const n = Math.max(1, Math.min(256, Math.ceil(Math.sqrt((3 * dd) / (4 * tol)))))
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    })
  }
}

function polyline(sp: SubPath, tol: number): Vec[] {
  if (sp.nodes.length === 0) return []
  const pts: Vec[] = [{ x: sp.nodes[0].x, y: sp.nodes[0].y }]
  for (const seg of segments(sp)) {
    if (isLine(seg)) pts.push({ x: seg[3].x, y: seg[3].y })
    else flattenCubic(seg, tol, pts)
  }
  // A closed polyline repeats no point: the closed flag draws the last edge.
  if (sp.closed && pts.length > 1) pts.pop()
  return pts
}

/** A DXF layer name for a paint: its hex, so the exact colour survives ACI rounding. */
function layerName(item: PathItem, stroke: boolean): string {
  if (item.id === 'paper') return 'PAPER'
  const paint = stroke ? (item.stroke?.color ?? '#000000') : item.fill
  return `${stroke ? 'STROKE' : 'FILL'}_${paint.replace('#', '').toUpperCase()}`
}

/**
 * The document as an R12 ASCII DXF. Units are the viewBox's (a traced doc's
 * are source pixels), with y flipped so the drawing is upright in CAD.
 * Outlines go on `FILL_<hex>` layers, stroke centrelines on `STROKE_<hex>`, an
 * opaque ground on `PAPER` so a cutter can switch it off.
 */
export function docToDxf(doc: EditableDoc): string {
  const [vx, vy, w, h] = doc.viewBox
  const tol = Math.max(w, h) / 4000
  const fmt = (v: number) => String(Number(v.toFixed(4)))
  const X = (x: number) => fmt(x - vx)
  const Y = (y: number) => fmt(vy + h - y)

  const layers = new Map<string, number>()
  const ents: string[] = []
  const emit = (layer: string, pts: Vec[], closed: boolean) => {
    if (pts.length < 2) return
    ents.push('0', 'POLYLINE', '8', layer, '66', '1', '10', '0', '20', '0', '30', '0', '70', closed ? '1' : '0')
    for (const p of pts) ents.push('0', 'VERTEX', '8', layer, '10', X(p.x), '20', Y(p.y), '30', '0')
    ents.push('0', 'SEQEND', '8', layer)
  }

  for (const { item } of visibleLeaves(doc.items)) {
    const filled = !isNone(item.fill)
    const stroked = item.stroke !== undefined && item.stroke.width > 0
    // A filled path is cut along its outline; a stroke-only one along its centreline.
    const asStroke = !filled && stroked
    if (!filled && !stroked) continue
    const layer = layerName(item, asStroke)
    if (!layers.has(layer)) {
      layers.set(layer, item.id === 'paper' ? 8 : nearestAci(asStroke ? item.stroke!.color : item.fill))
    }
    for (const sp of item.subPaths) emit(layer, polyline(sp, tol), sp.closed)
  }

  const out: string[] = []
  out.push('0', 'SECTION', '2', 'HEADER')
  out.push('9', '$ACADVER', '1', 'AC1009')
  out.push('9', '$EXTMIN', '10', '0', '20', '0', '30', '0')
  out.push('9', '$EXTMAX', '10', fmt(w), '20', fmt(h), '30', '0')
  out.push('0', 'ENDSEC')
  out.push('0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(layers.size + 1))
  out.push('0', 'LAYER', '2', '0', '70', '0', '62', '7', '6', 'CONTINUOUS')
  for (const [name, aci] of layers) out.push('0', 'LAYER', '2', name, '70', '0', '62', String(aci), '6', 'CONTINUOUS')
  out.push('0', 'ENDTAB', '0', 'ENDSEC')
  out.push('0', 'SECTION', '2', 'ENTITIES', ...ents, '0', 'ENDSEC', '0', 'EOF')
  // DXF readers on every platform accept CRLF; some old ones accept nothing else.
  return out.join('\r\n') + '\r\n'
}

// ---------------------------------------------------------------------------
// PDF (and AI, which is the same file)
// ---------------------------------------------------------------------------

/** The document as an Illustrator `.ai` — the PDF below, under Illustrator's extension. */
export function docToAi(doc: EditableDoc, title = 'logo'): Uint8Array {
  return docToPdf(doc, title)
}

/**
 * The document as a PDF 1.4 file, which is also what `.ai` downloads. One page the
 * size of the viewBox, 1 unit = 1 pt — the same size Illustrator gives the SVG.
 * Fills, even-odd holes, strokes (width, caps, joins, dashes), opacity and
 * linear/radial gradients carry over as native paint.
 */
export function docToPdf(doc: EditableDoc, title = 'logo'): Uint8Array {
  const [vx, vy, w, h] = doc.viewBox
  const fmt = (v: number) => String(Number(v.toFixed(3)))
  const rgb = (hex: string) =>
    hexRgb(hex)
      .map((c) => fmt(c / 255))
      .join(' ')
  // Content is drawn in viewBox coordinates under this flip; patterns live in
  // the page's default space and need the same matrix.
  const flip = `1 0 0 -1 ${fmt(-vx)} ${fmt(vy + h)}`

  const objects: string[] = [] // 1-based object bodies
  const add = (body: string) => objects.push(body)
  const reserve = () => add('')

  const catalog = reserve()
  const pages = reserve()
  const page = reserve()
  const content = reserve()

  const alphas = new Map<string, string>() // "ca/CA" → /GSn
  const alphaGs = (fill: number, stroke: number) => {
    const key = `${fmt(fill)}/${fmt(stroke)}`
    let name = alphas.get(key)
    if (!name) {
      name = `GS${alphas.size}`
      alphas.set(key, name)
    }
    return name
  }
  const gsObjects: string[] = []
  const patterns = new Map<GradientFill, string>()
  const patternObjects: string[] = []

  /** The stops as a PDF function of t, each stop read through `paint` (its colour, or its opacity). */
  const shadingFunction = (g: GradientFill, paint: (stop: GradientFill['stops'][number]) => string) => {
    const stops = [...g.stops].sort((a, b) => a.offset - b.offset)
    if (stops.length === 0) return '<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0] /C1 [0 0 0] /N 1 >>'
    if (stops[0].offset > 0) stops.unshift({ ...stops[0], offset: 0 })
    if (stops[stops.length - 1].offset < 1) stops.push({ ...stops[stops.length - 1], offset: 1 })
    const pieces: string[] = []
    for (let i = 0; i + 1 < stops.length; i++) {
      pieces.push(`<< /FunctionType 2 /Domain [0 1] /C0 [${paint(stops[i])}] /C1 [${paint(stops[i + 1])}] /N 1 >>`)
    }
    if (pieces.length === 1) return pieces[0]
    const bounds = stops.slice(1, -1).map((s) => fmt(s.offset))
    return `<< /FunctionType 3 /Domain [0 1] /Functions [${pieces.join(' ')}] /Bounds [${bounds.join(' ')}] /Encode [${pieces.map(() => '0 1').join(' ')}] >>`
  }
  const shading = (g: GradientFill, space: 'DeviceRGB' | 'DeviceGray') => {
    const fn =
      space === 'DeviceRGB' ? shadingFunction(g, (s) => rgb(s.color)) : shadingFunction(g, (s) => fmt(s.opacity ?? 1))
    const coords = g.type === 'linear' ? [g.x1, g.y1, g.x2, g.y2] : [g.fx ?? g.cx, g.fy ?? g.cy, 0, g.cx, g.cy, g.r]
    return `<< /ShadingType ${g.type === 'linear' ? 2 : 3} /ColorSpace /${space} /Coords [${coords.map(fmt).join(' ')}] /Function ${fn} /Extend [true true] >>`
  }
  const pattern = (g: GradientFill) => {
    let name = patterns.get(g)
    if (name) return name
    name = `P${patterns.size}`
    patterns.set(g, name)
    patternObjects.push(`<< /Type /Pattern /PatternType 2 /Matrix [${flip}] /Shading ${shading(g, 'DeviceRGB')} >>`)
    return name
  }
  // Stop opacity (a glow fading to nothing) is a luminosity soft mask: the same
  // gradient over the stops' alphas in grey. The mask is read in the space
  // current at `gs` — viewBox space, under the flip — so it shares the fill's coordinates.
  const masks = new Map<GradientFill, string>()
  const maskForms: { gradient: GradientFill; name: string }[] = []
  const softMask = (g: GradientFill) => {
    let name = masks.get(g)
    if (!name) {
      name = `SM${masks.size}`
      masks.set(g, name)
      maskForms.push({ gradient: g, name })
    }
    return name
  }

  const ops: string[] = [`${flip} cm`]
  for (const { item, opacity } of visibleLeaves(doc.items)) {
    const filled = !isNone(item.fill)
    const s = item.stroke && item.stroke.width > 0 ? item.stroke : null
    if (!filled && !s) continue
    ops.push('q')
    const fillA = opacity * (item.fillOpacity ?? 1)
    const strokeA = opacity * (s?.opacity ?? 1)
    if (fillA < 1 || strokeA < 1) ops.push(`/${alphaGs(fillA, strokeA)} gs`)
    if (filled) {
      if (item.gradient) {
        if (item.gradient.stops.some((st) => (st.opacity ?? 1) < 1)) ops.push(`/${softMask(item.gradient)} gs`)
        ops.push(`/Pattern cs /${pattern(item.gradient)} scn`)
      } else ops.push(`${rgb(item.fill)} rg`)
    }
    if (s) {
      ops.push(`${rgb(s.color)} RG`, `${fmt(s.width)} w`)
      ops.push(`${{ butt: 0, round: 1, square: 2 }[s.cap]} J`, `${{ miter: 0, round: 1, bevel: 2 }[s.join]} j`)
      if (s.dash && s.dash.length > 0) ops.push(`[${s.dash.map(fmt).join(' ')}] 0 d`)
    }
    for (const sp of item.subPaths) {
      if (sp.nodes.length === 0) continue
      ops.push(`${fmt(sp.nodes[0].x)} ${fmt(sp.nodes[0].y)} m`)
      for (const seg of segments(sp)) {
        const [, c1, c2, p] = seg
        ops.push(
          isLine(seg) ? `${fmt(p.x)} ${fmt(p.y)} l` : `${[c1.x, c1.y, c2.x, c2.y, p.x, p.y].map(fmt).join(' ')} c`,
        )
      }
      if (sp.closed) ops.push('h')
    }
    const even = item.fillRule === 'evenodd' ? '*' : ''
    ops.push(filled && s ? `B${even}` : filled ? `f${even}` : 'S', 'Q')
  }
  const stream = ops.join('\n')

  for (const key of alphas.keys()) {
    const [ca, CA] = key.split('/')
    gsObjects.push(`<< /Type /ExtGState /ca ${ca} /CA ${CA} >>`)
  }
  const gsNames = [...alphas.values()]
  for (const { gradient, name } of maskForms) {
    const sh = shading(gradient, 'DeviceGray')
    const body = `/Sh0 sh`
    const form = add(
      `<< /Type /XObject /Subtype /Form /BBox [${[vx, vy, vx + w, vy + h].map(fmt).join(' ')}] ` +
        `/Group << /S /Transparency /CS /DeviceGray >> /Resources << /Shading << /Sh0 ${sh} >> >> /Length ${body.length} >>
stream
${body}
endstream`,
    )
    gsObjects.push(`<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G ${form} 0 R >> >>`)
    gsNames.push(name)
  }
  const gsIds = gsObjects.map(add)
  const patIds = patternObjects.map(add)
  const resources = [
    gsIds.length ? `/ExtGState << ${gsNames.map((n, i) => `/${n} ${gsIds[i]} 0 R`).join(' ')} >>` : '',
    patIds.length ? `/Pattern << ${[...patterns.values()].map((n, i) => `/${n} ${patIds[i]} 0 R`).join(' ')} >>` : '',
  ].join(' ')

  const info = add(`<< /Title (${pdfString(title)}) /Creator (LogoLab) /Producer (LogoLab) >>`)
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`
  objects[pages - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`
  objects[page - 1] =
    `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${fmt(w)} ${fmt(h)}] /ArtBox [0 0 ${fmt(w)} ${fmt(h)}] ` +
    `/Resources << ${resources} >> /Contents ${content} 0 R >>`
  objects[content - 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`

  // Everything above is ASCII, so string length is byte length and the xref offsets are exact.
  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`

  const bytes = new Uint8Array(pdf.length)
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff
  return bytes
}

/** A PDF literal string: printable ASCII only, with the delimiters escaped. */
function pdfString(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`)
}
