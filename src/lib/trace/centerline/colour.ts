// Colour line art: several inks on one paper, traced as strokes in their own colours.
//
// The centreline engine reads ONE ink mask (skeleton, distance transform, coverage
// profile — all of them ink-vs-paper questions). So colour does not get a second
// engine: every ink is folded into one coverage raster — how much of each pixel is
// SOME ink rather than the paper — the union is traced as one line drawing, and each
// stroke is then painted in the ink it runs through.
//
// Tracing the union rather than one mask per ink is what keeps a crossing whole: a red
// line over a blue one cuts the blue mask in two, but in the union it is one crossing
// the junction pairing already knows how to thread (assemble.ts pairs arms by rank),
// so both lines come back continuous. A line that changes colour along its length
// comes back in its majority ink — the known limit of this version.
//
// The paper is the palette colour holding the border (the colour path's own
// background rule). Art on transparency has no paper colour: coverage is the alpha,
// and the composite the planar passes read is laid on white, or black when the inks
// are light, so a white line on transparency still has a ramp to read.

import type { PathItem, PathNode, SubPath } from '../../path/types'
import type { PaletteColor } from '../types'

export interface ColourInkCut {
  /** Opaque greyscale RGBA: black = all ink, white = paper. What `monoLabels` cuts at 128. */
  coverage: { data: Uint8ClampedArray; width: number; height: number }
  /** Palette label of the ink each pixel is closest to (every pixel; paper pixels too). */
  inkOf: Int32Array
  /** Palette labels that are inks (everything but the paper). */
  inks: number[]
  /** The paper's palette label, or -1 on transparency. */
  paperLabel: number
  /** The paper's colour — real when `paperLabel` ≥ 0, the composite's otherwise. */
  paper: { r: number; g: number; b: number }
  /** The source composited over `paper`: opaque RGBA for the planar fill passes. */
  image: { data: Uint8ClampedArray; width: number; height: number }
}

const dist2 = (r: number, g: number, b: number, c: { r: number; g: number; b: number }): number =>
  (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2

/**
 * Fold the inks of a palette segmentation into one coverage raster.
 * `labels` / `palette` come from `segmentFlatPalette` (label -1 = transparent);
 * `paperLabel` from the border-background rule (-1 = the paper is transparency).
 */
export function colourInkCut(
  img: { data: Uint8ClampedArray; width: number; height: number },
  labels: Int32Array,
  palette: PaletteColor[],
  paperLabel: number,
): ColourInkCut {
  const { width, height, data } = img
  const n = width * height
  const inks: number[] = []
  for (let l = 0; l < palette.length; l++) if (l !== paperLabel) inks.push(l)

  // On transparency the composite goes on white unless the inks are light.
  let paper: { r: number; g: number; b: number }
  if (paperLabel >= 0) {
    const c = palette[paperLabel]
    paper = { r: c.r, g: c.g, b: c.b }
  } else {
    let lum = 0
    for (const l of inks) lum += 0.299 * palette[l].r + 0.587 * palette[l].g + 0.114 * palette[l].b
    const light = inks.length > 0 && lum / inks.length > 160
    paper = light ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }
  }

  const out = new Uint8ClampedArray(n * 4)
  const cov = new Uint8ClampedArray(n * 4)
  const inkOf = new Int32Array(n).fill(inks.length > 0 ? inks[0] : -1)
  // Per ink: the ink-minus-paper direction and its squared length, for the projection.
  const dir = inks.map((l) => {
    const c = palette[l]
    const d = { r: c.r - paper.r, g: c.g - paper.g, b: c.b - paper.b }
    return { l, d, len2: d.r * d.r + d.g * d.g + d.b * d.b }
  })

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = data[p + 3] / 255
    const r = data[p] * a + paper.r * (1 - a)
    const g = data[p + 1] * a + paper.g * (1 - a)
    const b = data[p + 2] * a + paper.b * (1 - a)
    out[p] = r
    out[p + 1] = g
    out[p + 2] = b
    out[p + 3] = 255

    // Which ink: the pixel's own label when it is one, otherwise the ink whose
    // paper→ink line passes closest to the pixel (an anti-aliased edge pixel sits on it).
    let k = -1
    const own = labels[i]
    if (own >= 0 && own !== paperLabel) k = inks.indexOf(own)
    if (k < 0) {
      let best = Infinity
      for (let j = 0; j < dir.length; j++) {
        const { d, len2 } = dir[j]
        if (len2 < 1) continue
        const t = Math.max(0, Math.min(1, ((r - paper.r) * d.r + (g - paper.g) * d.g + (b - paper.b) * d.b) / len2))
        const res = (r - paper.r - t * d.r) ** 2 + (g - paper.g - t * d.g) ** 2 + (b - paper.b - t * d.b) ** 2
        if (res < best) {
          best = res
          k = j
        }
      }
    }

    // How much of the pixel is ink: on transparency the alpha says so directly; on a
    // paper colour it is the distance from the paper relative to that ink's — linear
    // across an ink/paper anti-aliasing ramp, and ≥ 1 where two inks meet (a mix of
    // two inks is far from the paper), so touching colours do not open a seam.
    let alpha = 0
    if (k >= 0) {
      inkOf[i] = dir[k].l
      if (paperLabel < 0) alpha = a
      else if (dir[k].len2 >= 1) alpha = Math.min(1, Math.sqrt(dist2(r, g, b, paper) / dir[k].len2))
    }
    const v = Math.round(255 * (1 - alpha))
    cov[p] = cov[p + 1] = cov[p + 2] = v
    cov[p + 3] = 255
  }

  return {
    coverage: { data: cov, width, height },
    inkOf,
    inks,
    paperLabel,
    paper,
    image: { data: out, width, height },
  }
}

/** The segment's ink vote: `inkOf` under points about a pixel apart along the Bézier. */
function segmentVotes(
  a: PathNode,
  b: PathNode,
  vote: (x: number, y: number, votes: Map<number, number>) => void,
): { votes: Map<number, number>; len: number } {
  const c1 = a.hOut ?? a
  const c2 = b.hIn ?? b
  const len = Math.hypot(c1.x - a.x, c1.y - a.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(b.x - c2.x, b.y - c2.y)
  const steps = Math.max(1, Math.min(256, Math.ceil(len)))
  const votes = new Map<number, number>()
  for (let k = 0; k <= steps; k++) {
    const t = k / steps
    const u = 1 - t
    vote(
      u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
      votes,
    )
  }
  return { votes, len }
}

const winner = (votes: Map<number, number>): { label: number; n: number } => {
  let label = -1
  let n = 0
  for (const [l, v] of votes)
    if (v > n) {
      n = v
      label = l
    }
  return { label, n }
}

/**
 * Paint each stroke in the ink its centreline runs through, and cut it where the ink
 * changes. The junction pairing (assemble.ts) threads a line through a junction by
 * geometry alone, so a dark string tied to a pink kite's corner comes back as one path
 * round the kite and down the string. Every segment votes for the `inkOf` label under
 * it; runs of one ink become separate strokes, split at the node between them. A run
 * shorter than the stroke is wide is a junction's overlap rather than a line of its own
 * and joins its neighbour. A colour change with no node at it stays one stroke, in its
 * majority ink — the limit of this version.
 *
 * Only pixels the cut called ink vote (`isInk`), so a stroke's overhang past a butt end
 * does not dilute it.
 */
export function paintStrokes(
  items: PathItem[],
  inkOf: Int32Array,
  isInk: (i: number) => boolean,
  width: number,
  height: number,
  hexOf: (label: number) => string,
  fallback: number,
): PathItem[] {
  const vote = (px: number, py: number, votes: Map<number, number>) => {
    const x = Math.floor(px)
    const y = Math.floor(py)
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const i = y * width + x
    if (!isInk(i)) return
    votes.set(inkOf[i], (votes.get(inkOf[i]) ?? 0) + 1)
  }
  const out: PathItem[] = []
  for (const it of items) {
    if (!it.stroke) {
      out.push(it)
      continue
    }
    const pieces: { sp: SubPath; label: number }[] = []
    for (const sp of it.subPaths) for (const run of inkRuns(sp, it.stroke.width, vote)) pieces.push(run)
    const total = new Map<number, number>()
    for (const p of pieces) total.set(p.label, (total.get(p.label) ?? 0) + 1)
    if (total.size <= 1) {
      const l = pieces[0]?.label ?? -1
      out.push({ ...it, stroke: { ...it.stroke, color: hexOf(l >= 0 ? l : fallback) } })
      continue
    }
    pieces.forEach((p, k) =>
      out.push({
        ...it,
        id: `${it.id}-${k}`,
        subPaths: [p.sp],
        stroke: { ...it.stroke!, color: hexOf(p.label >= 0 ? p.label : fallback) },
      }),
    )
  }
  return out
}

/** A sub-path cut into runs of one ink at the nodes where the ink changes. */
function inkRuns(
  sp: SubPath,
  strokeWidth: number,
  vote: (x: number, y: number, votes: Map<number, number>) => void,
): { sp: SubPath; label: number }[] {
  const { nodes, closed } = sp
  const segs = closed ? nodes.length : nodes.length - 1
  if (segs < 1) {
    const v = new Map<number, number>()
    if (nodes.length > 0) vote(nodes[0].x, nodes[0].y, v)
    return [{ sp, label: winner(v).label }]
  }
  // One label per segment; a segment that saw no ink takes its neighbour's.
  type Run = { from: number; to: number; votes: Map<number, number>; len: number; label: number }
  const runs: Run[] = []
  for (let s = 0; s < segs; s++) {
    const { votes, len } = segmentVotes(nodes[s], nodes[(s + 1) % nodes.length], vote)
    const { label } = winner(votes)
    const last = runs[runs.length - 1]
    if (last && (label === -1 || label === last.label)) {
      for (const [l, v] of votes) last.votes.set(l, (last.votes.get(l) ?? 0) + v)
      last.to = s + 1
      last.len += len
    } else runs.push({ from: s, to: s + 1, votes, len, label })
  }
  if (runs[0].label === -1 && runs.length > 1) {
    runs[1].from = runs[0].from
    runs[1].len += runs[0].len
    runs.shift()
  }
  // Short runs are a junction's overlap: fold each into the neighbour that shares
  // most of its votes, shortest first.
  for (;;) {
    let k = -1
    for (let j = 0; j < runs.length; j++)
      if (runs.length > 1 && runs[j].len < strokeWidth && (k < 0 || runs[j].len < runs[k].len)) k = j
    if (k < 0) break
    const prev = k > 0 ? runs[k - 1] : closed ? runs[runs.length - 1] : null
    const next = k < runs.length - 1 ? runs[k + 1] : closed ? runs[0] : null
    const into =
      prev && next ? ((runs[k].votes.get(prev.label) ?? 0) >= (runs[k].votes.get(next.label) ?? 0) ? prev : next) : (prev ?? next)!
    if (into === prev) into.to = runs[k].to
    else into.from = runs[k].from
    into.len += runs[k].len
    for (const [l, v] of runs[k].votes) into.votes.set(l, (into.votes.get(l) ?? 0) + v)
    runs.splice(k, 1)
  }
  // Adjacent runs that now agree merge back (also across a closed path's seam).
  for (let j = runs.length - 1; j > 0; j--)
    if (runs[j].label === runs[j - 1].label) {
      runs[j - 1].to = runs[j].to
      runs[j - 1].len += runs[j].len
      runs.splice(j, 1)
    }
  if (runs.length === 1) return [{ sp, label: runs[0].label }]
  if (closed && runs[0].label === runs[runs.length - 1].label) {
    const tail = runs.pop()!
    runs[0].from = tail.from - segs
  }
  // Each run is an open path over its nodes; a closed path's indices wrap.
  const at = (i: number) => nodes[((i % nodes.length) + nodes.length) % nodes.length]
  return runs.map((r) => {
    const ns: PathNode[] = []
    for (let i = r.from; i <= r.to; i++) {
      const n = at(i)
      ns.push({ ...n, hIn: i === r.from ? null : n.hIn, hOut: i === r.to ? null : n.hOut, kind: i === r.from || i === r.to ? 'corner' : n.kind })
    }
    return { sp: { nodes: ns, closed: false }, label: r.label }
  })
}
