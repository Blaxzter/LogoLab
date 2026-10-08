// Strokes where the reading is confident, fills for the rest (§39.8).
//
// A sheet of icons is not all line art. A QR code, a caption, the digits of a scorecard
// are ink a centreline reads badly — a QR block comes back as scribble, "Pro Shop" as
// "Dro S'op" — while the outline tracer reads them exactly. The engine already sends ink
// no stroke explains to the fills (blobs.ts); this sends a whole COMPONENT of ink there
// when its strokes, as traced, are not to be trusted. Three readings, each measured on
// the field report's sheets against the clean icons beside them:
//
//   texture   widths that disagree AND junctions everywhere: a QR block's modules thin
//             into a lattice whose profiles read one, two and three modules wide
//             (spread ≥ 2.2, junction density ≥ 0.2). Line art that mixes widths — a
//             width ladder, a thin line hanging off a bar — is junction-sparse (≤ 0.11).
//   broken    a small mark (a skeleton of at most 20 widths) whose strokes, drawn at
//             their widths, leave 8% of its ink uncovered: a mangled letter, a keyhole
//             read as a bar. A long stroke that misses a miter tip, or an icon that lost
//             a handle, is not small, and stays.
//   caption   three or more glyph-sized marks in a row, one of them broken: a line of
//             text goes to the fills whole, not letter by letter as each happens to read.
//             A row with no broken mark is a trash can's bars or a broadcast's arcs.
//
// Each component's ink then joins the fill mask and its strokes are dropped.

import type { StrokePath } from './assemble.ts'
import { distanceTransform } from './distance.ts'
import type { SkeletonGraph } from './graph.ts'
import type { Centreline } from './profile.ts'

/** Width spread (p90 / p10) and junction density above which a component is texture. */
export const TEXTURE_SPREAD = 2.2
export const TEXTURE_JUNCTIONS = 0.2
/** Share of a small mark's ink its strokes leave uncovered that says the reading broke. */
export const BROKEN_MISS = 0.08
/** A mark at most this many of its widths of skeleton is small. */
export const SMALL_MARK_LW = 20
/** A glyph is this many of its widths tall, at least and at most… */
export const GLYPH_MIN_H = 2.5
export const GLYPH_MAX_H = 12
/** …and a caption at least this many of them in a row. */
export const CAPTION_MIN = 3

export interface ComponentReading {
  /** 8-connected ink component per pixel, -1 on paper. */
  comp: Int32Array
  /** Components routed to the fills, and why. */
  routed: Map<number, 'texture' | 'broken' | 'caption'>
}

interface Feature {
  x0: number
  y0: number
  x1: number
  y1: number
  px: number
  len: number
  ws: number[]
  nodes: Set<number>
  ends: number
  strokes: number
  miss: number
}

/**
 * Read every ink component and decide which go to the fills. `paths` are the assembled
 * strokes (their polylines and widths), `blobMask` the fills already decided.
 */
export function readComponents(
  ink: Uint8Array,
  width: number,
  height: number,
  g: SkeletonGraph,
  lines: Centreline[],
  paths: StrokePath[],
  blobMask: Uint8Array | null,
): ComponentReading {
  const n = width * height
  const comp = new Int32Array(n).fill(-1)
  const feats: Feature[] = []
  const stack: number[] = []
  for (let s = 0; s < n; s++) {
    if (!ink[s] || comp[s] >= 0) continue
    const id = feats.length
    const f: Feature = {
      x0: width,
      y0: height,
      x1: 0,
      y1: 0,
      px: 0,
      len: 0,
      ws: [],
      nodes: new Set(),
      ends: 0,
      strokes: 0,
      miss: 0,
    }
    comp[s] = id
    stack.push(s)
    while (stack.length) {
      const p = stack.pop()!
      const x = p % width
      const y = (p / width) | 0
      f.px++
      if (x < f.x0) f.x0 = x
      if (y < f.y0) f.y0 = y
      if (x > f.x1) f.x1 = x
      if (y > f.y1) f.y1 = y
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const qx = x + dx
          const qy = y + dy
          if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue
          const q = qy * width + qx
          if (ink[q] && comp[q] < 0) {
            comp[q] = id
            stack.push(q)
          }
        }
    }
    feats.push(f)
  }
  // Skeleton features: length, widths, junctions and free ends per component.
  for (const l of lines) {
    if (l.chain.pixels.length === 0) continue
    const c = comp[l.chain.pixels[0]]
    if (c < 0) continue
    const f = feats[c]
    for (let k = 0; k < l.pts.length; k++) {
      if (k) f.len += Math.hypot(l.pts[k].x - l.pts[k - 1].x, l.pts[k].y - l.pts[k - 1].y)
      if (Number.isFinite(l.w[k]) && l.w[k] > 0) f.ws.push(l.w[k])
    }
    if (!l.closed)
      for (const end of [l.a, l.b]) {
        if (end < 0) f.ends++
        else if (g.nodes[end].alive) f.nodes.add(end)
      }
  }

  // Coverage: the strokes painted at their widths, plus the fills, and every ink pixel
  // further than a fifth of its component's width (1.5 px at least) from that paint.
  const drawn = new Uint8Array(n)
  if (blobMask) for (let i = 0; i < n; i++) if (blobMask[i]) drawn[i] = 1
  const owner = pathComponents(paths, comp, width, height)
  paths.forEach((p, k) => {
    if (owner[k] >= 0) feats[owner[k]].strokes++
    const r = p.width / 2
    const pts = p.polyline
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k]
      const b = pts[Math.min(pts.length - 1, k + 1)]
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)))
      for (let s = 0; s < steps; s++)
        disc(drawn, width, height, a.x + ((b.x - a.x) * s) / steps, a.y + ((b.y - a.y) * s) / steps, r)
    }
  })
  const away = new Uint8Array(n)
  for (let i = 0; i < n; i++) away[i] = drawn[i] ? 0 : 1
  const toDrawn = distanceTransform(away, width, height)
  const widthOf = (f: Feature): number => {
    if (f.ws.length === 0) return 0
    f.ws.sort((a, b) => a - b)
    return f.ws[f.ws.length >> 1]
  }
  const wc = feats.map(widthOf)
  const missed = new Float64Array(feats.length)
  for (let i = 0; i < n; i++) {
    const c = comp[i]
    if (c < 0 || drawn[i]) continue
    if (toDrawn[i] > Math.max(1.5, 0.2 * wc[c])) missed[c]++
  }

  const routed: ComponentReading['routed'] = new Map()
  const small: number[] = []
  feats.forEach((f, c) => {
    if (f.strokes === 0 || wc[c] <= 0) return
    f.miss = missed[c] / f.px
    const lw = f.len / wc[c]
    const q = (t: number): number => f.ws[Math.min(f.ws.length - 1, Math.floor(t * (f.ws.length - 1)))]
    const spread = f.ws.length >= 5 ? q(0.9) / Math.max(0.1, q(0.1)) : 1
    const jd = (f.nodes.size + f.ends) / Math.max(1, lw)
    if (spread >= TEXTURE_SPREAD && jd >= TEXTURE_JUNCTIONS) routed.set(c, 'texture')
    else if (lw <= SMALL_MARK_LW && f.miss >= BROKEN_MISS) routed.set(c, 'broken')
    const h = (f.y1 - f.y0 + 1) / wc[c]
    if (lw <= SMALL_MARK_LW && h >= GLYPH_MIN_H && h <= GLYPH_MAX_H && f.x1 - f.x0 <= 2 * (f.y1 - f.y0 + 1))
      small.push(c)
  })

  // Captions: glyph-sized marks side by side on one line — sharing most of their height,
  // of like height, no further apart than the taller is tall.
  small.sort((a, b) => feats[a].x0 - feats[b].x0)
  const parent = new Map<number, number>(small.map((c) => [c, c]))
  const find = (c: number): number => {
    let r = c
    while (parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  for (let i = 0; i < small.length; i++)
    for (let j = i + 1; j < small.length; j++) {
      const A = feats[small[i]]
      const B = feats[small[j]]
      const ha = A.y1 - A.y0 + 1
      const hb = B.y1 - B.y0 + 1
      const gap = B.x0 - A.x1
      if (gap > Math.max(ha, hb)) break
      const overlap = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0) + 1
      if (overlap < 0.6 * Math.min(ha, hb) || Math.abs(ha - hb) > 0.5 * Math.max(ha, hb)) continue
      parent.set(find(small[i]), find(small[j]))
    }
  const rows = new Map<number, number[]>()
  for (const c of small) {
    const r = find(c)
    rows.set(r, [...(rows.get(r) ?? []), c])
  }
  // A row of like marks is also a row of bars, of a broadcast's arcs, of a link's pieces:
  // it is a caption only once one of its marks reads as text the strokes cannot hold.
  for (const row of rows.values())
    if (row.length >= CAPTION_MIN && row.some((c) => routed.get(c) === 'broken'))
      for (const c of row) if (!routed.has(c)) routed.set(c, 'caption')

  return { comp, routed }
}

function disc(m: Uint8Array, width: number, height: number, cx: number, cy: number, r: number): void {
  const x0 = Math.max(0, Math.floor(cx - r))
  const x1 = Math.min(width - 1, Math.ceil(cx + r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const y1 = Math.min(height - 1, Math.ceil(cy + r))
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx
      if (dx * dx + dy * dy <= r * r) m[y * width + x] = 1
    }
  }
}

/** Which component each path belongs to (majority of its polyline), -1 for none. */
export function pathComponents(paths: StrokePath[], comp: Int32Array, width: number, height: number): number[] {
  return paths.map((p) => {
    const votes = new Map<number, number>()
    for (const q of p.polyline) {
      const x = Math.min(width - 1, Math.max(0, Math.floor(q.x)))
      const y = Math.min(height - 1, Math.max(0, Math.floor(q.y)))
      const c = comp[y * width + x]
      if (c >= 0) votes.set(c, (votes.get(c) ?? 0) + 1)
    }
    let best = -1
    let bv = 0
    for (const [c, v] of votes)
      if (v > bv) {
        bv = v
        best = c
      }
    return best
  })
}
