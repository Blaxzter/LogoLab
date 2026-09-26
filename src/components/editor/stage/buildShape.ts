// A drawing tool's rubber band (two corners) turned into a new path item.

import type { PathItem, Vec } from '../../../lib/path/types'
import {
  boxRadius,
  constrainLine,
  ellipseShape,
  lineShape,
  polygonShape,
  rectShape,
  starShape,
} from '../../../lib/editor/shapes'
import { makePath } from '../editorDoc'
import type { EditorTool } from '../tools'

export function buildShape(tool: EditorTool, vw: number, a: Vec, b: Vec, shift: boolean): PathItem | null {
  const pa = a
  let pb = b
  if (shift && tool !== 'line') {
    // Constrain to a square box, keeping the drag's direction.
    const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
    pb = { x: a.x + Math.sign(b.x - a.x || 1) * s, y: a.y + Math.sign(b.y - a.y || 1) * s }
  }
  let sp
  switch (tool) {
    case 'rect':
      sp = rectShape(pa, pb)
      break
    case 'ellipse':
      sp = ellipseShape(pa, pb)
      break
    case 'line': {
      if (shift) pb = { x: b.x, y: a.y === b.y ? b.y : constrainLine(a, b).y }
      sp = lineShape(pa, shift ? constrainLine(a, b) : pb)
      break
    }
    case 'polygon': {
      const { center, radius } = boxRadius(pa, pb)
      sp = polygonShape(center, radius, 6)
      break
    }
    case 'star': {
      const { center, radius } = boxRadius(pa, pb)
      sp = starShape(center, radius, 5, 0.45)
      break
    }
    default:
      return null
  }
  if (!sp || sp.length === 0) return null
  const item = makePath(sp)
  // A line has no interior, so it gets a stroke instead of a fill.
  if (tool === 'line') {
    item.fill = 'none'
    item.stroke = { color: '#111827', width: Math.max(1, vw / 256), cap: 'round', join: 'round' }
  }
  return item
}
