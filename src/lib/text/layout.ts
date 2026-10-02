// Text layout: styled runs → glyph outlines in document space, plus the caret
// geometry the editor draws and hit-tests with.
//
// Pure and synchronous. Shaping (which glyphs, where) is behind `ShapingFace`,
// so the same code runs on HarfBuzz in the browser and in the tests; nothing
// here knows about WASM or about how a font got loaded.
//
// Spaces, in order:
//   * font units   — what the face returns, y UP;
//   * layout space — y DOWN, first baseline at y = 0, x = 0 at the alignment
//     edge (left / centre / right of every line);
//   * document     — layout space through `TextData.matrix`.
// Text on a path bends layout space before the matrix: a glyph's x becomes a
// distance along the curve and its y an offset along the curve's normal.

import type { PathItem, PathNode, SubPath, TextData, TextStyle, Vec } from '../path/types.ts'
import { applyAffine } from '../path/geometry.ts'
import { reverseSubPath } from '../editor/pathOps.ts'

/** One positioned glyph from the shaper, in font units. */
export interface ShapedGlyph {
  gid: number
  /** UTF-16 index (into the shaped string) of the first character it draws. */
  cluster: number
  ax: number
  dx: number
  dy: number
}

export type OutlineCmd =
  | { t: 'M' | 'L'; x: number; y: number }
  | { t: 'Q'; x1: number; y1: number; x: number; y: number }
  | { t: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { t: 'Z' }

export interface ShapingFace {
  upem: number
  /** Font units, y up: ascender > 0, descender < 0. */
  ascender: number
  descender: number
  shape(text: string, features: Record<string, number>, variations: Record<string, number>): ShapedGlyph[]
  outline(gid: number, variations: Record<string, number>): OutlineCmd[]
}

/** The face for a font id; `synthItalic` when italic was asked for and the family has no italic face. */
export type FaceLookup = (font: string, italic: boolean) => { face: ShapingFace; synthItalic: boolean } | null

/** A caret stop: the segment from the top of the line box to the bottom, in document space. */
export interface Caret {
  top: Vec
  bottom: Vec
  line: number
}

export interface TextLayout {
  /** The glyph outlines, one compound path per fill, in document space. */
  children: PathItem[]
  /** One caret per character offset, 0…length inclusive. */
  carets: Caret[]
  /** Fonts that were asked for and are not loaded (their text is not drawn). */
  missing: string[]
}

/** Synthetic italic slant, as browsers synthesise it. */
const SLANT = Math.tan((12 * Math.PI) / 180)

/* ----------------------------------------------------------- content */

export function plainText(data: TextData): string {
  return data.runs.map((r) => r.text).join('')
}

/** The full style of every UTF-16 unit, resolved over the base. */
function styleRanges(data: TextData): { start: number; end: number; style: TextStyle }[] {
  const out: { start: number; end: number; style: TextStyle }[] = []
  let at = 0
  for (const r of data.runs) {
    if (r.text.length === 0) continue
    out.push({ start: at, end: at + r.text.length, style: resolveStyle(data.style, r.style) })
    at += r.text.length
  }
  return out
}

/** A run's style over the base; feature and axis maps merge key by key. */
export function resolveStyle(base: TextStyle, over: Partial<TextStyle> | undefined): TextStyle {
  if (!over) return base
  const out = { ...base, ...over }
  if (base.features || over.features) out.features = { ...base.features, ...over.features }
  if (base.variations || over.variations) out.variations = { ...base.variations, ...over.variations }
  return out
}

/** The resolved style at offset `i` (the character starting there, else the one before). */
export function styleAt(data: TextData, i: number): TextStyle {
  const ranges = styleRanges(data)
  for (const r of ranges) if (i >= r.start && i < r.end) return r.style
  return ranges.length > 0 ? ranges[ranges.length - 1].style : data.style
}

/* ------------------------------------------------------------ layout */

interface PlacedGlyph {
  face: ShapingFace
  gid: number
  variations: Record<string, number>
  /** Pen position (layout space, before alignment), baseline y. */
  x: number
  y: number
  advance: number
  scale: number
  slant: number
  fill: string
}

interface LineBox {
  start: number
  end: number
  y: number
  ascent: number
  descent: number
  width: number
  /** Pen x at each offset start…end (before alignment). */
  stops: number[]
  glyphs: PlacedGlyph[]
}

function featuresFor(style: TextStyle, kerning: boolean): Record<string, number> {
  const f: Record<string, number> = { ...style.features }
  if (!kerning) f.kern = 0
  return f
}

function variationsFor(style: TextStyle): Record<string, number> {
  return { ...style.variations, wght: style.weight }
}

/**
 * Lay the text out. `nextId(i)` names the i-th output path, so a relayout that
 * keeps its fills keeps its child ids.
 */
export function layoutText(data: TextData, lookup: FaceLookup, nextId: (i: number) => string): TextLayout {
  const text = plainText(data)
  const ranges = styleRanges(data)
  const missing = new Set<string>()
  const lines: LineBox[] = []

  // Line by line; within a line, one shaping call per style range.
  let lineStart = 0
  let y = 0
  for (;;) {
    let lineEnd = text.indexOf('\n', lineStart)
    if (lineEnd < 0) lineEnd = text.length
    const stops = new Array<number>(lineEnd - lineStart + 1).fill(Number.NaN)
    const glyphs: PlacedGlyph[] = []
    let pen = 0
    let ascent = 0
    let descent = 0
    let maxSize = 0

    for (const r of ranges) {
      const s = Math.max(r.start, lineStart)
      const e = Math.min(r.end, lineEnd)
      if (s >= e) continue
      const st = r.style
      maxSize = Math.max(maxSize, st.size)
      const got = lookup(st.font, st.italic)
      if (!got) {
        missing.add(st.font)
        for (let i = s; i < e; i++) stops[i - lineStart] = pen
        continue
      }
      const { face } = got
      const scale = st.size / face.upem
      ascent = Math.max(ascent, face.ascender * scale)
      descent = Math.max(descent, -face.descender * scale)
      const track = (st.tracking / 1000) * st.size
      const variations = variationsFor(st)
      const shaped = face.shape(text.slice(s, e), featuresFor(st, data.kerning), variations)
      const shift = st.baselineShift ?? 0

      for (let gi = 0; gi < shaped.length; gi++) {
        const g = shaped[gi]
        const advance = g.ax * scale + track
        // Characters this glyph stands for: up to the next glyph's cluster. A
        // ligature spreads its carets evenly over its advance.
        const from = s + g.cluster
        const nextCluster = gi + 1 < shaped.length ? s + shaped[gi + 1].cluster : e
        if (nextCluster > from) {
          const n = nextCluster - from
          for (let k = 0; k < n; k++) stops[from + k - lineStart] = pen + (advance * k) / n
        } else if (Number.isNaN(stops[from - lineStart])) {
          stops[from - lineStart] = pen
        }
        glyphs.push({
          face,
          gid: g.gid,
          variations,
          x: pen + g.dx * scale,
          y: y - g.dy * scale - shift,
          advance,
          scale,
          slant: got.synthItalic ? SLANT : 0,
          fill: st.fill,
        })
        pen += advance
      }
    }

    // Tracking trails the last glyph too; it is not part of the line's width.
    const lastStyle = styleAt(data, Math.max(lineStart, lineEnd - 1))
    const width = glyphs.length > 0 ? pen - (lastStyle.tracking / 1000) * lastStyle.size : 0
    stops[stops.length - 1] = pen
    // Offsets no glyph claimed (e.g. inside a decomposed cluster) take the one before.
    for (let i = 1; i < stops.length; i++) if (Number.isNaN(stops[i])) stops[i] = stops[i - 1]
    if (Number.isNaN(stops[0])) stops[0] = 0

    if (maxSize === 0) maxSize = (lineStart > 0 ? styleAt(data, lineStart - 1) : data.style).size
    if (ascent === 0 && descent === 0) {
      ascent = maxSize * 0.8
      descent = maxSize * 0.2
    }
    lines.push({ start: lineStart, end: lineEnd, y, ascent, descent, width, stops, glyphs })
    if (lineEnd >= text.length) break
    y += data.lineHeight * maxSize
    lineStart = lineEnd + 1
  }

  const along = data.onPath ? pathWalker(data.onPath.path, data.onPath.start, !!data.onPath.flip) : null
  const toDoc = (p: Vec): Vec => applyAffine(data.matrix, along ? along.map(p) : p)

  /* ---- outlines, grouped by fill ---- */
  const byFill = new Map<string, SubPath[]>()
  for (const line of lines) {
    const dx = alignOffset(data.align, line.width)
    for (const g of line.glyphs) {
      const cmds = g.face.outline(g.gid, g.variations)
      // On a path each glyph is placed rigidly at its centre, so it turns with
      // the curve instead of being sheared along it.
      const place = along ? glyphOnPath(along, g.x + dx + g.advance / 2, g.y) : null
      const map = (u: number, v: number): Vec => {
        const lx = u * g.scale + v * g.scale * g.slant
        const ly = -v * g.scale
        if (!place) return applyAffine(data.matrix, { x: g.x + dx + lx, y: g.y + ly })
        const ox = g.x + dx + lx - (g.x + dx + g.advance / 2)
        return applyAffine(data.matrix, {
          x: place.p.x + ox * place.cos - ly * place.sin,
          y: place.p.y + ox * place.sin + ly * place.cos,
        })
      }
      const subs = outlineToSubPaths(cmds, map)
      if (subs.length === 0) continue
      const list = byFill.get(g.fill)
      if (list) list.push(...subs)
      else byFill.set(g.fill, subs)
    }
  }

  const children: PathItem[] = [...byFill.entries()].map(([fill, subPaths], i) => ({
    kind: 'path',
    id: nextId(i),
    fill,
    fillRule: 'nonzero',
    subPaths,
    visible: true,
  }))

  /* ---- carets ---- */
  const carets: Caret[] = []
  lines.forEach((line, li) => {
    const dx = alignOffset(data.align, line.width)
    // stops run start…end inclusive; `end` is the newline's own offset, the
    // caret at the end of this line, so the lines' stops tile 0…length.
    for (let k = 0; k < line.stops.length; k++) {
      const x = line.stops[k] + dx
      carets.push({
        top: toDoc({ x, y: line.y - line.ascent }),
        bottom: toDoc({ x, y: line.y + line.descent }),
        line: li,
      })
    }
  })

  return { children, carets, missing: [...missing] }
}

function alignOffset(align: TextData['align'], width: number): number {
  return align === 'center' ? -width / 2 : align === 'right' ? -width : 0
}

/* ------------------------------------------------------- outlines */

function outlineToSubPaths(cmds: OutlineCmd[], map: (u: number, v: number) => Vec): SubPath[] {
  const out: SubPath[] = []
  let nodes: PathNode[] = []
  let cu = 0
  let cv = 0
  let su = 0
  let sv = 0
  const flush = (closed: boolean) => {
    if (nodes.length > 1) {
      // A closing segment that returns to the start duplicates the first node.
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (closed && Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) {
        first.hIn = last.hIn
        nodes.pop()
      }
      out.push({ nodes, closed: true })
    }
    nodes = []
  }
  for (const c of cmds) {
    switch (c.t) {
      case 'M': {
        flush(true)
        const p = map(c.x, c.y)
        nodes.push({ ...p, hIn: null, hOut: null, kind: 'corner' })
        cu = su = c.x
        cv = sv = c.y
        break
      }
      case 'L': {
        const p = map(c.x, c.y)
        nodes.push({ ...p, hIn: null, hOut: null, kind: 'corner' })
        cu = c.x
        cv = c.y
        break
      }
      case 'Q': {
        // Degree elevation: exact.
        const c1 = map(cu + (2 / 3) * (c.x1 - cu), cv + (2 / 3) * (c.y1 - cv))
        const c2 = map(c.x + (2 / 3) * (c.x1 - c.x), c.y + (2 / 3) * (c.y1 - c.y))
        nodes[nodes.length - 1].hOut = c1
        nodes.push({ ...map(c.x, c.y), hIn: c2, hOut: null, kind: 'corner' })
        cu = c.x
        cv = c.y
        break
      }
      case 'C': {
        nodes[nodes.length - 1].hOut = map(c.x1, c.y1)
        nodes.push({ ...map(c.x, c.y), hIn: map(c.x2, c.y2), hOut: null, kind: 'corner' })
        cu = c.x
        cv = c.y
        break
      }
      case 'Z':
        flush(true)
        cu = su
        cv = sv
        break
    }
  }
  flush(true)
  for (const sp of out) markSmooth(sp)
  return out
}

/** A node whose handles are opposite and collinear is smooth (so node editing keeps it so). */
function markSmooth(sp: SubPath): void {
  for (const n of sp.nodes) {
    if (!n.hIn || !n.hOut) continue
    const ax = n.x - n.hIn.x
    const ay = n.y - n.hIn.y
    const bx = n.hOut.x - n.x
    const by = n.hOut.y - n.y
    const cross = ax * by - ay * bx
    const dot = ax * bx + ay * by
    if (dot > 0 && Math.abs(cross) <= 1e-3 * Math.hypot(ax, ay) * Math.hypot(bx, by)) n.kind = 'smooth'
  }
}

/* ---------------------------------------------------- text on a path */

interface Walker {
  length: number
  /** Point and unit tangent at arc length `s` (extrapolated past either end). */
  at(s: number): { p: Vec; tx: number; ty: number }
  /** Bend a layout point: x along the curve, y along its normal. */
  map(p: Vec): Vec
}

const SAMPLES_PER_SEGMENT = 48

function pathWalker(path: SubPath, start: number, flip: boolean): Walker {
  const sp = flip ? reverseSubPath(path) : path
  const pts: Vec[] = []
  const n = sp.nodes.length
  const segs = sp.closed ? n : n - 1
  for (let i = 0; i < segs; i++) {
    const a = sp.nodes[i]
    const b = sp.nodes[(i + 1) % n]
    const c1 = a.hOut ?? a
    const c2 = b.hIn ?? b
    for (let k = i === 0 ? 0 : 1; k <= SAMPLES_PER_SEGMENT; k++) {
      const t = k / SAMPLES_PER_SEGMENT
      const u = 1 - t
      pts.push({
        x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
      })
    }
  }
  if (pts.length < 2) pts.push({ x: (pts[0]?.x ?? 0) + 1, y: pts[0]?.y ?? 0 })
  const cum = [0]
  for (let i = 1; i < pts.length; i++)
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  const length = cum[cum.length - 1] || 1
  const offset = start * length

  const at = (s0: number) => {
    let s = s0 + offset
    if (sp.closed) s = ((s % length) + length) % length
    // Binary search the polyline.
    let lo = 0
    let hi = cum.length - 1
    if (s <= 0) {
      lo = 0
      hi = 1
    } else if (s >= length) {
      lo = cum.length - 2
      hi = cum.length - 1
    } else {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (cum[mid] <= s) lo = mid
        else hi = mid
      }
    }
    const a = pts[lo]
    const b = pts[hi]
    const segLen = cum[hi] - cum[lo] || 1
    const tx = (b.x - a.x) / segLen
    const ty = (b.y - a.y) / segLen
    const d = s - cum[lo]
    return { p: { x: a.x + tx * d, y: a.y + ty * d }, tx, ty }
  }
  return {
    length,
    at,
    map: (p) => {
      const { p: q, tx, ty } = at(p.x)
      // Normal = tangent turned a quarter clockwise in y-down space: glyphs
      // stand on the curve's left as you walk it (outside of a clockwise circle).
      return { x: q.x - ty * p.y, y: q.y + tx * p.y }
    },
  }
}

function glyphOnPath(w: Walker, centerX: number, baselineY: number): { p: Vec; cos: number; sin: number } {
  const { tx, ty } = w.at(centerX)
  return { p: w.map({ x: centerX, y: baselineY }), cos: tx, sin: ty }
}

/* ------------------------------------------------------------ helpers */

/** Parse HarfBuzz's `glyphToPath` output (absolute M/L/Q/C/Z, font units). */
export function parseGlyphPath(d: string): OutlineCmd[] {
  const out: OutlineCmd[] = []
  const re = /([MLQCZ])([^MLQCZ]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(d))) {
    const n = m[2]
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
    switch (m[1]) {
      case 'M':
      case 'L':
        out.push({ t: m[1], x: n[0], y: n[1] })
        break
      case 'Q':
        out.push({ t: 'Q', x1: n[0], y1: n[1], x: n[2], y: n[3] })
        break
      case 'C':
        out.push({ t: 'C', x1: n[0], y1: n[1], x2: n[2], y2: n[3], x: n[4], y: n[5] })
        break
      case 'Z':
        out.push({ t: 'Z' })
        break
    }
  }
  return out
}

/** The caret offset nearest `p` — where a click in the text puts the caret. */
export function caretIndexAt(carets: readonly Caret[], p: Vec): number {
  let best = 0
  let bestD = Infinity
  carets.forEach((c, i) => {
    const vx = c.bottom.x - c.top.x
    const vy = c.bottom.y - c.top.y
    const len2 = vx * vx + vy * vy || 1
    const t = Math.max(0, Math.min(1, ((p.x - c.top.x) * vx + (p.y - c.top.y) * vy) / len2))
    const d = Math.hypot(p.x - (c.top.x + vx * t), p.y - (c.top.y + vy * t))
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

/** The word around offset `i` (letters, digits and apostrophes), as [start, end). */
export function wordAt(text: string, i: number): [number, number] {
  const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}'’_-]/u.test(ch)
  let a = i
  let b = i
  if (!isWord(text[i]) && isWord(text[i - 1])) a = b = i - 1
  while (a > 0 && isWord(text[a - 1])) a--
  while (b < text.length && isWord(text[b])) b++
  return b > a ? [a, b] : [i, Math.min(text.length, i + 1)]
}

/** Where along `path` (0–1 of its length) the point nearest `p` lies — where a click on a curve starts the text. */
export function pathFraction(path: SubPath, p: Vec): number {
  const w = pathWalker(path, 0, false)
  const steps = Math.max(64, Math.ceil(w.length / 2))
  let best = 0
  let bestD = Infinity
  for (let i = 0; i <= steps; i++) {
    const s = (i / steps) * w.length
    const q = w.at(s).p
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d < bestD) {
      bestD = d
      best = i / steps
    }
  }
  return best >= 1 ? 0 : best
}
