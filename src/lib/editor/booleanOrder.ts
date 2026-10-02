// Which selected shapes a boolean works on, and which one is the BASE — the
// shape Subtract cuts from, whose paint and place the result keeps.
//
// The base is the shape selected FIRST. A selection is an insertion-ordered
// set, so click order survives; a marquee or Select All adds in paint order,
// which makes the base the back-most shape — Affinity's rule — exactly when
// there was no click order to go by. Kept apart from boolean.ts so the stage
// can mark the base without loading paper.js.

import type { EditableDoc } from '../path/types.ts'
import { allPaths, findItem, isGroup, topLevelSelection, walkItems } from '../path/docTree.ts'

/** Selected top-level ids that draw something a boolean can use. */
function usable(doc: EditableDoc, id: string): boolean {
  const it = findItem(doc.items, id)
  if (!it) return false
  if (isGroup(it)) return allPaths(it.children).some((p) => p.visible)
  return it.kind === 'path'
}

/**
 * The operands, base first, the rest in paint order — or, with `paint`, all of
 * them back to front (Divide, where what is ON TOP decides each piece's paint).
 */
export function booleanOperandIds(doc: EditableDoc, selection: ReadonlySet<string>, paint = false): string[] {
  const picked = topLevelSelection(doc.items, selection).filter((id) => usable(doc, id))
  const set = new Set(picked)
  const byPaint: string[] = []
  walkItems(doc.items, (it) => {
    if (set.has(it.id)) byPaint.push(it.id)
  })
  if (paint || picked.length === 0) return byPaint
  return [picked[0], ...byPaint.filter((id) => id !== picked[0])]
}

/** The base a boolean would use, or null with fewer than two operands. */
export function booleanBase(doc: EditableDoc, selection: ReadonlySet<string>): string | null {
  const ids = booleanOperandIds(doc, selection)
  return ids.length >= 2 ? ids[0] : null
}
