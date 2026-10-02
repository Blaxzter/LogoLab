// The artboard: a fixed size, or one that grows with the drawing.
//
// A growing artboard is still a plain viewBox — the export never learns there
// was a mode. It is refitted to the VISIBLE artwork (hidden items are not
// exported, so they must not stretch the bounds), strokes included, rounded
// outward to whole units so the exported viewBox reads cleanly.
//
// The stage does not show a growing artboard as a frame at all: it is an
// infinite board with a free camera (`camera.ts`), and the artboard is only the
// dashed outline of what has been drawn so far.

import type { DocItem, EditableDoc } from '../path/types.ts'
import { isGroup } from '../path/docTree.ts'
import { itemBox, unionBoxes, type Box } from './transform.ts'

/** Below this, a float that should be a whole number still rounds to it. */
const EPS = 1e-6

/** Bounds of what the export draws: visible items, half a stroke outside each path. */
export function drawingBounds(items: readonly DocItem[]): Box | null {
  const boxes: (Box | null)[] = []
  const walk = (list: readonly DocItem[]) => {
    for (const it of list) {
      if (!it.visible) continue
      if (isGroup(it)) {
        walk(it.children)
        continue
      }
      const b = itemBox(it)
      if (!b) continue
      const half = it.kind === 'path' && it.stroke ? it.stroke.width / 2 : 0
      boxes.push({ x: b.x - half, y: b.y - half, w: b.w + half * 2, h: b.h + half * 2 })
    }
  }
  walk(items)
  return unionBoxes(boxes)
}

function hasVisibleRaw(items: readonly DocItem[]): boolean {
  return items.some((it) => it.visible && (it.kind === 'raw' || (isGroup(it) && hasVisibleRaw(it.children))))
}

/** Round a box outward to whole units, at least one unit on each side. */
export function outwardBox(b: Box): [number, number, number, number] {
  const x0 = Math.floor(b.x + EPS)
  const y0 = Math.floor(b.y + EPS)
  const x1 = Math.max(x0 + 1, Math.ceil(b.x + b.w - EPS))
  const y1 = Math.max(y0 + 1, Math.ceil(b.y + b.h - EPS))
  return [x0, y0, x1 - x0, y1 - y0]
}

/**
 * Refit a growing artboard to its drawing. A fixed artboard, an empty drawing
 * and an unchanged fit all return the SAME document, so history and the
 * logo's change guard see no edit.
 */
export function fitGrowingArtboard(doc: EditableDoc): EditableDoc {
  if (doc.artboard !== 'grow') return doc
  let bounds = drawingBounds(doc.items)
  if (!bounds) return doc
  // Imported markup is never parsed, so it has no box: assume it lies inside
  // the artboard it came with, and let the artboard grow but never shrink.
  if (hasVisibleRaw(doc.items)) {
    const [x, y, w, h] = doc.viewBox
    bounds = unionBoxes([bounds, { x, y, w, h }]) as Box
  }
  const vb = outwardBox(bounds)
  const same = vb.every((v, i) => v === doc.viewBox[i])
  return same ? doc : { ...doc, viewBox: vb }
}

/** Switch modes. Growing refits at once; fixing keeps the size it had grown to. */
export function setArtboardMode(doc: EditableDoc, grow: boolean): EditableDoc {
  if (grow === (doc.artboard === 'grow')) return doc
  if (grow) return fitGrowingArtboard({ ...doc, artboard: 'grow' })
  const next = { ...doc }
  delete next.artboard
  return next
}

/** A fixed artboard of a new size. The top-left corner and the artwork stay put. */
export function resizeArtboard(doc: EditableDoc, width: number, height: number): EditableDoc {
  const [x, y, w, h] = doc.viewBox
  if (w === width && h === height) return doc
  return { ...doc, viewBox: [x, y, width, height] }
}

/** Shrink-wrap a fixed artboard to the drawing once; null when there is nothing to fit. */
export function fitArtboardToDrawing(doc: EditableDoc): EditableDoc | null {
  const bounds = drawingBounds(doc.items)
  if (!bounds) return null
  const vb = outwardBox(bounds)
  return vb.every((v, i) => v === doc.viewBox[i]) ? doc : { ...doc, viewBox: vb }
}
