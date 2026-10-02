// Shape booleans — Add, Subtract, Intersect, Xor and Divide, as in Affinity.
//
// The curve maths is paper.js's: it intersects the Béziers themselves, so a
// circle minus a square comes back as two arcs and a straight edge, not as a
// polygon. Flattening to polygons and clipping was rejected for exactly that
// reason — it throws away the curves a logo is made of. paper is ~70 KB, so this
// module is only ever reached through a dynamic import (the studio's
// `runBoolean`); nothing else in the editor's chunk pulls it in.
//
// Rules:
//   * operands are the selected top-level items; a group is one operand (the
//     union of its paths);
//   * the BASE is the shape selected first (`booleanOrder.ts`; with no click
//     order — a marquee — that is the back-most one, Affinity's rule). The
//     stage marks it in its own colour while a boolean is possible;
//   * the result takes the base's paint and lands where the base was, so a
//     boolean never moves anything else up or down the stack;
//   * Subtract removes every other operand from the base;
//   * Divide cuts the operands at every crossing into separate pieces, each
//     painted like the front-most operand covering it;
//   * open subpaths count as closed (their fill area), like a filled open curve.

import paper from 'paper/dist/paper-core.js'
import type { DocItem, EditableDoc, PathItem, PathNode, SubPath } from '../path/types.ts'
import { allPaths, findItem, isGroup, removeItems } from '../path/docTree.ts'
import { booleanOperandIds } from './booleanOrder.ts'

export type BooleanOp = 'add' | 'subtract' | 'intersect' | 'xor' | 'divide'

type PItem = paper.PathItem

let ready = false
function scope(): typeof paper {
  if (!ready) {
    // Geometry only: no view is drawn, the size just satisfies setup().
    paper.setup(new paper.Size(1, 1))
    ready = true
  }
  return paper
}

/** Below this area (viewBox units²) a piece is a numerical sliver, not a shape. */
const EMPTY_AREA = 1e-6

/* ------------------------------------------------------- model ⇄ paper */

function toPaperPath(sp: SubPath): paper.Path {
  const P = scope()
  const segments = sp.nodes.map(
    (n) =>
      new P.Segment(
        new P.Point(n.x, n.y),
        n.hIn ? new P.Point(n.hIn.x - n.x, n.hIn.y - n.y) : undefined,
        n.hOut ? new P.Point(n.hOut.x - n.x, n.hOut.y - n.y) : undefined,
      ),
  )
  // Open subpaths are filled as if closed — that is what they paint.
  return new P.Path({ segments, closed: true, insert: false })
}

/** One model path as a paper compound, its fill rule kept. */
export function toPaper(item: PathItem): PItem {
  const P = scope()
  const children = item.subPaths.filter((sp) => sp.nodes.length > 1).map(toPaperPath)
  const out = new P.CompoundPath({ children, insert: false })
  out.fillRule = item.fillRule
  return out
}

/** Several paths as ONE operand (a group): their union, so overlaps don't cancel. */
function operandGeometry(paths: PathItem[]): PItem | null {
  let acc: PItem | null = null
  for (const p of paths) {
    const g = toPaper(p)
    acc = acc ? acc.unite(g, { insert: false }) : g
  }
  return acc
}

const HANDLE_EPS = 1e-9

function toNode(seg: paper.Segment): PathNode {
  const x = seg.point.x
  const y = seg.point.y
  const hi = seg.handleIn
  const ho = seg.handleOut
  const hIn = hi.length > HANDLE_EPS ? { x: x + hi.x, y: y + hi.y } : null
  const hOut = ho.length > HANDLE_EPS ? { x: x + ho.x, y: y + ho.y } : null
  // Smooth only where paper's two handles are opposite and collinear — a cut
  // through a curve leaves a corner, and calling it smooth would make the next
  // handle drag swing the other side round with it.
  let kind: PathNode['kind'] = 'corner'
  if (hIn && hOut) {
    const cross = hi.x * ho.y - hi.y * ho.x
    const dot = hi.x * ho.x + hi.y * ho.y
    if (dot < 0 && Math.abs(cross) <= 1e-6 * hi.length * ho.length) kind = 'smooth'
  }
  return { x, y, hIn, hOut, kind }
}

function pathsOf(item: PItem): paper.Path[] {
  if (item instanceof scope().CompoundPath) return item.children as paper.Path[]
  return [item as paper.Path]
}

/** Paper geometry back to subpaths. */
export function fromPaper(item: PItem): SubPath[] {
  return pathsOf(item)
    .filter((p) => p.segments.length > 1)
    .map((p) => ({ nodes: p.segments.map(toNode), closed: true }))
}

function isEmpty(item: PItem | null): boolean {
  // Per child, unsigned: paper's own `area` is signed, and an Xor's pieces can
  // come back wound opposite ways and sum to zero.
  return !item || pathsOf(item).every((p) => Math.abs(p.area) < EMPTY_AREA)
}

/**
 * Split a boolean result into its disconnected pieces, each with its own holes.
 * paper's results are non-overlapping with holes wound opposite their outline,
 * so containment depth tells outline (even) from hole (odd).
 */
function components(item: PItem): PItem[] {
  const P = scope()
  const kids = pathsOf(item).filter((p) => Math.abs(p.area) >= EMPTY_AREA)
  if (kids.length <= 1) return kids.length ? [item] : []
  // A point ON each loop, not `interiorPoint`: an outline's interior point can
  // sit in its own hole (a square ring's centre), which reads the outline as
  // nested. Result loops never cross, so a boundary point is inside exactly
  // the loops that enclose the whole loop.
  const probe = new Map(kids.map((k) => [k, k.getPointAt(k.length * 0.37)]))
  const depth = kids.map((k) => kids.filter((o) => o !== k && o.contains(probe.get(k)!)).length)
  const outers = kids.filter((_, i) => depth[i] % 2 === 0)
  const holes = new Map<paper.Path, paper.Path[]>(outers.map((o) => [o, []]))
  kids.forEach((k, i) => {
    if (depth[i] % 2 === 0) return
    // The hole belongs to the smallest outline around it.
    let best: paper.Path | null = null
    for (const o of outers) {
      if (!o.contains(probe.get(k)!)) continue
      if (!best || Math.abs(o.area) < Math.abs(best.area)) best = o
    }
    if (best) holes.get(best)!.push(k)
  })
  return outers.map(
    (o) =>
      new P.CompoundPath({
        children: [o.clone({ insert: false }), ...holes.get(o)!.map((h) => h.clone({ insert: false }))],
        insert: false,
      }),
  )
}

/* ------------------------------------------------------------ the ops */

interface Operand {
  id: string
  geom: PItem
  /** Paint and name come from here. */
  style: PathItem
}

/**
 * The geometry of a boolean over operands given back→front. Each output piece
 * names the operand whose paint it takes.
 */
export function booleanGeometry(
  op: BooleanOp,
  operands: { geom: PItem; style: number }[],
): { geom: PItem; style: number }[] {
  const [base, ...rest] = operands
  if (!base) return []
  const o = { insert: false }
  switch (op) {
    case 'add':
      return [{ geom: rest.reduce((acc, r) => acc.unite(r.geom, o), base.geom), style: base.style }]
    case 'intersect':
      return [{ geom: rest.reduce((acc, r) => acc.intersect(r.geom, o), base.geom), style: base.style }]
    case 'xor':
      return [{ geom: rest.reduce((acc, r) => acc.exclude(r.geom, o), base.geom), style: base.style }]
    case 'subtract':
      return [{ geom: rest.reduce((acc, r) => acc.subtract(r.geom, o), base.geom), style: base.style }]
    case 'divide': {
      let pieces = [base]
      let covered = base.geom
      for (const b of rest) {
        const next: { geom: PItem; style: number }[] = []
        for (const p of pieces) {
          // Where B overlaps a piece, B is on top and its paint wins.
          next.push({ geom: p.geom.subtract(b.geom, o), style: p.style })
          next.push({ geom: p.geom.intersect(b.geom, o), style: b.style })
        }
        next.push({ geom: b.geom.subtract(covered, o), style: b.style })
        covered = covered.unite(b.geom, o)
        pieces = next.filter((p) => !isEmpty(p.geom))
      }
      return pieces.flatMap((p) => components(p.geom).map((geom) => ({ geom, style: p.style })))
    }
  }
}

function collectOperands(doc: EditableDoc, selection: ReadonlySet<string>, paintOrder: boolean): Operand[] {
  const order = booleanOperandIds(doc, selection, paintOrder)
  const out: Operand[] = []
  for (const id of order) {
    const it = findItem(doc.items, id)
    if (!it) continue
    const paths = isGroup(it) ? allPaths(it.children).filter((p) => p.visible) : it.kind === 'path' ? [it] : []
    if (paths.length === 0) continue
    out.push({ id, geom: operandGeometry(paths) as PItem, style: paths[0] })
  }
  return out
}

/**
 * Run a boolean on the selection. The result replaces the base in place; the others are removed. Null when fewer than two shapes are selected.
 * An empty result (an Intersect of shapes that don't touch) removes them all,
 * as in Affinity — Ctrl+Z brings them back.
 */
export function booleanSelected(
  doc: EditableDoc,
  selection: ReadonlySet<string>,
  op: BooleanOp,
  nextId: () => string,
): { doc: EditableDoc; ids: Set<string> } | null {
  // Base first (the shape selected first); Divide goes by paint order instead.
  const operands = collectOperands(doc, selection, op === 'divide')
  if (operands.length < 2) return null
  const pieces = booleanGeometry(
    op,
    operands.map((o, i) => ({ geom: o.geom, style: i })),
  ).filter((p) => !isEmpty(p.geom))

  const results: PathItem[] = pieces.map((p, i) => {
    const src = operands[p.style].style
    const item: PathItem = {
      ...src,
      // The base keeps its id (and so its layer row) for a single
      // result; Divide's pieces are new shapes.
      id: pieces.length === 1 && i === 0 ? operands[0].style.id : nextId(),
      subPaths: fromPaper(p.geom),
      fillRule: 'nonzero',
      loops: undefined,
      visible: true,
    }
    if (op !== 'divide' && operands[0].style.name) item.name = operands[0].style.name
    else delete item.name
    return item
  })

  const anchor = operands[0].id
  const others = new Set(operands.slice(1).map((o) => o.id))
  const items = replaceWithMany(removeItems(doc.items, others), anchor, results)
  return { doc: { ...doc, items }, ids: new Set(results.map((r) => r.id)) }
}

/**
 * One path's own overlaps merged: contours that cross or stack (a script
 * font's joining strokes, glyphs that touch) become one outline, while holes —
 * a letter's counters — stay holes. The fill is unchanged under nonzero; the
 * outline you see and node-edit is the one that paints. Unchanged (the same
 * object) for a single contour.
 */
export function mergeOverlaps(item: PathItem): PathItem {
  if (item.subPaths.length < 2) return item
  const P = scope()
  const merged = toPaper(item).unite(new P.Path({ insert: false }), { insert: false })
  return { ...item, subPaths: fromPaper(merged), fillRule: 'nonzero', loops: undefined }
}

/**
 * Add with ONE shape selected: merge each selected path's own overlaps (paths
 * inside a selected group included; a live text is left alone). Null when
 * nothing changed.
 */
export function mergeSelected(doc: EditableDoc, selection: ReadonlySet<string>): EditableDoc | null {
  let changed = false
  const walk = (list: readonly DocItem[], on: boolean): DocItem[] =>
    list.map((it) => {
      const sel = on || selection.has(it.id)
      if (isGroup(it)) return it.text ? it : { ...it, children: walk(it.children, sel) }
      if (!sel || it.kind !== 'path') return it
      const next = mergeOverlaps(it)
      if (next !== it) changed = true
      return next
    })
  const items = walk(doc.items, false)
  return changed ? { ...doc, items } : null
}

/** Put `next` where `id` was, in its parent, in order. */
function replaceWithMany(items: readonly DocItem[], id: string, next: DocItem[]): DocItem[] {
  return items.flatMap((it): DocItem[] => {
    if (it.id === id) return next
    if (isGroup(it)) return [{ ...it, children: replaceWithMany(it.children, id, next) }]
    return [it]
  })
}
