// Fit a traced document into an icon grid: the artwork's tight bounds scaled to
// `size − 2·inset` units and centred in a `size`×`size` viewBox — the step every
// icon-set pipeline writes for itself ("fit the ink to 20 of 24 units, centre,
// round to two decimals"), done once, here, on the model rather than the markup.
//
// What counts as artwork: every visible path except the paper. The page under a
// mono trace is the whole icon box afterwards, not a shape to fit. A stroke
// reaches half its width past its centreline, so stroked paths are measured with
// that margin and the width scales with the geometry; gradients and the planar
// topology move with the shapes they belong to, so the doc stays consistent.

import { affineScale, applyAffine, subPathsTightBounds, transformSubPaths } from './geometry.ts'
import { isPaper, paperItem } from './paper.ts'
import type { Affine, DocItem, EditableDoc, GradientFill, PathItem, PathNode, Topology } from './types'

export interface NormalizeSpec {
  /** Side of the square viewBox the icon is fitted into (24 for a Lucide-style set). */
  size: number
  /** Units kept clear on every side: the art fills `size − 2·inset`. */
  inset: number
}

/** The inset most icon grids use: a twelfth of the box (2 units on a 24 grid). */
export function defaultInset(size: number): number {
  return Math.round(size / 12)
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The doc, refitted: viewBox `0 0 size size`, the art centred in the inner box.
 * A doc with no artwork (nothing but paper, or nothing at all) only gets the new
 * viewBox. Hidden items are not measured, but they move with the rest.
 */
export function normalizeDoc(doc: EditableDoc, spec: NormalizeSpec): EditableDoc {
  const size = Math.max(1, spec.size)
  const inset = Math.max(0, Math.min(size / 2 - 0.5, spec.inset))
  const m = fitAffine(artBounds(doc.items), size, inset)
  const out: EditableDoc = {
    ...doc,
    viewBox: [0, 0, size, size],
    items: doc.items.map((item) => transformItem(item, m, size)),
  }
  if (doc.topology) out.topology = transformTopology(doc.topology, m)
  return out
}

/** Tight bounds of the artwork (visible, non-paper paths), stroke margins included. */
export function artBounds(items: readonly DocItem[]): Box | null {
  let box: Box | null = null
  const consider = (b: Box) => {
    if (!box) {
      box = { ...b }
      return
    }
    const x1 = Math.max(box.x + box.w, b.x + b.w)
    const y1 = Math.max(box.y + box.h, b.y + b.h)
    box.x = Math.min(box.x, b.x)
    box.y = Math.min(box.y, b.y)
    box.w = x1 - box.x
    box.h = y1 - box.y
  }
  const walk = (list: readonly DocItem[]) => {
    for (const item of list) {
      if (!item.visible) continue
      if (item.kind === 'group') walk(item.children)
      else if (item.kind === 'path' && !isPaper(item)) {
        const b = subPathsTightBounds(item.subPaths)
        if (!b) continue
        const margin = item.stroke && item.stroke.width > 0 ? item.stroke.width / 2 : 0
        consider({ x: b.x - margin, y: b.y - margin, w: b.w + 2 * margin, h: b.h + 2 * margin })
      }
    }
  }
  walk(items)
  return box
}

/** The uniform scale + translation that centres `box` in the inner square. */
function fitAffine(box: Box | null, size: number, inset: number): Affine {
  if (!box) return [1, 0, 0, 1, 0, 0]
  const inner = size - 2 * inset
  const long = Math.max(box.w, box.h)
  const s = long > 0 ? inner / long : 1
  const tx = inset + (inner - box.w * s) / 2 - box.x * s
  const ty = inset + (inner - box.h * s) / 2 - box.y * s
  return [s, 0, 0, s, tx, ty]
}

function transformItem(item: DocItem, m: Affine, size: number): DocItem {
  if (item.kind === 'group') return { ...item, children: item.children.map((c) => transformItem(c, m, size)) }
  if (item.kind !== 'path') return item
  // The paper is the page: after the refit it is the whole icon box.
  if (isPaper(item)) return { ...paperItem(size, size, item.fill), visible: item.visible }
  return transformPath(item, m)
}

function transformPath(item: PathItem, m: Affine): PathItem {
  const s = affineScale(m)
  const out: PathItem = { ...item, subPaths: transformSubPaths(item.subPaths, m) }
  if (item.stroke) {
    out.stroke = { ...item.stroke, width: item.stroke.width * s }
    if (item.stroke.dash) out.stroke.dash = item.stroke.dash.map((d) => d * s)
  }
  if (item.gradient) out.gradient = transformGradient(item.gradient, m, s)
  return out
}

function transformGradient(g: GradientFill, m: Affine, s: number): GradientFill {
  if (g.type === 'linear') {
    const a = applyAffine(m, { x: g.x1, y: g.y1 })
    const b = applyAffine(m, { x: g.x2, y: g.y2 })
    return { ...g, x1: a.x, y1: a.y, x2: b.x, y2: b.y }
  }
  const c = applyAffine(m, { x: g.cx, y: g.cy })
  const out: GradientFill = { ...g, cx: c.x, cy: c.y, r: g.r * s }
  if (g.fx !== undefined && g.fy !== undefined) {
    const f = applyAffine(m, { x: g.fx, y: g.fy })
    out.fx = f.x
    out.fy = f.y
  }
  return out
}

function transformNodes(nodes: PathNode[], m: Affine): PathNode[] {
  return transformSubPaths([{ nodes, closed: false }], m)[0].nodes
}

function transformTopology(t: Topology, m: Affine): Topology {
  return {
    vertices: t.vertices.map((v) => ({ ...v, ...applyAffine(m, { x: v.x, y: v.y }) })),
    edges: t.edges.map((e) => ({ ...e, nodes: transformNodes(e.nodes, m) })),
  }
}
