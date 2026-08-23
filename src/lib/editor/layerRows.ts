// The layers panel's display model: the doc tree flattened into the rows the
// panel actually shows, plus the two questions a pointer asks of that list —
// "what does shift-click select?" and "where does this drop land?".
//
// Display order is REVERSED against paint order (top of the list = frontmost,
// like every layers panel ever made) and a collapsed group hides its subtree.
// The renderer, the range select and the drop resolver all have to agree on
// what row 5 is, so they read one array, built once, here.

import type { DocItem } from '../path/types.ts'
import { isGroup, walkItems } from '../path/docTree.ts'

export interface LayerRow {
  item: DocItem
  /** Indentation level; 0 at top level. */
  depth: number
  /** The group this row lives in — null at top level. */
  parentId: string | null
  /** Index within that parent's children, in PAINT order. */
  siblingIndex: number
  /** The number in "Path 3". */
  number: number
}

/** Where a drop lands: an insertion point in PAINT order. */
export interface DropSpot {
  parentId: string | null
  index: number
}

/** Which third of a row the pointer is over. */
export type DropEdge = 'above' | 'below' | 'into'

/**
 * Every visible row, top of the stack first.
 *
 * Numbering runs in PAINT order, not display order: counting down the reversed
 * list would renumber every existing row each time a shape is added — the shape
 * you were looking at silently becomes "Path 4" — and the number would disagree
 * with the one that shape carries everywhere else in the editor.
 */
export function layerRows(items: readonly DocItem[]): LayerRow[] {
  const numbers = new Map<string, number>()
  let pathIndex = 0
  let groupIndex = 0
  walkItems(items, (item) => {
    numbers.set(item.id, isGroup(item) ? ++groupIndex : ++pathIndex)
  })

  const rows: LayerRow[] = []
  const walk = (list: readonly DocItem[], depth: number, parentId: string | null) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i]
      rows.push({ item, depth, parentId, siblingIndex: i, number: numbers.get(item.id) ?? 0 })
      if (isGroup(item) && item.expanded !== false) walk(item.children, depth + 1, item.id)
    }
  }
  walk(items, 0, null)
  return rows
}

/**
 * The ids of every row between two rows, inclusive — what shift-click selects.
 *
 * The span is taken in DISPLAY order, so it is exactly the block of rows the
 * user drew a line down with their eyes: an expanded group caught in the middle
 * contributes both itself and its children, and structural ops drop the
 * children again through `topLevelSelection`.
 */
export function rowsBetween(
  rows: readonly LayerRow[],
  anchorId: string,
  toId: string,
): string[] {
  const a = rows.findIndex((r) => r.item.id === anchorId)
  const b = rows.findIndex((r) => r.item.id === toId)
  if (b < 0) return []
  if (a < 0) return [toId]
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return rows.slice(lo, hi + 1).map((r) => r.item.id)
}

/**
 * The edge a pointer at `offsetY` within a row of `height` is asking for. A
 * group row keeps a fat middle band that means "inside"; a leaf is a simple
 * top/bottom split, because there is nothing to drop into.
 */
export function edgeAt(offsetY: number, height: number, group: boolean): DropEdge {
  const f = height > 0 ? offsetY / height : 0.5
  if (group) return f < 0.3 ? 'above' : f > 0.7 ? 'below' : 'into'
  return f < 0.5 ? 'above' : 'below'
}

/**
 * The insertion point a drop on `rowId`'s `edge` means.
 *
 * ABOVE in the list is IN FRONT in paint order — that `+1` is the whole reason
 * this lives in one function instead of being inlined at the drop site.
 * Dropping INTO a group lands at the front of it, where the eye expects a row
 * dragged onto a folder to appear: first child under the header.
 */
export function dropSpot(
  rows: readonly LayerRow[],
  rowId: string,
  edge: DropEdge,
): DropSpot | null {
  const row = rows.find((r) => r.item.id === rowId)
  if (!row) return null
  if (edge === 'into') {
    if (!isGroup(row.item)) return null
    return { parentId: row.item.id, index: row.item.children.length }
  }
  return {
    parentId: row.parentId,
    index: edge === 'above' ? row.siblingIndex + 1 : row.siblingIndex,
  }
}
