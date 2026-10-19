// Outline stroke: a stroked path becomes filled geometry of the area its stroke
// paints, as Illustrator's "Outline Stroke" / Affinity's "Expand Stroke".
//
// `strokePieces.ts` builds the stroke as simple curved pieces (segment bodies
// between their offsets, joins, caps, dashes); paper.js unites them — the same
// engine as the shape booleans, so this module is likewise only reached through
// a dynamic import — and a last pass with Simplify at a hair's tolerance welds
// the nodes left where two pieces met smoothly (collinear sides, a body meeting
// its round join). The result is curves, the corners the stroke has (a miter's
// tip, a butt end) sharp, and holes wound so a nonzero fill leaves them open.
//
// A path that also has a fill comes back as a group of the fill (stroke
// removed) under the outline (filled in the stroke's colour and opacity),
// which is what it painted. Live text is left alone: its outlines are a cache
// of the words.

import type { DocItem, EditableDoc, GroupItem, PathItem, SubPath } from '../path/types.ts'
import { isGroup } from '../path/docTree.ts'
import { fromPaper, scope, toPaper } from './boolean.ts'
import { chainArea, paintedStroke, strokePieces } from './strokePieces.ts'
import { simplifySubPath } from './simplify.ts'
import { subPathCubics } from './bezierFit.ts'

/**
 * How far the outline may stray from the true stroke edge: half a percent of
 * the stroke width, or 0.05 units for a hairline.
 */
export function outlineTolerance(width: number): number {
  return Math.max(0.005 * width, 0.05)
}

/** Kinks under this (degrees) are where two pieces met, not corners of the stroke. */
const WELD_DEG = 1

/** The area `item`'s stroke paints, as closed subpaths for a nonzero fill. */
export function strokeOutline(item: PathItem): SubPath[] {
  const s = paintedStroke(item)
  if (!s) return []
  const tol = outlineTolerance(s.width)
  const pieces = item.subPaths.flatMap((sp) => strokePieces(sp, s, tol * 0.5))
  if (pieces.length === 0) return []
  const P = scope()
  const none = { insert: false }
  // A folding piece is resolved under its own nonzero fill first: its
  // swallowtail winds the other way, and summed with a neighbour it would cancel.
  const leaves = pieces.map(({ piece, folds }) => {
    const p = toPaper({ ...item, subPaths: [piece], fillRule: 'nonzero' })
    return folds ? p.unite(new P.Path(none), none) : p
  })
  // Two at a time, as a balanced tree over pieces in path order: a true
  // two-operand union is what merges pieces that only share an edge (one
  // compound resolved at once leaves them touching), pairing keeps each union
  // small, and path order keeps each operand one connected run of stroke.
  let layer = leaves
  while (layer.length > 1) {
    const next: typeof layer = []
    for (let i = 0; i < layer.length; i += 2)
      next.push(i + 1 < layer.length ? layer[i].unite(layer[i + 1], none) : layer[i])
    layer = next
  }
  let united = fromPaper(layer[0])
  // A union can never paint less than its largest piece. When paper.js drops a
  // contour anyway, redo it one piece at a time, which is slower and has not
  // been seen to fail.
  const largest = Math.max(...pieces.map(({ piece }) => Math.abs(chainArea(subPathCubics(piece.nodes, true)))))
  if (paintedArea(united) < largest * (1 - 1e-3)) {
    let acc = leaves[0]
    for (let i = 1; i < leaves.length; i++) acc = acc.unite(leaves[i], none)
    united = fromPaper(acc)
  }
  return united
    .map((sp) => simplifySubPath(sp, tol * 0.4, WELD_DEG))
    .filter((sp) => Math.abs(chainArea(subPathCubics(sp.nodes, true))) > tol * tol * 1e-3)
}

/** Area of closed subpaths under nonzero, their holes wound opposite. */
function paintedArea(sps: readonly SubPath[]): number {
  return Math.abs(sps.reduce((acc, sp) => acc + chainArea(subPathCubics(sp.nodes, true)), 0))
}

/** Whether a path's fill paints anything: a colour or gradient, over some area. */
function paintsFill(item: PathItem): boolean {
  if (item.fill === 'none' || (item.fillOpacity ?? 1) <= 0) return false
  return item.subPaths.some((sp) => Math.abs(chainArea(subPathCubics(sp.nodes, true))) > 1e-9)
}

/**
 * One stroked path outlined: the outline alone (keeping the path's id and
 * name), or a group of fill + outline in its place when it also has a fill.
 * Null when the path has no stroke to outline.
 */
export function outlinePath(item: PathItem, nextId: () => string): DocItem | null {
  const s = paintedStroke(item)
  if (!s) return null
  const subPaths = strokeOutline(item)
  const { stroke: _stroke, loops: _loops, gradient: _gradient, fillOpacity: _fo, name, ...rest } = item
  const outline: PathItem = {
    ...rest,
    fill: s.color,
    fillRule: 'nonzero',
    subPaths,
  }
  if (s.opacity !== undefined && s.opacity < 1) outline.fillOpacity = s.opacity
  if (!paintsFill(item)) {
    if (name) outline.name = name
    return outline
  }
  const { stroke: _s, loops: _l, name: _n, ...fillRest } = item
  const fill: PathItem = { ...fillRest, id: nextId() }
  const group: GroupItem = {
    kind: 'group',
    id: item.id,
    children: [fill, { ...outline, id: nextId() }],
    visible: item.visible,
  }
  if (name) group.name = name
  return group
}

/**
 * Outline every stroked path in the selection (walking into selected groups,
 * never into a live text). Each keeps its id, so the selection stays on what
 * it became. Null when nothing selected has a stroke.
 */
export function outlineSelected(
  doc: EditableDoc,
  selection: ReadonlySet<string>,
  nextId: () => string,
): EditableDoc | null {
  let changed = false
  const walk = (list: readonly DocItem[], on: boolean): DocItem[] =>
    list.map((it) => {
      const sel = on || selection.has(it.id)
      if (isGroup(it)) {
        if (it.text) return it
        const children = walk(it.children, sel)
        return children.some((c, i) => c !== it.children[i]) ? { ...it, children } : it
      }
      if (!sel || it.kind !== 'path') return it
      const next = outlinePath(it, nextId)
      if (!next) return it
      changed = true
      return next
    })
  const items = walk(doc.items, false)
  return changed ? { ...doc, items } : null
}
